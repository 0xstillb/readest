import type { Book } from '@/types/book';
import { getBookDirOfPath, getLocalBookFilename } from '@/utils/book';
import type {
  ShelfCleanupPolicy,
  ShelfDeletionDecision,
  ShelfDeletionPlan,
  ShelfDeletionReason,
  ShelfSnapshotStatus,
  ShelfSyncEntry,
} from './types';

export interface PlanShelfDeletionsOptions<TEntry extends ShelfSyncEntry<unknown>> {
  /** The absent entries identified from a COMPLETE, successful snapshot. */
  absentEntries: TEntry[];
  /** Cleanup policy configured for the shelf: 'keep_local' or 'remove_managed_copy'. */
  cleanupPolicy: ShelfCleanupPolicy;
  /** Current local library books. */
  library: Book[];
  /** Reference counts for local paths (across shelves/providers). */
  referenceCounts?: Map<string, number>;
  /** Optional custom predicate to determine if entry is managed by the provider. */
  isManaged?: (entry: TEntry) => boolean;
  /**
   * Explicit status of the snapshot from which absentEntries was derived.
   * Only 'complete' snapshots can produce removal decisions.
   */
  snapshotStatus?: ShelfSnapshotStatus;
  /**
   * Safety invariant guard: whether the snapshot that produced `absentEntries` was complete and successful.
   * If false, NO deletions are permitted regardless of other conditions.
   * Defaults to true.
   */
  snapshotComplete?: boolean;
}

/**
 * Evaluates deletion safety according to the Data Safety Invariant:
 *
 * When uncertain, KEEP the local book. Automatic deletion requires ALL:
 * 1. managed_by_provider = true
 * 2. removal proven from a COMPLETE successful snapshot
 * 3. cleanup_policy = remove_managed_copy
 * 4. no other shelf reference (referenceCount <= 1)
 * 5. no other provider reference
 * 6. tracked local file still corresponds to managed entry
 *
 * Failed/partial/cancelled/restarted/offline manifests MUST NEVER trigger deletion.
 */
