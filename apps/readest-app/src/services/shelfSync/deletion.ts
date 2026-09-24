import type { Book } from '@/types/book';
import { getLocalBookFilename } from '@/utils/book';
import type {
  ShelfCleanupPolicy,
  ShelfDeletionDecision,
  ShelfDeletionPlan,
  ShelfDeletionReason,
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
    snapshotComplete = true,
  } = options;

  const decisions: ShelfDeletionDecision<TEntry>[] = [];
  const toDelete: Array<{ entry: TEntry; book?: Book; localPath: string }> = [];
  const toKeep: Array<{ entry: TEntry; reason: ShelfDeletionReason }> = [];

  const currentRefCounts = new Map(referenceCounts);

  for (const entry of absentEntries) {
    if (!snapshotComplete) {
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

    const book = library.find((b) => getLocalBookFilename(b) === entry.localPath);
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
