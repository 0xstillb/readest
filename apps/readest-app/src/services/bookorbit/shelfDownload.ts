import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { getLocalBookFilename } from '@/utils/book';
import { isLanAddress } from '@/utils/network';
import { normalizeCustomHeaders } from '@/utils/customHeaders';
import { isTauriAppPlatform } from '@/services/environment';
import { tauriDownload, type ProgressHandler } from '@/utils/transfer';
import { safeShelfFilename } from '@/services/shelfSync/validation';
import type {
  IShelfSyncStore,
  ShelfCleanupPolicy,
  ShelfEntryWrite,
  ShelfSyncAdapter,
  ShelfSyncAppService,
  ShelfSyncBook,
  ShelfSyncEntry,
} from '@/services/shelfSync/types';

export interface BookOrbitShelfDownloadItem {
  bookId: string | number;
  bookHash?: string | null;
  fileId?: string | number | null;
  contentVersion?: string | null;
  filename: string;
  format?: string;
  fileHash?: string | null;
  sizeBytes?: number | null;
  size?: number;
  downloadUrl?: string;
  title?: string;
  author?: string;
}

export type BookOrbitShelfBook = BookOrbitShelfDownloadItem & ShelfSyncBook<string | number>;

export interface BookOrbitDownloadConfig {
  serverUrl: string;
  username?: string;
  userkey?: string;
  password?: string;
  accessToken?: string;
  customHeaders?: Record<string, string>;
  skipSslVerification?: boolean;
}

export type BookOrbitAppService = ShelfSyncAppService & {
  openFile?: AppService['openFile'];
  stats?: AppService['stats'];
  readFile?: AppService['readFile'];
};

export interface BookOrbitShelfDownloadOptions {
  item: BookOrbitShelfDownloadItem;
  config: BookOrbitDownloadConfig;
  appService: BookOrbitAppService;
  store: IShelfSyncStore;
  library: Book[];
  shelfType?: string;
  shelfId?: string | number;
  connectionId?: string;
  cleanupPolicy?: ShelfCleanupPolicy;
  previousEntry?: ShelfSyncEntry<unknown>;
  onImported?: (book: Book, library: Book[]) => Promise<void> | void;
  onRemoved?: (book: Book, library: Book[]) => Promise<void> | void;
  onProgress?: ProgressHandler;
  signal?: AbortSignal;
}

/**
 * Validates file signature (ZIP PK for EPUB/CBZ, %PDF for PDF) and size when present.
 */
export const validateBookOrbitDownload = (
  filename: string,
  header: Uint8Array | ArrayBuffer,
  actualSize?: number,
  expectedSize?: number | null,
  format?: string,
): void => {
  if (actualSize !== undefined && actualSize === 0) {
    throw new Error('Empty download');
  }

  if (expectedSize !== undefined && expectedSize !== null && expectedSize >= 0) {
    if (actualSize !== undefined && actualSize !== expectedSize) {
      throw new Error(`Unexpected download size: expected ${expectedSize}, got ${actualSize}`);
    }
  }

  const headerBytes = header instanceof Uint8Array ? header : new Uint8Array(header);
  if (headerBytes.length === 0) {
    throw new Error('Empty download');
  }

  const ext = (format || filename.split('.').pop() || '').toLowerCase();
  const isZipPk = headerBytes.length >= 2 && headerBytes[0] === 0x50 && headerBytes[1] === 0x4b;
  const isPdf =
    headerBytes.length >= 4 &&
    headerBytes[0] === 0x25 &&
    headerBytes[1] === 0x50 &&
    headerBytes[2] === 0x44 &&
    headerBytes[3] === 0x46;

  if (ext === 'epub' || ext === 'audioless_epub' || filename.toLowerCase().endsWith('.epub')) {
    if (!isZipPk) {
      throw new Error('Invalid EPUB: missing ZIP PK signature');
    }
  } else if (ext === 'cbz' || filename.toLowerCase().endsWith('.cbz')) {
    if (!isZipPk) {
      throw new Error('Invalid CBZ: missing ZIP PK signature');
    }
  } else if (ext === 'pdf' || filename.toLowerCase().endsWith('.pdf')) {
    if (!isPdf) {
      throw new Error('Invalid PDF: missing %PDF signature');
    }
  }
};

/**
 * Inspects the downloaded file header and actual size without buffering the entire
 * file into WebView / JS memory (bounds memory for large PDFs / CBZs).
 */
