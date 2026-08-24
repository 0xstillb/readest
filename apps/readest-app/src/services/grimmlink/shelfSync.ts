import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { GrimmLinkShelfBook, GrimmLinkShelfCleanupPolicy, GrimmLinkShelfType } from './types';
import { safeShelfFilename, validateShelfDownload } from './download';
import { GrimmLinkSyncStore } from './GrimmLinkSyncStore';
import type { ProgressHandler } from '@/utils/transfer';

type ShelfEntry = { bookId: number; bookHash: string; localPath: string | null; managedByGrimmLink: boolean };

export const mayRemoveManagedCopy = (
  entry: Pick<ShelfEntry, 'managedByGrimmLink' | 'localPath'>,
  managedRoot: string,
): boolean => {
  if (!entry.managedByGrimmLink || !entry.localPath) return false;
  const root = managedRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = entry.localPath.replace(/\\/g, '/');
  return !!root && path.startsWith(`${root}/`) && !path.split('/').some((segment) => segment === '.' || segment === '..');
};

export const planShelfSync = (remote: GrimmLinkShelfBook[], existing: ShelfEntry[], localHashes: Set<string>) => {
  const remoteIds = new Set(remote.map((book) => book.bookId));
  return {
    reuse: remote.filter((book) => localHashes.has(book.bookHash)).map((book) => book.bookId),
    download: remote.filter((book) => !localHashes.has(book.bookHash)),
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
    onImported: (book: Book) => Promise<void> | void,
    appService: Pick<AppService, 'createDir' | 'writeFile' | 'openFile' | 'deleteFile' | 'importBook'>,
    managedRoot = 'grimmlink',
    transfer?: { onProgress?: ProgressHandler; signal?: AbortSignal },
  ): Promise<void> {
    const remote = await this.client.getShelfBooks(type, shelfId);
    const existing = await this.store.getShelfEntries(type, shelfId);
    const plan = planShelfSync(remote, existing, new Set(library.map((book) => book.hash)));
    for (const bookId of plan.reuse) {
      const remoteBook = remote.find((book) => book.bookId === bookId)!;
      await this.store.markShelfEntry(type, shelfId, bookId, remoteBook.bookHash, null, false);
    }
    for (const remoteBook of plan.download) {
      await this.downloadAndImport(type, shelfId, remoteBook, library, onImported, appService, managedRoot, transfer);
    }
    if (cleanupPolicy === 'remove_managed_copy') {
      for (const entry of plan.absent) {
        if (!mayRemoveManagedCopy(entry, managedRoot)) continue;
        await appService.deleteFile(entry.localPath!, 'Books');
        await this.store.removeShelfEntry(type, shelfId, entry.bookId);
      }
    }
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
    onImported: (book: Book) => Promise<void> | void,
    appService: Pick<AppService, 'createDir' | 'writeFile' | 'openFile' | 'deleteFile' | 'importBook'>,
    managedRoot: string,
    transfer?: { onProgress?: ProgressHandler; signal?: AbortSignal },
  ): Promise<void> {
    const tempPath = `${managedRoot}/${safeShelfFilename(remote.filename, remote.bookId)}`;
    const data = await this.client.downloadShelfBook(remote.bookId, transfer?.onProgress, transfer?.signal);
    validateShelfDownload(remote.filename, data, remote.size);
    await appService.createDir(managedRoot, 'Temp', true);
    await appService.writeFile(tempPath, 'Temp', data);
    try {
      const file = await appService.openFile(tempPath, 'Temp');
      const imported = await appService.importBook(file, library);
      if (!imported) throw new Error('Failed to import GrimmLink shelf book');
      await onImported(imported);
      await this.store.markShelfEntry(type, shelfId, remote.bookId, remote.bookHash, `${managedRoot}/${remote.filename}`, true);
    } finally {
      await appService.deleteFile(tempPath, 'Temp').catch(() => {});
    }
  }
}
