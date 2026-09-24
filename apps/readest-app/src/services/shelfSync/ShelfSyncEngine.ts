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
  LibraryPresenceIndex,
  ShelfCleanupPolicy,
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
import {
  type GetShelfEntriesOptions,
  type GetShelfSubscriptionsOptions,
  type ReferenceQueryOptions,
  type SaveShelfSubscriptionInput,
  type ShelfEntryKey,
  type ShelfEntryRecord,
  type ShelfEntryWrite,
  type ShelfSubscriptionRecord,
  ShelfSyncStore,
} from './ShelfSyncStore';

export interface IShelfSyncStore {
  readonly provider?: string;
  readonly connectionId?: string;

  getShelfSubscriptions(options?: GetShelfSubscriptionsOptions): Promise<ShelfSubscriptionRecord[]>;
  saveShelfSubscription(
    shelfIdOrInput: string | number | SaveShelfSubscriptionInput,
    enabled?: boolean,
    cleanupPolicy?: ShelfCleanupPolicy,
    downloadPolicy?: ShelfDownloadPolicy,
    shelfType?: string,
  ): Promise<boolean | void>;
  deleteShelfSubscription(
    shelfId: string | number,
    shelfType?: string,
    options?: { provider?: string; connectionId?: string },
  ): Promise<void>;

  getShelfEntries(
    shelfId: string | number,
    shelfType?: string,
    options?: GetShelfEntriesOptions,
  ): Promise<ShelfEntryRecord[]>;
  markShelfEntries(
    entries: ShelfEntryWrite[],
    options?: { insertOnly?: boolean },
  ): Promise<number | void>;
  removeShelfEntries(entries: ShelfEntryKey[]): Promise<void>;

