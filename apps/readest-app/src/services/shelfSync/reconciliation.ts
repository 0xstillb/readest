import type {
  ShelfDownloadPolicy,
  ShelfReconciliation,
  ShelfSnapshot,
  ShelfSnapshotStatus,
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
 *
 * Enforces Data Safety Invariant: only COMPLETE successful snapshots may produce removal decisions.
 */
export const reconcileShelfSnapshot = <
  TBook extends ShelfSyncBook<unknown>,
  TEntry extends ShelfSyncEntry<unknown>,
>(
  remote: TBook[] | ShelfSnapshot<TBook>,
  existing: TEntry[],
  localHashes: Set<string>,
  localPaths = new Set<string>(),
  options?: { snapshotStatus?: ShelfSnapshotStatus; snapshotComplete?: boolean },
): ShelfReconciliation<TBook, TEntry> => {
  const isSnapshotObj = remote != null && typeof remote === 'object' && 'status' in remote;
  const snapshotObj = isSnapshotObj ? (remote as ShelfSnapshot<TBook>) : undefined;
  const books: TBook[] =
    snapshotObj && Array.isArray(snapshotObj.books)
      ? snapshotObj.books
      : Array.isArray(remote)
        ? remote
        : [];

  const isComplete =
    options?.snapshotStatus !== undefined
      ? options.snapshotStatus === 'complete'
      : options?.snapshotComplete !== undefined
        ? options.snapshotComplete
        : snapshotObj
          ? snapshotObj.status === 'complete' && !snapshotObj.restartRequired
          : true;

  const remoteById = new Map(books.map((book) => [book.bookId, book]));
  const existingById = new Map(existing.map((entry) => [entry.bookId, entry]));
  const added: TBook[] = [];
  const unchanged: TBook[] = [];
  const changed: { previous: TEntry; next: TBook }[] = [];

  for (const book of books) {
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
    removed: isComplete ? existing.filter((entry) => !remoteById.has(entry.bookId)) : [],
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
 *
 * Enforces Data Safety Invariant: only COMPLETE successful snapshots may produce absent entries
 * eligible for removal.
 */
export const planShelfSync = <
  TBook extends ShelfSyncBook<unknown>,
  TEntry extends ShelfSyncEntry<unknown>,
>(
  remote: TBook[] | ShelfSnapshot<TBook>,
  existing: TEntry[],
  localHashes: Set<string>,
  localPaths = new Set<string>(),
  options?: { snapshotStatus?: ShelfSnapshotStatus; snapshotComplete?: boolean },
): ShelfSyncPlan<TBook, TEntry, TBook['bookId']> => {
  const isSnapshotObj = remote != null && typeof remote === 'object' && 'status' in remote;
  const snapshotObj = isSnapshotObj ? (remote as ShelfSnapshot<TBook>) : undefined;
  const books: TBook[] =
    snapshotObj && Array.isArray(snapshotObj.books)
      ? snapshotObj.books
      : Array.isArray(remote)
        ? remote
        : [];

  const isComplete =
    options?.snapshotStatus !== undefined
      ? options.snapshotStatus === 'complete'
      : options?.snapshotComplete !== undefined
        ? options.snapshotComplete
        : snapshotObj
          ? snapshotObj.status === 'complete' && !snapshotObj.restartRequired
          : true;

  const remoteIds = new Set(books.map((book) => book.bookId));
  const trackedBooks = new Set(
    existing
      .filter((entry) => entry.localPath && localPaths.has(entry.localPath))
      .map((entry) => makeTrackedKey(entry.bookId, entry.bookHash)),
  );

  return {
    reuse: books
      .filter(
        (book) =>
          isHashPresent(book.bookHash, localHashes) ||
          trackedBooks.has(makeTrackedKey(book.bookId, book.bookHash)),
      )
      .map((book) => book.bookId),
    download: books.filter(
      (book) =>
        !isHashPresent(book.bookHash, localHashes) &&
        !trackedBooks.has(makeTrackedKey(book.bookId, book.bookHash)),
    ),
    absent: isComplete ? existing.filter((entry) => !remoteIds.has(entry.bookId)) : [],
  };
};
