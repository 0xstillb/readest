import type { Book, ReadingStatus } from '@/types/book';
import type { GrimmLinkSettings } from '@/types/settings';
import { getLocalBookFilename } from '@/utils/book';
import { hasGrimmLinkCapability } from './capabilities';
import { GrimmLinkClient } from './GrimmLinkClient';
import { GrimmLinkSyncStore } from './GrimmLinkSyncStore';
import { GrimmLinkOutbox } from './outbox';
import { GrimmLinkReplayScheduler } from './replayScheduler';
import { mapReadStatus, mergeRemoteReadStatus } from './status';
import type { GrimmLinkBookLink } from './types';

type StatusClient = {
  getReadStatuses(): Promise<{ statuses: string[] }>;
  getBookMetadata?(bookId: number): Promise<Record<string, unknown>>;
};

export class GrimmLinkReadStatusProvider {
  private statuses: string[] | null = null;

  constructor(
    private readonly client: StatusClient,
    private readonly store: GrimmLinkSyncStore,
    private readonly capabilities: string[],
  ) {}

  private async available(): Promise<string[]> {
    if (!hasGrimmLinkCapability(this.capabilities, 'read-status')) return [];
    this.statuses ??= (await this.client.getReadStatuses()).statuses;
    return this.statuses;
  }

  async queueExplicit(bookHash: string, bookId: number, status: ReadingStatus): Promise<boolean> {
    const mapped = mapReadStatus(status, await this.available());
    if (!mapped) return false;
    await this.store.enqueueStatus(bookHash, bookId, mapped);
    return true;
  }

  async mergeRemote<T extends { readingStatus?: ReadingStatus; readingStatusUpdatedAt?: number }>(
    local: T,
    remote: { status?: string; updatedAt?: string },
  ): Promise<T> {
    return { ...local, ...mergeRemoteReadStatus(local, remote, await this.available()) };
  }

  async pullRemote<T extends { readingStatus?: ReadingStatus; readingStatusUpdatedAt?: number }>(
    bookId: number,
    local: T,
    getLatestLocal?: () => T,
  ): Promise<T> {
    if (!this.client.getBookMetadata || !hasGrimmLinkCapability(this.capabilities, 'read-status'))
      return getLatestLocal?.() ?? local;
    const metadata = await this.client.getBookMetadata(bookId);
    const nested =
      metadata['readStatus'] && typeof metadata['readStatus'] === 'object'
        ? (metadata['readStatus'] as Record<string, unknown>)
        : null;
    const status =
      typeof metadata['readStatus'] === 'string'
        ? metadata['readStatus']
        : typeof nested?.['status'] === 'string'
          ? nested['status']
          : undefined;
    const updatedAt =
      typeof metadata['readStatusModifiedTime'] === 'string'
        ? metadata['readStatusModifiedTime']
        : typeof nested?.['updatedAt'] === 'string'
          ? nested['updatedAt']
          : undefined;
    // Resolve the local snapshot after the network wait so a delayed response
    // cannot overwrite a newer status or unrelated book fields.
    const latestLocal = getLatestLocal?.() ?? local;
    const available = await this.available();
    const merged = mergeRemoteReadStatus(latestLocal, { status, updatedAt }, available);
    return { ...latestLocal, ...merged };
  }
}

type ReadStatusSyncClient = Pick<
  GrimmLinkClient,
  'getCapabilities' | 'getReadStatuses' | 'getBookMetadata' | 'matchBook' | 'updateReadStatus'
>;

const replaySchedulers = new WeakMap<
  object,
  { client: object; scheduler: GrimmLinkReplayScheduler }
>();

const schedulerFor = (store: GrimmLinkSyncStore, client: ReadStatusSyncClient) => {
  const current = replaySchedulers.get(store);
  if (current?.client === client) return current.scheduler;
  const scheduler = new GrimmLinkReplayScheduler(new GrimmLinkOutbox(store, client));
  replaySchedulers.set(store, { client, scheduler });
  return scheduler;
};

/**
 * Queues an explicit local status change for Grimmory. Shelf imports use their
 * persisted local-path mapping first because Readest's content hash can differ
 * from the Grimmory hash. No status is sent in receive-only mode or when the
 * user clears a status (the v1 API has no safe unset operation).
 */
export const queueExplicitGrimmLinkReadStatus = async (
  book: Book,
  status: ReadingStatus | undefined,
  config: Pick<GrimmLinkSettings, 'enabled' | 'syncReadStatus' | 'strategy'>,
  store: GrimmLinkSyncStore,
  client: ReadStatusSyncClient,
): Promise<boolean> => {
  if (!config.enabled || !config.syncReadStatus || config.strategy === 'receive' || !status)
    return false;

  const shelfEntry = await store.getShelfEntryByLocalPath(getLocalBookFilename(book));
  const link: Pick<GrimmLinkBookLink, 'bookId'> | null =
    shelfEntry ?? (await client.matchBook(book.hash));
  if (!link) return false;

  const { capabilities } = await client.getCapabilities();
  const provider = new GrimmLinkReadStatusProvider(
    client,
    store,
    Array.isArray(capabilities) ? capabilities : [],
  );
  const queued = await provider.queueExplicit(book.hash, link.bookId, status);
  if (queued) {
    void schedulerFor(store, client)
      .requestReplay()
      .catch((error) => {
        console.warn('[GrimmLink] failed to replay reading status queue', error);
      });
  }
  return queued;
};
