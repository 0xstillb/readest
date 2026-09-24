import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { ProgressHandler } from '@/utils/transfer';
import type {
  GrimmLinkShelfBook,
  GrimmLinkShelfCleanupPolicy,
  GrimmLinkShelfDownloadPolicy,
  GrimmLinkShelfType,
} from './types';
import { repairMalformedEpubOpfNamespace } from './download';
import type { GrimmLinkSyncStore } from './GrimmLinkSyncStore';
import { recordGrimmLinkPerformance } from './einkDiagnostics';
import {
  type IShelfSyncStore,
  type LibraryPresenceIndex,
  type ShelfReconciliation,
  type ShelfSyncAdapter,
  type ShelfSyncAppService,
  type ShelfSyncEntry,
  type ShelfSyncPreview,
  type ShelfSyncResult,
  type ShelfSyncTransfer,
  buildLibraryPresenceIndex,
  migrateGrimmLinkShelfState,
  planShelfSync,
  reconcileShelfSnapshot,
  ShelfSyncEngine,
  ShelfSyncStore,
  summarizeShelfReconciliation,
  wrapLegacyShelfStore,
} from '@/services/shelfSync';

export type GrimmLinkLibraryPresenceIndex = LibraryPresenceIndex;

export const buildGrimmLinkLibraryPresenceIndex = async (
  library: Book[],
  appService: Pick<AppService, 'exists'>,
): Promise<GrimmLinkLibraryPresenceIndex> => {
  return buildLibraryPresenceIndex(library, appService, () => {
    recordGrimmLinkPerformance('shelfFileChecks');
  });
};

export type GrimmLinkShelfSyncResult = ShelfSyncResult;
export type GrimmLinkShelfReconciliation = ShelfReconciliation<
  GrimmLinkShelfBook,
  ShelfSyncEntry<number>
>;
export type GrimmLinkShelfPreview = ShelfSyncPreview;

export { planShelfSync, reconcileShelfSnapshot, summarizeShelfReconciliation };

export type ShelfClient = {
  getShelfBooks(type: GrimmLinkShelfType, shelfId: number): Promise<GrimmLinkShelfBook[]>;
  downloadShelfBook(
    bookId: number,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer>;
  downloadShelfBookToFile?: (
    bookId: number,
    filePath: string,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
  ) => Promise<void>;
};

/**
 * Adapter bridging GrimmLink client transport and listing to the generic ShelfSyncEngine.
 */
export class GrimmLinkShelfAdapter implements ShelfSyncAdapter<number, GrimmLinkShelfBook> {
  readonly provider = 'grimmlink';
  readonly connectionId: string;
  readonly tempFolder = 'grimmlink';
  readonly importErrorMessage = 'Failed to import GrimmLink shelf book';

  constructor(
    private readonly client: ShelfClient,
    connectionId = 'default',
  ) {
    this.connectionId = connectionId;
  }

  async getShelfBooks(shelfType: string, shelfId: number): Promise<GrimmLinkShelfBook[]> {
    return this.client.getShelfBooks(shelfType as GrimmLinkShelfType, Number(shelfId));
  }

  async downloadBook(
    book: GrimmLinkShelfBook,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    return this.client.downloadShelfBook(book.bookId, onProgress, signal);
  }

  get downloadBookToFile() {
    return this.client.downloadShelfBookToFile
      ? (
          book: GrimmLinkShelfBook,
          filePath: string,
          onProgress?: ProgressHandler,
          signal?: AbortSignal,
        ) => this.client.downloadShelfBookToFile!(book.bookId, filePath, onProgress, signal)
      : undefined;
  }

  async repairBookData(data: ArrayBuffer, book: GrimmLinkShelfBook): Promise<ArrayBuffer> {
    if (book.filename.toLowerCase().endsWith('.epub')) {
      return repairMalformedEpubOpfNamespace(data);
    }
    return data;
  }

  onPerformanceMetric(metric: string, value?: number): void {
    recordGrimmLinkPerformance(metric as Parameters<typeof recordGrimmLinkPerformance>[0], value);
  }
}

/**
 * GrimmLink shelf sync provider delegating to the generic ShelfSyncEngine.
 */
export class GrimmLinkShelfProvider {
  constructor(
    private readonly client: ShelfClient,
    private readonly store: GrimmLinkSyncStore | IShelfSyncStore,
  ) {}

  async sync(
    type: GrimmLinkShelfType,
    shelfId: number,
    library: Book[],
    onImported: (book: Book, library: Book[]) => Promise<void> | void,
    appService: ShelfSyncAppService,
    transfer?: ShelfSyncTransfer<GrimmLinkShelfBook>,
    onRemoved?: (book: Book, library: Book[]) => Promise<void> | void,
    cleanupPolicy: GrimmLinkShelfCleanupPolicy = 'keep_local',
    downloadPolicy: GrimmLinkShelfDownloadPolicy = 'always',
    presenceIndex?: GrimmLinkLibraryPresenceIndex,
  ): Promise<GrimmLinkShelfSyncResult> {
    const connectionId =
      'connectionId' in this.store && typeof this.store.connectionId === 'string'
        ? this.store.connectionId
        : 'default';

    let genericStore: IShelfSyncStore;
    if (this.store instanceof ShelfSyncStore) {
      genericStore = this.store;
    } else if (appService && 'openDatabase' in appService) {
      const concreteStore = new ShelfSyncStore(appService as AppService, 'grimmlink', connectionId);
      await migrateGrimmLinkShelfState(appService as AppService, connectionId, concreteStore).catch(
        () => {},
      );
      genericStore = concreteStore;
    } else {
      genericStore = wrapLegacyShelfStore(this.store, 'grimmlink', connectionId);
    }

    const adapter = new GrimmLinkShelfAdapter(this.client, connectionId);
    const engine = new ShelfSyncEngine(adapter, appService, genericStore);
    return engine.sync({
      shelfType: type,
      shelfId,
      library,
      onImported,
      onRemoved,
      transfer,
      cleanupPolicy,
      downloadPolicy,
      presenceIndex,
    });
  }
}

export async function syncSubscribedGrimmLinkShelves(
  client: ShelfClient,
  store: GrimmLinkSyncStore | IShelfSyncStore,
  getLibrary: () => Book[],
  onImported: (book: Book, library: Book[]) => Promise<void> | void,
  appService: ShelfSyncAppService,
  transfer?: ShelfSyncTransfer<GrimmLinkShelfBook>,
  onRemoved?: (book: Book, library: Book[]) => Promise<void> | void,
): Promise<GrimmLinkShelfSyncResult> {
  const connectionId =
    'connectionId' in store && typeof store.connectionId === 'string'
      ? store.connectionId
      : 'default';

  let genericStore: IShelfSyncStore;
  if (store instanceof ShelfSyncStore) {
    genericStore = store;
  } else if (appService && 'openDatabase' in appService) {
    const concreteStore = new ShelfSyncStore(appService as AppService, 'grimmlink', connectionId);
    await migrateGrimmLinkShelfState(appService as AppService, connectionId, concreteStore).catch(
      () => {},
    );
    genericStore = concreteStore;
  } else {
    genericStore = wrapLegacyShelfStore(store, 'grimmlink', connectionId);
  }

  const adapter = new GrimmLinkShelfAdapter(client, connectionId);
  const engine = new ShelfSyncEngine(adapter, appService, genericStore);
  return engine.syncSubscribed({
    getLibrary,
    onImported,
    onRemoved,
    transfer,
    filterSubscription: (sub) => sub.shelfType === 'regular' || sub.shelfType === 'magic',
  });
}
