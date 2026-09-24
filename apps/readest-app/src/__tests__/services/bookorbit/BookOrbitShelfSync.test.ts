import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type {
  IShelfSyncStore,
  SaveShelfSubscriptionInput,
  ShelfEntryRecord,
  ShelfEntryWrite,
  ShelfSubscriptionRecord,
} from '@/services/shelfSync/types';
import { BookOrbitClient } from '@/services/bookorbit/BookOrbitClient';
import {
  type BookOrbitAppService,
  type BookOrbitShelfBook,
  BookOrbitShelfAdapter,
} from '@/services/bookorbit/shelfDownload';
import {
  fetchBookOrbitShelves,
  previewBookOrbitShelfSync,
  syncSubscribedBookOrbitShelves,
} from '@/services/bookorbit/shelfSync';
import { getLocalBookFilename } from '@/utils/book';

const createMockStore = (): IShelfSyncStore & {
  subscriptions: ShelfSubscriptionRecord[];
  markedEntries: ShelfEntryWrite[];
  deletedEntries: { shelfId: string; shelfType: string; bookIds: string[] }[];
} => {
  const subscriptions: ShelfSubscriptionRecord[] = [];
  const entries: ShelfEntryRecord[] = [];
  const markedEntries: ShelfEntryWrite[] = [];
  const deletedEntries: { shelfId: string; shelfType: string; bookIds: string[] }[] = [];

  return {
    subscriptions,
    markedEntries,
    deletedEntries,
    async getShelfSubscriptions(filter?: { enabledOnly?: boolean }) {
      if (filter?.enabledOnly) {
        return subscriptions.filter((s) => s.enabled);
      }
      return [...subscriptions];
    },
    async saveShelfSubscription(sub: SaveShelfSubscriptionInput) {
      const shelfType = sub.shelfType ?? 'default';
      const shelfId = String(sub.shelfId);
      const idx = subscriptions.findIndex(
        (s) => s.shelfType === shelfType && s.shelfId === shelfId,
      );
      const record: ShelfSubscriptionRecord = {
        provider: sub.provider ?? 'bookorbit',
        connectionId: sub.connectionId ?? 'conn1',
        shelfType,
        shelfId,
        enabled: sub.enabled ?? true,
        cleanupPolicy: sub.cleanupPolicy ?? 'keep_local',
        downloadPolicy: sub.downloadPolicy ?? 'always',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (idx >= 0) subscriptions[idx] = record;
      else subscriptions.push(record);
    },
    async deleteShelfSubscription(shelfId: string | number, shelfType: string) {
      const idx = subscriptions.findIndex(
        (s) => s.shelfType === shelfType && s.shelfId === String(shelfId),
      );
      if (idx >= 0) subscriptions.splice(idx, 1);
    },
    async getShelfEntries(shelfId: string | number, shelfType: string) {
      return entries.filter((e) => e.shelfId === String(shelfId) && e.shelfType === shelfType);
    },
    async markShelfEntries(writes: ShelfEntryWrite[]) {
      markedEntries.push(...writes);
      for (const w of writes) {
        const shelfType = w.shelfType ?? 'collection';
        const shelfId = String(w.shelfId);
        const bookId = String(w.bookId);
        const idx = entries.findIndex(
          (e) => e.shelfId === shelfId && e.shelfType === shelfType && e.bookId === bookId,
        );
        const row: ShelfEntryRecord = {
          provider: w.provider ?? 'bookorbit',
          connectionId: w.connectionId ?? 'conn1',
          shelfType,
          shelfId,
          bookId,
          fileId: w.fileId ? String(w.fileId) : null,
          contentVersion: w.contentVersion ?? null,
          bookHash: w.bookHash ?? null,
          localPath: w.localPath ?? null,
          managedByProvider: w.managedByProvider ?? true,
          lastSeenAt: Date.now(),
        };
        if (idx >= 0) entries[idx] = row;
        else entries.push(row);
      }
    },
    async removeShelfEntries(
      entriesToDelete: import('@/services/shelfSync/types').ShelfEntryKey[],
    ) {
      for (const entry of entriesToDelete) {
        deletedEntries.push({
          shelfId: String(entry.shelfId),
          shelfType: entry.shelfType ?? '',
          bookIds: [String(entry.bookId)],
        });
        const idx = entries.findIndex(
          (e) =>
            e.shelfId === String(entry.shelfId) &&
            e.shelfType === (entry.shelfType ?? '') &&
            e.bookId === String(entry.bookId),
        );
        if (idx >= 0) entries.splice(idx, 1);
      }
    },
    async getAllShelfReferenceCounts(paths: string[]) {
      const counts = new Map<string, number>();
      for (const p of paths) {
        counts.set(p, entries.filter((e) => e.localPath === p).length);
      }
      return counts;
    },
    async getManagedShelfReferenceCounts(paths: string[]) {
      const counts = new Map<string, number>();
      for (const p of paths) {
        counts.set(p, entries.filter((e) => e.localPath === p && e.managedByProvider).length);
      }
      return counts;
    },
  };
};

const createMockAppService = () => {
  const files = new Map<string, Uint8Array>();
  const deletedBooks: Book[] = [];

  const appService: BookOrbitAppService & {
    files: Map<string, Uint8Array>;
    deletedBooks: Book[];
  } = {
    files,
    deletedBooks,
    async exists(path: string, _folder?: string) {
      return files.has(path);
    },
    async createDir() {},
    async writeFile(path: string, _folder?: string, content?: unknown) {
      if (content instanceof Uint8Array) files.set(path, content);
      else if (content instanceof ArrayBuffer) files.set(path, new Uint8Array(content));
      else files.set(path, new Uint8Array());
    },
    async resolveFilePath(path: string) {
      return `/mock/${path}`;
    },
    async deleteFile(path: string) {
      files.delete(path);
    },
    async stats(path: string) {
      const data = files.get(path);
      if (!data) throw new Error('Not found');
      return {
        isFile: true,
        isDirectory: false,
        size: data.byteLength,
        mtime: new Date(),
        atime: new Date(),
        birthtime: new Date(),
      };
    },
    async openFile(path: string) {
      const data = files.get(path) ?? new Uint8Array();
      return {
        name: path.split('/').pop() || 'file',
        size: data.byteLength,
        slice(start = 0, end = data.byteLength) {
          const sliceBytes = data.subarray(start, end);
          return {
            async arrayBuffer() {
              return sliceBytes.buffer.slice(
                sliceBytes.byteOffset,
                sliceBytes.byteOffset + sliceBytes.byteLength,
              );
            },
          };
        },
      } as unknown as File;
    },
    async readFile(path: string): Promise<string | ArrayBuffer> {
      const data = files.get(path);
      if (!data) throw new Error('Not found');
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      return copy.buffer;
    },
    async importBook(source: string | File) {
      const filename =
        typeof source === 'string' ? source.split('/').pop() || 'book.epub' : source.name;
      const hash = `hash-${filename}`;
      files.set(filename, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      return {
        hash,
        title: filename.replace(/\.[^.]+$/, ''),
        format: 'epub',
      } as unknown as Book;
    },
    async deleteBook(book: Book) {
      deletedBooks.push(book);
    },
  };

  return appService;
};

describe('BookOrbit Client Shelves & Books API', () => {
  it('fetches and normalizes Collections and SmartScopes', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/plugin/collections')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            collections: [
              { id: 10, name: 'Favorites', description: 'My favorite books', count: 5 },
            ],
          }),
        };
      }
      if (url.includes('/plugin/smartscopes')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 20, title: 'Unread Sci-Fi', bookCount: 12 }],
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = new BookOrbitClient({
      serverUrl: 'http://192.168.1.50:3000',
      username: 'testuser',
      userkey: 'testkey',
      deviceId: 'dev1',
      deviceName: 'Device',
      strategy: 'silent',
      enabled: true,
      syncProgress: true,
      syncNotes: true,
      syncStats: true,
      syncBookStates: true,
    });

    const collections = await client.getCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0]).toEqual({
      id: '10',
      name: 'Favorites',
      type: 'collection',
      description: 'My favorite books',
      bookCount: 5,
    });

    const smartscopes = await client.getSmartScopes();
    expect(smartscopes).toHaveLength(1);
    expect(smartscopes[0]).toEqual({
      id: '20',
      name: 'Unread Sci-Fi',
      type: 'smartscope',
      description: undefined,
      bookCount: 12,
    });

    const allShelves = await client.getShelves();
    expect(allShelves).toHaveLength(2);

    const shelvesFromHelper = await fetchBookOrbitShelves(client);
    expect(shelvesFromHelper).toHaveLength(2);

    vi.unstubAllGlobals();
  });

  it('handles fallback routes when primary plugin endpoints 404', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/plugin/collections')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (url.endsWith('/collections')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'col-1', name: 'Fallback Collection' }],
        };
      }
      if (url.endsWith('/plugin/smartscopes')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (url.endsWith('/plugin/smart-scopes')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'scope-1', name: 'Fallback Scope' }],
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = new BookOrbitClient({
      serverUrl: 'http://192.168.1.50:3000',
      username: 'testuser',
      userkey: 'testkey',
      deviceId: 'dev1',
      deviceName: 'Device',
      strategy: 'silent',
      enabled: true,
      syncProgress: true,
      syncNotes: true,
      syncStats: true,
      syncBookStates: true,
    });

    const collections = await client.getCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0]?.name).toBe('Fallback Collection');

    const scopes = await client.getSmartScopes();
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.name).toBe('Fallback Scope');

    vi.unstubAllGlobals();
  });

  it('fetches and normalizes shelf books for both collections and smartscopes', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/collections/10/books')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            books: [
              {
                id: 101,
                title: 'Dune',
                author: 'Frank Herbert',
                format: 'epub',
                hash: 'hash-dune',
                fileId: 501,
                sizeBytes: 12345,
              },
            ],
          }),
        };
      }
      if (url.includes('/smartscopes/20/books')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              bookId: 202,
              title: 'Neuromancer',
              authors: ['William Gibson'],
              filename: 'neuromancer.epub',
              fileHash: 'hash-neuro',
            },
          ],
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = new BookOrbitClient({
      serverUrl: 'http://192.168.1.50:3000',
      username: 'testuser',
      userkey: 'testkey',
      deviceId: 'dev1',
      deviceName: 'Device',
      strategy: 'silent',
      enabled: true,
      syncProgress: true,
      syncNotes: true,
      syncStats: true,
      syncBookStates: true,
    });

    const colBooks = await client.getShelfBooks('collection', 10);
    expect(colBooks).toHaveLength(1);
    expect(colBooks[0]?.title).toBe('Dune');
    expect(colBooks[0]?.author).toBe('Frank Herbert');
    expect(colBooks[0]?.fileId).toBe('501');
    expect(colBooks[0]?.bookHash).toBe('hash-dune');

    const scopeBooks = await client.getShelfBooks('smartscope', 20);
    expect(scopeBooks).toHaveLength(1);
    expect(scopeBooks[0]?.title).toBe('Neuromancer');
    expect(scopeBooks[0]?.author).toBe('William Gibson');
    expect(scopeBooks[0]?.filename).toBe('neuromancer.epub');
    expect(scopeBooks[0]?.fileHash).toBe('hash-neuro');

    vi.unstubAllGlobals();
  });
});