  getManagedShelfReferenceCounts(
    localPaths: string[],
    options?: ReferenceQueryOptions,
  ): Promise<Map<string, number>>;
  getAllShelfReferenceCounts(
    localPaths: string[],
    options?: ReferenceQueryOptions,
  ): Promise<Map<string, number>>;
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Normalizes legacy stores (like GrimmLinkSyncStore or mock test doubles)
 * into a store satisfying IShelfSyncStore.
 */
export function wrapLegacyShelfStore(
  store: unknown,
  defaultProvider = 'default',
  defaultConnectionId = 'default',
): IShelfSyncStore {
  if (store instanceof ShelfSyncStore) {
    return store;
  }

  const s = store as Record<string, unknown>;
  const provider = (s['provider'] as string) || defaultProvider;
  const connectionId = (s['connectionId'] as string) || defaultConnectionId;

  return {
    provider,
    connectionId,

    async getShelfSubscriptions(options?: GetShelfSubscriptionsOptions) {
      if (typeof s['getShelfSubscriptions'] === 'function') {
        const rows = (await (s['getShelfSubscriptions'] as AnyFn)(options)) as Array<
          Record<string, unknown>
        >;
        return rows.map((row) => ({
          provider: (row['provider'] as string) || provider,
          connectionId: (row['connectionId'] as string) || connectionId,
          shelfType: (row['shelfType'] as string) || 'default',
          shelfId: String(row['shelfId']),
          enabled:
            row['enabled'] != null ? Number(row['enabled']) === 1 || row['enabled'] === true : true,
          cleanupPolicy: (row['cleanupPolicy'] as ShelfCleanupPolicy) || 'keep_local',
          downloadPolicy: (row['downloadPolicy'] as ShelfDownloadPolicy) || 'always',
          createdAt: Number(row['createdAt']) || 0,
          updatedAt: Number(row['updatedAt']) || 0,
        }));
      }
      return [];
    },

    async saveShelfSubscription(shelfIdOrInput, enabled, cleanupPolicy, downloadPolicy, shelfType) {
      if (typeof s['saveShelfSubscription'] === 'function') {
        const fn = s['saveShelfSubscription'] as AnyFn;
        if (typeof shelfIdOrInput === 'object') {
          await fn(
            shelfIdOrInput.shelfType ?? 'default',
            shelfIdOrInput.shelfId,
            shelfIdOrInput.enabled ?? true,
            shelfIdOrInput.cleanupPolicy ?? 'keep_local',
            shelfIdOrInput.downloadPolicy ?? 'always',
          );
        } else {
          await fn(
            shelfType ?? 'default',
            shelfIdOrInput,
            enabled ?? true,
            cleanupPolicy ?? 'keep_local',
            downloadPolicy ?? 'always',
          );
        }
      }
    },

    async deleteShelfSubscription(shelfId, shelfType, options) {
      if (typeof s['deleteShelfSubscription'] === 'function') {
        await (s['deleteShelfSubscription'] as AnyFn)(shelfId, shelfType, options);
      }
    },

    async getShelfEntries(shelfId, shelfType = 'default', options) {
      if (typeof s['getShelfEntries'] === 'function') {
        const fn = s['getShelfEntries'] as AnyFn;
        // Try (shelfId, shelfType) first (ShelfSyncStore), then (shelfType, shelfId) (GrimmLinkSyncStore)
        let rows = (await Promise.resolve(fn(shelfId, shelfType, options)).catch(
          () => [],
        )) as Array<Record<string, unknown>>;
        if ((!rows || rows.length === 0) && shelfType) {
          const altRows = (await Promise.resolve(fn(shelfType, shelfId, options)).catch(
            () => [],
          )) as Array<Record<string, unknown>>;
          if (altRows && altRows.length > 0) {
            rows = altRows;
          }
        }
        return (rows || []).map((row) => ({
          provider: (row['provider'] as string) || provider,
          connectionId: (row['connectionId'] as string) || connectionId,
          shelfType: (row['shelfType'] as string) || shelfType,
          shelfId: String(shelfId),
          bookId: String(row['bookId']),
          fileId: (row['fileId'] as string) ?? null,
          bookHash: (row['bookHash'] as string) ?? null,
          contentVersion: (row['contentVersion'] as string) ?? null,
          localPath: (row['localPath'] as string) ?? null,
          managedByProvider:
            row['managedByProvider'] != null
              ? !!row['managedByProvider']
              : !!row['managedByGrimmLink'],
          lastSeenAt: Number(row['lastSeenAt']) || Date.now(),
        }));
      }
      return [];
    },

    async markShelfEntries(entries) {
      if (!entries.length) return;
      if (typeof s['markShelfEntries'] === 'function') {
        await (s['markShelfEntries'] as AnyFn)(
          entries.map((e) => ({
            ...e,
            shelfType: e.shelfType ?? 'default',
            shelfId: Number(e.shelfId) || e.shelfId,
            bookId: Number(e.bookId) || e.bookId,
            bookHash: e.bookHash ?? '',
            localPath: e.localPath ?? null,
            managedByGrimmLink: !!e.managedByProvider,
            managedByProvider: !!e.managedByProvider,
          })),
        );
      } else if (typeof s['markShelfEntry'] === 'function') {
        const fn = s['markShelfEntry'] as AnyFn;
        for (const e of entries) {
          if (fn.length <= 1) {
            await fn(e);
          } else {
            await fn(
              e.shelfType ?? 'default',
              Number(e.shelfId) || e.shelfId,
              Number(e.bookId) || e.bookId,
              e.bookHash ?? '',
              e.localPath ?? null,
              !!e.managedByProvider,
            );
          }
        }
      }
    },

    async removeShelfEntries(entries) {
      if (!entries.length) return;
      if (typeof s['removeShelfEntries'] === 'function') {
        await (s['removeShelfEntries'] as AnyFn)(
          entries.map((e) => ({
            ...e,
            shelfType: e.shelfType ?? 'default',
            shelfId: Number(e.shelfId) || e.shelfId,
            bookId: Number(e.bookId) || e.bookId,
          })),
        );
      } else if (typeof s['removeShelfEntry'] === 'function') {
        const fn = s['removeShelfEntry'] as AnyFn;
        for (const e of entries) {
          await fn(
            e.shelfType ?? 'default',
            Number(e.shelfId) || e.shelfId,
            Number(e.bookId) || e.bookId,
          );
        }
      }
    },

    async getManagedShelfReferenceCounts(localPaths, options) {
      const result = new Map<string, number>();
      for (const path of localPaths) result.set(path, 0);
      if (!localPaths.length) return result;

      if (typeof s['getManagedShelfReferenceCounts'] === 'function') {
        return (await (s['getManagedShelfReferenceCounts'] as AnyFn)(localPaths, options)) as Map<
          string,
          number
        >;
      }
      if (typeof s['getManagedShelfEntryReferences'] === 'function') {
        const fn = s['getManagedShelfEntryReferences'] as AnyFn;
        for (const path of localPaths) {
          result.set(path, Number(await fn(path, options)) || 0);
        }
        return result;
      }
      return result;
    },

    async getAllShelfReferenceCounts(localPaths, options) {
      const result = new Map<string, number>();
      for (const path of localPaths) result.set(path, 0);
      if (!localPaths.length) return result;

      if (typeof s['getAllShelfReferenceCounts'] === 'function') {
        return (await (s['getAllShelfReferenceCounts'] as AnyFn)(localPaths, options)) as Map<
          string,
          number
        >;
      }
      if (typeof s['getAllShelfEntryReferences'] === 'function') {
        const fn = s['getAllShelfEntryReferences'] as AnyFn;
        for (const path of localPaths) {
          result.set(path, Number(await fn(path, options)) || 0);
        }
        return result;
      }
      if (typeof s['getManagedShelfReferenceCounts'] === 'function') {
        return (await (s['getManagedShelfReferenceCounts'] as AnyFn)(localPaths, options)) as Map<
          string,
          number
        >;
      }
      if (typeof s['getManagedShelfEntryReferences'] === 'function') {
        const fn = s['getManagedShelfEntryReferences'] as AnyFn;
        for (const path of localPaths) {
          result.set(path, Number(await fn(path, options)) || 0);
        }
        return result;
      }
      return result;
    },
  };
}

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
    store?: IShelfSyncStore | ShelfSyncStore | unknown,
  ) {
    this.adapter = adapter;
    this.appService = appService;
    this.store = store
      ? wrapLegacyShelfStore(store, adapter.provider, adapter.connectionId)
      : new ShelfSyncStore(appService as AppService, adapter.provider, adapter.connectionId);
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
      ? [...options.presenceIndex.booksByHash.values()]
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

    const localHashes = new Set(presentBooks.map((b) => b.hash));
    const localPaths = new Set(presentBooks.map(getLocalBookFilename));

    // 4. Plan and reconcile
    const plan = planShelfSync(remote, existing, localHashes, localPaths);
    const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);

    // 5. Record reused entries
    await this.store.markShelfEntries(
      plan.reuse.map((bookId) => {
        const remoteBook = remote.find((book) => book.bookId === bookId)!;
        const tracked = existing.find(
          (entry) =>
            entry.bookId === String(bookId) &&
            (entry.bookHash === remoteBook.bookHash ||
              (remoteBook.bookHash != null && localHashes.has(remoteBook.bookHash))),
        );
        return {
          provider: this.adapter.provider,
          connectionId: this.adapter.connectionId,
          shelfType,
          shelfId: String(shelfId),
          bookId: String(bookId),
          bookHash: remoteBook.bookHash,
          localPath: tracked?.localPath ?? null,
          managedByProvider: tracked?.managedByProvider ?? false,
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
    const subscriptions = await this.store.getShelfSubscriptions();
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