export function planShelfDeletions<TEntry extends ShelfSyncEntry<unknown>>(
  options: PlanShelfDeletionsOptions<TEntry>,
): ShelfDeletionPlan<TEntry> {
  const {
    absentEntries,
    cleanupPolicy,
    library,
    referenceCounts = new Map<string, number>(),
    isManaged,
    snapshotStatus,
    snapshotComplete = true,
  } = options;

  const isComplete =
    snapshotStatus !== undefined ? snapshotStatus === 'complete' : snapshotComplete;

  const decisions: ShelfDeletionDecision<TEntry>[] = [];
  const toDelete: Array<{ entry: TEntry; book?: Book; localPath: string }> = [];
  const toKeep: Array<{ entry: TEntry; reason: ShelfDeletionReason }> = [];

  const currentRefCounts = new Map(referenceCounts);

  for (const entry of absentEntries) {
    if (!isComplete) {
      const reason: ShelfDeletionReason = 'snapshot_incomplete';
      decisions.push({ action: 'keep', entry, reason });
      toKeep.push({ entry, reason });
      continue;
    }

    if (cleanupPolicy !== 'remove_managed_copy') {
      const reason: ShelfDeletionReason = 'policy_keep_local';
      decisions.push({ action: 'keep', entry, reason });
      toKeep.push({ entry, reason });
      continue;
    }

    const managed = isManaged ? isManaged(entry) : (entry.managedByProvider ?? false);
    if (!managed) {
      const reason: ShelfDeletionReason = 'not_managed_by_provider';
      decisions.push({ action: 'keep', entry, reason });
      toKeep.push({ entry, reason });
      continue;
    }

    if (!entry.localPath) {
      const reason: ShelfDeletionReason = 'missing_local_path';
      decisions.push({ action: 'keep', entry, reason });
      toKeep.push({ entry, reason });
      continue;
    }

    const references = currentRefCounts.get(entry.localPath) ?? 1;
    if (references > 1) {
      currentRefCounts.set(entry.localPath, references - 1);
      const reason: ShelfDeletionReason = 'multiple_references';
      decisions.push({ action: 'keep', entry, reason, localPath: entry.localPath });
      toKeep.push({ entry, reason });
      continue;
    }

    // Guard 6 (Invariant): Tracked local file must still correspond to managed entry.
    // When uncertain, KEEP the local book. Prefer extra file over false deletion.

    // 6a. Check path ambiguity: exactly one book in library should match entry.localPath
    const localDir = getBookDirOfPath(entry.localPath);
    const matchingBooks = library.filter(
      (b) =>
        getLocalBookFilename(b) === entry.localPath ||
        (localDir !== undefined && b.hash === localDir),
    );
    if (matchingBooks.length > 1) {
      const reason: ShelfDeletionReason = 'ambiguous_local_path';
      decisions.push({ action: 'keep', entry, reason, localPath: entry.localPath });
      toKeep.push({ entry, reason });
      continue;
    }

    const book = matchingBooks[0];

    // 6b. Check hash correspondence and detect user replacements
    if (entry.bookHash) {
      // If a book with this hash exists in library at a DIFFERENT path/directory, path is ambiguous
      const booksWithHash = library.filter((b) => b.hash === entry.bookHash);
      if (
        booksWithHash.length > 1 ||
        (booksWithHash.length === 1 &&
          localDir !== undefined &&
          booksWithHash[0]!.hash !== localDir &&
          getLocalBookFilename(booksWithHash[0]!) !== entry.localPath)
      ) {
        const reason: ShelfDeletionReason = 'ambiguous_local_path';
        decisions.push({ action: 'keep', entry, reason, localPath: entry.localPath });
        toKeep.push({ entry, reason });
        continue;
      }

      // If the book matches neither the tracked bookHash nor the tracked local path directory, user replaced it
      if (
        book &&
        book.hash !== entry.bookHash &&
        (localDir === undefined || book.hash !== localDir)
      ) {
        const reason: ShelfDeletionReason = 'unmatched_managed_entry';
        decisions.push({ action: 'keep', entry, reason, localPath: entry.localPath });
        toKeep.push({ entry, reason });
        continue;
      }
    }

    // 6c. If the book was not found in library, correspondence cannot be proven.
    // Prefer extra file over false deletion.
    if (!book) {
      const reason: ShelfDeletionReason = 'unmatched_managed_entry';
      decisions.push({ action: 'keep', entry, reason, localPath: entry.localPath });
      toKeep.push({ entry, reason });
      continue;
    }

    // All 6 safety criteria satisfied: eligible for deletion
    decisions.push({
      action: 'delete',
      entry,
      book,
      localPath: entry.localPath,
    });
    toDelete.push({
      entry,
      book,
      localPath: entry.localPath,
    });
  }

  return { decisions, toDelete, toKeep };
}

export interface CanDeleteObsoleteRevisionOptions<TEntry extends ShelfSyncEntry<unknown>> {
  previousEntry: TEntry;
  importedBook: Book;
  cleanupPolicy: ShelfCleanupPolicy;
  referenceCount: number;
  snapshotStatus?: ShelfSnapshotStatus;
  snapshotComplete?: boolean;
}

/**
 * Evaluates whether an obsolete managed copy replaced by a newer revision can be safely deleted.
 * Follows the Data Safety Invariant:
 * 1. Snapshot must be complete
 * 2. cleanup_policy must be remove_managed_copy
 * 3. previous entry must be managed_by_provider
 * 4. local path must exist and differ from the replacement book
 * 5. no remaining shelf or provider references (referenceCount === 0)
 */
export function canDeleteObsoleteRevision<TEntry extends ShelfSyncEntry<unknown>>(
  options: CanDeleteObsoleteRevisionOptions<TEntry>,
): boolean {
  const isComplete =
    options.snapshotStatus !== undefined
      ? options.snapshotStatus === 'complete'
      : (options.snapshotComplete ?? true);

  if (!isComplete) return false;
  if (options.cleanupPolicy !== 'remove_managed_copy') return false;
  if (!options.previousEntry.managedByProvider) return false;
  if (!options.previousEntry.localPath) return false;

  const newPath = getLocalBookFilename(options.importedBook);
  if (options.previousEntry.localPath === newPath) return false;
  if (
    options.previousEntry.bookHash &&
    options.previousEntry.bookHash === options.importedBook.hash
  ) {
    return false;
  }

  return options.referenceCount === 0;
}
