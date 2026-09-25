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

export const isHashPresent = (hash: string | null | undefined, localHashes: Set<string>): boolean =>
  hash != null && hash !== '' && localHashes.has(hash);

export const getRemoteBookHash = <TBook extends ShelfSyncBook<unknown>>(
  book: TBook,
): string | null => {
  if (book.fileHash != null && book.fileHash !== '') return book.fileHash;
  if (book.bookHash != null && book.bookHash !== '') return book.bookHash;
  return null;
};

/**
 * Determines whether a remote book represents a changed revision compared to a previously tracked entry.
 *
 * Rules:
 * - Treat same remote bookId as changed revision when fileHash or contentVersion changes.
 * - For null hash, use remote fileId/contentVersion conservatively.
 */
export const isChangedRevision = <
  TBook extends ShelfSyncBook<unknown>,
  TEntry extends ShelfSyncEntry<unknown>,
>(
  remote: TBook,
  previous: TEntry,
): boolean => {
  const remoteHash = getRemoteBookHash(remote);
  const trackedHash =
    previous.bookHash != null && previous.bookHash !== '' ? previous.bookHash : null;

  // Case 1: Both remote and tracked have non-null hashes
  if (remoteHash != null && trackedHash != null) {
    if (remoteHash !== trackedHash) {
      return true;
    }
    // Hashes match, but contentVersion changed
    if (
      remote.contentVersion != null &&
      previous.contentVersion != null &&
      String(remote.contentVersion) !== String(previous.contentVersion)
    ) {
      return true;
    }
    // Hashes match, but fileId changed
    if (
      remote.fileId != null &&
      previous.fileId != null &&
      String(remote.fileId) !== String(previous.fileId)
    ) {
      return true;
    }
    return false;
  }

  // Case 2: One or both hashes are null
  // Check contentVersion change
  if (
    remote.contentVersion != null &&
    previous.contentVersion != null &&
    String(remote.contentVersion) !== String(previous.contentVersion)
  ) {
    return true;
  }

  // Check fileId change
  if (
    remote.fileId != null &&
    previous.fileId != null &&
    String(remote.fileId) !== String(previous.fileId)
  ) {
    return true;
  }

  // If remote has a concrete hash where tracked entry didn't have one
  if (remoteHash != null && trackedHash == null) {
    return true;
  }

  // For null hash where neither contentVersion nor fileId changed, conservatively return false
  return false;
};

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

  const remoteById = new Map(books.map((book) => [String(book.bookId), book]));
  const existingById = new Map(existing.map((entry) => [String(entry.bookId), entry]));
  const added: TBook[] = [];
  const unchanged: TBook[] = [];
  const changed: { previous: TEntry; next: TBook }[] = [];

  for (const book of books) {
    const remoteHash = getRemoteBookHash(book);
    const previous = existingById.get(String(book.bookId));
    const isRemoteLocallyPresent = isHashPresent(remoteHash, localHashes);

    if (!previous) {
      if (isRemoteLocallyPresent) {
        unchanged.push(book);
      } else {
        added.push(book);
      }
      continue;
    }

    // Previous exists: check if revision changed
    if (isChangedRevision(book, previous)) {
      // If the revision changed because the remote hash changed, BUT that new remote hash
      // is already present locally in the library, reuse it without downloading.
      // However, if contentVersion or fileId changed, the local copy is an older revision
      // and MUST be downloaded.
      const isRemoteHashNewAndLocal =
        remoteHash != null &&
        remoteHash !== previous.bookHash &&
        isHashPresent(remoteHash, localHashes) &&
        !(
          book.contentVersion != null &&
          previous.contentVersion != null &&
          String(book.contentVersion) !== String(previous.contentVersion)
        ) &&
        !(
          book.fileId != null &&
          previous.fileId != null &&
          String(book.fileId) !== String(previous.fileId)
        );

      if (isRemoteHashNewAndLocal) {
        unchanged.push(book);
      } else {
        changed.push({ previous, next: book });
      }
      continue;
    }

    // Same revision: verify if local file is available
    const localAvailable =
      (remoteHash != null && isHashPresent(remoteHash, localHashes)) ||
      (previous.bookHash != null && isHashPresent(previous.bookHash, localHashes)) ||
      (previous.localPath != null && localPaths.has(previous.localPath));

    if (localAvailable) {
      unchanged.push(book);
    } else {
      // Local file missing, needs re-download
      added.push(book);
    }
  }

  return {
    added,
    unchanged,
    changed,
    removed: isComplete ? existing.filter((entry) => !remoteById.has(String(entry.bookId))) : [],
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
  const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths, options);

  return {
    reuse: reconciliation.unchanged.map((book) => book.bookId),
    download: [...reconciliation.added, ...reconciliation.changed.map((item) => item.next)],
    absent: reconciliation.removed,
  };
};
