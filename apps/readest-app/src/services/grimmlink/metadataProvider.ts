import type { BookNote } from '@/types/book';
import { hasGrimmLinkCapability } from './capabilities';
import { GrimmLinkSyncStore } from './GrimmLinkSyncStore';
import { fromGrimmLinkMetadataNote, toGrimmLinkMetadataNote } from './metadata';

type MetadataClient = {
  getMetadata(query: Record<string, string | number>): Promise<Record<string, unknown>>;
};

type MetadataConfig = { capabilities: string[]; device: string; deviceId: string };

const itemDedupeKey = (item: unknown): string => {
  if (!item || typeof item !== 'object') throw new Error('Invalid GrimmLink metadata note');
  const record = item as Record<string, unknown>;
  const payload =
    record['payload'] && typeof record['payload'] === 'object'
      ? (record['payload'] as Record<string, unknown>)
      : record;
  const key = record['dedupeKey'] ?? payload['dedupeKey'];
  if (typeof key !== 'string' || !key) throw new Error('Invalid GrimmLink metadata note');
  return key;
};

export class GrimmLinkMetadataProvider {
  constructor(
    private readonly client: MetadataClient,
    private readonly store: GrimmLinkSyncStore,
    private readonly config: MetadataConfig,
  ) {}

  async queuePush(
    bookHash: string,
    bookId: number,
    notes: BookNote[],
    bookFileId?: number,
    fileFormat?: string,
  ): Promise<boolean> {
    if (!hasGrimmLinkCapability(this.config.capabilities, 'metadata')) return false;
    const annotationPairs = notes
      .filter((note) => note.type === 'annotation')
      .map((note) => ({
        note,
        payload: toGrimmLinkMetadataNote(note, this.store.connectionId, bookHash),
      }));
    const bookmarkPairs = notes
      .filter((note) => note.type === 'bookmark')
      .map((note) => ({
        note,
        payload: toGrimmLinkMetadataNote(note, this.store.connectionId, bookHash),
      }));
    const annotations = annotationPairs.map(({ payload }) => payload);
    const bookmarks = bookmarkPairs.map(({ payload }) => payload);
    if (!annotations.length && !bookmarks.length) return false;
    await this.store.enqueueMetadata(bookHash, {
      schemaVersion: 1,
      syncMode: 'incremental',
      bookId,
      bookHash,
      bookFileId,
      fileFormat,
      device: this.config.device,
      deviceId: this.config.deviceId,
      timestamp: new Date().toISOString(),
      annotations,
      bookmarks,
    });
    await this.store.applyMetadataPage(
      bookHash,
      'annotation',
      annotationPairs.map(({ note, payload }) => ({
        noteId: note.id,
        dedupeKey: payload.dedupeKey,
      })),
      null,
    );
    await this.store.applyMetadataPage(
      bookHash,
      'bookmark',
      bookmarkPairs.map(({ note, payload }) => ({
        noteId: note.id,
        dedupeKey: payload.dedupeKey,
      })),
      null,
    );
    return true;
  }

  async pull(
    bookHash: string,
    notes: BookNote[],
    apply: (notes: BookNote[]) => Promise<void> | void,
    onUnresolved?: (note: BookNote) => void,
  ): Promise<BookNote[]> {
    if (!hasGrimmLinkCapability(this.config.capabilities, 'metadata')) return notes;
    let merged = [...notes];
    for (const type of ['annotation', 'bookmark'] as const) {
      let cursor = await this.store.getMetadataCursor(bookHash, type);
      while (true) {
        const query: Record<string, string | number> = { bookHash, type, limit: 500 };
        if (cursor) query['cursor'] = cursor;
        const response = await this.client.getMetadata(query);
        if (!Array.isArray(response['items']))
          throw new Error('Invalid GrimmLink metadata response');
        const mappings: { noteId: string; dedupeKey: string }[] = [];
        const next = new Map(merged.map((note) => [note.id, note]));
        for (const item of response['items']) {
          const dedupeKey = itemDedupeKey(item);
          const mappedId = await this.store.getNoteMapping(bookHash, dedupeKey);
          const localId = mappedId ?? `grimmlink:${type}:${dedupeKey}`;
          const local = next.get(localId);
          const remote = fromGrimmLinkMetadataNote(item, local, localId);
          if (remote) {
            if (!remote.cfi) {
              await this.store.recordUnresolvedMetadata(
                bookHash,
                dedupeKey,
                item as Record<string, unknown>,
              );
              onUnresolved?.(remote);
              continue;
            }
            next.set(remote.id, remote);
            mappings.push({ noteId: remote.id, dedupeKey });
          }
        }
        const candidate = [...next.values()];
        await apply(candidate);
        merged = candidate;
        const nextCursor =
          typeof response['nextCursor'] === 'string' && response['nextCursor']
            ? response['nextCursor']
            : null;
        await this.store.applyMetadataPage(bookHash, type, mappings, nextCursor);
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
    }
    return merged;
  }
}
