import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { getLocalBookFilename } from '@/utils/book';
import { isTauriAppPlatform } from '@/services/environment';
import { safeShelfFilename, validateShelfDownload } from './validation';
import {
  NATIVE_IMPORT_THRESHOLD_BYTES,
  isMeteredConnection,
  repairMalformedEpubOpfNamespace,
} from './download';
import { addToPresenceIndex, buildLibraryPresenceIndex, removeFromPresenceIndex } from './presence';
import {
  planShelfSync,
  reconcileShelfSnapshot,
  summarizeShelfReconciliation,
} from './reconciliation';
import { planShelfDeletions } from './deletion';
import type {
  IShelfSyncStore,
  LibraryPresenceIndex,
  ShelfDownloadPolicy,
  ShelfSubscribedSyncOptions,
  ShelfSyncAdapter,
  ShelfSyncAppService,
  ShelfSyncBook,
  ShelfSyncPreview,
  ShelfSyncResult,
  ShelfSyncRunOptions,
  ShelfSyncTransfer,
} from './types';
import { ShelfSyncStore } from './ShelfSyncStore';

export type { IShelfSyncStore };

/**
 * Generic shelf synchronization engine.
 *
 * Responsibilities:
 * - Owns subscriptions, presence indexing, reconciliation, reuse, download/import orchestration.
 * - Enforces policies: off / wifi_only / always, keep_local / remove_managed_copy.
 * - Managed bookkeeping, reference-safe cleanup, cancellation, summary/progress.
 * - Bounds memory with serial import, native direct download, and temp file cleanup.
 */
export class ShelfSyncEngine<
  TId extends string | number = string | number,
  TBook extends ShelfSyncBook<TId> = ShelfSyncBook<TId>,
