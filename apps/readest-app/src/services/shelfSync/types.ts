import type { Book } from '@/types/book';

export type ShelfCleanupPolicy = 'keep_local' | 'remove_managed_copy';
export type ShelfDownloadPolicy = 'off' | 'wifi_only' | 'always';

/**
 * Generic representation of a book in a remote shelf snapshot.
 * `bookHash` is nullable to support providers or workflows where the remote hash
 * is unknown or transformed prior to import.
 */
export interface ShelfSyncBook<TId = number | string> {
  bookId: TId;
  bookHash: string | null;
  filename: string;
  format?: string;
  size?: number;
  title?: string;
  author?: string;
}

/**
 * Generic representation of a recorded shelf entry in local storage.
 */
export interface ShelfSyncEntry<TId = number | string> {
  bookId: TId;
  bookHash: string | null;
  localPath: string | null;
  managedByProvider?: boolean;
}

/**
 * In-memory index of books verified to exist on the local filesystem.
 */
export interface LibraryPresenceIndex {
  hashes: Set<string>;
  paths: Set<string>;
  booksByHash: Map<string, Book>;
  booksByPath: Map<string, Book>;
}

/**
 * Pure snapshot reconciliation result.
 */
export interface ShelfReconciliation<
  TBook extends ShelfSyncBook<unknown> = ShelfSyncBook,
  TEntry extends ShelfSyncEntry<unknown> = ShelfSyncEntry,
> {
  added: TBook[];
  unchanged: TBook[];
  changed: { previous: TEntry; next: TBook }[];
  removed: TEntry[];
}

/**
 * Summary of sync impact for UI display or dry-run evaluation.
 */
export interface ShelfSyncPreview {
  total: number;
  added: number;
  unchanged: number;
  changed: number;
  removed: number;
  downloads: number;
}

/**
 * Execution plan partitioning remote and local entries.
 */
export interface ShelfSyncPlan<
  TBook extends ShelfSyncBook<unknown> = ShelfSyncBook,
  TEntry extends ShelfSyncEntry<unknown> = ShelfSyncEntry,
  TId = TBook['bookId'],
> {
  reuse: TId[];
  download: TBook[];
  absent: TEntry[];
}

export type ShelfDeletionReason =
  | 'policy_keep_local'
  | 'not_managed_by_provider'
  | 'missing_local_path'
  | 'multiple_references'
  | 'snapshot_incomplete';

export interface ShelfDeletionDecision<TEntry extends ShelfSyncEntry<unknown> = ShelfSyncEntry> {
  action: 'delete' | 'keep';
  entry: TEntry;
  reason?: ShelfDeletionReason;
  book?: Book;
  localPath?: string;
}

export interface ShelfDeletionPlan<TEntry extends ShelfSyncEntry<unknown> = ShelfSyncEntry> {
  decisions: ShelfDeletionDecision<TEntry>[];
  toDelete: Array<{ entry: TEntry; book?: Book; localPath: string }>;
  toKeep: Array<{ entry: TEntry; reason: ShelfDeletionReason }>;
}
