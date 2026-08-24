import type { BookNote } from '@/types/book';

export interface GrimmLinkRating { value: number; scale: 5 | 10; updatedAt: number; }

type GrimmLinkNoteType = Extract<BookNote['type'], 'annotation' | 'bookmark'>;

export interface GrimmLinkMetadataNote {
  dedupeKey: string;
  type: GrimmLinkNoteType;
  text?: string;
  note?: string;
  title?: string;
  color?: string;
  style?: string;
  page?: number;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
  location: { cfi?: string; pos0?: string; pos1?: string; pageno?: number; raw?: string };
}

const timestamp = (value: unknown): number | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export const stableMetadataDedupeKey = (connectionId: string, bookHash: string, note: BookNote): string =>
  `${connectionId}:${bookHash}:${note.id}:${note.type}:${note.updatedAt}:${note.deletedAt ?? ''}`;

export const toGrimmLinkMetadataNote = (
  note: BookNote,
  connectionId: string,
  bookHash: string,
): GrimmLinkMetadataNote => ({
  dedupeKey: stableMetadataDedupeKey(connectionId, bookHash, note),
  type: note.type === 'bookmark' ? 'bookmark' : 'annotation',
  text: note.text,
  note: note.note,
  title: note.type === 'bookmark' ? (note.note || note.text) : undefined,
  color: note.color,
  style: note.style,
  page: note.page,
  createdAt: new Date(note.createdAt).toISOString(),
  updatedAt: new Date(note.updatedAt).toISOString(),
  deleted: !!note.deletedAt,
  location: {
    cfi: note.cfi || undefined, pos0: note.xpointer0, pos1: note.xpointer1,
    pageno: note.page, raw: !note.cfi ? note.xpointer0 : undefined,
  },
});

/** Maps one validated remote note; equal timestamps deliberately retain local data. */
export const fromGrimmLinkMetadataNote = (
  item: unknown,
  local: BookNote | undefined,
  localId: string,
): BookNote | null => {
  if (!item || typeof item !== 'object') throw new Error('Invalid GrimmLink metadata note');
  const record = item as Record<string, unknown>;
  const payload = record['payload'] && typeof record['payload'] === 'object'
    ? record['payload'] as Record<string, unknown> : record;
  const type = payload['type'] ?? record['type'];
  if (type !== 'annotation' && type !== 'bookmark') throw new Error('Invalid GrimmLink metadata note');
  const updatedAt = timestamp(payload['updatedAt'] ?? record['updatedAt']);
  if (updatedAt === null) throw new Error('Invalid GrimmLink metadata note');
  if (local && local.updatedAt >= updatedAt) return local;
  if (payload['deleted'] === true || payload['deletedAt']) {
    return local ? { ...local, updatedAt, deletedAt: updatedAt } : null;
  }
  const location = payload['location'] && typeof payload['location'] === 'object'
    ? payload['location'] as Record<string, unknown> : {};
  const cfi = typeof location['cfi'] === 'string' ? location['cfi'] : '';
  const page = typeof location['pageno'] === 'number' ? location['pageno'] :
    typeof payload['page'] === 'number' ? payload['page'] : undefined;
  return {
    id: localId, type, cfi,
    xpointer0: typeof location['pos0'] === 'string' ? location['pos0'] : undefined,
    xpointer1: typeof location['pos1'] === 'string' ? location['pos1'] : undefined,
    text: typeof payload['text'] === 'string' ? payload['text'] : undefined,
    note: typeof payload['note'] === 'string' ? payload['note'] : '',
    style: payload['style'] === 'highlight' || payload['style'] === 'underline' || payload['style'] === 'squiggly' ? payload['style'] : undefined,
    color: typeof payload['color'] === 'string' ? payload['color'] : undefined,
    page, createdAt: timestamp(payload['createdAt']) ?? updatedAt, updatedAt,
  };
};

export const toGrimmLinkRating = (rating: GrimmLinkRating, connectionId: string, bookHash: string) => ({
  dedupeKey: `${connectionId}:${bookHash}:rating:${rating.updatedAt}`,
  value: rating.scale === 5 ? rating.value * 2 : rating.value,
  scale: 10,
  updatedAt: new Date(rating.updatedAt).toISOString(),
});

export const fromGrimmLinkRating = (
  remote: { value: number; scale: number; updatedAt: string },
  local: GrimmLinkRating | null,
): GrimmLinkRating | null => {
  const updatedAt = Date.parse(remote.updatedAt);
  if (!Number.isFinite(updatedAt) || (local && local.updatedAt >= updatedAt)) return local;
  return { value: remote.scale === 10 ? remote.value / 2 : remote.value, scale: 5, updatedAt };
};

export const parseGrimmLinkRating = (item: unknown): GrimmLinkRating => {
  if (!item || typeof item !== 'object') throw new Error('Invalid GrimmLink rating');
  const record = item as Record<string, unknown>;
  if (record['type'] !== undefined && record['type'] !== 'rating') throw new Error('Invalid GrimmLink rating');
  const payload = record['payload'] && typeof record['payload'] === 'object'
    ? record['payload'] as Record<string, unknown>
    : record;
  const value = payload['value'];
  const scale = payload['scale'];
  const updatedAt = payload['updatedAt'];
  if (
    typeof value !== 'number' || !Number.isFinite(value) ||
    (scale !== 5 && scale !== 10) || value < 1 || value > scale ||
    typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))
  ) throw new Error('Invalid GrimmLink rating');
  return { value: scale === 10 ? value / 2 : value, scale: 5, updatedAt: Date.parse(updatedAt) };
};
