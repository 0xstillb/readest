import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type {
  GrimmLinkShelfBook,
  GrimmLinkShelfCleanupPolicy,
  GrimmLinkShelfDownloadPolicy,
  GrimmLinkShelfType,
} from './types';
import {
  repairMalformedEpubOpfNamespace,
  safeShelfFilename,
  validateShelfDownload,
} from './download';
import { GrimmLinkSyncStore } from './GrimmLinkSyncStore';
import { recordGrimmLinkPerformance } from './einkDiagnostics';
import type { ProgressHandler } from '@/utils/transfer';
import { getLocalBookFilename } from '@/utils/book';
import { isTauriAppPlatform } from '../environment';

import {
  type LibraryPresenceIndex,
  type ShelfReconciliation,
  type ShelfSyncPreview,
  addToPresenceIndex,
  buildLibraryPresenceIndex,
  planShelfDeletions,
  planShelfSync,
  reconcileShelfSnapshot,
  removeFromPresenceIndex,
  summarizeShelfReconciliation,
} from '@/services/shelfSync';

type ShelfEntry = {
  bookId: number;
  bookHash: string;
  localPath: string | null;
  managedByGrimmLink: boolean;
};
type ShelfSyncStage = 'downloading' | 'importing';
type ShelfSyncTransfer = {
  onProgress?: ProgressHandler;
  onStage?: (event: { stage: ShelfSyncStage; book: GrimmLinkShelfBook }) => void;
  signal?: AbortSignal;
};

type ShelfSyncAppService = Pick<
  AppService,
  | 'createDir'
  | 'writeFile'
  | 'resolveFilePath'
  | 'exists'
  | 'deleteFile'
  | 'importBook'
  | 'deleteBook'
>;

export type GrimmLinkLibraryPresenceIndex = LibraryPresenceIndex;

export const buildGrimmLinkLibraryPresenceIndex = async (
  library: Book[],
  appService: Pick<AppService, 'exists'>,
): Promise<GrimmLinkLibraryPresenceIndex> => {
  return buildLibraryPresenceIndex(library, appService, () => {
    recordGrimmLinkPerformance('shelfFileChecks');
  });
};

type ShelfEntryWrite = {
  shelfType: string;
  shelfId: number;
  bookId: number;
  bookHash: string;
  localPath: string | null;
  managedByGrimmLink: boolean;
};

const markShelfEntries = async (store: GrimmLinkSyncStore, entries: ShelfEntryWrite[]) => {
  const batchStore = store as GrimmLinkSyncStore & {
    markShelfEntries?: (entries: ShelfEntryWrite[]) => Promise<void>;
  };
  if (batchStore.markShelfEntries) return batchStore.markShelfEntries(entries);
  for (const entry of entries)
    await store.markShelfEntry(
      entry.shelfType,
      entry.shelfId,
      entry.bookId,
      entry.bookHash,
      entry.localPath,
      entry.managedByGrimmLink,
    );
};

const removeShelfEntries = async (
  store: GrimmLinkSyncStore,
  entries: { shelfType: string; shelfId: number; bookId: number }[],
) => {
  const batchStore = store as GrimmLinkSyncStore & {
    removeShelfEntries?: (
      entries: { shelfType: string; shelfId: number; bookId: number }[],
    ) => Promise<void>;
  };
  if (batchStore.removeShelfEntries) return batchStore.removeShelfEntries(entries);
  for (const entry of entries)
    await store.removeShelfEntry(entry.shelfType, entry.shelfId, entry.bookId);
};

const NATIVE_IMPORT_THRESHOLD_BYTES = 8 * 1024 * 1024;

export interface GrimmLinkShelfSyncResult {
  reused: number;
  downloaded: number;
  removed: number;
}

export type GrimmLinkShelfReconciliation = ShelfReconciliation<GrimmLinkShelfBook, ShelfEntry>;

export type GrimmLinkShelfPreview = ShelfSyncPreview;

export { planShelfSync, reconcileShelfSnapshot, summarizeShelfReconciliation };

