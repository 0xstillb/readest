import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { ProgressHandler } from '@/utils/transfer';
import type {
  GetShelfEntriesOptions,
  GetShelfSubscriptionsOptions,
  ReferenceQueryOptions,
  SaveShelfSubscriptionInput,
  ShelfEntryKey,
  ShelfEntryRecord,
  ShelfEntryWrite,
  ShelfSubscriptionRecord,
} from './ShelfSyncStore';

export type {
  GetShelfEntriesOptions,
  GetShelfSubscriptionsOptions,
  ReferenceQueryOptions,
  SaveShelfSubscriptionInput,
  ShelfEntryKey,
  ShelfEntryRecord,
  ShelfEntryWrite,
  ShelfSubscriptionRecord,
};

export type ShelfCleanupPolicy = 'keep_local' | 'remove_managed_copy';
export type ShelfDownloadPolicy = 'off' | 'wifi_only' | 'always';

export interface IShelfSyncStore {
  readonly provider?: string;
  readonly connectionId?: string;

  getShelfSubscriptions(options?: GetShelfSubscriptionsOptions): Promise<ShelfSubscriptionRecord[]>;
  saveShelfSubscription(
    shelfIdOrInput: string | number | SaveShelfSubscriptionInput,
    enabled?: boolean,
    cleanupPolicy?: ShelfCleanupPolicy,
    downloadPolicy?: ShelfDownloadPolicy,
    shelfType?: string,
  ): Promise<boolean | void>;
  deleteShelfSubscription(
    shelfId: string | number,
    shelfType?: string,
    options?: { provider?: string; connectionId?: string },
  ): Promise<void>;

  getShelfEntries(
    shelfId: string | number,
    shelfType?: string,
    options?: GetShelfEntriesOptions,
  ): Promise<ShelfEntryRecord[]>;
  markShelfEntries(
    entries: ShelfEntryWrite[],
    options?: { insertOnly?: boolean },
  ): Promise<number | void>;
  removeShelfEntries(entries: ShelfEntryKey[]): Promise<void>;

  getManagedShelfReferenceCounts(
    localPaths: string[],
    options?: ReferenceQueryOptions,
  ): Promise<Map<string, number>>;
  getAllShelfReferenceCounts(
    localPaths: string[],
    options?: ReferenceQueryOptions,
  ): Promise<Map<string, number>>;
}

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
  fileId?: string | number | null;
  contentVersion?: string | null;
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

export type ShelfSyncStage = 'downloading' | 'importing';

export interface ShelfSyncProgressEvent<TBook = ShelfSyncBook<unknown>> {
  stage: ShelfSyncStage;
  book?: TBook;
  progress?: number;
  total?: number;
  message?: string;
}

export interface ShelfSyncTransfer<TBook = ShelfSyncBook<unknown>> {
  onProgress?: ProgressHandler;
  onStage?: (event: { stage: ShelfSyncStage; book: TBook }) => void;
  onStatus?: (status: ShelfSyncProgressEvent<TBook>) => void;
  signal?: AbortSignal;
}

export interface ShelfSyncResult {
  reused: number;
  downloaded: number;
  removed: number;
}

export type ShelfSyncAppService = Pick<
  AppService,
  | 'createDir'
  | 'writeFile'
  | 'resolveFilePath'
  | 'exists'
  | 'deleteFile'
  | 'importBook'
  | 'deleteBook'
>;

/**
 * Provider-specific adapter that owns remote listing, mapping, transport, and download construction.
 */
export interface ShelfSyncAdapter<
  TId extends string | number = string | number,
  TBook extends ShelfSyncBook<TId> = ShelfSyncBook<TId>,
> {
  readonly provider: string;
  readonly connectionId: string;
  readonly tempFolder?: string;
  readonly importErrorMessage?: string;

  /**
   * Fetch all books in a remote shelf.
   */
  getShelfBooks(shelfType: string, shelfId: TId): Promise<TBook[]>;

  /**
   * Download a shelf book into memory as an ArrayBuffer.
   */
  downloadBook(
    book: TBook,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer>;

  /**
   * Optional direct file download to avoid WebView memory constraints on native platforms.
   */
  downloadBookToFile?: (
    book: TBook,
    filePath: string,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
  ) => Promise<void>;

  /**
   * Optional hook to inspect or repair book bytes before validation and import.
   */
  repairBookData?: (data: ArrayBuffer, book: TBook) => Promise<ArrayBuffer> | ArrayBuffer;

  /**
   * Optional custom validator on downloaded bytes (defaults to validateShelfDownload).
   */
  validateBookData?: (filename: string, data: ArrayBuffer, expectedSize?: number) => void;

  /**
   * Optional telemetry/metrics hook.
   */
  onPerformanceMetric?: (metric: string, value?: number) => void;
}

export interface ShelfSyncRunOptions<
  TId extends string | number = string | number,
  TBook extends ShelfSyncBook<TId> = ShelfSyncBook<TId>,
> {
  shelfType: string;
  shelfId: TId;
  library: Book[];
  onImported: (book: Book, library: Book[]) => Promise<void> | void;
  onRemoved?: (book: Book, library: Book[]) => Promise<void> | void;
  transfer?: ShelfSyncTransfer<TBook>;
  cleanupPolicy?: ShelfCleanupPolicy;
  downloadPolicy?: ShelfDownloadPolicy;
  presenceIndex?: LibraryPresenceIndex;
}

export interface ShelfSubscribedSyncOptions<
  TId extends string | number = string | number,
  TBook extends ShelfSyncBook<TId> = ShelfSyncBook<TId>,
> {
  getLibrary: () => Book[];
  onImported: (book: Book, library: Book[]) => Promise<void> | void;
  onRemoved?: (book: Book, library: Book[]) => Promise<void> | void;
  transfer?: ShelfSyncTransfer<TBook>;
  filterSubscription?: (subscription: ShelfSubscriptionRecord) => boolean;
}
