import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import { getLocalBookFilename } from '@/utils/book';
import type { IShelfSyncStore, ShelfEntryWrite } from '@/services/shelfSync/types';
import {
  type BookOrbitAppService,
  type BookOrbitDownloadConfig,
  type BookOrbitShelfDownloadItem,
  BookOrbitShelfAdapter,
  BookOrbitShelfDownloader,
  buildBookOrbitDownloadUrl,
  buildBookOrbitHeaders,
  downloadAndImportBookOrbitBook,
  downloadAndImportBookOrbitBooksSerially,
  validateBookOrbitDownload,
} from '@/services/bookorbit/shelfDownload';

const tauriDownloadMock = vi.fn();
vi.mock('@/utils/transfer', () => ({
  tauriDownload: (...args: unknown[]) => tauriDownloadMock(...args),
}));

const createMockAppService = () => {
  const files = new Map<string, Uint8Array>();
  const deletedBooks: string[] = [];
  const deletedFiles: string[] = [];
  const createdDirs: string[] = [];

  const appService: BookOrbitAppService & {
    files: Map<string, Uint8Array>;
    deletedBooks: string[];
    deletedFiles: string[];
    createdDirs: string[];
    importCustomHash?: string;
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
      if (content instanceof Uint8Array) {
        files.set(path, content);
      } else if (content instanceof ArrayBuffer) {
        files.set(path, new Uint8Array(content));
      } else if (typeof content === 'string') {
        files.set(path, new TextEncoder().encode(content));
      } else {
        files.set(path, new Uint8Array());
      }
    },
    async resolveFilePath(path: string, _folder?: string) {
      return `/mock/native/${path}`;
    },
    async deleteFile(path: string, _folder?: string) {
      deletedFiles.push(path);
      files.delete(path);
    },
    async stats(path: string, _folder?: string) {
      const data = files.get(path);
      if (!data) throw new Error(`File not found: ${path}`);
      return {
        isFile: true,
        isDirectory: false,
        size: data.byteLength,
        mtime: new Date(),
        atime: new Date(),
        birthtime: new Date(),
      };
    },
    async openFile(path: string, _folder?: string) {
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
    async readFile(
      path: string,
      _folder?: string,
      _mode?: 'text' | 'binary',
    ): Promise<string | ArrayBuffer> {
      const data = files.get(path);
      if (!data) throw new Error(`File not found: ${path}`);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    },
    async importBook(source: unknown, _library: Book[]) {
      const filepath = typeof source === 'string' ? source : (source as File).name;
      const leaf = filepath.split('/').pop() || 'book';
      const filename = leaf.replace(/^\d+-/, ''); // strip safeShelfFilename id prefix
      const ext = filename.split('.').pop() || 'epub';
      const baseTitle = filename.replace(/\.[^.]+$/, '');
      const hash = appService.importCustomHash || `hash-${filename}`;
      const format =
        ext.toUpperCase() === 'PDF' ? 'PDF' : ext.toUpperCase() === 'CBZ' ? 'CBZ' : 'EPUB';
      const newBook: Book = {
        hash,
        title: baseTitle,
        author: 'Author',
        sourceTitle: baseTitle,
        format,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      files.set(getLocalBookFilename(newBook), new Uint8Array([1, 2, 3]));
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
  const markedEntries: ShelfEntryWrite[] = [];

  const store: IShelfSyncStore & { markedEntries: ShelfEntryWrite[] } = {
    markedEntries,
    async getShelfSubscriptions() {
      return [];
    },
    async saveShelfSubscription() {},
    async deleteShelfSubscription() {},
    async getShelfEntries() {
      return [];
    },
    async markShelfEntries(entries: ShelfEntryWrite[]) {
      markedEntries.push(...entries);
    },
    async removeShelfEntries() {},
    async getManagedShelfReferenceCounts() {
      return new Map();
    },
    async getAllShelfReferenceCounts() {
      return new Map();
    },
  };

  return store;
};

const makeConfig = (overrides: Partial<BookOrbitDownloadConfig> = {}): BookOrbitDownloadConfig => ({
  serverUrl: 'https://books.example.com',
  username: 'testuser',
  userkey: 'a'.repeat(32),
  ...overrides,
});

describe('BookOrbit Native Shelf Download & Import Flow', () => {
  const originalPlatform = process.env['NEXT_PUBLIC_APP_PLATFORM'];

  beforeEach(() => {
    vi.restoreAllMocks();
    tauriDownloadMock.mockReset();
    delete process.env['NEXT_PUBLIC_APP_PLATFORM'];
  });

  afterEach(() => {
    process.env['NEXT_PUBLIC_APP_PLATFORM'] = originalPlatform;
    vi.unstubAllGlobals();
  });

  describe('Validation', () => {
    it('validates EPUB ZIP PK signature', () => {
      const validPk = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      expect(() => validateBookOrbitDownload('test.epub', validPk, 4, 4)).not.toThrow();

      const invalidPk = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
      expect(() => validateBookOrbitDownload('test.epub', invalidPk, 4, 4)).toThrow(
        'Invalid EPUB: missing ZIP PK signature',
      );
    });

    it('validates PDF %PDF signature', () => {
      const validPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
      expect(() => validateBookOrbitDownload('doc.pdf', validPdf, 6, 6)).not.toThrow();

      const invalidPdf = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      expect(() => validateBookOrbitDownload('doc.pdf', invalidPdf, 6, 6)).toThrow(
        'Invalid PDF: missing %PDF signature',
      );
    });

    it('validates CBZ ZIP PK signature', () => {
      const validCbz = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
      expect(() => validateBookOrbitDownload('comic.cbz', validCbz, 4, 4)).not.toThrow();

      const invalidCbz = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      expect(() => validateBookOrbitDownload('comic.cbz', invalidCbz, 4, 4)).toThrow(
        'Invalid CBZ: missing ZIP PK signature',
      );
    });

    it('rejects empty downloads', () => {
      expect(() => validateBookOrbitDownload('empty.epub', new Uint8Array(), 0, null)).toThrow(
        'Empty download',
      );
    });

    it('rejects size mismatch when expected size is provided', () => {
      const pk = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      expect(() => validateBookOrbitDownload('book.epub', pk, 100, 200)).toThrow(
        'Unexpected download size: expected 200, got 100',
      );
    });
  });

  describe('Download & Import Formats (EPUB, PDF, CBZ)', () => {
    it('successfully downloads, validates, imports and persists an EPUB', async () => {
      const epubBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => epubBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();
      const library: Book[] = [];
      const item: BookOrbitShelfDownloadItem = {
        bookId: 101,
        fileId: 501,
        contentVersion: 'v1.0',
        filename: 'novel.epub',
        format: 'epub',
        fileHash: 'hash-novel.epub',
        sizeBytes: epubBytes.byteLength,
      };

      const imported = await downloadAndImportBookOrbitBook({
        item,
        config: makeConfig(),
        appService,
        store,
        library,
        shelfType: 'main',
        shelfId: 'shelf-1',
      });

      expect(imported.hash).toBe('hash-novel.epub');
      expect(library).toHaveLength(1);
      expect(library[0]?.hash).toBe('hash-novel.epub');

      // Persisted to store with remote bookId, fileId, contentVersion, local Book.hash, managedByProvider
      expect(store.markedEntries).toHaveLength(1);
      const entry = store.markedEntries[0]!;
      expect(entry.provider).toBe('bookorbit');
      expect(entry.bookId).toBe('101');
      expect(entry.fileId).toBe('501');
      expect(entry.contentVersion).toBe('v1.0');
      expect(entry.bookHash).toBe('hash-novel.epub');
      expect(entry.managedByProvider).toBe(true);
      expect(entry.localPath).toBe('hash-novel.epub/novel.epub');

      // Temp file cleaned up without touching library file
      expect(appService.deletedFiles).toContain('bookorbit/101-novel.epub');
      expect(appService.files.has('hash-novel.epub/novel.epub')).toBe(true);
    });

    it('successfully downloads, validates, imports and persists a PDF', async () => {
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => pdfBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();
      const library: Book[] = [];
      const item: BookOrbitShelfDownloadItem = {
        bookId: 102,
        fileId: 502,
        contentVersion: 'v1.2',
        filename: 'manual.pdf',
        format: 'pdf',
        fileHash: 'hash-manual.pdf',
        sizeBytes: pdfBytes.byteLength,
      };

      const imported = await downloadAndImportBookOrbitBook({
        item,
        config: makeConfig(),
        appService,
        store,
        library,
      });

      expect(imported.hash).toBe('hash-manual.pdf');
      expect(store.markedEntries).toHaveLength(1);
      expect(store.markedEntries[0]?.bookId).toBe('102');
      expect(store.markedEntries[0]?.fileId).toBe('502');
      expect(appService.deletedFiles).toContain('bookorbit/102-manual.pdf');
    });

    it('successfully downloads, validates, imports and persists a CBZ', async () => {
      const cbzBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 10, 20, 30, 40]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => cbzBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();
      const library: Book[] = [];
      const item: BookOrbitShelfDownloadItem = {
        bookId: 103,
        fileId: 503,
        filename: 'comic.cbz',
        format: 'cbz',
        fileHash: 'hash-comic.cbz',
        sizeBytes: cbzBytes.byteLength,
      };

      const imported = await downloadAndImportBookOrbitBook({
        item,
        config: makeConfig(),
        appService,
        store,
        library,
      });

      expect(imported.hash).toBe('hash-comic.cbz');
      expect(store.markedEntries[0]?.fileId).toBe('503');
      expect(appService.deletedFiles).toContain('bookorbit/103-comic.cbz');
    });
  });

  describe('Bad Signatures & Size Mismatch', () => {
    it('fails on bad signature and cleans up temp without polluting library or store', async () => {
      const badEpubBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]); // Missing PK
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => badEpubBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();
      const item: BookOrbitShelfDownloadItem = {
        bookId: 104,
        filename: 'bad.epub',
        format: 'epub',
        sizeBytes: 4,
      };

      await expect(
        downloadAndImportBookOrbitBook({
          item,
          config: makeConfig(),
          appService,
          store,
          library: [],
        }),
      ).rejects.toThrow('Invalid EPUB: missing ZIP PK signature');

      // Temp file cleaned up
      expect(appService.deletedFiles).toContain('bookorbit/104-bad.epub');
      // Nothing persisted to store
      expect(store.markedEntries).toHaveLength(0);
    });

    it('fails on size mismatch and cleans up temp', async () => {
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes.buffer,
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();
      const item: BookOrbitShelfDownloadItem = {
        bookId: 105,
        filename: 'mismatch.epub',
        format: 'epub',
        sizeBytes: 100, // expected 100, got 4
      };

      await expect(
        downloadAndImportBookOrbitBook({
          item,
          config: makeConfig(),
          appService,
          store,
          library: [],
        }),
      ).rejects.toThrow('Unexpected download size: expected 100, got 4');

      expect(appService.deletedFiles).toContain('bookorbit/105-mismatch.epub');
      expect(store.markedEntries).toHaveLength(0);
    });
  });

  describe('Cancellation', () => {
    it('propagates pre-aborted cancellation without starting download', async () => {
      const controller = new AbortController();
      controller.abort();

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const appService = createMockAppService();
      const store = createMockStore();

      await expect(
        downloadAndImportBookOrbitBook({
          item: { bookId: 106, filename: 'cancelled.epub' },
          config: makeConfig(),
          appService,
          store,
          library: [],
          signal: controller.signal,
        }),
      ).rejects.toThrow('Download cancelled');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.markedEntries).toHaveLength(0);
    });

    it('cleans up temp file when cancelled mid-download', async () => {
      const controller = new AbortController();
      const epubBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => {
          controller.abort();
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => epubBytes.buffer,
          };
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();

      await expect(
        downloadAndImportBookOrbitBook({
          item: { bookId: 107, filename: 'aborted.epub' },
          config: makeConfig(),
          appService,
          store,
          library: [],
          signal: controller.signal,
        }),
      ).rejects.toThrow('Download cancelled');

      expect(appService.deletedFiles).toContain('bookorbit/107-aborted.epub');
      expect(store.markedEntries).toHaveLength(0);
    });
  });

  describe('Network, Temp, and Import Failures', () => {
    it('handles HTTP network failure and cleans up temp', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 502,
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();

      await expect(
        downloadAndImportBookOrbitBook({
          item: { bookId: 108, filename: 'server-error.epub' },
          config: makeConfig(),
          appService,
          store,
          library: [],
        }),
      ).rejects.toThrow('Download failed with status 502');

      expect(store.markedEntries).toHaveLength(0);
    });

    it('handles importBook failure and cleans up temp', async () => {
      const epubBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => epubBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      // Fail importBook by returning null
      appService.importBook = async () => null;

      const store = createMockStore();

      await expect(
        downloadAndImportBookOrbitBook({
          item: { bookId: 109, filename: 'corrupt-internal.epub' },
          config: makeConfig(),
          appService,
          store,
          library: [],
        }),
      ).rejects.toThrow('Failed to import BookOrbit shelf book');

      expect(appService.deletedFiles).toContain('bookorbit/109-corrupt-internal.epub');
      expect(store.markedEntries).toHaveLength(0);
    });
  });

  describe('Hash Mismatch vs Data Safety Invariant', () => {
    it('fails on fileHash mismatch, purges mismatched import, and never deletes existing books', async () => {
      const epubBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => epubBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      appService.importCustomHash = 'different-local-hash-999';

      const existingBook: Book = {
        hash: 'existing-safe-hash',
        title: 'safe.epub',
        author: '',
        sourceTitle: 'safe.epub',
        format: 'EPUB',
        createdAt: 0,
        updatedAt: 0,
      };
      const library: Book[] = [existingBook];
      const store = createMockStore();

      await expect(
        downloadAndImportBookOrbitBook({
          item: {
            bookId: 110,
            filename: 'hash-test.epub',
            fileHash: 'expected-server-hash-111',
          },
          config: makeConfig(),
          appService,
          store,
          library,
        }),
      ).rejects.toThrow(
        'Book hash mismatch: expected expected-server-hash-111, got different-local-hash-999',
      );

      // The mismatched imported book was purged
      expect(appService.deletedBooks).toContain('different-local-hash-999');
      // Existing book is PRESERVED (Data Safety Invariant)
      expect(appService.deletedBooks).not.toContain('existing-safe-hash');
      expect(library).toHaveLength(1);
      expect(library[0]?.hash).toBe('existing-safe-hash');
      // Store entries are NOT marked
      expect(store.markedEntries).toHaveLength(0);
      // Temp file cleaned up
      expect(appService.deletedFiles).toContain('bookorbit/110-hash-test.epub');
    });
  });

  describe('Audioless EPUB with Null Hash / Size', () => {
    it('allows audioless_epub to have null hash and null size, retaining remote IDs and local hash', async () => {
      const audiolessBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => audiolessBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      appService.importCustomHash = 'local-computed-audioless-hash';

      const store = createMockStore();
      const library: Book[] = [];
      const item: BookOrbitShelfDownloadItem = {
        bookId: 777,
        fileId: 888,
        contentVersion: 'audioless-v1',
        filename: 'narration.audioless.epub',
        format: 'audioless_epub',
        fileHash: null, // Null hash allowed!
        sizeBytes: null, // Null size allowed!
      };

      const imported = await downloadAndImportBookOrbitBook({
        item,
        config: makeConfig(),
        appService,
        store,
        library,
        shelfType: 'audiobook_sync',
        shelfId: 'sync-1',
      });

      expect(imported.hash).toBe('local-computed-audioless-hash');
      expect(store.markedEntries).toHaveLength(1);
      const entry = store.markedEntries[0]!;
      expect(entry.bookId).toBe('777');
      expect(entry.fileId).toBe('888');
      expect(entry.contentVersion).toBe('audioless-v1');
      expect(entry.bookHash).toBe('local-computed-audioless-hash');
      expect(entry.managedByProvider).toBe(true);
      expect(entry.localPath).toBe('local-computed-audioless-hash/narration.audioless.epub');
    });
  });

  describe('Large PDF Native Path (Tauri direct-to-file)', () => {
    it('streams large PDF directly to native file without full WebView ArrayBuffer', async () => {
      process.env['NEXT_PUBLIC_APP_PLATFORM'] = 'tauri';

      const appService = createMockAppService();
      const store = createMockStore();

      // Simulate native download writing %PDF header and large 50MB file to disk
      tauriDownloadMock.mockImplementation(async (_url, destinationPath) => {
        // Destination is /mock/native/bookorbit/200-large.pdf
        const relative = destinationPath.replace('/mock/native/', '');
        const largeFileBytes = new Uint8Array(8);
        largeFileBytes.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
        appService.files.set(relative, largeFileBytes);
      });

      const item: BookOrbitShelfDownloadItem = {
        bookId: 200,
        filename: 'large.pdf',
        format: 'pdf',
        fileHash: 'hash-large.pdf',
        sizeBytes: 8,
      };

      const imported = await downloadAndImportBookOrbitBook({
        item,
        config: makeConfig(),
        appService,
        store,
        library: [],
      });

      expect(tauriDownloadMock).toHaveBeenCalledTimes(1);
      const [url, destPath] = tauriDownloadMock.mock.calls[0] as [string, string];
      expect(url).toBe('https://books.example.com/api/v1/books/200/download');
      expect(destPath).toBe('/mock/native/bookorbit/200-large.pdf');

      expect(imported.hash).toBe('hash-large.pdf');
      expect(store.markedEntries).toHaveLength(1);
      expect(store.markedEntries[0]?.bookId).toBe('200');
      // Temp file cleaned up
      expect(appService.deletedFiles).toContain('bookorbit/200-large.pdf');
    });
  });

  describe('Serial Imports', () => {
    it('executes batch imports sequentially', async () => {
      const epubBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => epubBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();
      const library: Book[] = [];

      const items: BookOrbitShelfDownloadItem[] = [
        { bookId: 1, filename: 'book1.epub', format: 'epub', fileHash: 'hash-book1.epub' },
        { bookId: 2, filename: 'book2.epub', format: 'epub', fileHash: 'hash-book2.epub' },
      ];

      const imported = await downloadAndImportBookOrbitBooksSerially(items, {
        config: makeConfig(),
        appService,
        store,
        library,
      });

      expect(imported).toHaveLength(2);
      expect(imported[0]?.hash).toBe('hash-book1.epub');
      expect(imported[1]?.hash).toBe('hash-book2.epub');
      expect(store.markedEntries).toHaveLength(2);
    });
  });

  describe('Downloader & Adapter Integration', () => {
    it('BookOrbitShelfDownloader delegates to downloadAndImportBookOrbitBook', async () => {
      const epubBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => epubBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();
      const downloader = new BookOrbitShelfDownloader(makeConfig(), appService, store, 'conn-test');

      const imported = await downloader.downloadAndImport(
        { bookId: 99, filename: 'b.epub', format: 'epub', fileHash: 'hash-b.epub' },
        [],
      );

      expect(imported.hash).toBe('hash-b.epub');
      expect(store.markedEntries[0]?.connectionId).toBe('conn-test');
    });

    it('BookOrbitShelfAdapter implements ShelfSyncAdapter', async () => {
      const adapter = new BookOrbitShelfAdapter(makeConfig(), 'orbit-conn');
      expect(adapter.provider).toBe('bookorbit');
      expect(adapter.connectionId).toBe('orbit-conn');
      expect(adapter.tempFolder).toBe('bookorbit');
      expect(typeof adapter.downloadBookToFile).toBe('function');
    });

    it('constructs correct download URLs and headers with credentials and custom headers', () => {
      const config = makeConfig({
        serverUrl: 'https://orbit.myhome.net:8443/',
        username: 'alice',
        userkey: 'secret-key',
        customHeaders: { 'X-Custom-Client': 'Readest-Eink' },
      });

      const urlWithFileId = buildBookOrbitDownloadUrl(
        { bookId: 42, fileId: 99, filename: 'b.epub' },
        config,
      );
      expect(urlWithFileId).toBe('https://orbit.myhome.net:8443/api/v1/books/files/99/serve');

      const urlWithoutFileId = buildBookOrbitDownloadUrl(
        { bookId: 42, filename: 'b.epub' },
        config,
      );
      expect(urlWithoutFileId).toBe('https://orbit.myhome.net:8443/api/v1/books/42/download');

      const urlWithExplicitUrl = buildBookOrbitDownloadUrl(
        { bookId: 42, filename: 'b.epub', downloadUrl: '/api/v1/custom/download' },
        config,
      );
      expect(urlWithExplicitUrl).toBe('https://orbit.myhome.net:8443/api/v1/custom/download');

      const headers = buildBookOrbitHeaders(config);
      expect(headers['X-Auth-User']).toBe('alice');
      expect(headers['X-Auth-Key']).toBe('secret-key');
      expect(headers['X-Custom-Client']).toBe('Readest-Eink');
    });
  });

  describe('Fault Injection and Crash Recovery', () => {
    it('Fault injection after import before DB mark: rolls back library and purges book on onImported error', async () => {
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => pdfBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();
      const library: Book[] = [];
      const item: BookOrbitShelfDownloadItem = {
        bookId: 801,
        filename: 'fault1.pdf',
        format: 'pdf',
        fileHash: 'hash-fault1.pdf',
        sizeBytes: pdfBytes.byteLength,
      };

      await expect(
        downloadAndImportBookOrbitBook({
          item,
          config: makeConfig(),
          appService,
          store,
          library,
          onImported: () => {
            throw new Error('Injected onImported DB failure');
          },
        }),
      ).rejects.toThrow('Injected onImported DB failure');

      // Rollback verified:
      expect(library).toHaveLength(0);
      expect(appService.deletedBooks).toContain('hash-fault1.pdf');
      expect(store.markedEntries).toHaveLength(0);
      // Temp cleaned up
      expect(appService.deletedFiles).toContain('bookorbit/801-fault1.pdf');

      // Retry: onImported succeeds
      const retryResult = await downloadAndImportBookOrbitBook({
        item,
        config: makeConfig(),
        appService,
        store,
        library,
        onImported: async () => {},
      });

      expect(retryResult.hash).toBe('hash-fault1.pdf');
      expect(library).toHaveLength(1);
      expect(store.markedEntries).toHaveLength(1);
      expect(store.markedEntries[0]?.managedByProvider).toBe(true);
    });

    it('Fault injection during DB mark: rolls back library and purges book on store.markShelfEntries failure', async () => {
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => pdfBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();
      store.markShelfEntries = async () => {
        throw new Error('Injected store.markShelfEntries transaction failure');
      };

      const library: Book[] = [];
      const item: BookOrbitShelfDownloadItem = {
        bookId: 802,
        filename: 'fault2.pdf',
        format: 'pdf',
        fileHash: 'hash-fault2.pdf',
        sizeBytes: pdfBytes.byteLength,
      };

      await expect(
        downloadAndImportBookOrbitBook({
          item,
          config: makeConfig(),
          appService,
          store,
          library,
        }),
      ).rejects.toThrow('Injected store.markShelfEntries transaction failure');

      // Rollback verified:
      expect(library).toHaveLength(0);
      expect(appService.deletedBooks).toContain('hash-fault2.pdf');
      expect(store.markedEntries).toHaveLength(0);
    });

    it('Cancellation right after import: purges imported book and rolls back library', async () => {
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => pdfBytes.buffer,
        }),
      );

      const appService = createMockAppService();
      const store = createMockStore();
      const controller = new AbortController();

      const library: Book[] = [];
      const item: BookOrbitShelfDownloadItem = {
        bookId: 803,
        filename: 'fault3.pdf',
        format: 'pdf',
        fileHash: 'hash-fault3.pdf',
        sizeBytes: pdfBytes.byteLength,
      };

      await expect(
        downloadAndImportBookOrbitBook({
          item,
          config: makeConfig(),
          appService,
          store,
          library,
          signal: controller.signal,
          onImported: () => {
            controller.abort();
          },
        }),
      ).rejects.toThrow('Download cancelled');

      // Rollback verified:
      expect(library).toHaveLength(0);
      expect(appService.deletedBooks).toContain('hash-fault3.pdf');
      expect(store.markedEntries).toHaveLength(0);
    });
  });
});