export async function inspectDownloadedFile(
  appService: BookOrbitAppService,
  tempPath: string,
): Promise<{ headerBytes: Uint8Array; actualSize: number }> {
  let actualSize: number | undefined;

  if (typeof appService.stats === 'function') {
    const fileStats = await appService.stats(tempPath, 'Temp').catch(() => null);
    if (fileStats && typeof fileStats.size === 'number') {
      actualSize = fileStats.size;
    }
  }

  if (typeof appService.openFile === 'function') {
    const file = await appService.openFile(tempPath, 'Temp');
    if (actualSize === undefined) {
      actualSize = file.size;
    }
    const slice = await file.slice(0, 8).arrayBuffer();
    return { headerBytes: new Uint8Array(slice), actualSize };
  }

  if (typeof appService.readFile === 'function') {
    const content = await appService.readFile(tempPath, 'Temp', 'binary');
    const buf = typeof content === 'string' ? new TextEncoder().encode(content).buffer : content;
    const bytes = new Uint8Array(buf);
    if (actualSize === undefined) {
      actualSize = bytes.byteLength;
    }
    return { headerBytes: bytes.slice(0, 8), actualSize };
  }

  throw new Error(
    'Cannot inspect downloaded file: appService does not support stats, openFile, or readFile',
  );
}

export function buildBookOrbitDownloadUrl(
  item: BookOrbitShelfDownloadItem,
  config: BookOrbitDownloadConfig,
): string {
  if (item.downloadUrl) {
    if (/^https?:\/\//i.test(item.downloadUrl)) {
      return item.downloadUrl;
    }
    const base = config.serverUrl.replace(/\/+$/, '');
    const path = item.downloadUrl.startsWith('/') ? item.downloadUrl : `/${item.downloadUrl}`;
    return `${base}${path}`;
  }
  const base = config.serverUrl.replace(/\/+$/, '');
  if (item.fileId != null) {
    return `${base}/api/v1/books/files/${encodeURIComponent(String(item.fileId))}/serve`;
  }
  return `${base}/api/v1/books/${encodeURIComponent(String(item.bookId))}/download`;
}

export function buildBookOrbitHeaders(config: BookOrbitDownloadConfig): Record<string, string> {
  const headers: Record<string, string> = {
    ...normalizeCustomHeaders(config.customHeaders),
  };
  if (config.username && config.userkey) {
    headers['X-Auth-User'] = config.username;
    headers['X-Auth-Key'] = config.userkey;
  }
  if (config.accessToken) {
    headers['Authorization'] = `Bearer ${config.accessToken}`;
  }
  return headers;
}

/**
 * Downloads a BookOrbit shelf book directly to a file on disk.
 */