type ShelfClient = {
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

export class GrimmLinkShelfProvider {
  constructor(
    private readonly client: ShelfClient,
    private readonly store: GrimmLinkSyncStore,
  ) {}

  async sync(
    type: GrimmLinkShelfType,
    shelfId: number,
    library: Book[],
    onImported: (book: Book, library: Book[]) => Promise<void> | void,
    appService: ShelfSyncAppService,
    transfer?: ShelfSyncTransfer,
    onRemoved?: (book: Book, library: Book[]) => Promise<void> | void,
    cleanupPolicy: GrimmLinkShelfCleanupPolicy = 'keep_local',
    downloadPolicy: GrimmLinkShelfDownloadPolicy = 'always',
    presenceIndex?: GrimmLinkLibraryPresenceIndex,
  ): Promise<GrimmLinkShelfSyncResult> {
    const remote = await this.client.getShelfBooks(type, shelfId);
    const existing = await this.store.getShelfEntries(type, shelfId);
    const localLibrary = [...library];
    // A normal Readest delete retains a tombstone so other storage providers
    // can process it safely.  GrimmLink is download-only, though: its shelf
    // must treat that tombstone (and any stale shelf path) as absent so Sync
    // restores the book from Grimmory without ever requesting a remote delete.
    const presentBooks = presenceIndex
      ? [...presenceIndex.booksByHash.values()]
      : (
          await Promise.all(
            localLibrary
              .filter((book) => !book.deletedAt)
              .map(async (book) => ({
                book,
                present: await appService.exists(getLocalBookFilename(book), 'Books'),
              })),
          )
        )
          .filter(({ present }) => present)
          .map(({ book }) => book);
    const plan = planShelfSync(
      remote,
      existing,
      new Set(presentBooks.map((book) => book.hash)),
      new Set(presentBooks.map(getLocalBookFilename)),
    );
    const reconciliation = reconcileShelfSnapshot(
      remote,
      existing,
      new Set(presentBooks.map((book) => book.hash)),
      new Set(presentBooks.map(getLocalBookFilename)),
    );
    await markShelfEntries(
      this.store,
      plan.reuse.map((bookId) => {
        const remoteBook = remote.find((book) => book.bookId === bookId)!;
        const tracked = existing.find(
          (entry) => entry.bookId === bookId && entry.bookHash === remoteBook.bookHash,
        );
        return {
          shelfType: type,
          shelfId,
          bookId,
          bookHash: remoteBook.bookHash,
          localPath: tracked?.localPath ?? null,
          managedByGrimmLink: tracked?.managedByGrimmLink ?? false,
        };
      }),
    );
    const needsDownload = [
      ...reconciliation.added,
      ...reconciliation.changed.map((item) => item.next),
    ];
    const downloadsBlocked =
      downloadPolicy === 'off' || (downloadPolicy === 'wifi_only' && isMeteredConnection());
    if (!downloadsBlocked) {
      // Deliberately serial: one import at a time bounds memory and prevents
      // duplicate records on Android/WebView readers.
      for (const remoteBook of needsDownload) {
        await this.downloadAndImport(
          type,
          shelfId,
          remoteBook,
          localLibrary,
          onImported,
          appService,
          transfer,
          presenceIndex,
        );
      }
    } else {
      // Persist a remote-only membership so a later policy change can retry
      // it, while keeping localPath null so cleanup can never delete a file.
      await markShelfEntries(
        this.store,
        needsDownload.map((remoteBook) => ({
          shelfType: type,
          shelfId,
          bookId: remoteBook.bookId,
          bookHash: remoteBook.bookHash,
          localPath: null,
          managedByGrimmLink: false,
        })),
      );
    }
    let removed = 0;
    const referenceCounts = new Map<string, number>();
    if (cleanupPolicy === 'remove_managed_copy') {
      const paths = plan.absent.flatMap((entry) => (entry.localPath ? [entry.localPath] : []));
      const batchStore = this.store as GrimmLinkSyncStore & {
        getManagedShelfReferenceCounts?: (localPaths: string[]) => Promise<Map<string, number>>;
      };
      if (batchStore.getManagedShelfReferenceCounts) {
        for (const [path, count] of await batchStore.getManagedShelfReferenceCounts(paths))
          referenceCounts.set(path, count);
      } else {
        for (const path of paths)
          referenceCounts.set(path, (await this.store.getManagedShelfEntryReferences?.(path)) ?? 1);
      }
    }
    const deletionPlan = planShelfDeletions({
      absentEntries: plan.absent.map((entry) => ({
        ...entry,
        managedByProvider: entry.managedByGrimmLink,
      })),
      cleanupPolicy,
      library: localLibrary,
      referenceCounts,
      snapshotComplete: true,
    });
    for (const item of deletionPlan.toDelete) {
      if (item.book) {
        const bookIndex = localLibrary.findIndex((book) => book.hash === item.book!.hash);
        await appService.deleteBook(item.book, 'purge');
        if (bookIndex >= 0) localLibrary.splice(bookIndex, 1);
        if (presenceIndex) removeFromPresenceIndex(presenceIndex, item.book);
        await onRemoved?.(item.book, [...localLibrary]);
        removed += 1;
      } else if (await appService.exists(item.localPath, 'Books')) {
        await appService.deleteFile(item.localPath, 'Books');
        removed += 1;
      }
    }
    await removeShelfEntries(
      this.store,
      plan.absent.map((entry) => ({ shelfType: type, shelfId, bookId: entry.bookId })),
    );
    return {
      reused: reconciliation.unchanged.length,
      downloaded: downloadsBlocked ? 0 : needsDownload.length,
      removed,
    };
  }

  private async downloadAndImport(
    type: GrimmLinkShelfType,
    shelfId: number,
    remote: GrimmLinkShelfBook,
    library: Book[],
    onImported: (book: Book, library: Book[]) => Promise<void> | void,
    appService: ShelfSyncAppService,
    transfer?: ShelfSyncTransfer,
    presenceIndex?: GrimmLinkLibraryPresenceIndex,
  ): Promise<void> {
    transfer?.onStage?.({ stage: 'downloading', book: remote });

    // On native builds, keep the payload out of the WebView entirely.  The
    // previous path accumulated all response chunks and then created another
    // ArrayBuffer before writing Temp, which is enough to make Android kill the
    // process while importing otherwise ordinary 15–50 MB books.
    if (isTauriAppPlatform() && this.client.downloadShelfBookToFile) {
      const tempPath = `grimmlink/${safeShelfFilename(remote.filename, remote.bookId)}`;
      try {
        await appService.createDir('grimmlink', 'Temp', true);
        if (await appService.exists(tempPath, 'Temp')) {
          await appService.deleteFile(tempPath, 'Temp');
        }
        let nativePath: string;
        try {
          nativePath = await appService.resolveFilePath(tempPath, 'Temp');
        } catch {
          nativePath = '';
        }
        if (nativePath) {
          await this.client.downloadShelfBookToFile(
            remote.bookId,
            nativePath,
            transfer?.onProgress,
            transfer?.signal,
          );
          transfer?.onStage?.({ stage: 'importing', book: remote });
          const imported = await appService.importBook(nativePath, library);
          if (!imported) throw new Error('Failed to import GrimmLink shelf book');
          const existingIndex = library.findIndex((book) => book.hash === imported.hash);
          if (existingIndex === -1) library.push(imported);
          else library[existingIndex] = imported;
          await onImported(imported, [...library]);
          await this.store.markShelfEntry(
            type,
            shelfId,
            remote.bookId,
            remote.bookHash,
            getLocalBookFilename(imported),
            true,
          );
          if (presenceIndex) addToPresenceIndex(presenceIndex, imported);
          return;
        }
      } finally {
        await appService.deleteFile(tempPath, 'Temp').catch(() => {});
      }
    }

    const downloaded = await this.client.downloadShelfBook(
      remote.bookId,
      transfer?.onProgress,
      transfer?.signal,
    );
    const data = remote.filename.toLowerCase().endsWith('.epub')
      ? await repairMalformedEpubOpfNamespace(downloaded)
      : downloaded;
    validateShelfDownload(remote.filename, data, remote.size);
    transfer?.onStage?.({ stage: 'importing', book: remote });
    const useNativeImport = data.byteLength >= NATIVE_IMPORT_THRESHOLD_BYTES;
    const tempPath = `grimmlink/${safeShelfFilename(remote.filename, remote.bookId)}`;
    let importSource: string | File = new File([data], remote.filename);
    try {
      if (useNativeImport) {
        // Large files are safer through the native filesystem path. EPUBs can
        // use the Rust metadata bridge and PDFs avoid ferrying a large Blob into
        // the WebView parser over the Android bridge.
        await appService.createDir('grimmlink', 'Temp', true);
        if (await appService.exists(tempPath, 'Temp')) {
          await appService.deleteFile(tempPath, 'Temp');
        }
        await appService.writeFile(tempPath, 'Temp', importSource);
        try {
          importSource = await appService.resolveFilePath(tempPath, 'Temp');
        } catch {
          // Keep the File path as a safe fallback on platforms without path
          // resolution support (web/test doubles).
        }
      }
      const imported = await appService.importBook(importSource, library);
      if (!imported) throw new Error('Failed to import GrimmLink shelf book');
      const existingIndex = library.findIndex((book) => book.hash === imported.hash);
      if (existingIndex === -1) library.push(imported);
      else library[existingIndex] = imported;
      await onImported(imported, [...library]);
      if (presenceIndex) addToPresenceIndex(presenceIndex, imported);
      await this.store.markShelfEntry(
        type,
        shelfId,
        remote.bookId,
        remote.bookHash,
        getLocalBookFilename(imported),
        true,
      );
    } finally {
      if (useNativeImport) await appService.deleteFile(tempPath, 'Temp').catch(() => {});
    }
  }
}

export async function syncSubscribedGrimmLinkShelves(
  client: ShelfClient,
  store: GrimmLinkSyncStore,
  getLibrary: () => Book[],
  onImported: (book: Book, library: Book[]) => Promise<void> | void,
  appService: ShelfSyncAppService,
  transfer?: ShelfSyncTransfer,
  onRemoved?: (book: Book, library: Book[]) => Promise<void> | void,
): Promise<GrimmLinkShelfSyncResult> {
  const key = `${store.connectionId}`;
  const active = activeShelfSyncs.get(key);
  if (active) return active;
  const startedAt = Date.now();
  const run = syncSubscribedGrimmLinkShelvesInternal(
    client,
    store,
    getLibrary,
    onImported,
    appService,
    transfer,
    onRemoved,
  );
  activeShelfSyncs.set(key, run);
  try {
    return await run;
  } finally {
    recordGrimmLinkPerformance('shelfSyncDurationMs', Date.now() - startedAt);
    if (activeShelfSyncs.get(key) === run) activeShelfSyncs.delete(key);
  }
}

const isMeteredConnection = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean; type?: string } }
  ).connection;
  return connection?.saveData === true || connection?.type === 'cellular';
};