> {
  private static readonly activeSyncs = new Map<string, Promise<ShelfSyncResult>>();

  readonly adapter: ShelfSyncAdapter<TId, TBook>;
  readonly appService: ShelfSyncAppService;
  readonly store: IShelfSyncStore;

  constructor(
    adapter: ShelfSyncAdapter<TId, TBook>,
    appService: ShelfSyncAppService,
    store?: IShelfSyncStore,
  ) {
    this.adapter = adapter;
    this.appService = appService;
    this.store =
      store ?? new ShelfSyncStore(appService as AppService, adapter.provider, adapter.connectionId);
  }

  /**
   * Sync a single shelf snapshot against local presence and tracked entries.
   */
  async sync(options: ShelfSyncRunOptions<TId, TBook>): Promise<ShelfSyncResult> {
    const { shelfType, shelfId } = options;

    // 1. Fetch remote snapshot (if this fails, abort safely before touching any local state)
    const remote = await this.adapter.getShelfBooks(shelfType, shelfId);

    // 2. Fetch existing tracked entries
    const existing = await this.store.getShelfEntries(shelfId, shelfType);

    // 3. Resolve local library presence
    const localLibrary = [...options.library];
    const presentBooks = options.presenceIndex
      ? [...options.presenceIndex.booksByPath.values()]
      : (
          await Promise.all(
            localLibrary
              .filter((book) => !book.deletedAt)
              .map(async (book) => ({
                book,
                present: await this.appService.exists(getLocalBookFilename(book), 'Books'),
              })),
          )
        )
          .filter(({ present }) => present)
          .map(({ book }) => book);

    const localHashes = options.presenceIndex
      ? options.presenceIndex.hashes
      : new Set(presentBooks.map((b) => b.hash).filter(Boolean) as string[]);
    const localPaths = options.presenceIndex
      ? options.presenceIndex.paths
      : new Set(presentBooks.map(getLocalBookFilename));

    // 4. Plan and reconcile
    const plan = planShelfSync(remote, existing, localHashes, localPaths);
    const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);

    // 5. Record reused entries
    await this.store.markShelfEntries(
      plan.reuse.map((bookId) => {
        const remoteBook = remote.find((book) => book.bookId === bookId)!;
        const tracked = existing.find((entry) => entry.bookId === String(bookId));

        const localBook = remoteBook.bookHash
          ? (options.presenceIndex?.booksByHash.get(remoteBook.bookHash) ??
            presentBooks.find((book) => book.hash === remoteBook.bookHash))
          : tracked?.localPath
            ? (options.presenceIndex?.booksByPath.get(tracked.localPath) ??
              presentBooks.find((book) => getLocalBookFilename(book) === tracked.localPath))
            : undefined;

        let resolvedLocalPath: string | null = null;
        let managedByProvider = false;

        if (localBook) {
          resolvedLocalPath = getLocalBookFilename(localBook);
          const isSamePath = tracked?.localPath === resolvedLocalPath;
          const isSameHash = (tracked?.bookHash ?? null) === (remoteBook.bookHash ?? null);
          managedByProvider = !!tracked?.managedByProvider && isSamePath && isSameHash;
        } else if (tracked?.localPath && localPaths.has(tracked.localPath)) {
          resolvedLocalPath = tracked.localPath;
          const isSameHash = (tracked?.bookHash ?? null) === (remoteBook.bookHash ?? null);
          managedByProvider = !!tracked.managedByProvider && isSameHash;
        }

        return {
          provider: this.adapter.provider,
          connectionId: this.adapter.connectionId,
          shelfType,
          shelfId: String(shelfId),
          bookId: String(bookId),
          fileId: remoteBook.fileId != null ? String(remoteBook.fileId) : (tracked?.fileId ?? null),
          contentVersion:
            remoteBook.contentVersion != null
              ? String(remoteBook.contentVersion)
              : (tracked?.contentVersion ?? null),
          bookHash: remoteBook.bookHash,
          localPath: resolvedLocalPath,
          managedByProvider,
        };
      }),
    );

    // 6. Handle downloads according to policy
    const needsDownload = [
      ...reconciliation.added,
      ...reconciliation.changed.map((item) => item.next),
    ];
    const downloadPolicy = options.downloadPolicy ?? 'always';
    const downloadsBlocked =
      downloadPolicy === 'off' || (downloadPolicy === 'wifi_only' && isMeteredConnection());

    if (!downloadsBlocked) {
      // Deliberately serial: one import at a time bounds memory and prevents
      // duplicate records on Android/WebView readers.
      for (const remoteBook of needsDownload) {
        if (options.transfer?.signal?.aborted) {
          throw new Error('Shelf sync cancelled');
        }
        await this.downloadAndImport({
          shelfType,
          shelfId,
          remoteBook,
          library: localLibrary,
          onImported: options.onImported,
          transfer: options.transfer,
          presenceIndex: options.presenceIndex,
        });
      }
    } else {
      // Persist remote-only membership so a later policy change can retry it,
      // while keeping localPath null so cleanup can never delete a file.
      await this.store.markShelfEntries(
        needsDownload.map((remoteBook) => ({
          provider: this.adapter.provider,
          connectionId: this.adapter.connectionId,
          shelfType,
          shelfId: String(shelfId),
          bookId: String(remoteBook.bookId),
          fileId: remoteBook.fileId != null ? String(remoteBook.fileId) : null,
          contentVersion:
            remoteBook.contentVersion != null ? String(remoteBook.contentVersion) : null,
          bookHash: remoteBook.bookHash,
          localPath: null,
          managedByProvider: false,
        })),
      );
    }

    // 7. Plan and execute reference-safe deletions
    let removed = 0;
    const cleanupPolicy = options.cleanupPolicy ?? 'keep_local';
    const referenceCounts = new Map<string, number>();

    if (cleanupPolicy === 'remove_managed_copy') {
      const paths = plan.absent.flatMap((entry) => (entry.localPath ? [entry.localPath] : []));
      if (paths.length > 0) {
        const counts = await this.store.getAllShelfReferenceCounts(paths);
        for (const [path, count] of counts) {
          referenceCounts.set(path, count);
        }
      }
    }

    const deletionPlan = planShelfDeletions({
      absentEntries: plan.absent.map((entry) => ({
        ...entry,
        managedByProvider: entry.managedByProvider ?? false,
      })),
      cleanupPolicy,
      library: localLibrary,
      referenceCounts,
      snapshotComplete: true,
    });

    for (const item of deletionPlan.toDelete) {
      if (item.book) {
        const bookIndex = localLibrary.findIndex((book) => book.hash === item.book!.hash);
        await this.appService.deleteBook(item.book, 'purge');
        if (bookIndex >= 0) localLibrary.splice(bookIndex, 1);
        if (options.presenceIndex) removeFromPresenceIndex(options.presenceIndex, item.book);
        await options.onRemoved?.(item.book, [...localLibrary]);
        removed += 1;
      } else if (item.localPath && (await this.appService.exists(item.localPath, 'Books'))) {
        await this.appService.deleteFile(item.localPath, 'Books');
        removed += 1;
      }
    }

    await this.store.removeShelfEntries(
      plan.absent.map((entry) => ({
        provider: this.adapter.provider,
        connectionId: this.adapter.connectionId,
        shelfType,
        shelfId: String(shelfId),
        bookId: String(entry.bookId),
      })),
    );

    return {
      reused: reconciliation.unchanged.length,
      downloaded: downloadsBlocked ? 0 : needsDownload.length,
      removed,
    };
  }

  /**
   * Sync all subscribed shelves for this provider and connection.
   * Coalesces concurrent invocations per connection.
   */
  async syncSubscribed(options: ShelfSubscribedSyncOptions<TId, TBook>): Promise<ShelfSyncResult> {
    const key = `${this.adapter.provider}:${this.adapter.connectionId}`;
    const active = ShelfSyncEngine.activeSyncs.get(key);
    if (active) return active;

    const startedAt = Date.now();
    const run = this.syncSubscribedInternal(options);
    ShelfSyncEngine.activeSyncs.set(key, run);
    try {
      return await run;
    } finally {
      this.adapter.onPerformanceMetric?.('shelfSyncDurationMs', Date.now() - startedAt);
      if (ShelfSyncEngine.activeSyncs.get(key) === run) {
        ShelfSyncEngine.activeSyncs.delete(key);
      }
    }
  }

  private async syncSubscribedInternal(
    options: ShelfSubscribedSyncOptions<TId, TBook>,
  ): Promise<ShelfSyncResult> {
    const subscriptions = await this.store.getShelfSubscriptions({
      enabledOnly: true,
    });
    let reused = 0;
    let downloaded = 0;
    let removed = 0;
    const library = options.getLibrary();
    const presenceIndex = await buildLibraryPresenceIndex(library, this.appService, () => {
      this.adapter.onPerformanceMetric?.('shelfFileChecks');
    });

    for (const subscription of subscriptions) {
      if (options.filterSubscription && !options.filterSubscription(subscription)) {
        continue;
      }
      const result = await this.sync({
        shelfType: subscription.shelfType,
        shelfId: subscription.shelfId as unknown as TId,
        library: options.getLibrary(),
        onImported: options.onImported,
        onRemoved: options.onRemoved,
        transfer: options.transfer,
        cleanupPolicy: subscription.cleanupPolicy,
        downloadPolicy: subscription.downloadPolicy,
        presenceIndex,
      });
      reused += result.reused;
      downloaded += result.downloaded;
      removed += result.removed;
    }

    return { reused, downloaded, removed };
  }

  /**
   * Preview changes for a shelf without executing downloads or deletions.
   */
  async preview(
    shelfType: string,
    shelfId: TId,
    library: Book[],
    downloadPolicy: ShelfDownloadPolicy = 'always',
  ): Promise<ShelfSyncPreview> {
    const [remote, existing] = await Promise.all([
      this.adapter.getShelfBooks(shelfType, shelfId),
      this.store.getShelfEntries(shelfId, shelfType),
    ]);
    const localHashes = new Set(library.map((b) => b.hash));
    const localPaths = new Set(library.map(getLocalBookFilename));
    const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
    return summarizeShelfReconciliation(reconciliation, downloadPolicy);
  }

  private async downloadAndImport({
    shelfType,
    shelfId,
    remoteBook,
    library,
    onImported,
    transfer,
    presenceIndex,
  }: {
    shelfType: string;
    shelfId: TId;
    remoteBook: TBook;
    library: Book[];
    onImported: (book: Book, library: Book[]) => Promise<void> | void;
    transfer?: ShelfSyncTransfer<TBook>;
    presenceIndex?: LibraryPresenceIndex;
  }): Promise<void> {
    transfer?.onStage?.({ stage: 'downloading', book: remoteBook });

    const tempFolder = this.adapter.tempFolder ?? this.adapter.provider;
    const tempFilename = safeShelfFilename(remoteBook.filename, remoteBook.bookId);
    const tempPath = `${tempFolder}/${tempFilename}`;

    // 1. Native direct download path (Tauri desktop / Android)
    if (isTauriAppPlatform() && this.adapter.downloadBookToFile) {
      try {
        await this.appService.createDir(tempFolder, 'Temp', true);
        if (await this.appService.exists(tempPath, 'Temp')) {
          await this.appService.deleteFile(tempPath, 'Temp');
        }
        let nativePath: string;
        try {
          nativePath = await this.appService.resolveFilePath(tempPath, 'Temp');
        } catch {
          nativePath = '';
        }
        if (nativePath) {
          await this.adapter.downloadBookToFile(
            remoteBook,
            nativePath,
            transfer?.onProgress,
            transfer?.signal,
          );
          transfer?.onStage?.({ stage: 'importing', book: remoteBook });
          const imported = await this.appService.importBook(nativePath, library);
          if (!imported) {
            throw new Error(this.adapter.importErrorMessage ?? 'Failed to import shelf book');
          }
          const existingIndex = library.findIndex((book) => book.hash === imported.hash);
          if (existingIndex === -1) library.push(imported);
          else library[existingIndex] = imported;
          await onImported(imported, [...library]);
          await this.store.markShelfEntries([
            {
              provider: this.adapter.provider,
              connectionId: this.adapter.connectionId,
              shelfType,
              shelfId: String(shelfId),
              bookId: String(remoteBook.bookId),
              fileId: remoteBook.fileId != null ? String(remoteBook.fileId) : null,
              contentVersion:
                remoteBook.contentVersion != null ? String(remoteBook.contentVersion) : null,
              bookHash: remoteBook.bookHash ?? imported.hash,
              localPath: getLocalBookFilename(imported),
              managedByProvider: true,
            },
          ]);
          if (presenceIndex) addToPresenceIndex(presenceIndex, imported);
          return;
        }
      } finally {
        await this.appService.deleteFile(tempPath, 'Temp').catch(() => {});
      }
    }

    // 2. In-memory download path
    const downloaded = await this.adapter.downloadBook(
      remoteBook,
      transfer?.onProgress,
      transfer?.signal,
    );

    const data = this.adapter.repairBookData
      ? await this.adapter.repairBookData(downloaded, remoteBook)
      : remoteBook.filename.toLowerCase().endsWith('.epub')
        ? await repairMalformedEpubOpfNamespace(downloaded)
        : downloaded;

    if (this.adapter.validateBookData) {
      this.adapter.validateBookData(remoteBook.filename, data, remoteBook.size);
    } else {
      validateShelfDownload(remoteBook.filename, data, remoteBook.size);
    }

    transfer?.onStage?.({ stage: 'importing', book: remoteBook });
    const useNativeImport = data.byteLength >= NATIVE_IMPORT_THRESHOLD_BYTES;
    let importSource: string | File = new File([data], remoteBook.filename);

    try {
      if (useNativeImport) {
        await this.appService.createDir(tempFolder, 'Temp', true);
        if (await this.appService.exists(tempPath, 'Temp')) {
          await this.appService.deleteFile(tempPath, 'Temp');
        }
        await this.appService.writeFile(tempPath, 'Temp', importSource);
        try {
          importSource = await this.appService.resolveFilePath(tempPath, 'Temp');
        } catch {
          // Keep File as safe fallback
        }
      }

      const imported = await this.appService.importBook(importSource, library);
      if (!imported) {
        throw new Error(this.adapter.importErrorMessage ?? 'Failed to import shelf book');
      }

      const existingIndex = library.findIndex((book) => book.hash === imported.hash);
      if (existingIndex === -1) library.push(imported);
      else library[existingIndex] = imported;

      await onImported(imported, [...library]);
      if (presenceIndex) addToPresenceIndex(presenceIndex, imported);

      await this.store.markShelfEntries([
        {
          provider: this.adapter.provider,
          connectionId: this.adapter.connectionId,
          shelfType,
          shelfId: String(shelfId),
          bookId: String(remoteBook.bookId),
          fileId: remoteBook.fileId != null ? String(remoteBook.fileId) : null,
          contentVersion:
            remoteBook.contentVersion != null ? String(remoteBook.contentVersion) : null,
          bookHash: remoteBook.bookHash ?? imported.hash,
          localPath: getLocalBookFilename(imported),
          managedByProvider: true,
        },
      ]);
    } finally {
      if (useNativeImport) {
        await this.appService.deleteFile(tempPath, 'Temp').catch(() => {});
      }
    }
  }
}
