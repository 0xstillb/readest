import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { GrimmLinkShelfBook, GrimmLinkShelfType } from './types';
import { repairMalformedEpubOpfNamespace, safeShelfFilename, validateShelfDownload } from './download';
import { GrimmLinkSyncStore } from './GrimmLinkSyncStore';
import type { ProgressHandler } from '@/utils/transfer';
import { getLocalBookFilename } from '@/utils/book';
import { isTauriAppPlatform } from '../environment';

type ShelfEntry = { bookId: number; bookHash: string; localPath: string | null; managedByGrimmLink: boolean };
type ShelfSyncStage = 'downloading' | 'importing';
type ShelfSyncTransfer = {
  onProgress?: ProgressHandler;
  onStage?: (event: { stage: ShelfSyncStage; book: GrimmLinkShelfBook }) => void;
  signal?: AbortSignal;
};

type ShelfSyncAppService = Pick<
  AppService,
  'createDir' | 'writeFile' | 'resolveFilePath' | 'exists' | 'deleteFile' | 'importBook' | 'deleteBook'
>;

const NATIVE_IMPORT_THRESHOLD_BYTES = 8 * 1024 * 1024;

export interface GrimmLinkShelfSyncResult {
  reused: number;
  downloaded: number;
  removed: number;
}

export const planShelfSync = (
  remote: GrimmLinkShelfBook[],
  existing: ShelfEntry[],
  localHashes: Set<string>,
  localPaths = new Set<string>(),
) => {
  const remoteIds = new Set(remote.map((book) => book.bookId));
  const trackedBooks = new Set(existing
    .filter((entry) => entry.localPath && localPaths.has(entry.localPath))
    .map((entry) => `${entry.bookId}\u0000${entry.bookHash}`));
  return {
    reuse: remote.filter((book) => localHashes.has(book.bookHash) || trackedBooks.has(`${book.bookId}\u0000${book.bookHash}`)).map((book) => book.bookId),
    download: remote.filter((book) => !localHashes.has(book.bookHash) && !trackedBooks.has(`${book.bookId}\u0000${book.bookHash}`)),
    absent: existing.filter((entry) => !remoteIds.has(entry.bookId)),
  };
};

type ShelfClient = {
  getShelfBooks(type: GrimmLinkShelfType, shelfId: number): Promise<GrimmLinkShelfBook[]>;
  downloadShelfBook(bookId: number, onProgress?: ProgressHandler, signal?: AbortSignal): Promise<ArrayBuffer>;
  downloadShelfBookToFile?: (bookId: number, filePath: string, onProgress?: ProgressHandler, signal?: AbortSignal) => Promise<void>;
};

export class GrimmLinkShelfProvider {
  constructor(private readonly client: ShelfClient, private readonly store: GrimmLinkSyncStore) {}

  async sync(
    type: GrimmLinkShelfType,
    shelfId: number,
    library: Book[],
    onImported: (book: Book, library: Book[]) => Promise<void> | void,
    appService: ShelfSyncAppService,
    transfer?: ShelfSyncTransfer,
    onRemoved?: (book: Book, library: Book[]) => Promise<void> | void,
  ): Promise<GrimmLinkShelfSyncResult> {
    const remote = await this.client.getShelfBooks(type, shelfId);
    const existing = await this.store.getShelfEntries(type, shelfId);
    const localLibrary = [...library];
    // A normal Readest delete retains a tombstone so other storage providers
    // can process it safely.  GrimmLink is download-only, though: its shelf
    // must treat that tombstone (and any stale shelf path) as absent so Sync
    // restores the book from Grimmory without ever requesting a remote delete.
    const presentBooks = (await Promise.all(localLibrary
      .filter((book) => !book.deletedAt)
      .map(async (book) => ({ book, present: await appService.exists(getLocalBookFilename(book), 'Books') }))))
      .filter(({ present }) => present)
      .map(({ book }) => book);
    const plan = planShelfSync(
      remote,
      existing,
      new Set(presentBooks.map((book) => book.hash)),
      new Set(presentBooks.map(getLocalBookFilename)),
    );
    for (const bookId of plan.reuse) {
      const remoteBook = remote.find((book) => book.bookId === bookId)!;
      const tracked = existing.find((entry) => entry.bookId === bookId && entry.bookHash === remoteBook.bookHash);
      await this.store.markShelfEntry(
        type,
        shelfId,
        bookId,
        remoteBook.bookHash,
        tracked?.localPath ?? null,
        tracked?.managedByGrimmLink ?? false,
      );
    }
    for (const remoteBook of plan.download) {
      await this.downloadAndImport(type, shelfId, remoteBook, localLibrary, onImported, appService, transfer);
    }
    let removed = 0;
    for (const entry of plan.absent) {
      // Only remove files that this integration imported. User-owned books and
      // books imported by another source are never touched by shelf cleanup.
      const bookIndex = entry.localPath
        ? localLibrary.findIndex((book) => getLocalBookFilename(book) === entry.localPath)
        : -1;
      const book = bookIndex >= 0 ? localLibrary[bookIndex] : undefined;
      if (entry.managedByGrimmLink && entry.localPath) {
        if (book) {
          await appService.deleteBook(book, 'purge');
          localLibrary.splice(bookIndex, 1);
          await onRemoved?.(book, [...localLibrary]);
          removed += 1;
        } else if (await appService.exists(entry.localPath, 'Books')) {
          await appService.deleteFile(entry.localPath, 'Books');
          removed += 1;
        }
      }
      await this.store.removeShelfEntry(type, shelfId, entry.bookId);
    }
    return { reused: plan.reuse.length, downloaded: plan.download.length, removed };
  }