const activeShelfSyncs = new Map<string, Promise<GrimmLinkShelfSyncResult>>();

async function syncSubscribedGrimmLinkShelvesInternal(
  client: ShelfClient,
  store: GrimmLinkSyncStore,
  getLibrary: () => Book[],
  onImported: (book: Book, library: Book[]) => Promise<void> | void,
  appService: ShelfSyncAppService,
  transfer?: ShelfSyncTransfer,
  onRemoved?: (book: Book, library: Book[]) => Promise<void> | void,
): Promise<GrimmLinkShelfSyncResult> {
  const subscriptions = await store.getShelfSubscriptions();
  let reused = 0;
  let downloaded = 0;
  let removed = 0;
  const presenceIndex = await buildGrimmLinkLibraryPresenceIndex(getLibrary(), appService);
  for (const subscription of subscriptions) {
    if (subscription.shelfType !== 'regular' && subscription.shelfType !== 'magic') continue;
    const result = await new GrimmLinkShelfProvider(client, store).sync(
      subscription.shelfType,
      subscription.shelfId,
      getLibrary(),
      onImported,
      appService,
      transfer,
      onRemoved,
      subscription.cleanupPolicy as GrimmLinkShelfCleanupPolicy,
      subscription.downloadPolicy as GrimmLinkShelfDownloadPolicy,
      presenceIndex,
    );
    reused += result.reused;
    downloaded += result.downloaded;
    removed += result.removed;
  }
  return { reused, downloaded, removed };
}
