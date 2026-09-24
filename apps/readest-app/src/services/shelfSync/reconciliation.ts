import type {
  ShelfDownloadPolicy,
  ShelfReconciliation,
  ShelfSyncBook,
  ShelfSyncEntry,
  ShelfSyncPlan,
  ShelfSyncPreview,
} from './types';

const isHashPresent = (hash: string | null | undefined, localHashes: Set<string>): boolean =>
  hash != null && hash !== '' && localHashes.has(hash);

const makeTrackedKey = (bookId: unknown, bookHash: string | null | undefined): string =>
  `${bookId}\u0000${bookHash ?? ''}`;

/**
 * Pure snapshot reconciliation against previously tracked entries and local presence.
 * Never mutates the library or filesystem.
 */
export const reconcileShelfSnapshot = <
  TBook extends ShelfSyncBook<unknown>,
  TEntry extends ShelfSyncEntry<unknown>,
>(
  remote: TBook[],
  existing: TEntry[],
  localHashes: Set<string>,
  localPaths = new Set<string>(),
): ShelfReconciliation<TBook, TEntry> => {
  const remoteById = new Map(remote.map((book) => [book.bookId, book]));
  const existingById = new Map(existing.map((entry) => [entry.bookId, entry]));
  const added: TBook[] = [];
  const unchanged: TBook[] = [];
  const changed: { previous: TEntry; next: TBook }[] = [];

  for (const book of remote) {
    const previous = existingById.get(book.bookId);
    const localAvailable =
      isHashPresent(book.bookHash, localHashes) ||
      (previous?.localPath != null && localPaths.has(previous.localPath));

    if (!previous) {
      if (localAvailable) unchanged.push(book);
      else added.push(book);
    } else if (isHashPresent(book.bookHash, localHashes)) {
      // The new remote revision is already present locally (for example it
      // was imported by another shelf). Repoint membership without another
      // download, even when the previous tracked hash differs.
      unchanged.push(book);
    } else if (previous.bookHash === book.bookHash && localAvailable) {
      unchanged.push(book);
    } else if (previous.bookHash !== book.bookHash) {
      changed.push({ previous, next: book });
    } else {
      added.push(book);
    }
  }

  return {
    added,
    unchanged,
    changed,
    removed: existing.filter((entry) => !remoteById.has(entry.bookId)),
  };
};

/**
 * Summarizes the outcome of shelf reconciliation into high-level counts.
 */
export const summarizeShelfReconciliation = <
  TBook extends ShelfSyncBook<unknown>,
  TEntry extends ShelfSyncEntry<unknown>,
>(
  reconciliation: ShelfReconciliation<TBook, TEntry>,
  downloadPolicy: ShelfDownloadPolicy = 'always',
): ShelfSyncPreview => ({
  total:
    reconciliation.added.length + reconciliation.unchanged.length + reconciliation.changed.length,
  added: reconciliation.added.length,
  unchanged: reconciliation.unchanged.length,
  changed: reconciliation.changed.length,
  removed: reconciliation.removed.length,
  downloads:
    downloadPolicy === 'off' ? 0 : reconciliation.added.length + reconciliation.changed.length,
});

/**
 * Partitions books into reuse, download, and absent sets.
 */
export const planShelfSync = <
  TBook extends ShelfSyncBook<unknown>,
  TEntry extends ShelfSyncEntry<unknown>,
>(
  remote: TBook[],
  existing: TEntry[],
  localHashes: Set<string>,
  localPaths = new Set<string>(),
): ShelfSyncPlan<TBook, TEntry, TBook['bookId']> => {
  const remoteIds = new Set(remote.map((book) => book.bookId));
  const trackedBooks = new Set(
    existing
      .filter((entry) => entry.localPath && localPaths.has(entry.localPath))
      .map((entry) => makeTrackedKey(entry.bookId, entry.bookHash)),
  );

  return {
    reuse: remote
      .filter(
        (book) =>
          isHashPresent(book.bookHash, localHashes) ||
          trackedBooks.has(makeTrackedKey(book.bookId, book.bookHash)),
      )
      .map((book) => book.bookId),
    download: remote.filter(
      (book) =>
        !isHashPresent(book.bookHash, localHashes) &&
        !trackedBooks.has(makeTrackedKey(book.bookId, book.bookHash)),
    ),
    absent: existing.filter((entry) => !remoteIds.has(entry.bookId)),
  };
};
