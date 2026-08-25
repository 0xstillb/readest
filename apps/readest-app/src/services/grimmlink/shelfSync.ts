import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { GrimmLinkShelfBook, GrimmLinkShelfCleanupPolicy, GrimmLinkShelfType } from './types';
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

export const mayRemoveManagedCopy = (
  entry: Pick<ShelfEntry, 'managedByGrimmLink' | 'localPath'>,
  managedRoot: string,
): boolean => {
  if (!entry.managedByGrimmLink || !entry.localPath) return false;
  const root = managedRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = entry.localPath.replace(/\\/g, '/');
  return !!root && path.startsWith(`${root}/`) && !path.split('/').some((segment) => segment === '.' || segment === '..');
};

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
    cleanupPolicy: GrimmLinkShelfCleanupPolicy,
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
      await this.store.markShelfEntry(type, shelfId, bookId, remoteBook.bookHash, null, false);
    }
    for (const remoteBook of plan.download) {
      await this.downloadAndImport(type, shelfId, remoteBook, localLibrary, onImported, appService, managedRoot, transfer);
    }
    let removed = 0;
    if (cleanupPolicy === 'remove_managed_copy') {
      for (const entry of plan.absent) {
        if (!mayRemoveManagedCopy(entry, managedRoot)) continue;
        await appService.deleteFile(entry.localPath!, 'Books');
        await this.store.removeShelfEntry(type, shelfId, entry.bookId);
        removed += 1;
      }
    }
    return { reused: plan.reuse.length, downloaded: plan.download.length, removed };
  }

  /** This is deliberately separate from local cleanup and cannot queue without confirmation. */
  async requestRemoteRemoval(confirmed: boolean, type: GrimmLinkShelfType, shelfId: number, bookId: number): Promise<boolean> {
    if (!confirmed) return false;
    await this.store.enqueueShelfRemoval(type, shelfId, bookId);
    return true;
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
