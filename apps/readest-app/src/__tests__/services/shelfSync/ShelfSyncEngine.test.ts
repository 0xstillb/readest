import { describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { getLocalBookFilename } from '@/utils/book';
import type { ProgressHandler } from '@/utils/transfer';
import {
  type SaveShelfSubscriptionInput,
  type ShelfEntryKey,
  type ShelfEntryWrite,
  type ShelfPage,
  type ShelfSnapshot,
  type ShelfSyncAdapter,
  type ShelfSyncAppService,
  type ShelfSyncBook,
  ShelfSyncEngine,
  ShelfSyncStore,
  migrateGrimmLinkShelfState,
} from '@/services/shelfSync';

interface FakeBook extends ShelfSyncBook<string> {
  bookId: string;
  bookHash: string;
  filename: string;
  format?: string;
  size?: number;
}

class FakeShelfAdapter implements ShelfSyncAdapter<string, FakeBook> {
  readonly provider: string;
  readonly connectionId: string;
  readonly tempFolder: string;
  readonly importErrorMessage: string;

  remoteShelves = new Map<string, FakeBook[]>();
  downloads = new Map<string, ArrayBuffer>();
  downloadCalls: string[] = [];
  downloadToFileCalls: Array<{ bookId: string; filePath: string }> = [];
  metrics: Array<{ metric: string; value?: number }> = [];

  downloadBookToFile?: (
    book: FakeBook,
    filePath: string,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
  ) => Promise<void>;

  constructor(provider = 'fake-provider', connectionId = 'conn-1') {
    this.provider = provider;
    this.connectionId = connectionId;
    this.tempFolder = provider;
    this.importErrorMessage = 'Failed to import fake shelf book';
  }

  async getShelfBooks(shelfType: string, shelfId: string): Promise<FakeBook[]> {
    const key = `${shelfType}:${shelfId}`;
    return this.remoteShelves.get(key) ?? [];
  }

  async downloadBook(book: FakeBook): Promise<ArrayBuffer> {
    this.downloadCalls.push(book.bookId);
    const data = this.downloads.get(book.bookId);
    if (!data) {
      return new TextEncoder().encode('%PDF-1.7 standard dummy content').buffer;
    }
    return data;
  }

  onPerformanceMetric(metric: string, value?: number): void {
    this.metrics.push({ metric, value });
  }
}

const createMockAppService = () => {
  const files = new Map<string, string | Uint8Array>();
  const deletedBooks: string[] = [];
  const deletedFiles: string[] = [];
  const createdDirs: string[] = [];

  const appService: ShelfSyncAppService & {
    files: Map<string, string | Uint8Array>;
    deletedBooks: string[];
    deletedFiles: string[];
    createdDirs: string[];
  } = {
    files,
    deletedBooks,
    deletedFiles,
    createdDirs,
    async exists(path: string, _folder?: string) {
      return files.has(path);
    },
    async createDir(path: string, _folder?: string, _recursive?: boolean) {
      createdDirs.push(path);
    },
    async writeFile(path: string, _folder?: string, content?: unknown) {
      files.set(path, content instanceof Uint8Array ? content : new Uint8Array());
    },
    async resolveFilePath(path: string, _folder?: string) {
      return `/virtual/path/${path}`;
    },
    async deleteFile(path: string, _folder?: string) {
      deletedFiles.push(path);
      files.delete(path);
    },
    async importBook(source: unknown, _library: Book[]) {
      const filename = typeof source === 'string' ? source : (source as File).name;
      const hash = `hash-${filename}`;
      const newBook: Book = {
        hash,
        title: filename,
        author: 'Author',
        sourceTitle: filename,
        format: 'PDF',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      files.set(`${hash}/${filename}`, new Uint8Array([1, 2, 3]));
      files.set(getLocalBookFilename(newBook), new Uint8Array([1, 2, 3]));
      return newBook;
    },
    async deleteBook(book: Book, _mode?: string) {
      deletedBooks.push(book.hash);
      files.delete(`${book.hash}/${book.title}`);
      files.delete(getLocalBookFilename(book));
    },
  };

  return appService;
};

const createMockStore = () => {
  const subscriptions = new Map<
    string,
    {
      shelfType: string;
      shelfId: string;
      enabled: boolean;
      cleanupPolicy: 'keep_local' | 'remove_managed_copy';
      downloadPolicy: 'off' | 'wifi_only' | 'always';
    }
  >();

  const entries = new Map<
    string,
    {
      provider: string;
      connectionId: string;
      shelfType: string;
      shelfId: string;
      bookId: string;
      fileId?: string | null;
      bookHash: string | null;
      contentVersion?: string | null;
      localPath: string | null;
      managedByProvider: boolean;
      lastSeenAt: number;
    }
  >();

  return {
    subscriptions,
    entries,
    async getShelfSubscriptions(options?: { enabledOnly?: boolean }) {
      let list = Array.from(subscriptions.values());
      if (options?.enabledOnly) {
        list = list.filter((s) => s.enabled);
      }
      return list.map((s) => ({
        provider: 'fake-provider',
        connectionId: 'conn-1',
        shelfType: s.shelfType,
        shelfId: s.shelfId,
        enabled: s.enabled,
        cleanupPolicy: s.cleanupPolicy,
        downloadPolicy: s.downloadPolicy,
        createdAt: 0,
        updatedAt: 0,
      }));
    },
    async saveShelfSubscription(input: SaveShelfSubscriptionInput) {
      const key = `${input.shelfType ?? 'default'}:${input.shelfId}`;
      subscriptions.set(key, {
        shelfType: input.shelfType ?? 'default',
        shelfId: String(input.shelfId),
        enabled: input.enabled ?? true,
        cleanupPolicy: input.cleanupPolicy ?? 'keep_local',
        downloadPolicy: input.downloadPolicy ?? 'always',
      });
    },
    async deleteShelfSubscription(shelfId: string, shelfType = 'default') {
      subscriptions.delete(`${shelfType}:${shelfId}`);
    },
    async getShelfEntries(shelfId: string | number, shelfType = 'default') {
      const result = [];
      for (const entry of entries.values()) {
        if (entry.shelfId === String(shelfId) && entry.shelfType === shelfType) {
          result.push({
            ...entry,
            fileId: entry.fileId ?? null,
            contentVersion: entry.contentVersion ?? null,
          });
        }
      }
      return result;
    },
    async markShelfEntries(writes: ShelfEntryWrite[]) {
      for (const w of writes) {
        const key = `${w.shelfType ?? 'default'}:${w.shelfId}:${w.bookId}`;
        entries.set(key, {
          provider: w.provider ?? 'fake-provider',
          connectionId: w.connectionId ?? 'conn-1',
          shelfType: w.shelfType ?? 'default',
          shelfId: String(w.shelfId),
          bookId: String(w.bookId),
          fileId: w.fileId != null ? String(w.fileId) : null,
          bookHash: w.bookHash ?? null,
          contentVersion: w.contentVersion != null ? String(w.contentVersion) : null,
          localPath: w.localPath ?? null,
          managedByProvider: !!w.managedByProvider,
          lastSeenAt: w.lastSeenAt ?? Date.now(),
        });
      }
    },
    async removeShelfEntries(keys: ShelfEntryKey[]) {
      for (const k of keys) {
        entries.delete(`${k.shelfType ?? 'default'}:${k.shelfId}:${k.bookId}`);
      }
    },
    async getManagedShelfReferenceCounts(localPaths: string[]) {
      const counts = new Map<string, number>();
      for (const p of localPaths) counts.set(p, 0);
      for (const e of entries.values()) {
        if (e.managedByProvider && e.localPath && counts.has(e.localPath)) {
          counts.set(e.localPath, (counts.get(e.localPath) ?? 0) + 1);
        }
      }
      return counts;
    },
    async getAllShelfReferenceCounts(localPaths: string[]) {
      const counts = new Map<string, number>();
      for (const p of localPaths) counts.set(p, 0);
      for (const e of entries.values()) {
        if (e.localPath && counts.has(e.localPath)) {
          counts.set(e.localPath, (counts.get(e.localPath) ?? 0) + 1);
        }
      }
      return counts;
    },
  };
};

describe('ShelfSyncEngine', () => {
  it('downloads new remote books and imports them serially', async () => {
    const adapter = new FakeShelfAdapter();
    adapter.remoteShelves.set('default:shelf-1', [
      { bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF' },
      { bookId: 'b2', bookHash: 'h2', filename: 'book2.pdf', format: 'PDF' },
    ]);

    const appService = createMockAppService();
    const store = createMockStore();
    const engine = new ShelfSyncEngine(adapter, appService, store);

    const imported: Book[] = [];
    const library: Book[] = [];

    const result = await engine.sync({
      shelfType: 'default',
      shelfId: 'shelf-1',
      library,
      onImported: (book, updated) => {
        imported.push(book);
        library.splice(0, library.length, ...updated);
      },
    });

    expect(result).toEqual({ reused: 0, downloaded: 2, removed: 0 });
    expect(imported).toHaveLength(2);
    expect(adapter.downloadCalls).toEqual(['b1', 'b2']);
    expect(store.entries.size).toBe(2);

    const entry1 = store.entries.get('default:shelf-1:b1');
    expect(entry1?.managedByProvider).toBe(true);
    expect(entry1?.bookHash).toBe('h1');
  });

  it('reuses existing local books matching remote hash without downloading', async () => {
    const adapter = new FakeShelfAdapter();
    adapter.remoteShelves.set('default:shelf-1', [
      { bookId: 'b1', bookHash: 'hash-local-1', filename: 'book1.pdf', format: 'PDF' },
      { bookId: 'b2', bookHash: 'hash-missing', filename: 'book2.pdf', format: 'PDF' },
    ]);

    const appService = createMockAppService();
    // Simulate that hash-local-1 exists on disk
    appService.files.set('hash-local-1/book1.pdf', new Uint8Array([1, 2, 3]));

    const library: Book[] = [
      {
        hash: 'hash-local-1',
        title: 'book1',
        author: '',
        sourceTitle: 'book1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      },
    ];

    const store = createMockStore();
    const engine = new ShelfSyncEngine(adapter, appService, store);

    const result = await engine.sync({
      shelfType: 'default',
      shelfId: 'shelf-1',
      library,
      onImported: (_book, updated) => {
        library.splice(0, library.length, ...updated);
      },
    });

    expect(result).toEqual({ reused: 1, downloaded: 1, removed: 0 });
    expect(adapter.downloadCalls).toEqual(['b2']);
  });

  it('restores soft-deleted shelf books (tombstones) by downloading them again', async () => {
    const adapter = new FakeShelfAdapter();
    adapter.remoteShelves.set('default:shelf-1', [
      { bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF' },
    ]);

    const appService = createMockAppService();
    // Library has a soft-deleted tombstone
    const library: Book[] = [
      {
        hash: 'h1',
        title: 'book1.pdf',
        author: '',
        sourceTitle: 'book1.pdf',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
        deletedAt: 1234567, // tombstone
      },
    ];

    const store = createMockStore();
    const engine = new ShelfSyncEngine(adapter, appService, store);

    const result = await engine.sync({
      shelfType: 'default',
      shelfId: 'shelf-1',
      library,
      onImported: (_book, updated) => {
        library.splice(0, library.length, ...updated);
      },
    });

    expect(result.downloaded).toBe(1);
    expect(result.removed).toBe(0);
    expect(adapter.downloadCalls).toEqual(['b1']);
  });

  describe('Download Policies', () => {
    it('blocks download and tracks remote-only entry when downloadPolicy is off', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF' },
      ]);

      const appService = createMockAppService();
      const store = createMockStore();
      const engine = new ShelfSyncEngine(adapter, appService, store);

      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library: [],
        onImported: () => {},
        downloadPolicy: 'off',
      });

      expect(result).toEqual({ reused: 0, downloaded: 0, removed: 0 });
      expect(adapter.downloadCalls).toEqual([]);

      const entry = store.entries.get('default:shelf-1:b1');
      expect(entry).toBeDefined();
      expect(entry?.localPath).toBeNull();
      expect(entry?.managedByProvider).toBe(false);
    });
  });

  describe('Cleanup Policies & Data Safety Invariants', () => {
    it('retains local files and only removes tracking when cleanupPolicy is keep_local', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', []); // Book removed remotely

      const appService = createMockAppService();
      appService.files.set('h1/book1.pdf', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'h1',
          title: 'book1',
          author: '',
          sourceTitle: 'book1',
          format: 'PDF',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      // Tracked previously as managed
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'keep_local',
      });

      expect(result.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
      expect(appService.deletedFiles).toHaveLength(0);
      expect(store.entries.size).toBe(0); // Unlinked from shelf
    });

    it('purges managed book when cleanupPolicy is remove_managed_copy and refCount is 1', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', []); // Removed remotely

      const appService = createMockAppService();
      appService.files.set('h1/book1.pdf', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'h1',
          title: 'book1',
          author: '',
          sourceTitle: 'book1',
          format: 'PDF',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(result.removed).toBe(1);
      expect(appService.deletedBooks).toEqual(['h1']);
      expect(store.entries.size).toBe(0);
    });

    it('keeps managed book when another shelf still references it (refCount > 1)', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', []);

      const appService = createMockAppService();
      appService.files.set('h1/book1.pdf', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'h1',
          title: 'book1',
          author: '',
          sourceTitle: 'book1',
          format: 'PDF',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      // Shelf 1 tracks it
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
      ]);
      // Shelf 2 also tracks it
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-2',
          bookId: 'b10',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(result.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
    });

    it('never deletes user-imported books even under remove_managed_copy', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', []);

      const appService = createMockAppService();
      appService.files.set('h1/user.pdf', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'h1',
          title: 'user',
          author: '',
          sourceTitle: 'user',
          format: 'PDF',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      // Tracked as unmanaged / user import
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/user.pdf',
          managedByProvider: false,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(result.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
    });

    it('does not delete local file when another provider holds an unmanaged reference (cross-provider safety)', async () => {
      const adapterA = new FakeShelfAdapter('provider-a', 'conn-a');
      adapterA.remoteShelves.set('default:shelf-1', []); // Removed from Provider A

      const appService = createMockAppService();
      appService.files.set('h1/book.epub', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'h1',
          title: 'book',
          author: '',
          sourceTitle: 'book',
          format: 'EPUB',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      // Provider A: managed reference
      await store.markShelfEntries([
        {
          provider: 'provider-a',
          connectionId: 'conn-a',
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book.epub',
          managedByProvider: true,
        },
      ]);
      // Provider B: unmanaged reference to the same localPath
      await store.markShelfEntries([
        {
          provider: 'provider-b',
          connectionId: 'conn-b',
          shelfType: 'default',
          shelfId: 'shelf-2',
          bookId: 'b2',
          bookHash: 'h1',
          localPath: 'h1/book.epub',
          managedByProvider: false,
        },
      ]);

      const engineA = new ShelfSyncEngine(adapterA, appService, store);

      const result = await engineA.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      // MUST NOT delete the local file because Provider B references it
      expect(result.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
      expect(appService.files.has('h1/book.epub')).toBe(true);
      // Provider A's shelf entry is unlinked, Provider B's shelf entry remains
      expect(store.entries.has('default:shelf-1:b1')).toBe(false);
      expect(store.entries.has('default:shelf-2:b2')).toBe(true);
    });

    it('keeps local file when multiple providers hold managed references, and deletes only when one managed entry remains', async () => {
      const adapterA = new FakeShelfAdapter('provider-a', 'conn-a');
      adapterA.remoteShelves.set('default:shelf-1', []); // Removed from Provider A

      const appService = createMockAppService();
      appService.files.set('h1/book.epub', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'h1',
          title: 'book',
          author: '',
          sourceTitle: 'book',
          format: 'EPUB',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      // Provider A: managed
      await store.markShelfEntries([
        {
          provider: 'provider-a',
          connectionId: 'conn-a',
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book.epub',
          managedByProvider: true,
        },
      ]);
      // Provider B: also managed
      await store.markShelfEntries([
        {
          provider: 'provider-b',
          connectionId: 'conn-b',
          shelfType: 'default',
          shelfId: 'shelf-2',
          bookId: 'b2',
          bookHash: 'h1',
          localPath: 'h1/book.epub',
          managedByProvider: true,
        },
      ]);

      const engineA = new ShelfSyncEngine(adapterA, appService, store);

      // Step 1: Provider A sync with remove_managed_copy -> KEEP because Provider B also references it
      const resultA = await engineA.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(resultA.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
      expect(appService.files.has('h1/book.epub')).toBe(true);
      expect(store.entries.has('default:shelf-1:b1')).toBe(false);
      expect(store.entries.has('default:shelf-2:b2')).toBe(true);

      // Step 2: Now only Provider B's managed entry remains
      const adapterB = new FakeShelfAdapter('provider-b', 'conn-b');
      adapterB.remoteShelves.set('default:shelf-2', []); // Removed from Provider B
      const engineB = new ShelfSyncEngine(adapterB, appService, store);

      const resultB = await engineB.sync({
        shelfType: 'default',
        shelfId: 'shelf-2',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      // Now only 1 managed entry remained, so it is eligible for delete
      expect(resultB.removed).toBe(1);
      expect(appService.deletedBooks).toEqual(['h1']);
      expect(store.entries.has('default:shelf-2:b2')).toBe(false);
    });
  });

  describe('Phase 8A: Snapshot Completeness + Offline Safety', () => {
    it('confirmed complete empty shelf plans and executes removals under remove_managed_copy', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', []); // Confirmed complete empty shelf

      const appService = createMockAppService();
      appService.files.set('h1/book.pdf', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'h1',
          title: 'book',
          author: '',
          sourceTitle: 'book',
          format: 'PDF',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      // Confirmed empty shelf: removals executed
      expect(result.removed).toBe(1);
      expect(appService.deletedBooks).toEqual(['h1']);
      expect(store.entries.has('default:shelf-1:b1')).toBe(false);
    });

    it('offline before first page produces zero destructive removals and preserves prior store membership', async () => {
      const adapter = new FakeShelfAdapter();
      vi.spyOn(adapter, 'getShelfBooks').mockRejectedValue(new Error('Network offline'));

      const appService = createMockAppService();
      appService.files.set('h1/book.pdf', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'h1',
          title: 'book',
          author: '',
          sourceTitle: 'book',
          format: 'PDF',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: () => {},
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow('Network offline');

      // ZERO destructive removals
      expect(appService.deletedBooks).toHaveLength(0);
      expect(appService.files.has('h1/book.pdf')).toBe(true);
      // Prior membership preserved in store
      expect(store.entries.has('default:shelf-1:b1')).toBe(true);
    });

    it('failed zero-book snapshot produces zero destructive removals and preserves membership', async () => {
      const adapter = new FakeShelfAdapter();
      // Adapter returns a failed snapshot object with 0 books
      (
        adapter as unknown as { getShelfSnapshot: () => Promise<ShelfSnapshot<FakeBook>> }
      ).getShelfSnapshot = async () => ({
        status: 'failed',
        books: [],
        error: new Error('Server returned 500 error payload'),
      });

      const appService = createMockAppService();
      appService.files.set('h1/book.pdf', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'h1',
          title: 'book',
          author: '',
          sourceTitle: 'book',
          format: 'PDF',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: () => {},
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow('Server returned 500 error payload');

      // ZERO destructive removals
      expect(appService.deletedBooks).toHaveLength(0);
      expect(appService.files.has('h1/book.pdf')).toBe(true);
      // Prior membership preserved in store
      expect(store.entries.has('default:shelf-1:b1')).toBe(true);
    });

    it('mid-pagination error produces zero destructive removals and preserves absent entries', async () => {
      const adapter = new FakeShelfAdapter();
      (
        adapter as unknown as {
          getShelfPage: (
            type: string,
            id: string,
            opt?: { cursor?: string | null },
          ) => Promise<ShelfPage<FakeBook>>;
        }
      ).getShelfPage = async (_type: string, _id: string, opt?: { cursor?: string | null }) => {
        if (opt?.cursor === 'p2') {
          throw new Error('Connection terminated on page 2');
        }
        return {
          books: [{ bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF' }],
          nextCursor: 'p2',
          hasMore: true,
        };
      };

      const appService = createMockAppService();
      appService.files.set('h1/book1.pdf', new Uint8Array([1, 2, 3]));
      appService.files.set('h2/book2.pdf', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'h1',
          title: 'b1',
          author: '',
          sourceTitle: 'b1',
          format: 'PDF',
          createdAt: 0,
          updatedAt: 0,
        },
        {
          hash: 'h2',
          title: 'b2',
          author: '',
          sourceTitle: 'b2',
          format: 'PDF',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      // Tracked both b1 and b2
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b2',
          bookHash: 'h2',
          localPath: 'h2/book2.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      // Default: throws on incomplete snapshot
      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: () => {},
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow('Connection terminated on page 2');

      // Neither book is deleted
      expect(appService.deletedBooks).toHaveLength(0);
      expect(appService.files.has('h2/book2.pdf')).toBe(true);
      // Both entries remain in store
      expect(store.entries.has('default:shelf-1:b1')).toBe(true);
      expect(store.entries.has('default:shelf-1:b2')).toBe(true);

      // Even if throwOnIncompleteSnapshot is false:
      const nonThrowingResult = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
        throwOnIncompleteSnapshot: false,
      });

      expect(nonThrowingResult.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
      expect(store.entries.has('default:shelf-1:b2')).toBe(true);
    });

    it('restartRequired produces zero destructive removals and preserves membership', async () => {
      const adapter = new FakeShelfAdapter();
      (
        adapter as unknown as {
          getShelfPage: () => Promise<ShelfPage<FakeBook>>;
        }
      ).getShelfPage = async () => ({
        books: [],
        restartRequired: true,
      });

      const appService = createMockAppService();
      appService.files.set('h1/book.pdf', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'h1',
          title: 'b',
          author: '',
          sourceTitle: 'b',
          format: 'PDF',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: () => {},
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow('restart required');

      expect(appService.deletedBooks).toHaveLength(0);
      expect(store.entries.has('default:shelf-1:b1')).toBe(true);
    });

    it('preview distinguishes confirmed empty from failed empty snapshot', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', []); // Confirmed empty

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, createMockAppService(), store);

      // Confirmed empty: preview shows removed = 1
      const confirmedPreview = await engine.preview('default', 'shelf-1', []);
      expect(confirmedPreview.removed).toBe(1);

      // Failed snapshot: preview returns 0 removed
      vi.spyOn(adapter, 'getShelfBooks').mockRejectedValueOnce(new Error('Network error'));
      const failedPreview = await engine.preview('default', 'shelf-1', []);
      expect(failedPreview.removed).toBe(0);
      expect(failedPreview.total).toBe(0);
    });
  });

  describe('Direct file download & Bounded Memory', () => {
    it('uses downloadBookToFile on native platforms when available', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF' },
      ]);

      adapter.downloadBookToFile = async (book, filePath) => {
        adapter.downloadToFileCalls.push({ bookId: book.bookId, filePath });
      };

      const originalPlatform = process.env['NEXT_PUBLIC_APP_PLATFORM'];
      process.env['NEXT_PUBLIC_APP_PLATFORM'] = 'tauri';

      const appService = createMockAppService();
      const store = createMockStore();
      const engine = new ShelfSyncEngine(adapter, appService, store);

      try {
        const result = await engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library: [],
          onImported: () => {},
        });

        expect(result.downloaded).toBe(1);
        expect(adapter.downloadToFileCalls).toHaveLength(1);
        expect(adapter.downloadToFileCalls[0]?.bookId).toBe('b1');
        // Temp file cleaned up
        expect(appService.deletedFiles.length).toBeGreaterThan(0);
      } finally {
        process.env['NEXT_PUBLIC_APP_PLATFORM'] = originalPlatform;
      }
    });

    it('cleans up temp file on import failure for large downloads', async () => {
      const adapter = new FakeShelfAdapter();
      const largeData = new ArrayBuffer(9 * 1024 * 1024); // 9MB > 8MB threshold
      new Uint8Array(largeData).set(new TextEncoder().encode('%PDF-1.7'));
      adapter.downloads.set('b1', largeData);
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h1', filename: 'large.pdf', format: 'PDF' },
      ]);

      const appService = createMockAppService();
      // Fail importBook
      appService.importBook = async () => null;

      const store = createMockStore();
      const engine = new ShelfSyncEngine(adapter, appService, store);

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library: [],
          onImported: () => {},
        }),
      ).rejects.toThrow('Failed to import fake shelf book');

      // Temp file was deleted on failure
      expect(appService.deletedFiles).toContain('fake-provider/b1-large.pdf');
      expect(store.entries.size).toBe(0);
    });
  });

  describe('Cancellation', () => {
    it('aborts cleanly via AbortSignal without corrupting state', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF' },
        { bookId: 'b2', bookHash: 'h2', filename: 'book2.pdf', format: 'PDF' },
      ]);

      const controller = new AbortController();
      const appService = createMockAppService();
      const store = createMockStore();
      const engine = new ShelfSyncEngine(adapter, appService, store);

      let importCount = 0;
      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library: [],
          onImported: () => {
            importCount++;
            controller.abort();
          },
          transfer: { signal: controller.signal },
        }),
      ).rejects.toThrow('Shelf sync cancelled');

      expect(importCount).toBe(1);
    });
  });

  describe('Subscriptions and syncSubscribed', () => {
    it('syncs all enabled subscriptions sequentially and deduplicates concurrent runs', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('regular:s1', [
        { bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF' },
      ]);
      adapter.remoteShelves.set('magic:s2', [
        { bookId: 'b2', bookHash: 'h2', filename: 'book2.pdf', format: 'PDF' },
      ]);

      const appService = createMockAppService();
      const store = createMockStore();
      await store.saveShelfSubscription({ shelfType: 'regular', shelfId: 's1', enabled: true });
      await store.saveShelfSubscription({ shelfType: 'magic', shelfId: 's2', enabled: true });

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const library: Book[] = [];

      const result = await engine.syncSubscribed({
        getLibrary: () => library,
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
      });

      expect(result).toEqual({ reused: 0, downloaded: 2, removed: 0 });
      expect(library).toHaveLength(2);
      expect(adapter.metrics.some((m) => m.metric === 'shelfSyncDurationMs')).toBe(true);
    });

    it('only syncs enabled subscriptions and ignores disabled subscriptions completely', async () => {
      const adapter = new FakeShelfAdapter();
      const getShelfBooksSpy = vi.spyOn(adapter, 'getShelfBooks');

      adapter.remoteShelves.set('regular:enabled-shelf', [
        { bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF' },
      ]);
      adapter.remoteShelves.set('magic:disabled-shelf', [
        { bookId: 'b2', bookHash: 'h2', filename: 'book2.pdf', format: 'PDF' },
      ]);

      const appService = createMockAppService();
      const store = createMockStore();
      await store.saveShelfSubscription({
        shelfType: 'regular',
        shelfId: 'enabled-shelf',
        enabled: true,
      });
      await store.saveShelfSubscription({
        shelfType: 'magic',
        shelfId: 'disabled-shelf',
        enabled: false,
      });

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const library: Book[] = [];
      const onImported = vi.fn((_book, updated) => {
        library.splice(0, library.length, ...updated);
      });
      const onRemoved = vi.fn();

      const result = await engine.syncSubscribed({
        getLibrary: () => library,
        onImported,
        onRemoved,
      });

      // Enabled shelf: adapter.getShelfBooks() called, shelf synced
      expect(getShelfBooksSpy).toHaveBeenCalledWith('regular', 'enabled-shelf');
      expect(result.downloaded).toBe(1);
      expect(library).toHaveLength(1);
      expect(library[0]?.title).toBe('book1.pdf');

      // Disabled shelf: adapter.getShelfBooks() NOT called, no import, no removal
      expect(getShelfBooksSpy).not.toHaveBeenCalledWith('magic', 'disabled-shelf');
      expect(onImported).toHaveBeenCalledTimes(1);
      expect(onRemoved).not.toHaveBeenCalled();
    });
  });

  describe('Reuse Ownership Safety and Reference Tracking', () => {
    it('Test A: new shelf reuses existing user/local book with actual localPath and managedByProvider=false', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'H1', filename: 'book.epub', format: 'EPUB' },
      ]);

      const appService = createMockAppService();
      appService.files.set('H1/book.epub', new Uint8Array([1, 2, 3]));

      const library: Book[] = [
        {
          hash: 'H1',
          title: 'book',
          author: '',
          sourceTitle: 'book',
          format: 'EPUB',
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const store = createMockStore();
      const engine = new ShelfSyncEngine(adapter, appService, store);

      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
      });

      expect(result).toEqual({ reused: 1, downloaded: 0, removed: 0 });
      expect(adapter.downloadCalls).toEqual([]);

      const entry = store.entries.get('default:shelf-1:b1');
      expect(entry).toBeDefined();
      expect(entry?.bookHash).toBe('H1');
      expect(entry?.localPath).toBe('H1/book.epub');
      expect(entry?.managedByProvider).toBe(false);
    });

    it('Test B: cross-provider safety with reused book preserves file on unmanaged reference', async () => {
      const appService = createMockAppService();
      const book: Book = {
        hash: 'H1',
        title: 'book',
        author: '',
        sourceTitle: 'book',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const bookPath = getLocalBookFilename(book);
      appService.files.set(bookPath, new Uint8Array([1, 2, 3]));

      const library: Book[] = [book];

      const store = createMockStore();

      // Provider A previously downloaded and manages the book
      const adapterA = new FakeShelfAdapter('provider-a', 'conn-a');
      adapterA.remoteShelves.set('default:shelf-a', [
        { bookId: 'book-a', bookHash: 'H1', filename: 'book.pdf', format: 'PDF' },
      ]);
      store.entries.set('default:shelf-a:book-a', {
        provider: 'provider-a',
        connectionId: 'conn-a',
        shelfType: 'default',
        shelfId: 'shelf-a',
        bookId: 'book-a',
        bookHash: 'H1',
        localPath: bookPath,
        managedByProvider: true,
        lastSeenAt: Date.now(),
      });

      // Provider B syncs a shelf that reuses the same local book
      const adapterB = new FakeShelfAdapter('provider-b', 'conn-b');
      adapterB.remoteShelves.set('default:shelf-b', [
        { bookId: 'book-b', bookHash: 'H1', filename: 'book.pdf', format: 'PDF' },
      ]);
      const engineB = new ShelfSyncEngine(adapterB, appService, store);

      const resultB = await engineB.sync({
        shelfType: 'default',
        shelfId: 'shelf-b',
        library,
        onImported: () => {},
      });

      expect(resultB.reused).toBe(1);
      const entryB = store.entries.get('default:shelf-b:book-b');
      expect(entryB?.localPath).toBe(bookPath);
      expect(entryB?.managedByProvider).toBe(false);

      // Verify global all-reference count is 2 before removal
      const countsBefore = await store.getAllShelfReferenceCounts([bookPath]);
      expect(countsBefore.get(bookPath)).toBe(2);

      // Provider A removes the book with cleanupPolicy = remove_managed_copy
      adapterA.remoteShelves.set('default:shelf-a', []); // book removed from remote
      const engineA = new ShelfSyncEngine(adapterA, appService, store);
      const onRemovedA = vi.fn();

      const resultA = await engineA.sync({
        shelfType: 'default',
        shelfId: 'shelf-a',
        library,
        cleanupPolicy: 'remove_managed_copy',
        onImported: () => {},
        onRemoved: onRemovedA,
      });

      expect(resultA.removed).toBe(0);
      expect(onRemovedA).not.toHaveBeenCalled();
      // Local file and book remain intact!
      expect(appService.files.has(bookPath)).toBe(true);
      expect(library.some((b) => b.hash === 'H1')).toBe(true);

      // Provider A entry is removed, Provider B entry remains
      expect(store.entries.has('default:shelf-a:book-a')).toBe(false);
      expect(store.entries.has('default:shelf-b:book-b')).toBe(true);
    });

    it('Test C: changed revision already exists locally reuses new local path and clears managed ownership', async () => {
      const adapter = new FakeShelfAdapter();
      // Remote now has book 10 with NEW hash
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: '10', bookHash: 'NEW', filename: 'book-new.pdf', format: 'PDF' },
      ]);

      const bookOld: Book = {
        hash: 'OLD',
        title: 'book-old',
        author: '',
        sourceTitle: 'book-old',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const bookNew: Book = {
        hash: 'NEW',
        title: 'book-new',
        author: '',
        sourceTitle: 'book-new',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const oldPath = getLocalBookFilename(bookOld);
      const newPath = getLocalBookFilename(bookNew);

      const appService = createMockAppService();
      appService.files.set(oldPath, new Uint8Array([1]));
      appService.files.set(newPath, new Uint8Array([2]));

      const library: Book[] = [bookOld, bookNew];

      const store = createMockStore();
      // Previously tracked entry: bookId=10, hash=OLD, path=oldPath, managed=true
      store.entries.set('default:shelf-1:10', {
        provider: 'fake-provider',
        connectionId: 'conn-1',
        shelfType: 'default',
        shelfId: 'shelf-1',
        bookId: '10',
        bookHash: 'OLD',
        localPath: oldPath,
        managedByProvider: true,
        lastSeenAt: Date.now() - 1000,
      });

      const engine = new ShelfSyncEngine(adapter, appService, store);

      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
      });

      expect(result).toEqual({ reused: 1, downloaded: 0, removed: 0 });
      expect(adapter.downloadCalls).toEqual([]);

      const entry = store.entries.get('default:shelf-1:10');
      expect(entry).toBeDefined();
      expect(entry?.bookHash).toBe('NEW');
      expect(entry?.localPath).toBe(newPath);
      expect(entry?.managedByProvider).toBe(false);
      // Must NOT point NEW hash at OLD path
      expect(entry?.localPath).not.toBe(oldPath);
    });

    it('Test D: same managed file unchanged preserves existing path and managedByProvider=true', async () => {
      const adapter = new FakeShelfAdapter();
      // Remote still has same hash H1
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: '10', bookHash: 'H1', filename: 'book.pdf', format: 'PDF' },
      ]);

      const book: Book = {
        hash: 'H1',
        title: 'book',
        author: '',
        sourceTitle: 'book',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const bookPath = getLocalBookFilename(book);

      const appService = createMockAppService();
      appService.files.set(bookPath, new Uint8Array([1, 2, 3]));

      const library: Book[] = [book];

      const store = createMockStore();
      // Previously tracked entry: bookId=10, hash=H1, path=bookPath, managed=true
      store.entries.set('default:shelf-1:10', {
        provider: 'fake-provider',
        connectionId: 'conn-1',
        shelfType: 'default',
        shelfId: 'shelf-1',
        bookId: '10',
        bookHash: 'H1',
        localPath: bookPath,
        managedByProvider: true,
        lastSeenAt: Date.now() - 1000,
      });

      const engine = new ShelfSyncEngine(adapter, appService, store);

      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
      });

      expect(result).toEqual({ reused: 1, downloaded: 0, removed: 0 });
      expect(adapter.downloadCalls).toEqual([]);

      const entry = store.entries.get('default:shelf-1:10');
      expect(entry).toBeDefined();
      expect(entry?.bookHash).toBe('H1');
      expect(entry?.localPath).toBe(bookPath);
      expect(entry?.managedByProvider).toBe(true);
    });
  });

  describe('GrimmLink State Migration', () => {
    it('migrates subscriptions and entries idempotently without deleting old db', async () => {
      const mockLegacyDb = {
        async select(sql: string, _params?: unknown[]) {
          if (sql.includes('sqlite_master')) {
            return [{ name: 'shelf_subscriptions' }, { name: 'shelf_entries' }];
          }
          if (sql.includes('shelf_subscriptions')) {
            return [
              {
                shelf_type: 'regular',
                shelf_id: 101,
                enabled: 1,
                cleanup_policy: 'remove_managed_copy',
                download_policy: 'always',
              },
            ];
          }
          if (sql.includes('shelf_entries')) {
            return [
              {
                shelf_type: 'regular',
                shelf_id: 101,
                book_id: 202,
                book_hash: 'legacy-hash',
                local_path: 'legacy-hash/book.epub',
                managed_by_grimmlink: 1,
                last_seen_at: 1000,
              },
            ];
          }
          return [];
        },
        async close() {},
      };

      let dbDeleted = false;
      const appService = {
        openDatabase: async () => mockLegacyDb,
        deleteDatabase: async () => {
          dbDeleted = true;
        },
      } as unknown as AppService;

      const targetStore = {
        saveShelfSubscription: vi.fn().mockResolvedValue(undefined),
        markShelfEntries: vi.fn().mockResolvedValue(undefined),
      } as unknown as ShelfSyncStore;

      const result = await migrateGrimmLinkShelfState(appService, 'connection-1', targetStore);

      expect(result.migratedSubscriptions).toBe(1);
      expect(result.migratedEntries).toBe(1);
      expect(result.skipped).toBe(false);
      expect(dbDeleted).toBe(false);

      expect(targetStore.saveShelfSubscription).toHaveBeenCalledWith({
        provider: 'grimmlink',
        connectionId: 'connection-1',
        shelfType: 'regular',
        shelfId: '101',
        enabled: true,
        cleanupPolicy: 'remove_managed_copy',
        downloadPolicy: 'always',
        insertOnly: true,
      });

      expect(targetStore.markShelfEntries).toHaveBeenCalledWith(
        [
          {
            provider: 'grimmlink',
            connectionId: 'connection-1',
            shelfType: 'regular',
            shelfId: '101',
            bookId: '202',
            bookHash: 'legacy-hash',
            localPath: 'legacy-hash/book.epub',
            managedByProvider: true,
            lastSeenAt: 1000,
            insertOnly: true,
          },
        ],
        { insertOnly: true },
      );
    });
  });

  describe('Phase 8B: Revision Detection and Safe Replacement', () => {
    it('successfully replaces old managed copy when hash changes and cleanupPolicy is remove_managed_copy', async () => {
      const adapter = new FakeShelfAdapter();
      // Remote has new revision for b1
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);
      const appService = createMockAppService();
      // Library already has old revision
      const oldBook: Book = {
        hash: 'hash-book1-v1',
        title: 'book1-v1',
        author: '',
        sourceTitle: 'book1-v1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      appService.files.set('hash-book1-v1/book1-v1.pdf', new Uint8Array([1, 1, 1]));

      const store = createMockStore();
      // Previously tracked entry
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'hash-book1-v1',
          localPath: 'hash-book1-v1/book1-v1.pdf',
          managedByProvider: true,
        },
      ]);

      const removedBooks: Book[] = [];
      const engine = new ShelfSyncEngine(adapter, appService, store);
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        cleanupPolicy: 'remove_managed_copy',
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
        onRemoved: (book, updated) => {
          removedBooks.push(book);
          library.splice(0, library.length, ...updated);
        },
      });

      expect(result.reused).toBe(0);
      expect(result.downloaded).toBe(1);
      expect(result.removed).toBe(1);

      // New revision imported into library
      expect(library).toHaveLength(1);
      expect(library[0]?.title).toBe('book1-v2.pdf');
      // Old book purged
      expect(appService.deletedBooks).toContain('hash-book1-v1');
      expect(removedBooks).toHaveLength(1);
      expect(removedBooks[0]?.hash).toBe('hash-book1-v1');

      // Store tracking updated to new revision
      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.bookHash).toBe('h2');
      expect(entries[0]?.localPath).toBe('hash-book1-v2.pdf/book1-v2.pdf.pdf');
      expect(entries[0]?.managedByProvider).toBe(true);
    });

    it('retains old copy when cleanupPolicy is keep_local', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);
      const appService = createMockAppService();
      const oldBook: Book = {
        hash: 'hash-book1-v1.pdf',
        title: 'book1-v1.pdf',
        author: '',
        sourceTitle: 'book1-v1.pdf',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      appService.files.set('hash-book1-v1.pdf/book1-v1.pdf', new Uint8Array([1, 1, 1]));

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'hash-book1-v1.pdf/book1-v1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        cleanupPolicy: 'keep_local',
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
      });

      expect(result.downloaded).toBe(1);
      expect(result.removed).toBe(0);
      // Both books exist in library
      expect(library).toHaveLength(2);
      expect(appService.deletedBooks).not.toContain('hash-book1-v1.pdf');
    });

    it('retains old copy when managedByProvider is false', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);
      const appService = createMockAppService();
      const oldBook: Book = {
        hash: 'hash-book1-v1.pdf',
        title: 'book1-v1.pdf',
        author: '',
        sourceTitle: 'book1-v1.pdf',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      appService.files.set('hash-book1-v1.pdf/book1-v1.pdf', new Uint8Array([1, 1, 1]));

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'hash-book1-v1.pdf/book1-v1.pdf',
          managedByProvider: false, // user copy!
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        cleanupPolicy: 'remove_managed_copy',
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
      });

      expect(result.removed).toBe(0);
      expect(appService.deletedBooks).not.toContain('hash-book1-v1.pdf');
      expect(library).toHaveLength(2);
    });

    it('retains old copy when another shelf references it', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);
      const appService = createMockAppService();
      const oldBook: Book = {
        hash: 'hash-book1-v1.pdf',
        title: 'book1-v1.pdf',
        author: '',
        sourceTitle: 'book1-v1.pdf',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      appService.files.set('hash-book1-v1.pdf/book1-v1.pdf', new Uint8Array([1, 1, 1]));

      const store = createMockStore();
      // Tracked on shelf-1
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'hash-book1-v1.pdf/book1-v1.pdf',
          managedByProvider: true,
        },
        // Also tracked on shelf-2!
        {
          shelfType: 'default',
          shelfId: 'shelf-2',
          bookId: 'b100',
          bookHash: 'h1',
          localPath: 'hash-book1-v1.pdf/book1-v1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        cleanupPolicy: 'remove_managed_copy',
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
      });

      // Not removed because shelf-2 references the old file!
      expect(result.removed).toBe(0);
      expect(appService.deletedBooks).not.toContain('hash-book1-v1.pdf');
      expect(library).toHaveLength(2);
    });

    it('retains old valid copy and leaves store intact when download fails', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);
      // Simulate download failure
      vi.spyOn(adapter, 'downloadBook').mockRejectedValueOnce(new Error('Network failure'));

      const appService = createMockAppService();
      const oldBook: Book = {
        hash: 'hash-book1-v1.pdf',
        title: 'book1-v1.pdf',
        author: '',
        sourceTitle: 'book1-v1.pdf',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      appService.files.set('hash-book1-v1.pdf/book1-v1.pdf', new Uint8Array([1, 1, 1]));

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'hash-book1-v1.pdf/book1-v1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          cleanupPolicy: 'remove_managed_copy',
          onImported: (_book, updated) => {
            library.splice(0, library.length, ...updated);
          },
        }),
      ).rejects.toThrow('Network failure');

      // Old copy is untouched!
      expect(appService.deletedBooks).toHaveLength(0);
      expect(library).toHaveLength(1);
      expect(library[0]?.hash).toBe('hash-book1-v1.pdf');

      // Store entry is untouched!
      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries[0]?.bookHash).toBe('h1');
      expect(entries[0]?.localPath).toBe('hash-book1-v1.pdf/book1-v1.pdf');
    });

    it('retains old valid copy and leaves store intact when validation fails', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.epub', format: 'EPUB' },
      ]);
      // Downloaded data is corrupt (missing PK header for EPUB)
      adapter.downloads.set('b1', new TextEncoder().encode('corrupt non-epub data').buffer);

      const appService = createMockAppService();
      const oldBook: Book = {
        hash: 'hash-book1-v1.epub',
        title: 'book1-v1.epub',
        author: '',
        sourceTitle: 'book1-v1.epub',
        format: 'EPUB',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      appService.files.set('hash-book1-v1.epub/book1-v1.epub', new Uint8Array([1, 1, 1]));

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'hash-book1-v1.epub/book1-v1.epub',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          cleanupPolicy: 'remove_managed_copy',
          onImported: (_book, updated) => {
            library.splice(0, library.length, ...updated);
          },
        }),
      ).rejects.toThrow('Invalid EPUB');

      // Old copy is untouched!
      expect(appService.deletedBooks).toHaveLength(0);
      expect(library).toHaveLength(1);
      expect(library[0]?.hash).toBe('hash-book1-v1.epub');

      // Store entry is untouched!
      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries[0]?.bookHash).toBe('h1');
      expect(entries[0]?.localPath).toBe('hash-book1-v1.epub/book1-v1.epub');
    });

    it('retains old valid copy and leaves store intact when import fails', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);

      const appService = createMockAppService();
      // Simulate import failure
      vi.spyOn(appService, 'importBook').mockResolvedValueOnce(null as unknown as Book);

      const oldBook: Book = {
        hash: 'hash-book1-v1.pdf',
        title: 'book1-v1.pdf',
        author: '',
        sourceTitle: 'book1-v1.pdf',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      appService.files.set('hash-book1-v1.pdf/book1-v1.pdf', new Uint8Array([1, 1, 1]));

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'hash-book1-v1.pdf/book1-v1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          cleanupPolicy: 'remove_managed_copy',
          onImported: (_book, updated) => {
            library.splice(0, library.length, ...updated);
          },
        }),
      ).rejects.toThrow('Failed to import fake shelf book');

      // Old copy is untouched!
      expect(appService.deletedBooks).toHaveLength(0);
      expect(library).toHaveLength(1);
      expect(library[0]?.hash).toBe('hash-book1-v1.pdf');

      // Store entry is untouched!
      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries[0]?.bookHash).toBe('h1');
      expect(entries[0]?.localPath).toBe('hash-book1-v1.pdf/book1-v1.pdf');
    });

    it('repoints tracking without downloading when new revision is already present locally', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);

      const appService = createMockAppService();
      // Library ALREADY contains the new revision (e.g. imported earlier or by another shelf)
      const existingBookV2: Book = {
        hash: 'h2',
        title: 'existing-v2',
        author: '',
        sourceTitle: 'existing-v2',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [existingBookV2];
      appService.files.set('h2/existing-v2.pdf', new Uint8Array([1, 1, 1]));

      const store = createMockStore();
      // Tracked previously as h1
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/old.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        cleanupPolicy: 'remove_managed_copy',
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
      });

      expect(result.reused).toBe(1);
      expect(result.downloaded).toBe(0);
      expect(adapter.downloadCalls).toHaveLength(0);

      // Store tracking updated to the existing local book
      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.bookHash).toBe('h2');
      expect(entries[0]?.localPath).toBe('h2/existing-v2.pdf');
    });

    it('downloads null-hash revision when contentVersion or fileId changes', async () => {
      const adapter = new FakeShelfAdapter();
      adapter.remoteShelves.set('default:shelf-1', [
        {
          bookId: 'b1',
          bookHash: null as unknown as string,
          contentVersion: '2',
          fileId: 'f2',
          filename: 'book1-rev2.pdf',
          format: 'PDF',
        },
      ]);

      const appService = createMockAppService();
      const oldBook: Book = {
        hash: 'hash-book1-rev1.pdf',
        title: 'book1-rev1.pdf',
        author: '',
        sourceTitle: 'book1-rev1.pdf',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      appService.files.set('hash-book1-rev1.pdf/book1-rev1.pdf', new Uint8Array([1, 1, 1]));

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: null,
          contentVersion: '1',
          fileId: 'f1',
          localPath: 'hash-book1-rev1.pdf/book1-rev1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        cleanupPolicy: 'remove_managed_copy',
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
      });

      expect(result.downloaded).toBe(1);
      expect(result.removed).toBe(1);
      expect(adapter.downloadCalls).toEqual(['b1']);

      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries[0]?.contentVersion).toBe('2');
      expect(entries[0]?.fileId).toBe('f2');
    });
  });

  describe('Phase 8C: Managed Cleanup and Reference Safety (Data Safety Invariant)', () => {
    it('Scenario 1: user-owned same hash is never marked managed and never deleted', async () => {
      const adapter = new FakeShelfAdapter('bookorbit');
      adapter.remoteShelves.set('default:shelf-1', [
        {
          bookId: 'b1',
          bookHash: 'h1',
          filename: 'book1.pdf',
          format: 'PDF',
        },
      ]);

      const appService = createMockAppService();
      appService.files.set('h1/book1.pdf', new Uint8Array([1, 2, 3]));
      const userBook: Book = {
        hash: 'h1',
        title: 'book1',
        author: '',
        sourceTitle: 'book1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [userBook];
      const store = createMockStore();
      const engine = new ShelfSyncEngine(adapter, appService, store);

      // Step 1: Sync matches existing user-owned book
      const result1 = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });
      expect(result1.reused).toBe(1);
      expect(result1.downloaded).toBe(0);

      // Verify tracked entry has managedByProvider = false
      const entries1 = await store.getShelfEntries('shelf-1', 'default');
      expect(entries1[0]?.managedByProvider).toBe(false);

      // Step 2: Book is removed remotely
      adapter.remoteShelves.set('default:shelf-1', []);
      const result2 = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      // User book MUST NOT be deleted
      expect(result2.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
      expect(library).toContainEqual(userBook);
    });

    it('Scenario 2: BookOrbit-created copy is marked managed and deleted under remove_managed_copy', async () => {
      const adapter = new FakeShelfAdapter('bookorbit');
      adapter.remoteShelves.set('default:shelf-1', [
        {
          bookId: 'b1',
          bookHash: 'h1',
          filename: 'book1.pdf',
          format: 'PDF',
        },
      ]);

      const appService = createMockAppService();
      const library: Book[] = [];
      const store = createMockStore();
      const engine = new ShelfSyncEngine(adapter, appService, store);

      // Step 1: Initial sync downloads book
      const result1 = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
        cleanupPolicy: 'remove_managed_copy',
      });
      expect(result1.downloaded).toBe(1);
      const entries1 = await store.getShelfEntries('shelf-1', 'default');
      expect(entries1[0]?.managedByProvider).toBe(true);

      // Step 2: Book is removed remotely
      adapter.remoteShelves.set('default:shelf-1', []);
      const result2 = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });
      expect(result2.removed).toBe(1);
      expect(appService.deletedBooks.length).toBeGreaterThan(0);
    });

    it('Scenario 3: two BookOrbit shelves keep until final reference dereference', async () => {
      const adapter = new FakeShelfAdapter('bookorbit');
      adapter.remoteShelves.set('default:shelf-1', []);
      adapter.remoteShelves.set('default:shelf-2', [
        {
          bookId: 'b1',
          bookHash: 'h1',
          filename: 'book1.pdf',
          format: 'PDF',
        },
      ]);

      const appService = createMockAppService();
      appService.files.set('h1/book1.pdf', new Uint8Array([1, 2, 3]));
      const book: Book = {
        hash: 'h1',
        title: 'book1',
        author: '',
        sourceTitle: 'book1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [book];
      const store = createMockStore();

      // Tracked in both shelves
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
        {
          shelfType: 'default',
          shelfId: 'shelf-2',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      // Shelf 1 sync: book removed remotely from Shelf 1 -> KEPT because Shelf 2 references it
      const result1 = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });
      expect(result1.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);

      // Now remove from Shelf 2 as well
      adapter.remoteShelves.set('default:shelf-2', []);
      const result2 = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-2',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      // Final reference dereference -> DELETED
      expect(result2.removed).toBe(1);
      expect(appService.deletedBooks).toEqual(['h1']);
    });

    it('Scenario 4: BookOrbit + GrimmLink cross-provider reference keeps file', async () => {
      const adapter = new FakeShelfAdapter('bookorbit');
      adapter.remoteShelves.set('default:shelf-1', []);

      const appService = createMockAppService();
      appService.files.set('h1/book1.pdf', new Uint8Array([1, 2, 3]));
      const book: Book = {
        hash: 'h1',
        title: 'book1',
        author: '',
        sourceTitle: 'book1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [book];
      const store = createMockStore();

      // BookOrbit tracks it as managed
      await store.markShelfEntries([
        {
          provider: 'bookorbit',
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
      ]);
      // GrimmLink tracks the same file
      await store.markShelfEntries([
        {
          provider: 'grimmlink',
          shelfType: 'default',
          shelfId: 'shelf-grimmlink',
          bookId: 'g1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(result.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
    });

    it('Scenario 5: final managed reference with remove_managed_copy is deleted', async () => {
      const adapter = new FakeShelfAdapter('bookorbit');
      adapter.remoteShelves.set('default:shelf-1', []);

      const appService = createMockAppService();
      appService.files.set('h1/book1.pdf', new Uint8Array([1, 2, 3]));
      const book: Book = {
        hash: 'h1',
        title: 'book1',
        author: '',
        sourceTitle: 'book1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [book];
      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(result.removed).toBe(1);
      expect(appService.deletedBooks).toEqual(['h1']);
    });

    it('Scenario 6: keep_local cleanup policy preserves file and only removes tracking', async () => {
      const adapter = new FakeShelfAdapter('bookorbit');
      adapter.remoteShelves.set('default:shelf-1', []);

      const appService = createMockAppService();
      appService.files.set('h1/book1.pdf', new Uint8Array([1, 2, 3]));
      const book: Book = {
        hash: 'h1',
        title: 'book1',
        author: '',
        sourceTitle: 'book1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [book];
      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'keep_local',
      });

      expect(result.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
      expect(store.entries.size).toBe(0); // Tracking was removed
    });

    it('Scenario 7: user-replaced or ambiguous path keeps local book', async () => {
      const adapter = new FakeShelfAdapter('bookorbit');
      adapter.remoteShelves.set('default:shelf-1', []);

      const appService = createMockAppService();
      // Tracked entry has hash h1
      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
      ]);

      // Library has user-replaced book with different hash
      const userReplacedBook: Book = {
        hash: 'user-replaced-hash',
        title: 'book1',
        author: '',
        sourceTitle: 'book1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [userReplacedBook];

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      // User replaced book MUST NOT be deleted
      expect(result.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
      expect(library).toContainEqual(userReplacedBook);
    });

    it('Scenario 8: remote-only entry has nothing to delete', async () => {
      const adapter = new FakeShelfAdapter('bookorbit');
      adapter.remoteShelves.set('default:shelf-1', []);

      const appService = createMockAppService();
      const store = createMockStore();
      // Remote-only tracked entry
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: null,
          managedByProvider: false,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library: [],
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(result.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
      expect(appService.deletedFiles).toHaveLength(0);
    });

    it('Scenario 9: failed or partial snapshot performs zero cleanup and preserves membership', async () => {
      const adapter = new FakeShelfAdapter('bookorbit');
      adapter.getShelfBooks = async () => {
        throw new Error('Network error');
      };

      const appService = createMockAppService();
      appService.files.set('h1/book1.pdf', new Uint8Array([1, 2, 3]));
      const book: Book = {
        hash: 'h1',
        title: 'book1',
        author: '',
        sourceTitle: 'book1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [book];
      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: () => {},
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow('Network error');

      expect(appService.deletedBooks).toHaveLength(0);
      expect(store.entries.size).toBe(1);

      // Now test with explicit partial snapshot
      const partialSnapshot: ShelfSnapshot<FakeBook> = {
        status: 'partial',
        books: [],
      };
      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          snapshot: partialSnapshot,
          onImported: () => {},
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow();

      expect(appService.deletedBooks).toHaveLength(0);
      expect(store.entries.size).toBe(1);
    });

    it('Scenario 10: old revision cleanup only occurs after replacement is completely safe', async () => {
      const adapter = new FakeShelfAdapter('bookorbit');
      adapter.remoteShelves.set('default:shelf-1', [
        {
          bookId: 'b1',
          bookHash: 'h2',
          filename: 'book1-v2.pdf',
          format: 'PDF',
        },
      ]);

      const appService = createMockAppService();
      appService.files.set('h1/book1-v1.pdf', new Uint8Array([1, 1, 1]));
      const oldBook: Book = {
        hash: 'h1',
        title: 'book1-v1',
        author: '',
        sourceTitle: 'book1-v1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1-v1.pdf',
          managedByProvider: true,
        },
      ]);

      // Sub-case A: Download fails -> Old copy MUST NOT be deleted
      adapter.downloadBook = async () => {
        throw new Error('Download timeout');
      };
      const engine = new ShelfSyncEngine(adapter, appService, store);

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: () => {},
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow('Download timeout');

      expect(appService.deletedBooks).toHaveLength(0);
      const entriesAfterFailedDownload = await store.getShelfEntries('shelf-1', 'default');
      expect(entriesAfterFailedDownload[0]?.bookHash).toBe('h1');

      // Sub-case B: Successful replacement deletes old copy only when no other shelf references it
      adapter.downloadBook = async () => new TextEncoder().encode('%PDF-1.7 replacement').buffer;
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(result.downloaded).toBe(1);
      expect(result.removed).toBe(1);
      expect(appService.deletedBooks).toContain('h1');
    });
  });

  describe('Phase 8D: Crash Recovery, Fault Injection, and Transaction Boundaries', () => {
    it('Fault injection after temp creation: temp cleanup best effort, no DB mark, retry recovers', async () => {
      const adapter = new FakeShelfAdapter('bookorbit', 'conn-1');
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF' },
      ]);

      const appService = createMockAppService();
      const store = createMockStore();
      const engine = new ShelfSyncEngine(adapter, appService, store);

      const originalPlatform = process.env['NEXT_PUBLIC_APP_PLATFORM'];
      process.env['NEXT_PUBLIC_APP_PLATFORM'] = 'tauri';

      let tempCreated = false;
      adapter.downloadBookToFile = async (_book, _filePath) => {
        tempCreated = true;
        throw new Error('Disk write fault during download to file');
      };

      try {
        await expect(
          engine.sync({
            shelfType: 'default',
            shelfId: 'shelf-1',
            library: [],
            onImported: () => {},
          }),
        ).rejects.toThrow('Disk write fault during download to file');

        expect(tempCreated).toBe(true);
        // Best-effort temp deletion executed in finally
        expect(appService.deletedFiles.length).toBeGreaterThan(0);
        // DB not marked
        const entries = await store.getShelfEntries('shelf-1', 'default');
        expect(entries).toHaveLength(0);

        // Retry: downloadBookToFile restored and working
        adapter.downloadBookToFile = async (_book, filePath) => {
          appService.files.set(filePath, new TextEncoder().encode('%PDF-1.7 valid'));
        };

        const retryResult = await engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library: [],
          onImported: () => {},
        });

        expect(retryResult.downloaded).toBe(1);
        const entriesAfterRetry = await store.getShelfEntries('shelf-1', 'default');
        expect(entriesAfterRetry).toHaveLength(1);
        expect(entriesAfterRetry[0]?.managedByProvider).toBe(true);
      } finally {
        process.env['NEXT_PUBLIC_APP_PLATFORM'] = originalPlatform;
      }
    });

    it('Fault injection after download before validation: invalid download rejected, old copy kept, retry recovers', async () => {
      const adapter = new FakeShelfAdapter('bookorbit', 'conn-1');
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);

      const oldBook: Book = {
        hash: 'h1',
        title: 'book1-v1',
        author: '',
        sourceTitle: 'book1-v1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      const appService = createMockAppService();
      appService.files.set('h1/book1-v1.pdf', new Uint8Array([1, 2, 3]));

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1-v1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      // Fault: network download completes, but returns empty payload
      adapter.downloadBook = async () => new ArrayBuffer(0);

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: () => {},
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow('Empty download');

      // Guarantee: old valid revision preserved until safe
      expect(appService.deletedBooks).toHaveLength(0);
      expect(library).toHaveLength(1);
      expect(library[0]?.hash).toBe('h1');
      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries[0]?.bookHash).toBe('h1');

      // Retry: adapter now provides valid PDF payload
      adapter.downloadBook = async () => new TextEncoder().encode('%PDF-1.7 new valid').buffer;

      const retryResult = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(retryResult.downloaded).toBe(1);
      expect(retryResult.removed).toBe(1);
      expect(appService.deletedBooks).toContain('h1');
      const entriesAfter = await store.getShelfEntries('shelf-1', 'default');
      expect(entriesAfter[0]?.bookHash).toBe('h2');
    });

    it('Fault injection during/after validation: corrupt data throws, no library save or DB mark, retry recovers', async () => {
      const adapter = new FakeShelfAdapter('bookorbit', 'conn-1');
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF', size: 100 },
      ]);

      // Download returns wrong magic bytes for PDF
      const corruptBytes = new Uint8Array(100);
      corruptBytes.fill(0xaa);
      adapter.downloadBook = async () => corruptBytes.buffer;

      const appService = createMockAppService();
      const store = createMockStore();
      const library: Book[] = [];
      const engine = new ShelfSyncEngine(adapter, appService, store);

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: () => {},
        }),
      ).rejects.toThrow('Invalid PDF');

      expect(library).toHaveLength(0);
      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries).toHaveLength(0);

      // Retry: valid PDF provided
      const validPdfBytes = new Uint8Array(100);
      validPdfBytes.set(new TextEncoder().encode('%PDF-1.7 valid pdf test content'));
      adapter.downloadBook = async () => validPdfBytes.buffer;

      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: (book) => {
          library.push(book);
        },
      });

      expect(result.downloaded).toBe(1);
      expect(library).toHaveLength(1);
      const entriesAfter = await store.getShelfEntries('shelf-1', 'default');
      expect(entriesAfter).toHaveLength(1);
      expect(entriesAfter[0]?.managedByProvider).toBe(true);
    });

    it('Fault injection during import: import failure never marked success, old revision preserved, retry recovers', async () => {
      const adapter = new FakeShelfAdapter('bookorbit', 'conn-1');
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);

      const oldBook: Book = {
        hash: 'h1',
        title: 'book1-v1',
        author: '',
        sourceTitle: 'book1-v1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      const appService = createMockAppService();
      appService.files.set('h1/book1-v1.pdf', new Uint8Array([1, 2, 3]));

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1-v1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      // Injected fault in appService.importBook
      const originalImportBook = appService.importBook;
      appService.importBook = async () => {
        throw new Error('Unreadable PDF stream in importBook');
      };

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: () => {},
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow('Unreadable PDF stream in importBook');

      // Guarantee failed import not marked success
      expect(library).toHaveLength(1);
      expect(library[0]?.hash).toBe('h1');
      expect(appService.deletedBooks).toHaveLength(0);
      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries[0]?.bookHash).toBe('h1');

      // Retry: restore importBook
      appService.importBook = originalImportBook;

      const retryResult = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(retryResult.downloaded).toBe(1);
      expect(retryResult.removed).toBe(1);
      expect(appService.deletedBooks).toContain('h1');
      const entriesAfter = await store.getShelfEntries('shelf-1', 'default');
      expect(entriesAfter[0]?.bookHash).toBe('h2');
    });

    it('Fault injection after import before DB mark: rolls back library and purges book, old revision preserved, retry recovers', async () => {
      const adapter = new FakeShelfAdapter('bookorbit', 'conn-1');
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);

      const oldBook: Book = {
        hash: 'h1',
        title: 'book1-v1',
        author: '',
        sourceTitle: 'book1-v1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      const appService = createMockAppService();
      appService.files.set('h1/book1-v1.pdf', new Uint8Array([1, 2, 3]));

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1-v1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      // Fault: onImported throws before DB mark
      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: () => {
            throw new Error('Database transaction lock error in onImported');
          },
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow('Database transaction lock error in onImported');

      // Verify rollback:
      // 1. Newly imported book purged
      expect(appService.deletedBooks).toContain('hash-book1-v2.pdf');
      // 2. Old copy kept and not purged
      expect(appService.deletedBooks).not.toContain('h1');
      // 3. Library array restored to old state
      expect(library).toHaveLength(1);
      expect(library[0]?.hash).toBe('h1');
      // 4. Store still points to old book
      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries[0]?.bookHash).toBe('h1');

      // Retry: onImported succeeds
      const retryResult = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(retryResult.downloaded).toBe(1);
      expect(retryResult.removed).toBe(1);
      expect(appService.deletedBooks).toContain('h1');
      const entriesAfter = await store.getShelfEntries('shelf-1', 'default');
      expect(entriesAfter[0]?.bookHash).toBe('h2');
    });

    it('Fault injection during DB mark: store error rolls back import, old copy preserved, retry recovers', async () => {
      const adapter = new FakeShelfAdapter('bookorbit', 'conn-1');
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h2', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);

      const oldBook: Book = {
        hash: 'h1',
        title: 'book1-v1',
        author: '',
        sourceTitle: 'book1-v1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      const appService = createMockAppService();
      appService.files.set('h1/book1-v1.pdf', new Uint8Array([1, 2, 3]));

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1-v1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      // Fault: store.markShelfEntries throws SQLite write failure on new book
      const originalMarkEntries = store.markShelfEntries.bind(store);
      store.markShelfEntries = async (writes) => {
        if (writes.some((w) => w.bookHash === 'h2' || w.bookId === 'b1')) {
          throw new Error('SQLite busy: disk I/O error');
        }
        return originalMarkEntries(writes);
      };

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: (_book, updated) => {
            library.splice(0, library.length, ...updated);
          },
          onRemoved: (_book, updated) => {
            library.splice(0, library.length, ...updated);
          },
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow('SQLite busy: disk I/O error');

      // Verify rollback:
      expect(appService.deletedBooks).toContain('hash-book1-v2.pdf');
      expect(appService.deletedBooks).not.toContain('h1');
      expect(library).toHaveLength(1);
      expect(library[0]?.hash).toBe('h1');

      // Retry: store restored
      store.markShelfEntries = originalMarkEntries;

      const retryResult = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
        onRemoved: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(retryResult.downloaded).toBe(1);
      expect(retryResult.removed).toBe(1);
      expect(appService.deletedBooks).toContain('h1');
    });

    it('Fault injection during obsolete revision cleanup: cleanup error preserves old book, retry recovers', async () => {
      const adapter = new FakeShelfAdapter('bookorbit', 'conn-1');
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'hash-book1-v2.pdf', filename: 'book1-v2.pdf', format: 'PDF' },
      ]);

      const oldBook: Book = {
        hash: 'h1',
        title: 'book1-v1',
        author: '',
        sourceTitle: 'book1-v1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [oldBook];
      const appService = createMockAppService();
      appService.files.set('h1/book1-v1.pdf', new Uint8Array([1, 2, 3]));

      const store = createMockStore();
      await store.markShelfEntries([
        {
          shelfType: 'default',
          shelfId: 'shelf-1',
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book1-v1.pdf',
          managedByProvider: true,
        },
      ]);

      const engine = new ShelfSyncEngine(adapter, appService, store);

      // Fault: deleteBook for old book throws (e.g. file lock on Windows)
      const originalDeleteBook = appService.deleteBook.bind(appService);
      appService.deleteBook = async (book, mode) => {
        if (book.hash === 'h1') {
          throw new Error('EBUSY: resource locked on Windows during purge');
        }
        return originalDeleteBook(book, mode);
      };

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library,
          onImported: (_book, updated) => {
            library.splice(0, library.length, ...updated);
          },
          onRemoved: (_book, updated) => {
            library.splice(0, library.length, ...updated);
          },
          cleanupPolicy: 'remove_managed_copy',
        }),
      ).rejects.toThrow('EBUSY: resource locked on Windows during purge');

      // Data safety invariant: old book kept!
      expect(library.some((b) => b.hash === 'h1')).toBe(true);
      // New book was imported and marked in DB
      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries[0]?.bookHash).toBe('hash-book1-v2.pdf');

      // Retry: file lock released
      appService.deleteBook = originalDeleteBook;

      const retryResult = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
        onRemoved: (_book, updated) => {
          library.splice(0, library.length, ...updated);
        },
        cleanupPolicy: 'remove_managed_copy',
      });

      // New book is reused; retry completes safely
      expect(retryResult.reused).toBe(1);
    });

    it('Cancellation at each phase never becomes success and leaves zero orphan state', async () => {
      const adapter = new FakeShelfAdapter('bookorbit', 'conn-1');
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF' },
        { bookId: 'b2', bookHash: 'h2', filename: 'book2.pdf', format: 'PDF' },
      ]);

      const appService = createMockAppService();
      const store = createMockStore();
      const engine = new ShelfSyncEngine(adapter, appService, store);

      // Phase A: Pre-aborted signal before sync begins
      const controllerA = new AbortController();
      controllerA.abort();
      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library: [],
          onImported: () => {},
          transfer: { signal: controllerA.signal },
        }),
      ).rejects.toThrow('Shelf sync cancelled');

      expect(appService.createdDirs).toHaveLength(0);
      expect(await store.getShelfEntries('shelf-1', 'default')).toHaveLength(0);

      // Phase B: Abort right after first book download
      const controllerB = new AbortController();
      let downloadsAttempted = 0;
      adapter.downloadBook = async () => {
        downloadsAttempted += 1;
        if (downloadsAttempted === 1) {
          controllerB.abort();
        }
        return new TextEncoder().encode('%PDF-1.7 data').buffer;
      };

      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library: [],
          onImported: () => {},
          transfer: { signal: controllerB.signal },
        }),
      ).rejects.toThrow('Shelf sync cancelled');

      // Second book was never downloaded
      expect(downloadsAttempted).toBe(1);

      // Phase C: Abort right after import before DB mark
      const controllerC = new AbortController();
      downloadsAttempted = 0;
      adapter.downloadBook = async () => new TextEncoder().encode('%PDF-1.7 data').buffer;

      const libraryC: Book[] = [];
      await expect(
        engine.sync({
          shelfType: 'default',
          shelfId: 'shelf-1',
          library: libraryC,
          onImported: () => {
            controllerC.abort();
          },
          transfer: { signal: controllerC.signal },
        }),
      ).rejects.toThrow('Shelf sync cancelled');

      // Imported book rolled back / purged
      expect(libraryC).toHaveLength(0);
      expect(appService.deletedBooks.length).toBeGreaterThan(0);
      expect(await store.getShelfEntries('shelf-1', 'default')).toHaveLength(0);

      // Final: Clean retry with fresh uncancelled controller succeeds completely
      const freshLibrary: Book[] = [];
      const finalResult = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library: freshLibrary,
        onImported: (book) => {
          freshLibrary.push(book);
        },
      });

      expect(finalResult.downloaded).toBe(2);
      expect(freshLibrary).toHaveLength(2);
      const finalEntries = await store.getShelfEntries('shelf-1', 'default');
      expect(finalEntries).toHaveLength(2);
      expect(finalEntries.every((e) => e.managedByProvider)).toBe(true);
    });

    it('Ownership safety on crash recovery: unconfirmed crash reuse sets managedByProvider=false', async () => {
      const adapter = new FakeShelfAdapter('bookorbit', 'conn-1');
      adapter.remoteShelves.set('default:shelf-1', [
        { bookId: 'b1', bookHash: 'h1', filename: 'book1.pdf', format: 'PDF' },
      ]);

      // Simulate a hard power loss crash that occurred after a book was placed on disk/library
      // but BEFORE store.markShelfEntries could run
      const bookOnDisk: Book = {
        hash: 'h1',
        title: 'book1',
        author: '',
        sourceTitle: 'book1',
        format: 'PDF',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [bookOnDisk];
      const appService = createMockAppService();
      appService.files.set('h1/book1.pdf', new Uint8Array([1, 2, 3]));

      // Store has NO record of b1
      const store = createMockStore();
      const engine = new ShelfSyncEngine(adapter, appService, store);

      // On retry/re-sync:
      const result = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      // The existing local book is reused
      expect(result.reused).toBe(1);
      expect(result.downloaded).toBe(0);

      // Guarantee: "managed only after ownership known"
      // Because ownership was not confirmed before the crash, it must be marked managedByProvider = false
      const entries = await store.getShelfEntries('shelf-1', 'default');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.managedByProvider).toBe(false);

      // Subsequent deletion test: if b1 disappears from remote snapshot, it MUST NOT be deleted!
      adapter.remoteShelves.set('default:shelf-1', []);
      const deletionResult = await engine.sync({
        shelfType: 'default',
        shelfId: 'shelf-1',
        library,
        onImported: () => {},
        cleanupPolicy: 'remove_managed_copy',
      });

      expect(deletionResult.removed).toBe(0);
      expect(appService.deletedBooks).toHaveLength(0);
      expect(library).toHaveLength(1);
    });
  });
});
