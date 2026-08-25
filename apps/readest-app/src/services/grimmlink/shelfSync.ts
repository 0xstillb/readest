import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { GrimmLinkShelfBook, GrimmLinkShelfType } from './types';
import { repairMalformedEpubOpfNamespace, safeShelfFilename, validateShelfDownload } from './download';
import { GrimmLinkSyncStore } from './GrimmLinkSyncStore';
import type { ProgressHandler } from '@/utils/transfer';
import { getLocalBookFilename } from '@/utils/book';

type ShelfEntry = { bookId: number; bookHash: string; localPath: string | null; managedByGrimmLink: boolean };

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
    appService: Pick<AppService, 'createDir' | 'writeFile' | 'openFile' | 'deleteFile' | 'importBook'>,
    managedRoot = 'grimmlink',
    transfer?: { onProgress?: ProgressHandler; signal?: AbortSignal },
  ): Promise<GrimmLinkShelfSyncResult> {
    const remote = await this.client.getShelfBooks(type, shelfId);
    const existing = await this.store.getShelfEntries(type, shelfId);
    const localLibrary = [...library];
    const plan = planShelfSync(remote, existing, new Set(localLibrary.map((book) => book.hash)), new Set(localLibrary.map(getLocalBookFilename)));
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
    appService: Pick<AppService, 'createDir' | 'writeFile' | 'openFile' | 'deleteFile' | 'importBook'>,
    managedRoot: string,
    transfer?: { onProgress?: ProgressHandler; signal?: AbortSignal },
  ): Promise<void> {
    const tempPath = `${managedRoot}/${safeShelfFilename(remote.filename, remote.bookId)}`;
    const downloaded = await this.client.downloadShelfBook(remote.bookId, transfer?.onProgress, transfer?.signal);
    const data = remote.filename.toLowerCase().endsWith('.epub')
      ? await repairMalformedEpubOpfNamespace(downloaded)
      : downloaded;
    validateShelfDownload(remote.filename, data, remote.size);
    await appService.createDir(managedRoot, 'Temp', true);
    await appService.writeFile(tempPath, 'Temp', data);
    try {
      const file = await appService.openFile(tempPath, 'Temp');
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