describe('BookOrbit Shelf Sync & Preview', () => {
  let appService: ReturnType<typeof createMockAppService>;
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    appService = createMockAppService();
    store = createMockStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('previews downloads, updates, and removals accurately', async () => {
    const mockClient = {
      async getShelfBooks(_type: string, shelfId: string | number): Promise<BookOrbitShelfBook[]> {
        if (String(shelfId) === 'col-1') {
          return [
            { bookId: 'b1', filename: 'b1.epub', format: 'epub', bookHash: 'hash-b1' },
            { bookId: 'b2', filename: 'b2.epub', format: 'epub', bookHash: 'hash-b2-v2' },
          ];
        }
        return [];
      },
    };

    store.subscriptions.push({
      provider: 'bookorbit',
      connectionId: 'conn1',
      shelfType: 'collection',
      shelfId: 'col-1',
      enabled: true,
      cleanupPolicy: 'keep_local',
      downloadPolicy: 'always',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Existing tracked entries: b2 has old hash, b3 was removed from remote
    await store.markShelfEntries([
      {
        provider: 'bookorbit',
        connectionId: 'conn1',
        shelfType: 'collection',
        shelfId: 'col-1',
        bookId: 'b2',
        bookHash: 'hash-b2-v1',
        localPath: 'b2.epub',
        managedByProvider: true,
      },
      {
        provider: 'bookorbit',
        connectionId: 'conn1',
        shelfType: 'collection',
        shelfId: 'col-1',
        bookId: 'b3',
        bookHash: 'hash-b3',
        localPath: 'b3.epub',
        managedByProvider: true,
      },
    ]);

    // Local library only has b2
    const library: Book[] = [
      { hash: 'hash-b2-v1', title: 'b2', format: 'epub' } as unknown as Book,
    ];

    const preview = await previewBookOrbitShelfSync(mockClient, store, library, {
      serverUrl: 'https://orbit.example.com',
    });

    expect(preview.total).toBe(2);
    expect(preview.downloads).toBe(2); // b1 (new) + b2 (changed hash)
    expect(preview.changed).toBe(1); // b2
    expect(preview.removed).toBe(1); // b3
  });

  it('executes manual sync: downloads new books, preserves reused books, handles cleanup policy', async () => {
    const epubBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => epubBytes.buffer,
      }),
    );

    const mockClient = {
      async getShelfBooks(_type: string, _shelfId: string | number): Promise<BookOrbitShelfBook[]> {
        return [
          {
            bookId: 'remote-1',
            filename: 'remote-1.epub',
            format: 'epub',
            bookHash: 'hash-remote-1.epub',
          },
          {
            bookId: 'remote-2',
            filename: 'existing.epub',
            format: 'epub',
            bookHash: 'hash-existing.epub',
          },
        ];
      },
    };

    store.subscriptions.push({
      provider: 'bookorbit',
      connectionId: 'orbit-conn',
      shelfType: 'collection',
      shelfId: 'shelf-100',
      enabled: true,
      cleanupPolicy: 'remove_managed_copy',
      downloadPolicy: 'always',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const bookExisting = {
      hash: 'hash-existing.epub',
      title: 'existing',
      format: 'epub',
    } as unknown as Book;
    const book3 = {
      hash: 'hash-remote-3.epub',
      title: 'remote-3',
      format: 'epub',
    } as unknown as Book;
    const pathExisting = getLocalBookFilename(bookExisting);
    const path3 = getLocalBookFilename(book3);

    // Remote-3 was in shelf previously, now removed from remote
    await store.markShelfEntries([
      {
        provider: 'bookorbit',
        connectionId: 'orbit-conn',
        shelfType: 'collection',
        shelfId: 'shelf-100',
        bookId: 'remote-3',
        bookHash: 'hash-remote-3.epub',
        localPath: path3,
        managedByProvider: true,
      },
    ]);

    // Setup library: existing.epub already exists locally (should be reused with managed = false)
    // remote-3.epub exists locally and was managed (should be removed)
    appService.files.set(pathExisting, epubBytes);
    appService.files.set(path3, epubBytes);
    const library: Book[] = [bookExisting, book3];

    const adapter = new BookOrbitShelfAdapter(
      { serverUrl: 'https://orbit.example.com' },
      'orbit-conn',
      mockClient,
    );

    const onImported = vi.fn();
    const onRemoved = vi.fn();

    const result = await syncSubscribedBookOrbitShelves(
      adapter,
      store,
      () => library,
      onImported,
      appService,
      undefined,
      onRemoved,
    );

    expect(result.downloaded).toBe(1); // remote-1
    expect(result.reused).toBe(1); // remote-2 / existing
    expect(result.removed).toBe(1); // remote-3

    // Verify remote-1 marked as managed
    const entry1 = store.markedEntries.find((e) => e.bookId === 'remote-1');
    expect(entry1?.managedByProvider).toBe(true);

    // Verify reused existing book marked as unmanaged
    const entry2 = store.markedEntries.find((e) => e.bookId === 'remote-2');
    expect(entry2?.managedByProvider).toBe(false);

    // Verify remote-3 removed from store
    expect(store.deletedEntries).toHaveLength(1);
    expect(store.deletedEntries[0]?.bookIds).toContain('remote-3');
  });

  it('respects cancellation signal during sync without data corruption', async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    const mockClient = {
      async getShelfBooks(): Promise<BookOrbitShelfBook[]> {
        return [{ bookId: 'b1', filename: 'b1.epub', format: 'epub', bookHash: 'hash-b1' }];
      },
    };

    store.subscriptions.push({
      provider: 'bookorbit',
      connectionId: 'orbit-conn',
      shelfType: 'collection',
      shelfId: 'c1',
      enabled: true,
      cleanupPolicy: 'keep_local',
      downloadPolicy: 'always',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const adapter = new BookOrbitShelfAdapter(
      { serverUrl: 'https://orbit.example.com' },
      'orbit-conn',
      mockClient,
    );

    await expect(
      syncSubscribedBookOrbitShelves(adapter, store, () => [], vi.fn(), appService, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');

    // No entries should have been marked or deleted
    expect(store.markedEntries).toHaveLength(0);
    expect(store.deletedEntries).toHaveLength(0);
  });
});