  private async downloadAndImport(
    type: GrimmLinkShelfType,
    shelfId: number,
    remote: GrimmLinkShelfBook,
    library: Book[],
    onImported: (book: Book, library: Book[]) => Promise<void> | void,
    appService: ShelfSyncAppService,
    transfer?: ShelfSyncTransfer,
  ): Promise<void> {
    transfer?.onStage?.({ stage: 'downloading', book: remote });

    // On native builds, keep the payload out of the WebView entirely.  The
    // previous path accumulated all response chunks and then created another
    // ArrayBuffer before writing Temp, which is enough to make Android kill the
    // process while importing otherwise ordinary 15–50 MB books.
    if (isTauriAppPlatform() && this.client.downloadShelfBookToFile) {
      const tempPath = `grimmlink/${safeShelfFilename(remote.filename, remote.bookId)}`;
      await appService.createDir('grimmlink', 'Temp', true);
      let nativePath: string;
      try {
        nativePath = await appService.resolveFilePath(tempPath, 'Temp');
      } catch {
        nativePath = '';
      }
      if (nativePath) {
        try {
          await this.client.downloadShelfBookToFile(remote.bookId, nativePath, transfer?.onProgress, transfer?.signal);
          transfer?.onStage?.({ stage: 'importing', book: remote });
          const imported = await appService.importBook(nativePath, library);
          if (!imported) throw new Error('Failed to import GrimmLink shelf book');
          const existingIndex = library.findIndex((book) => book.hash === imported.hash);
          if (existingIndex === -1) library.push(imported); else library[existingIndex] = imported;
          await onImported(imported, [...library]);
          await this.store.markShelfEntry(type, shelfId, remote.bookId, remote.bookHash, getLocalBookFilename(imported), true);
          return;
        } finally {
          await appService.deleteFile(tempPath, 'Temp').catch(() => {});
        }
      }
    }

    const downloaded = await this.client.downloadShelfBook(remote.bookId, transfer?.onProgress, transfer?.signal);
    const data = remote.filename.toLowerCase().endsWith('.epub')
      ? await repairMalformedEpubOpfNamespace(downloaded)
      : downloaded;
    validateShelfDownload(remote.filename, data, remote.size);
    transfer?.onStage?.({ stage: 'importing', book: remote });
    const useNativeImport = data.byteLength >= NATIVE_IMPORT_THRESHOLD_BYTES;
    const tempPath = `grimmlink/${safeShelfFilename(remote.filename, remote.bookId)}`;
    let importSource: string | File = new File([data], remote.filename);
    if (useNativeImport) {
      // Large files are safer through the native filesystem path. EPUBs can
      // use the Rust metadata bridge and PDFs avoid ferrying a large Blob into
      // the WebView parser over the Android bridge.
      await appService.createDir('grimmlink', 'Temp', true);
      await appService.writeFile(tempPath, 'Temp', importSource);
      try {
        importSource = await appService.resolveFilePath(tempPath, 'Temp');
      } catch {
        // Keep the File path as a safe fallback on platforms without path
        // resolution support (web/test doubles).
      }
    }
    try {
      const imported = await appService.importBook(importSource, library);
      if (!imported) throw new Error('Failed to import GrimmLink shelf book');
      const existingIndex = library.findIndex((book) => book.hash === imported.hash);
      if (existingIndex === -1) library.push(imported); else library[existingIndex] = imported;
      await onImported(imported, [...library]);
      await this.store.markShelfEntry(type, shelfId, remote.bookId, remote.bookHash, getLocalBookFilename(imported), true);
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
  const subscriptions = await store.getShelfSubscriptions();
  let reused = 0;
  let downloaded = 0;
  let removed = 0;
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
    );
    reused += result.reused;
    downloaded += result.downloaded;
    removed += result.removed;
  }
  return { reused, downloaded, removed };
}
