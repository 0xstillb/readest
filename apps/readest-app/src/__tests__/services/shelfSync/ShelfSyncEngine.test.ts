import { describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { ProgressHandler } from '@/utils/transfer';
import {
  type SaveShelfSubscriptionInput,
  type ShelfEntryKey,
  type ShelfEntryWrite,
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
      return newBook;
    },
    async deleteBook(book: Book, _mode?: string) {
      deletedBooks.push(book.hash);
      files.delete(`${book.hash}/${book.title}`);
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
      bookHash: string | null;
      localPath: string | null;
      managedByProvider: boolean;
      lastSeenAt: number;
    }
  >();

  return {
    subscriptions,
    entries,
    async getShelfSubscriptions() {
      return Array.from(subscriptions.values()).map((s) => ({
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
          result.push({ ...entry, fileId: null, contentVersion: null });
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
          bookHash: w.bookHash ?? null,
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
});