export async function downloadBookOrbitFile(
  item: BookOrbitShelfDownloadItem,
  destinationPath: string,
  config: BookOrbitDownloadConfig,
  options?: {
    onProgress?: ProgressHandler;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (options?.signal?.aborted) {
    throw new Error('Download cancelled');
  }

  const url = buildBookOrbitDownloadUrl(item, config);
  const headers = buildBookOrbitHeaders(config);
  const skipSsl = config.skipSslVerification ?? isLanAddress(config.serverUrl);

  if (isTauriAppPlatform()) {
    await tauriDownload(
      url,
      destinationPath,
      options?.onProgress,
      headers,
      undefined,
      false,
      skipSsl,
    );
  } else {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: options?.signal,
    });
    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}`);
    }
  }
}

/**
 * Orchestrates preferred native download and import flow:
 * BookOrbit HTTP → native direct-to-file → temp → validate → importBook(nativePath) → persist → cleanup.
 */
export async function downloadAndImportBookOrbitBook(
  options: BookOrbitShelfDownloadOptions,
): Promise<Book> {
  const {
    item,
    config,
    appService,
    store,
    library,
    shelfType,
    shelfId,
    connectionId,
    onImported,
    onProgress,
    signal,
  } = options;

  if (signal?.aborted) {
    throw new Error('Download cancelled');
  }

  const tempFolder = 'bookorbit';
  const tempFilename = safeShelfFilename(item.filename, item.bookId);
  const tempPath = `${tempFolder}/${tempFilename}`;

  let nativePath = '';

  try {
    await appService.createDir(tempFolder, 'Temp', true);
    if (await appService.exists(tempPath, 'Temp')) {
      await appService.deleteFile(tempPath, 'Temp');
    }

    try {
      nativePath = await appService.resolveFilePath(tempPath, 'Temp');
    } catch {
      nativePath = '';
    }

    const url = buildBookOrbitDownloadUrl(item, config);
    const headers = buildBookOrbitHeaders(config);
    const skipSsl = config.skipSslVerification ?? isLanAddress(config.serverUrl);

    if (isTauriAppPlatform() && nativePath) {
      await tauriDownload(url, nativePath, onProgress, headers, undefined, false, skipSsl);
    } else {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal,
      });
      if (!response.ok) {
        throw new Error(`Download failed with status ${response.status}`);
      }
      const data = await response.arrayBuffer();
      await appService.writeFile(tempPath, 'Temp', data);
    }

    if (signal?.aborted) {
      throw new Error('Download cancelled');
    }

    // Validate downloaded bytes on disk (EPUB/CBZ PK, PDF %PDF, sizeBytes)
    const { headerBytes, actualSize } = await inspectDownloadedFile(appService, tempPath);
    const isAudioless =
      item.format === 'audioless_epub' || item.filename.toLowerCase().endsWith('.audioless.epub');
    const expectedSize = isAudioless
      ? (item.sizeBytes ?? null)
      : (item.sizeBytes ?? item.size ?? null);
    validateBookOrbitDownload(item.filename, headerBytes, actualSize, expectedSize, item.format);

    if (signal?.aborted) {
      throw new Error('Download cancelled');
    }

    // Import into local library
    const importSource = nativePath || (await appService.openFile?.(tempPath, 'Temp')) || tempPath;
    const imported = await appService.importBook(importSource, library);
    if (!imported) {
      throw new Error('Failed to import BookOrbit shelf book');
    }

    if (signal?.aborted) {
      await appService.deleteBook(imported, 'purge').catch(() => {});
      throw new Error('Download cancelled');
    }

    // For original bytes with fileHash, verify identity appropriately;
    // mismatch must not silently succeed or destructively clean.
    // For audioless_epub, allow null hash/size and skip mismatch check.
    const expectedHash = item.fileHash ?? item.bookHash;
    if (!isAudioless && expectedHash) {
      if (imported.hash !== expectedHash) {
        await appService.deleteBook(imported, 'purge').catch(() => {});
        throw new Error(`Book hash mismatch: expected ${expectedHash}, got ${imported.hash}`);
      }
    }

    const existingIndex = library.findIndex((book) => book.hash === imported.hash);
    if (existingIndex === -1) {
      library.push(imported);
    } else {
      library[existingIndex] = imported;
    }

    await onImported?.(imported, [...library]);

    // Persist to ShelfSyncStore:
    // Retain remote bookId, fileId, contentVersion + local Book.hash after import
    const entry: ShelfEntryWrite = {
      provider: 'bookorbit',
      connectionId: connectionId ?? config.serverUrl,
      shelfType: shelfType ?? 'default',
      shelfId: String(shelfId ?? 'default'),
      bookId: String(item.bookId),
      fileId: item.fileId != null ? String(item.fileId) : null,
      contentVersion: item.contentVersion != null ? String(item.contentVersion) : null,
      bookHash: item.fileHash ?? item.bookHash ?? imported.hash,
      localPath: getLocalBookFilename(imported),
      managedByProvider: true,
    };
    await store.markShelfEntries([entry]);

    if (
      options.cleanupPolicy === 'remove_managed_copy' &&
      options.previousEntry?.managedByProvider &&
      options.previousEntry.localPath
    ) {
      const counts = await store.getAllShelfReferenceCounts([options.previousEntry.localPath]);
      const refCount = counts.get(options.previousEntry.localPath) ?? 0;
      const { canDeleteObsoleteRevision } = await import('@/services/shelfSync/deletion');
      if (
        canDeleteObsoleteRevision({
          previousEntry: options.previousEntry,
          importedBook: imported,
          cleanupPolicy: options.cleanupPolicy,
          referenceCount: refCount,
        })
      ) {
        const oldBook = library.find(
          (b) =>
            getLocalBookFilename(b) === options.previousEntry!.localPath ||
            (options.previousEntry!.bookHash && b.hash === options.previousEntry!.bookHash),
        );
        if (oldBook && oldBook.hash !== imported.hash) {
          const idx = library.findIndex((b) => b.hash === oldBook.hash);
          await appService.deleteBook(oldBook, 'purge');
          if (idx >= 0) library.splice(idx, 1);
          await options.onRemoved?.(oldBook, [...library]);
        } else if (
          options.previousEntry.localPath &&
          (await appService.exists(options.previousEntry.localPath, 'Books'))
        ) {
          await appService.deleteFile(options.previousEntry.localPath, 'Books');
        }
      }
    }

    return imported;
  } finally {
    // Finally cleanup temp without touching imported library file
    try {
      if (await appService.exists(tempPath, 'Temp')) {
        await appService.deleteFile(tempPath, 'Temp');
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Imports multiple BookOrbit shelf books strictly serially to bound memory
 * on low-RAM / e-ink Android WebViews.
 */
export async function downloadAndImportBookOrbitBooksSerially(
  items: BookOrbitShelfDownloadItem[],
  options: Omit<BookOrbitShelfDownloadOptions, 'item'>,
): Promise<Book[]> {
  const importedBooks: Book[] = [];
  for (const item of items) {
    if (options.signal?.aborted) {
      throw new Error('Download cancelled');
    }
    const book = await downloadAndImportBookOrbitBook({
      ...options,
      item,
    });
    importedBooks.push(book);
  }
  return importedBooks;
}

/**
 * Service encapsulating BookOrbit shelf downloads.
 */
export class BookOrbitShelfDownloader {
  constructor(
    private readonly config: BookOrbitDownloadConfig,
    private readonly appService: BookOrbitAppService,
    private readonly store: IShelfSyncStore,
    private readonly connectionId?: string,
  ) {}

  async downloadAndImport(
    item: BookOrbitShelfDownloadItem,
    library: Book[],
    options?: {
      shelfType?: string;
      shelfId?: string | number;
      onImported?: (book: Book, library: Book[]) => Promise<void> | void;
      onProgress?: ProgressHandler;
      signal?: AbortSignal;
    },
  ): Promise<Book> {
    return downloadAndImportBookOrbitBook({
      item,
      config: this.config,
      appService: this.appService,
      store: this.store,
      library,
      connectionId: this.connectionId,
      ...options,
    });
  }

  async downloadAndImportSerially(
    items: BookOrbitShelfDownloadItem[],
    library: Book[],
    options?: {
      shelfType?: string;
      shelfId?: string | number;
      onImported?: (book: Book, library: Book[]) => Promise<void> | void;
      onProgress?: ProgressHandler;
      signal?: AbortSignal;
    },
  ): Promise<Book[]> {
    return downloadAndImportBookOrbitBooksSerially(items, {
      config: this.config,
      appService: this.appService,
      store: this.store,
      library,
      connectionId: this.connectionId,
      ...options,
    });
  }
}

/**
 * Adapter bridging BookOrbit download and listing to the generic ShelfSyncEngine.
 */
export class BookOrbitShelfAdapter
  implements ShelfSyncAdapter<string | number, BookOrbitShelfBook>
{
  readonly provider = 'bookorbit';
  readonly connectionId: string;
  readonly tempFolder = 'bookorbit';
  readonly importErrorMessage = 'Failed to import BookOrbit shelf book';
  private readonly client?: import('./types').BookOrbitShelfClient;

  constructor(
    private readonly config: BookOrbitDownloadConfig,
    connectionIdOrClient?: string | import('./types').BookOrbitShelfClient,
    clientOrConnectionId?: string | import('./types').BookOrbitShelfClient,
  ) {
    if (typeof connectionIdOrClient === 'string') {
      this.connectionId = connectionIdOrClient;
      this.client = clientOrConnectionId as import('./types').BookOrbitShelfClient | undefined;
    } else if (connectionIdOrClient && typeof connectionIdOrClient === 'object') {
      this.client = connectionIdOrClient;
      this.connectionId =
        typeof clientOrConnectionId === 'string' ? clientOrConnectionId : config.serverUrl;
    } else {
      this.connectionId =
        typeof clientOrConnectionId === 'string' ? clientOrConnectionId : config.serverUrl;
    }
    this.connectionId = this.connectionId ?? config.serverUrl;
  }

  async getShelfBooks(shelfType: string, shelfId: string | number): Promise<BookOrbitShelfBook[]> {
    if (this.client) {
      return this.client.getShelfBooks(shelfType, shelfId);
    }
    const { BookOrbitClient } = await import('./BookOrbitClient');
    const client = new BookOrbitClient(
      this.config as unknown as import('@/types/settings').BookOrbitSettings,
    );
    return client.getShelfBooks(shelfType, shelfId);
  }

  async downloadBook(
    book: BookOrbitShelfBook,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (signal?.aborted) throw new Error('Download cancelled');
    if (this.client?.downloadShelfBook) {
      return this.client.downloadShelfBook(book.bookId, onProgress, signal);
    }
    const url = buildBookOrbitDownloadUrl(book, this.config);
    const headers = buildBookOrbitHeaders(this.config);
    const res = await fetch(url, { method: 'GET', headers, signal });
    if (!res.ok) {
      throw new Error(`Download failed with status ${res.status}`);
    }
    return await res.arrayBuffer();
  }

  get downloadBookToFile() {
    return async (
      book: BookOrbitShelfBook,
      filePath: string,
      onProgress?: ProgressHandler,
      signal?: AbortSignal,
    ): Promise<void> => {
      if (this.client?.downloadShelfBookToFile) {
        await this.client.downloadShelfBookToFile(book, filePath, onProgress, signal);
        return;
      }
      await downloadBookOrbitFile(book, filePath, this.config, { onProgress, signal });
    };
  }

  async repairBookData(data: ArrayBuffer): Promise<ArrayBuffer> {
    return data;
  }

  validateBookData(filename: string, data: ArrayBuffer, expectedSize?: number): void {
    validateBookOrbitDownload(filename, data, data.byteLength, expectedSize);
  }
}
