import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { getLocalBookFilename } from '@/utils/book';
import type { LibraryPresenceIndex } from './types';

/**
 * Builds an index of books that physically exist on disk and are not soft-deleted tombstones.
 * Tombstones (`deletedAt` present) are intentionally treated as absent so sync workflows
 * can detect missing books and restore them without triggering remote deletions.
 */
export const buildLibraryPresenceIndex = async (
  library: Book[],
  appService: Pick<AppService, 'exists'>,
  onFileChecked?: () => void,
): Promise<LibraryPresenceIndex> => {
  const present = await Promise.all(
    library
      .filter((book) => !book.deletedAt)
      .map(async (book) => {
        onFileChecked?.();
        const path = getLocalBookFilename(book);
        return {
          book,
          path,
          present: await appService.exists(path, 'Books'),
        };
      }),
  );
  const index: LibraryPresenceIndex = {
    hashes: new Set(),
    paths: new Set(),
    booksByHash: new Map(),
    booksByPath: new Map(),
  };
  for (const item of present) {
    if (!item.present) continue;
    if (item.book.hash) {
      index.hashes.add(item.book.hash);
      index.booksByHash.set(item.book.hash, item.book);
    }
    index.paths.add(item.path);
    index.booksByPath.set(item.path, item.book);
  }
  return index;
};

export const addToPresenceIndex = (index: LibraryPresenceIndex, book: Book): void => {
  const path = getLocalBookFilename(book);
  if (book.hash) {
    index.hashes.add(book.hash);
    index.booksByHash.set(book.hash, book);
  }
  index.paths.add(path);
  index.booksByPath.set(path, book);
};

export const removeFromPresenceIndex = (index: LibraryPresenceIndex, book: Book): void => {
  const path = getLocalBookFilename(book);
  if (book.hash) {
    index.hashes.delete(book.hash);
    index.booksByHash.delete(book.hash);
  }
  index.paths.delete(path);
  index.booksByPath.delete(path);
};
