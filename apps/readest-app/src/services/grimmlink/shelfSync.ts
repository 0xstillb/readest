import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { GrimmLinkShelfBook, GrimmLinkShelfType } from './types';
import { repairMalformedEpubOpfNamespace, safeShelfFilename, validateShelfDownload } from './download';
import { GrimmLinkSyncStore } from './GrimmLinkSyncStore';
import type { ProgressHandler } from '@/utils/transfer';
import { getLocalBookFilename } from '@/utils/book';
import { isTauriAppPlatform } from '@/services/environment';

type ShelfEntry = { bookId: number; bookHash: string; localPath: string | null; managedByGrimmLink: boolean };
type ShelfSyncStage = 'downloading' | 'importing';
type ShelfSyncTransfer = {
  onProgress?: ProgressHandler;
  onStage?: (event: { stage: ShelfSyncStage; book: GrimmLinkShelfBook }) => void;
  signal?: AbortSignal;
};

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
};

export class GrimmLinkShelfProvider {
  constructor(private readonly client: ShelfClient, private readonly store: GrimmLinkSyncStore) {}

  async sync(
    type: GrimmLinkShelfType,
    shelfId: number,
    library: Book[],
    onImported: (book: Book, library: Book[]) => Promise<void> | void,
    appService: Pick<AppService, 'createDir' | 'writeFile' | 'openFile' | 'deleteFile' | 'exists' | 'importBook' | 'resolveFilePath'>,
    managedRoot = 'grimmlink',
    transfer?: ShelfSyncTransfer,
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
      await this.downloadAndImport(type, shelfId, remoteBook, localLibrary, onImported, appService, managedRoot, transfer);
    }
    // A book disappearing from a remote shelf only affects this sync plan.
    // Keep the imported local copy and its mapping; no local or remote delete
    // request is ever issued by the GrimmLink integration.
    return { reused: plan.reuse.length, downloaded: plan.download.length, removed: 0 };
  }

  private async downloadAndImport(
    type: GrimmLinkShelfType,
    shelfId: number,
    remote: GrimmLinkShelfBook,
    library: Book[],
    onImported: (book: Book, library: Book[]) => Promise<void> | void,
    appService: Pick<AppService, 'createDir' | 'writeFile' | 'openFile' | 'deleteFile' | 'exists' | 'importBook' | 'resolveFilePath'>,
    managedRoot: string,
    transfer?: ShelfSyncTransfer,
  ): Promise<void> {
    const tempPath = `${managedRoot}/${safeShelfFilename(remote.filename, remote.bookId)}`;
    transfer?.onStage?.({ stage: 'downloading', book: remote });
    const downloaded = await this.client.downloadShelfBook(remote.bookId, transfer?.onProgress, transfer?.signal);
    transfer?.onStage?.({ stage: 'importing', book: remote });
    const data = remote.filename.toLowerCase().endsWith('.epub')
      ? await repairMalformedEpubOpfNamespace(downloaded)
      : downloaded;
    validateShelfDownload(remote.filename, data, remote.size);
    await appService.createDir(managedRoot, 'Temp', true);
    await appService.writeFile(tempPath, 'Temp', data);
    try {
      // Native imports can parse an EPUB and copy it directly from its temp path.
      // Passing a File object forces the slower JavaScript parser and a buffered
      // write instead, which is especially noticeable on large Android shelves.
      const file = isTauriAppPlatform()
        ? await appService.resolveFilePath(tempPath, 'Temp')
        : await appService.openFile(tempPath, 'Temp');
      const imported = await appService.importBook(file, library);
      if (!imported) throw new Error('Failed to import GrimmLink shelf book');
      const existingIndex = library.findIndex((book) => book.hash === imported.hash);
      if (existingIndex === -1) library.push(imported); else library[existingIndex] = imported;
      await onImported(imported, [...library]);
      await this.store.markShelfEntry(type, shelfId, remote.bookId, remote.bookHash, getLocalBookFilename(imported), true);
    } finally {
      await appService.deleteFile(tempPath, 'Temp').catch(() => {});
    }
  }
}
