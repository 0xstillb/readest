import type { Book } from '@/types/book';
import type {
  IShelfSyncStore,
  ShelfSyncAppService,
  ShelfSyncPreview,
  ShelfSyncResult,
  ShelfSyncTransfer,
} from '@/services/shelfSync';
import {
  buildLibraryPresenceIndex,
  planShelfSync,
  reconcileShelfSnapshot,
  ShelfSyncEngine,
  summarizeShelfReconciliation,
} from '@/services/shelfSync';
import { getLocalBookFilename } from '@/utils/book';
import {
  type BookOrbitDownloadConfig,
  type BookOrbitShelfBook,
  BookOrbitShelfAdapter,
} from './shelfDownload';
import type {
  BookOrbitShelf,
  BookOrbitShelfCleanupPolicy,
  BookOrbitShelfClient,
  BookOrbitShelfDownloadPolicy,
  BookOrbitShelfType,
} from './types';

export {
  buildLibraryPresenceIndex,
  planShelfSync,
  reconcileShelfSnapshot,
  summarizeShelfReconciliation,
};

export type {
  BookOrbitShelf,
  BookOrbitShelfBook,
  BookOrbitShelfCleanupPolicy,
  BookOrbitShelfClient,
  BookOrbitShelfDownloadPolicy,
  BookOrbitShelfType,
};

/**
 * Fetches all available BookOrbit Collections and SmartScopes for display in subscription UI.
 */
export async function fetchBookOrbitShelves(
  client: BookOrbitShelfClient,
  type?: BookOrbitShelfType,
): Promise<BookOrbitShelf[]> {
  if (client.getShelves) {
    return client.getShelves(type);
  }
  const [collections, smartscopes] = await Promise.all([
    client.getCollections ? client.getCollections() : Promise.resolve([]),
    client.getSmartScopes ? client.getSmartScopes() : Promise.resolve([]),
  ]);
  if (type === 'collection') return collections;
  if (type === 'smartscope') return smartscopes;
  return [...collections, ...smartscopes];
}

/**
 * Previews upcoming changes (downloads, updates, removals) for subscribed shelves
 * using generic reconciliation without performing actual writes.
 */
export async function previewBookOrbitShelfSync(
  clientOrAdapter: BookOrbitShelfClient | BookOrbitShelfAdapter,
  store: IShelfSyncStore,
  library: Book[],
  config?: BookOrbitDownloadConfig,
): Promise<ShelfSyncPreview> {
  const connectionId =
    'connectionId' in store && typeof store.connectionId === 'string'
      ? store.connectionId
      : 'default';

  const adapter =
    clientOrAdapter instanceof BookOrbitShelfAdapter
      ? clientOrAdapter
      : new BookOrbitShelfAdapter(
          config ?? { serverUrl: connectionId.split('\u0000')[0] || '' },
          connectionId,
          clientOrAdapter,
        );

  const subscriptions = await store.getShelfSubscriptions({ enabledOnly: true });
  const localHashes = new Set(library.map((b) => b.hash).filter(Boolean) as string[]);
  const localPaths = new Set(library.map(getLocalBookFilename));

  const previews = await Promise.all(
    subscriptions
      .filter(
        (sub) =>
          sub.shelfType === 'collection' ||
          sub.shelfType === 'smartscope' ||
          sub.shelfType === 'smart_scope',
      )
      .map(async (subscription) => {
        try {
          const [remote, existing] = await Promise.all([
            adapter.getShelfBooks(subscription.shelfType, subscription.shelfId),
            store.getShelfEntries(subscription.shelfId, subscription.shelfType),
          ]);
          return summarizeShelfReconciliation(
            reconcileShelfSnapshot(remote, existing, localHashes, localPaths),
            subscription.downloadPolicy,
          );
        } catch {
          return { total: 0, added: 0, unchanged: 0, changed: 0, removed: 0, downloads: 0 };
        }
      }),
  );

  return previews.reduce(
    (total, current) => ({
      total: total.total + current.total,
      added: total.added + current.added,
      unchanged: total.unchanged + current.unchanged,
      changed: total.changed + current.changed,
      removed: total.removed + current.removed,
      downloads: total.downloads + current.downloads,
    }),
    { total: 0, added: 0, unchanged: 0, changed: 0, removed: 0, downloads: 0 },
  );
}

/**
 * Synchronizes all subscribed BookOrbit Collections and SmartScopes using generic ShelfSyncEngine.
 */
export async function syncSubscribedBookOrbitShelves(
  clientOrAdapter: BookOrbitShelfClient | BookOrbitShelfAdapter,
  store: IShelfSyncStore,
  getLibrary: () => Book[],
  onImported: (book: Book, library: Book[]) => Promise<void> | void,
  appService: ShelfSyncAppService,
  transfer?: ShelfSyncTransfer<BookOrbitShelfBook>,
  onRemoved?: (book: Book, library: Book[]) => Promise<void> | void,
  config?: BookOrbitDownloadConfig,
): Promise<ShelfSyncResult> {
  const connectionId =
    'connectionId' in store && typeof store.connectionId === 'string'
      ? store.connectionId
      : 'default';

  const adapter =
    clientOrAdapter instanceof BookOrbitShelfAdapter
      ? clientOrAdapter
      : new BookOrbitShelfAdapter(
          config ?? { serverUrl: connectionId.split('\u0000')[0] || '' },
          connectionId,
          clientOrAdapter,
        );

  const engine = new ShelfSyncEngine(adapter, appService, store);
  return engine.syncSubscribed({
    getLibrary,
    onImported,
    onRemoved,
    transfer,
    filterSubscription: (sub) =>
      sub.shelfType === 'collection' ||
      sub.shelfType === 'smartscope' ||
      sub.shelfType === 'smart_scope',
  });
}
