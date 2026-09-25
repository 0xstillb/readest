import { describe, expect, it } from 'vitest';
import type { Book } from '@/types/book';
import {
  addToPresenceIndex,
  buildLibraryPresenceIndex,
  canDeleteObsoleteRevision,
  collectShelfSnapshot,
  createCancelledSnapshot,
  createCompleteSnapshot,
  createFailedSnapshot,
  createPartialSnapshot,
  createRestartRequiredSnapshot,
  isCompleteSnapshot,
  planShelfDeletions,
  planShelfSync,
  reconcileShelfSnapshot,
  removeFromPresenceIndex,
  safeShelfFilename,
  summarizeShelfReconciliation,
  validateShelfDownload,
} from '@/services/shelfSync';

describe('Generic Shelf Sync Reconciliation and Planning', () => {
  const makeMockBook = (overrides: Partial<Book> = {}): Book => ({
    hash: 'hash-1',
    title: 'Test Book',
    author: 'Test Author',
    sourceTitle: 'Test Book',
    format: 'EPUB',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });

  describe('new book', () => {
    it('plans download and reconciles as added when a remote book is not tracked and not local', () => {
      const remote = [{ bookId: 'b1', bookHash: 'hash-new', filename: 'new.epub', format: 'EPUB' }];
      const existing: Array<{
        bookId: string;
        bookHash: string | null;
        localPath: string | null;
        managedByProvider: boolean;
      }> = [];
      const localHashes = new Set<string>();
      const localPaths = new Set<string>();

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.reuse).toEqual([]);
      expect(plan.download).toEqual(remote);
      expect(plan.absent).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.added).toEqual(remote);
      expect(reconciliation.unchanged).toEqual([]);
      expect(reconciliation.changed).toEqual([]);
      expect(reconciliation.removed).toEqual([]);

      const preview = summarizeShelfReconciliation(reconciliation);
      expect(preview).toEqual({
        total: 1,
        added: 1,
        unchanged: 0,
        changed: 0,
        removed: 0,
        downloads: 1,
      });
    });
  });

  describe('same hash', () => {
    it('plans reuse and reconciles as unchanged when hash matches and local file exists', () => {
      const remote = [
        { bookId: 'b1', bookHash: 'hash-same', filename: 'same.epub', format: 'EPUB' },
      ];
      const existing = [
        {
          bookId: 'b1',
          bookHash: 'hash-same',
          localPath: 'hash-same/same.epub',
          managedByProvider: true,
        },
      ];
      const localHashes = new Set(['hash-same']);
      const localPaths = new Set(['hash-same/same.epub']);

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.reuse).toEqual(['b1']);
      expect(plan.download).toEqual([]);
      expect(plan.absent).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.unchanged).toEqual(remote);
      expect(reconciliation.added).toEqual([]);
      expect(reconciliation.changed).toEqual([]);
      expect(reconciliation.removed).toEqual([]);

      const preview = summarizeShelfReconciliation(reconciliation);
      expect(preview.downloads).toBe(0);
      expect(preview.unchanged).toBe(1);
    });
  });

  describe('changed hash', () => {
    it('plans download and reconciles as changed when remote hash differs and is not locally available', () => {
      const remote = [{ bookId: 'b1', bookHash: 'hash-v2', filename: 'book.epub', format: 'EPUB' }];
      const existing = [
        {
          bookId: 'b1',
          bookHash: 'hash-v1',
          localPath: 'hash-v1/book.epub',
          managedByProvider: true,
        },
      ];
      const localHashes = new Set(['hash-v1']);
      const localPaths = new Set(['hash-v1/book.epub']);

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.reuse).toEqual([]);
      expect(plan.download).toEqual(remote);
      expect(plan.absent).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.changed).toEqual([
        {
          previous: existing[0],
          next: remote[0],
        },
      ]);
      expect(reconciliation.added).toEqual([]);
      expect(reconciliation.unchanged).toEqual([]);

      const preview = summarizeShelfReconciliation(reconciliation);
      expect(preview.changed).toBe(1);
      expect(preview.downloads).toBe(1);
    });

    it('detects changed revision when remote provides fileHash differing from tracked bookHash', () => {
      const remote = [
        {
          bookId: 'b1',
          fileHash: 'filehash-v2',
          bookHash: null,
          filename: 'book.epub',
          format: 'EPUB',
        },
      ];
      const existing = [
        {
          bookId: 'b1',
          bookHash: 'hash-v1',
          localPath: 'hash-v1/book.epub',
          managedByProvider: true,
        },
      ];
      const localHashes = new Set(['hash-v1']);
      const localPaths = new Set(['hash-v1/book.epub']);

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.download).toEqual(remote);
      expect(plan.reuse).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.changed).toHaveLength(1);
      expect(reconciliation.changed[0]?.next.fileHash).toBe('filehash-v2');
    });

    it('treats same remote bookId as changed revision when contentVersion changes', () => {
      const remote = [
        {
          bookId: 'b1',
          bookHash: 'hash-same',
          contentVersion: '2',
          filename: 'book.epub',
          format: 'EPUB',
        },
      ];
      const existing = [
        {
          bookId: 'b1',
          bookHash: 'hash-same',
          contentVersion: '1',
          localPath: 'hash-same/book.epub',
          managedByProvider: true,
        },
      ];
      const localHashes = new Set(['hash-same']);
      const localPaths = new Set(['hash-same/book.epub']);

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      // Because contentVersion changed, it plans download rather than reuse
      expect(plan.download).toEqual(remote);
      expect(plan.reuse).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.changed).toHaveLength(1);
      expect(reconciliation.changed[0]?.previous.contentVersion).toBe('1');
      expect(reconciliation.changed[0]?.next.contentVersion).toBe('2');
    });

    it('treats same remote bookId as changed revision when fileId changes', () => {
      const remote = [
        {
          bookId: 'b1',
          bookHash: 'hash-same',
          fileId: 202,
          filename: 'book.epub',
          format: 'EPUB',
        },
      ];
      const existing = [
        {
          bookId: 'b1',
          bookHash: 'hash-same',
          fileId: 101,
          localPath: 'hash-same/book.epub',
          managedByProvider: true,
        },
      ];
      const localHashes = new Set(['hash-same']);
      const localPaths = new Set(['hash-same/book.epub']);

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.download).toEqual(remote);
      expect(plan.reuse).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.changed).toHaveLength(1);
      expect(reconciliation.changed[0]?.previous.fileId).toBe(101);
      expect(reconciliation.changed[0]?.next.fileId).toBe(202);
    });

    it('detects null-hash revision when contentVersion changes', () => {
      const remote = [
        {
          bookId: 'b1',
          bookHash: null,
          contentVersion: 'v2',
          filename: 'book.epub',
          format: 'EPUB',
        },
      ];
      const existing = [
        {
          bookId: 'b1',
          bookHash: null,
          contentVersion: 'v1',
          localPath: 'path/book.epub',
          managedByProvider: true,
        },
      ];
      const localHashes = new Set<string>();
      const localPaths = new Set(['path/book.epub']);

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.download).toEqual(remote);
      expect(plan.reuse).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.changed).toHaveLength(1);
      expect(reconciliation.changed[0]?.next.contentVersion).toBe('v2');
    });

    it('detects null-hash revision when fileId changes', () => {
      const remote = [
        {
          bookId: 'b1',
          bookHash: null,
          fileId: 'file-new',
          filename: 'book.epub',
          format: 'EPUB',
        },
      ];
      const existing = [
        {
          bookId: 'b1',
          bookHash: null,
          fileId: 'file-old',
          localPath: 'path/book.epub',
          managedByProvider: true,
        },
      ];
      const localHashes = new Set<string>();
      const localPaths = new Set(['path/book.epub']);

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.download).toEqual(remote);
      expect(plan.reuse).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.changed).toHaveLength(1);
      expect(reconciliation.changed[0]?.next.fileId).toBe('file-new');
    });

    it('conservatively reuses null-hash book when version and fileId are unchanged and local file exists', () => {
      const remote = [
        {
          bookId: 'b1',
          bookHash: null,
          fileId: 'f1',
          contentVersion: '1',
          filename: 'book.epub',
          format: 'EPUB',
        },
      ];
      const existing = [
        {
          bookId: 'b1',
          bookHash: null,
          fileId: 'f1',
          contentVersion: '1',
          localPath: 'path/book.epub',
          managedByProvider: true,
        },
      ];
      const localHashes = new Set<string>();
      const localPaths = new Set(['path/book.epub']);

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.reuse).toEqual(['b1']);
      expect(plan.download).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.unchanged).toEqual(remote);
      expect(reconciliation.changed).toEqual([]);
      expect(reconciliation.added).toEqual([]);
    });

    it('conservatively reuses null-hash remote book when tracked has hash but version/fileId match', () => {
      const remote = [
        {
          bookId: 'b1',
          bookHash: null,
          fileId: 'f1',
          contentVersion: '1',
          filename: 'book.epub',
          format: 'EPUB',
        },
      ];
      const existing = [
        {
          bookId: 'b1',
          bookHash: 'hash-known',
          fileId: 'f1',
          contentVersion: '1',
          localPath: 'path/book.epub',
          managedByProvider: true,
        },
      ];
      const localHashes = new Set(['hash-known']);
      const localPaths = new Set(['path/book.epub']);

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.reuse).toEqual(['b1']);
      expect(plan.download).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.unchanged).toEqual(remote);
      expect(reconciliation.changed).toEqual([]);
    });

    it('reconciles changed revision as unchanged when new revision is already present locally', () => {
      const remote = [
        {
          bookId: 'b1',
          bookHash: 'hash-v2',
          filename: 'book.epub',
          format: 'EPUB',
        },
      ];
      const existing = [
        {
          bookId: 'b1',
          bookHash: 'hash-v1',
          localPath: 'hash-v1/book.epub',
          managedByProvider: true,
        },
      ];
      // hash-v2 is already local in library!
      const localHashes = new Set(['hash-v1', 'hash-v2']);
      const localPaths = new Set(['hash-v1/book.epub', 'hash-v2/book.epub']);

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.reuse).toEqual(['b1']);
      expect(plan.download).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.unchanged).toEqual(remote);
      expect(reconciliation.changed).toEqual([]);
      expect(reconciliation.added).toEqual([]);
    });
  });

  describe('canDeleteObsoleteRevision', () => {
    const makeBook = (hash: string, filename: string): Book => ({
      hash,
      title: filename,
      author: 'Author',
      sourceTitle: filename,
      format: 'EPUB',
      createdAt: 0,
      updatedAt: 0,
    });

    it('approves deletion when all invariant conditions are satisfied', () => {
      const prev = {
        bookId: 'b1',
        bookHash: 'hash-v1',
        localPath: 'hash-v1/book.epub',
        managedByProvider: true,
      };
      const imported = makeBook('hash-v2', 'book-v2.epub');

      const canDelete = canDeleteObsoleteRevision({
        previousEntry: prev,
        importedBook: imported,
        cleanupPolicy: 'remove_managed_copy',
        referenceCount: 0,
        snapshotComplete: true,
      });

      expect(canDelete).toBe(true);
    });

    it('forbids deletion when snapshot is incomplete', () => {
      const prev = {
        bookId: 'b1',
        bookHash: 'hash-v1',
        localPath: 'hash-v1/book.epub',
        managedByProvider: true,
      };
      const imported = makeBook('hash-v2', 'book-v2.epub');

      expect(
        canDeleteObsoleteRevision({
          previousEntry: prev,
          importedBook: imported,
          cleanupPolicy: 'remove_managed_copy',
          referenceCount: 0,
          snapshotComplete: false,
        }),
      ).toBe(false);

      expect(
        canDeleteObsoleteRevision({
          previousEntry: prev,
          importedBook: imported,
          cleanupPolicy: 'remove_managed_copy',
          referenceCount: 0,
          snapshotStatus: 'partial',
        }),
      ).toBe(false);
    });

    it('forbids deletion when cleanupPolicy is keep_local', () => {
      const prev = {
        bookId: 'b1',
        bookHash: 'hash-v1',
        localPath: 'hash-v1/book.epub',
        managedByProvider: true,
      };
      const imported = makeBook('hash-v2', 'book-v2.epub');

      expect(
        canDeleteObsoleteRevision({
          previousEntry: prev,
          importedBook: imported,
          cleanupPolicy: 'keep_local',
          referenceCount: 0,
          snapshotComplete: true,
        }),
      ).toBe(false);
    });

    it('forbids deletion when not managed by provider', () => {
      const prev = {
        bookId: 'b1',
        bookHash: 'hash-v1',
        localPath: 'hash-v1/book.epub',
        managedByProvider: false,
      };
      const imported = makeBook('hash-v2', 'book-v2.epub');

      expect(
        canDeleteObsoleteRevision({
          previousEntry: prev,
          importedBook: imported,
          cleanupPolicy: 'remove_managed_copy',
          referenceCount: 0,
          snapshotComplete: true,
        }),
      ).toBe(false);
    });

    it('forbids deletion when other shelves still reference previous localPath', () => {
      const prev = {
        bookId: 'b1',
        bookHash: 'hash-v1',
        localPath: 'hash-v1/book.epub',
        managedByProvider: true,
      };
      const imported = makeBook('hash-v2', 'book-v2.epub');

      expect(
        canDeleteObsoleteRevision({
          previousEntry: prev,
          importedBook: imported,
          cleanupPolicy: 'remove_managed_copy',
          referenceCount: 1, // another shelf references it!
          snapshotComplete: true,
        }),
      ).toBe(false);
    });

    it('forbids deletion when imported book has same hash or localPath', () => {
      const prev = {
        bookId: 'b1',
        bookHash: 'hash-same',
        localPath: 'hash-same/book.epub',
        managedByProvider: true,
      };
      const imported = makeBook('hash-same', 'book.epub');

      expect(
        canDeleteObsoleteRevision({
          previousEntry: prev,
          importedBook: imported,
          cleanupPolicy: 'remove_managed_copy',
          referenceCount: 0,
          snapshotComplete: true,
        }),
      ).toBe(false);
    });
  });

  describe('removal', () => {
    it('plans absent and reconciles as removed when tracked entry is missing from remote snapshot', () => {
      const remote: Array<{
        bookId: number;
        bookHash: string;
        filename: string;
      }> = [];
      const existing = [
        {
          bookId: 10,
          bookHash: 'hash-10',
          localPath: 'hash-10/book.epub',
          managedByProvider: true,
        },
      ];

      const plan = planShelfSync(remote, existing, new Set(), new Set());
      expect(plan.absent).toEqual(existing);
      expect(plan.download).toEqual([]);
      expect(plan.reuse).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, new Set(), new Set());
      expect(reconciliation.removed).toEqual(existing);
      expect(reconciliation.added).toEqual([]);
      expect(reconciliation.unchanged).toEqual([]);
    });

    it('approves deletion when cleanupPolicy is remove_managed_copy and single reference', () => {
      const existing = [
        {
          bookId: 10,
          bookHash: 'hash-10',
          localPath: 'hash-10/Test Book.epub',
          managedByProvider: true,
        },
      ];
      const book = makeMockBook({ hash: 'hash-10', title: 'Test Book', format: 'EPUB' });

      const deletionPlan = planShelfDeletions({
        absentEntries: existing,
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['hash-10/Test Book.epub', 1]]),
        snapshotComplete: true,
      });

      expect(deletionPlan.toDelete).toHaveLength(1);
      expect(deletionPlan.toDelete[0]?.book?.hash).toBe('hash-10');
      expect(deletionPlan.toDelete[0]?.localPath).toBe('hash-10/Test Book.epub');
      expect(deletionPlan.toKeep).toHaveLength(0);
    });

    it('keeps local copy when cleanupPolicy is keep_local', () => {
      const existing = [
        {
          bookId: 10,
          bookHash: 'hash-10',
          localPath: 'hash-10/Test Book.epub',
          managedByProvider: true,
        },
      ];
      const book = makeMockBook({ hash: 'hash-10' });

      const deletionPlan = planShelfDeletions({
        absentEntries: existing,
        cleanupPolicy: 'keep_local',
        library: [book],
        snapshotComplete: true,
      });

      expect(deletionPlan.toDelete).toHaveLength(0);
      expect(deletionPlan.toKeep).toHaveLength(1);
      expect(deletionPlan.toKeep[0]?.reason).toBe('policy_keep_local');
    });
  });

  describe('missing file', () => {
    it('plans download again when remembered entry matches hash but file is absent from disk', () => {
      const remote = [{ bookId: 1, bookHash: 'hash-1', filename: 'book.epub', format: 'EPUB' }];
      const existing = [
        {
          bookId: 1,
          bookHash: 'hash-1',
          localPath: 'hash-1/book.epub',
          managedByProvider: true,
        },
      ];
      // File missing on disk -> not in localHashes and not in localPaths
      const localHashes = new Set<string>();
      const localPaths = new Set<string>();

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.reuse).toEqual([]);
      expect(plan.download).toEqual(remote);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.added).toEqual(remote);
      expect(reconciliation.unchanged).toEqual([]);
    });
  });

  describe('tombstone', () => {
    it('excludes soft-deleted tombstones from presence index so sync restores them', async () => {
      const activeBook = makeMockBook({ hash: 'active-hash', title: 'Active' });
      const tombstoneBook = makeMockBook({
        hash: 'deleted-hash',
        title: 'Deleted',
        deletedAt: Date.now(),
      });

      const appService = {
        exists: async (_path: string) => true,
      };

      const presence = await buildLibraryPresenceIndex([activeBook, tombstoneBook], appService);

      expect(presence.hashes.has('active-hash')).toBe(true);
      expect(presence.hashes.has('deleted-hash')).toBe(false);

      // Given the presence index excludes tombstones, syncing a remote book matching
      // the tombstone hash must download it rather than falsely reusing the deleted tombstone
      const remote = [
        { bookId: 2, bookHash: 'deleted-hash', filename: 'restored.epub', format: 'EPUB' },
      ];
      const plan = planShelfSync(remote, [], presence.hashes, presence.paths);
      expect(plan.download).toEqual(remote);
      expect(plan.reuse).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, [], presence.hashes, presence.paths);
      expect(reconciliation.added).toEqual(remote);
      expect(reconciliation.unchanged).toEqual([]);
    });
  });

  describe('user-owned file', () => {
    it('never purges user-owned books even under destructive cleanup policy', () => {
      const userEntry = {
        bookId: 99,
        bookHash: 'user-hash',
        localPath: 'user-hash/UserBook.epub',
        managedByProvider: false,
      };
      const book = makeMockBook({ hash: 'user-hash', title: 'UserBook' });

      const deletionPlan = planShelfDeletions({
        absentEntries: [userEntry],
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['user-hash/UserBook.epub', 1]]),
        snapshotComplete: true,
      });

      expect(deletionPlan.toDelete).toHaveLength(0);
      expect(deletionPlan.toKeep).toHaveLength(1);
      expect(deletionPlan.toKeep[0]?.reason).toBe('not_managed_by_provider');
    });

    it('respects custom isManaged predicate if provided', () => {
      const entry = {
        bookId: 88,
        bookHash: 'h88',
        localPath: 'h88/book.epub',
        managedByProvider: true, // flag says true, but custom predicate says false
      };

      const deletionPlan = planShelfDeletions({
        absentEntries: [entry],
        cleanupPolicy: 'remove_managed_copy',
        library: [],
        isManaged: () => false,
        snapshotComplete: true,
      });

      expect(deletionPlan.toDelete).toHaveLength(0);
      expect(deletionPlan.toKeep[0]?.reason).toBe('not_managed_by_provider');
    });
  });

  describe('multiple shelf refs', () => {
    it('preserves a managed file when another shelf or provider still references it', () => {
      const sharedEntry = {
        bookId: 42,
        bookHash: 'shared-hash',
        localPath: 'shared-hash/SharedBook.epub',
        managedByProvider: true,
      };
      const book = makeMockBook({ hash: 'shared-hash', title: 'SharedBook' });

      // Reference count = 2
      const referenceCounts = new Map([['shared-hash/SharedBook.epub', 2]]);

      const deletionPlan = planShelfDeletions({
        absentEntries: [sharedEntry],
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts,
        snapshotComplete: true,
      });

      expect(deletionPlan.toDelete).toHaveLength(0);
      expect(deletionPlan.toKeep).toHaveLength(1);
      expect(deletionPlan.toKeep[0]?.reason).toBe('multiple_references');
    });

    it('deletes on the final dereference when multiple absent entries share the path in one plan', () => {
      const entryA = {
        bookId: 101,
        bookHash: 'shared-hash',
        localPath: 'shared-hash/SharedBook.epub',
        managedByProvider: true,
      };
      const entryB = {
        bookId: 102,
        bookHash: 'shared-hash',
        localPath: 'shared-hash/SharedBook.epub',
        managedByProvider: true,
      };
      const book = makeMockBook({ hash: 'shared-hash', title: 'SharedBook' });

      // Total references is 2, and both entries are removed in the same batch
      const referenceCounts = new Map([['shared-hash/SharedBook.epub', 2]]);

      const deletionPlan = planShelfDeletions({
        absentEntries: [entryA, entryB],
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts,
        snapshotComplete: true,
      });

      // First entry keeps because ref count drops 2 -> 1; second entry deletes because ref count <= 1
      expect(deletionPlan.toKeep).toHaveLength(1);
      expect(deletionPlan.toKeep[0]?.reason).toBe('multiple_references');
      expect(deletionPlan.toDelete).toHaveLength(1);
      expect(deletionPlan.toDelete[0]?.entry.bookId).toBe(102);
    });
  });

  describe('revision already local', () => {
    it('reuses a changed remote revision if the new hash is already imported in the library', () => {
      const remote = [
        { bookId: 'rev-1', bookHash: 'hash-v2', filename: 'book.epub', format: 'EPUB' },
      ];
      const existing = [
        {
          bookId: 'rev-1',
          bookHash: 'hash-v1',
          localPath: 'hash-v1/book.epub',
          managedByProvider: true,
        },
      ];
      // hash-v2 was imported elsewhere (e.g. by another shelf or direct user import)
      const localHashes = new Set(['hash-v1', 'hash-v2']);
      const localPaths = new Set(['hash-v1/book.epub', 'hash-v2/book.epub']);

      const plan = planShelfSync(remote, existing, localHashes, localPaths);
      expect(plan.reuse).toEqual(['rev-1']);
      expect(plan.download).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, localHashes, localPaths);
      expect(reconciliation.unchanged).toEqual(remote);
      expect(reconciliation.changed).toEqual([]);
      expect(reconciliation.added).toEqual([]);
    });
  });

  describe('nullable bookHash', () => {
    it('supports null bookHash for remote books and plans download if untracked', () => {
      const remote = [{ bookId: 1, bookHash: null, filename: 'unhashed.epub', format: 'EPUB' }];
      const existing: Array<{
        bookId: number;
        bookHash: string | null;
        localPath: string | null;
        managedByProvider: boolean;
      }> = [];

      const plan = planShelfSync(remote, existing, new Set(), new Set());
      expect(plan.download).toEqual(remote);
      expect(plan.reuse).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, new Set(), new Set());
      expect(reconciliation.added).toEqual(remote);
      expect(reconciliation.unchanged).toEqual([]);
    });

    it('reuses an entry with null bookHash when previous entry had null bookHash and path is valid', () => {
      const remote = [{ bookId: 1, bookHash: null, filename: 'unhashed.epub', format: 'EPUB' }];
      const existing = [
        {
          bookId: 1,
          bookHash: null,
          localPath: 'unhashed.epub',
          managedByProvider: true,
        },
      ];
      const localPaths = new Set(['unhashed.epub']);

      const plan = planShelfSync(remote, existing, new Set(), localPaths);
      expect(plan.reuse).toEqual([1]);
      expect(plan.download).toEqual([]);

      const reconciliation = reconcileShelfSnapshot(remote, existing, new Set(), localPaths);
      expect(reconciliation.unchanged).toEqual(remote);
      expect(reconciliation.added).toEqual([]);
    });

    it('detects change when previous entry had null bookHash and remote receives a hash', () => {
      const remote = [
        { bookId: 1, bookHash: 'now-has-hash', filename: 'book.epub', format: 'EPUB' },
      ];
      const existing = [
        {
          bookId: 1,
          bookHash: null,
          localPath: 'book.epub',
          managedByProvider: true,
        },
      ];

      const reconciliation = reconcileShelfSnapshot(
        remote,
        existing,
        new Set(),
        new Set(['book.epub']),
      );
      expect(reconciliation.changed).toHaveLength(1);
      expect(reconciliation.changed[0]?.next.bookHash).toBe('now-has-hash');
    });
  });

  describe('data safety invariant: snapshot completeness guard', () => {
    it('proves confirmed empty shelf may plan removals while failed/partial empty produces zero destructive removals', () => {
      const absent = [
        {
          bookId: 1,
          bookHash: 'h1',
          localPath: 'h1/book.epub',
          managedByProvider: true,
        },
      ];
      const book = makeMockBook({ hash: 'h1', title: 'book', sourceTitle: 'book', format: 'EPUB' });

      // 1. Confirmed complete empty shelf: plans removals
      const confirmedPlan = planShelfDeletions({
        absentEntries: absent,
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['h1/book.epub', 1]]),
        snapshotStatus: 'complete',
      });
      expect(confirmedPlan.toDelete).toHaveLength(1);
      expect(confirmedPlan.toDelete[0]?.book?.hash).toBe('h1');
      expect(confirmedPlan.toKeep).toHaveLength(0);

      // 2. Failed snapshot empty: zero destructive removals
      const failedPlan = planShelfDeletions({
        absentEntries: absent,
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['h1/book.epub', 1]]),
        snapshotStatus: 'failed',
      });
      expect(failedPlan.toDelete).toHaveLength(0);
      expect(failedPlan.toKeep).toHaveLength(1);
      expect(failedPlan.toKeep[0]?.reason).toBe('snapshot_incomplete');

      // 3. Partial snapshot empty: zero destructive removals
      const partialPlan = planShelfDeletions({
        absentEntries: absent,
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['h1/book.epub', 1]]),
        snapshotStatus: 'partial',
      });
      expect(partialPlan.toDelete).toHaveLength(0);
      expect(partialPlan.toKeep).toHaveLength(1);
      expect(partialPlan.toKeep[0]?.reason).toBe('snapshot_incomplete');

      // 4. Cancelled snapshot: zero destructive removals
      const cancelledPlan = planShelfDeletions({
        absentEntries: absent,
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['h1/book.epub', 1]]),
        snapshotStatus: 'cancelled',
      });
      expect(cancelledPlan.toDelete).toHaveLength(0);
      expect(cancelledPlan.toKeep).toHaveLength(1);
      expect(cancelledPlan.toKeep[0]?.reason).toBe('snapshot_incomplete');

      // 5. Restart-required snapshot: zero destructive removals
      const restartPlan = planShelfDeletions({
        absentEntries: absent,
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['h1/book.epub', 1]]),
        snapshotStatus: 'restart_required',
      });
      expect(restartPlan.toDelete).toHaveLength(0);
      expect(restartPlan.toKeep).toHaveLength(1);
      expect(restartPlan.toKeep[0]?.reason).toBe('snapshot_incomplete');

      // 6. snapshotComplete boolean guard compatibility
      const boolIncompletePlan = planShelfDeletions({
        absentEntries: absent,
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['h1/book.epub', 1]]),
        snapshotComplete: false,
      });
      expect(boolIncompletePlan.toDelete).toHaveLength(0);
      expect(boolIncompletePlan.toKeep).toHaveLength(1);
      expect(boolIncompletePlan.toKeep[0]?.reason).toBe('snapshot_incomplete');
    });

    it('enforces that reconcileShelfSnapshot and planShelfSync only produce removals on complete snapshots', () => {
      const existing = [
        {
          bookId: 'b1',
          bookHash: 'h1',
          localPath: 'h1/book.epub',
          managedByProvider: true,
        },
      ];

      // Confirmed complete empty snapshot
      const completeEmpty = createCompleteSnapshot([]);
      expect(isCompleteSnapshot(completeEmpty)).toBe(true);

      const completeReconciliation = reconcileShelfSnapshot(completeEmpty, existing, new Set());
      expect(completeReconciliation.removed).toHaveLength(1);
      expect(completeReconciliation.removed[0]?.bookId).toBe('b1');

      const completePlan = planShelfSync(completeEmpty, existing, new Set());
      expect(completePlan.absent).toHaveLength(1);

      // Failed snapshot
      const failedSnapshot = createFailedSnapshot(new Error('Network offline'));
      expect(isCompleteSnapshot(failedSnapshot)).toBe(false);

      const failedReconciliation = reconcileShelfSnapshot(failedSnapshot, existing, new Set());
      expect(failedReconciliation.removed).toHaveLength(0);

      const failedPlan = planShelfSync(failedSnapshot, existing, new Set());
      expect(failedPlan.absent).toHaveLength(0);

      // Partial snapshot
      const partialSnapshot = createPartialSnapshot([]);
      expect(isCompleteSnapshot(partialSnapshot)).toBe(false);

      const partialReconciliation = reconcileShelfSnapshot(partialSnapshot, existing, new Set());
      expect(partialReconciliation.removed).toHaveLength(0);

      const partialPlan = planShelfSync(partialSnapshot, existing, new Set());
      expect(partialPlan.absent).toHaveLength(0);

      // Cancelled snapshot
      const cancelledSnapshot = createCancelledSnapshot();
      expect(isCompleteSnapshot(cancelledSnapshot)).toBe(false);

      const cancelledReconciliation = reconcileShelfSnapshot(
        cancelledSnapshot,
        existing,
        new Set(),
      );
      expect(cancelledReconciliation.removed).toHaveLength(0);

      const cancelledPlan = planShelfSync(cancelledSnapshot, existing, new Set());
      expect(cancelledPlan.absent).toHaveLength(0);

      // Restart required snapshot
      const restartSnapshot = createRestartRequiredSnapshot();
      expect(isCompleteSnapshot(restartSnapshot)).toBe(false);

      const restartReconciliation = reconcileShelfSnapshot(restartSnapshot, existing, new Set());
      expect(restartReconciliation.removed).toHaveLength(0);

      const restartPlan = planShelfSync(restartSnapshot, existing, new Set());
      expect(restartPlan.absent).toHaveLength(0);
    });

    describe('collectShelfSnapshot pagination and offline scenarios', () => {
      it('handles offline before first page as failed snapshot', async () => {
        const adapter = {
          provider: 'test-p',
          connectionId: 'c1',
          async getShelfPage() {
            throw new Error('TypeError: Failed to fetch (offline)');
          },
          downloadBook: async () => new ArrayBuffer(0),
        };

        const snapshot = await collectShelfSnapshot(adapter, 'col', '1');
        expect(snapshot.status).toBe('failed');
        expect(snapshot.books).toHaveLength(0);
        expect(isCompleteSnapshot(snapshot)).toBe(false);
      });

      it('handles mid-pagination error as partial snapshot preserving retrieved books', async () => {
        let callCount = 0;
        const adapter = {
          provider: 'test-p',
          connectionId: 'c1',
          async getShelfPage(_type: string, _id: string, options?: { cursor?: string | null }) {
            callCount += 1;
            if (options?.cursor === 'page-2') {
              throw new Error('Connection reset mid-pagination');
            }
            return {
              books: [
                { bookId: 'b1', bookHash: 'h1', filename: 'b1.epub' },
                { bookId: 'b2', bookHash: 'h2', filename: 'b2.epub' },
              ],
              nextCursor: 'page-2',
              hasMore: true,
            };
          },
          downloadBook: async () => new ArrayBuffer(0),
        };

        const snapshot = await collectShelfSnapshot(adapter, 'col', '1');
        expect(callCount).toBe(2);
        expect(snapshot.status).toBe('partial');
        expect(snapshot.books).toHaveLength(2);
        expect(snapshot.books[0]?.bookId).toBe('b1');
        expect(isCompleteSnapshot(snapshot)).toBe(false);
      });

      it('handles mid-pagination cancellation via AbortSignal', async () => {
        const controller = new AbortController();
        const adapter = {
          provider: 'test-p',
          connectionId: 'c1',
          async getShelfPage(_type: string, _id: string, options?: { cursor?: string | null }) {
            if (options?.cursor === 'page-2') {
              controller.abort();
            }
            return {
              books: [{ bookId: 'b1', bookHash: 'h1', filename: 'b1.epub' }],
              nextCursor: 'page-2',
              hasMore: true,
            };
          },
          downloadBook: async () => new ArrayBuffer(0),
        };

        const snapshot = await collectShelfSnapshot(adapter, 'col', '1', {
          signal: controller.signal,
        });
        expect(snapshot.status).toBe('cancelled');
        expect(isCompleteSnapshot(snapshot)).toBe(false);
      });

      it('handles malformed page payloads gracefully', async () => {
        // 1. Page is null
        const nullAdapter = {
          provider: 'test-p',
          connectionId: 'c1',
          getShelfPage: async () => null as unknown as { books: [] },
          downloadBook: async () => new ArrayBuffer(0),
        };
        const nullSnap = await collectShelfSnapshot(nullAdapter, 'col', '1');
        expect(nullSnap.status).toBe('failed');

        // 2. Books is not array
        const notArrayAdapter = {
          provider: 'test-p',
          connectionId: 'c1',
          getShelfPage: async () => ({ books: 'not an array' }) as unknown as { books: [] },
          downloadBook: async () => new ArrayBuffer(0),
        };
        const notArraySnap = await collectShelfSnapshot(notArrayAdapter, 'col', '1');
        expect(notArraySnap.status).toBe('failed');

        // 3. Books has malformed item (missing bookId)
        const corruptItemAdapter = {
          provider: 'test-p',
          connectionId: 'c1',
          getShelfPage: async () => ({
            books: [{ filename: 'no-id.epub' }] as unknown as [],
          }),
          downloadBook: async () => new ArrayBuffer(0),
        };
        const corruptSnap = await collectShelfSnapshot(corruptItemAdapter, 'col', '1');
        expect(corruptSnap.status).toBe('failed');
      });

      it('handles restartRequired flag in paginated responses', async () => {
        const adapter = {
          provider: 'test-p',
          connectionId: 'c1',
          getShelfPage: async () => ({
            books: [],
            restartRequired: true,
          }),
          downloadBook: async () => new ArrayBuffer(0),
        };

        const snapshot = await collectShelfSnapshot(adapter, 'col', '1');
        expect(snapshot.status).toBe('restart_required');
        expect(snapshot.restartRequired).toBe(true);
        expect(isCompleteSnapshot(snapshot)).toBe(false);
      });

      it('detects looping cursor when nextCursor repeats current cursor', async () => {
        const adapter = {
          provider: 'test-p',
          connectionId: 'c1',
          getShelfPage: async (
            _type: string,
            _id: string,
            options?: { cursor?: string | null },
          ) => ({
            books: [{ bookId: `b-${options?.cursor ?? 'first'}`, bookHash: 'h', filename: 'f' }],
            nextCursor: 'loop-cursor',
            hasMore: true,
          }),
          downloadBook: async () => new ArrayBuffer(0),
        };

        const snapshot = await collectShelfSnapshot(adapter, 'col', '1');
        expect(snapshot.status).toBe('partial');
        expect(snapshot.error).toBeInstanceOf(Error);
        expect((snapshot.error as Error).message).toContain('Looping cursor detected');
        expect(isCompleteSnapshot(snapshot)).toBe(false);
      });

      it('detects cyclic cursor when nextCursor repeats an earlier visited cursor', async () => {
        let page = 0;
        const adapter = {
          provider: 'test-p',
          connectionId: 'c1',
          getShelfPage: async () => {
            page += 1;
            // page 1 -> cursor-A -> page 2 -> cursor-B -> page 3 -> cursor-A (cycle)
            const nextCursor = page === 1 ? 'cursor-A' : page === 2 ? 'cursor-B' : 'cursor-A';
            return {
              books: [{ bookId: `b-${page}`, bookHash: 'h', filename: 'f' }],
              nextCursor,
              hasMore: true,
            };
          },
          downloadBook: async () => new ArrayBuffer(0),
        };

        const snapshot = await collectShelfSnapshot(adapter, 'col', '1');
        expect(snapshot.status).toBe('partial');
        expect((snapshot.error as Error).message).toContain('Looping cursor detected');
        expect(isCompleteSnapshot(snapshot)).toBe(false);
      });

      it('successfully collects confirmed complete empty shelf', async () => {
        const adapter = {
          provider: 'test-p',
          connectionId: 'c1',
          getShelfPage: async () => ({
            books: [],
            hasMore: false,
          }),
          downloadBook: async () => new ArrayBuffer(0),
        };

        const snapshot = await collectShelfSnapshot(adapter, 'col', '1');
        expect(snapshot.status).toBe('complete');
        expect(snapshot.books).toEqual([]);
        expect(isCompleteSnapshot(snapshot)).toBe(true);
      });
    });
  });

  describe('download validation', () => {
    it('validates valid EPUB, PDF, and CBZ payloads', () => {
      const epub = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;
      const pdf = new TextEncoder().encode('%PDF-1.7 standard document').buffer;
      const cbz = new Uint8Array([0x50, 0x4b, 0x05, 0x06]).buffer;

      expect(() => validateShelfDownload('book.epub', epub, 4)).not.toThrow();
      expect(() => validateShelfDownload('doc.pdf', pdf)).not.toThrow();
      expect(() => validateShelfDownload('comic.cbz', cbz)).not.toThrow();
    });

    it('rejects empty payloads, size mismatches, and invalid signatures', () => {
      expect(() => validateShelfDownload('book.epub', new ArrayBuffer(0))).toThrow(
        'Empty download',
      );
      expect(() =>
        validateShelfDownload('book.pdf', new TextEncoder().encode('%PDF-1.7').buffer, 999),
      ).toThrow('Unexpected download size');
      expect(() => validateShelfDownload('book.epub', new Uint8Array([1, 2, 3, 4]).buffer)).toThrow(
        'Invalid EPUB',
      );
      expect(() => validateShelfDownload('book.pdf', new Uint8Array([1, 2, 3, 4]).buffer)).toThrow(
        'Invalid PDF',
      );
      expect(() => validateShelfDownload('comic.cbz', new Uint8Array([1, 2, 3, 4]).buffer)).toThrow(
        'Invalid CBZ',
      );
    });
  });

  describe('safeShelfFilename', () => {
    it('sanitizes unsafe characters and directory traversal patterns', () => {
      expect(safeShelfFilename('normal.epub', 1)).toBe('1-normal.epub');
      expect(safeShelfFilename('..hidden.epub', 2)).toBe('2-hidden.epub');
      expect(safeShelfFilename('dir/file.epub', 2)).toBe('2-dir_file.epub');
      expect(safeShelfFilename('foo:bar*baz?.pdf', 'uuid-1')).toBe('uuid-1-foo_bar_baz_.pdf');
      expect(safeShelfFilename('...', 3)).toBe('3-book-3');
    });
  });

  describe('presence index mutation helpers', () => {
    it('adds and removes books from presence index correctly', () => {
      const index = {
        hashes: new Set<string>(),
        paths: new Set<string>(),
        booksByHash: new Map<string, Book>(),
        booksByPath: new Map<string, Book>(),
      };

      const book = makeMockBook({ hash: 'h-100', title: 'Mutate Test', format: 'EPUB' });
      addToPresenceIndex(index, book);

      expect(index.hashes.has('h-100')).toBe(true);
      expect(index.booksByHash.get('h-100')).toBe(book);
      expect(index.paths.size).toBe(1);

      removeFromPresenceIndex(index, book);
      expect(index.hashes.has('h-100')).toBe(false);
      expect(index.booksByHash.has('h-100')).toBe(false);
      expect(index.paths.size).toBe(0);
    });
  });

  describe('Phase 8C: Managed Cleanup and Reference Safety (Data Safety Invariant)', () => {
    it('never purges user-owned books even under remove_managed_copy', () => {
      const userEntry = {
        bookId: 'u1',
        bookHash: 'user-hash',
        localPath: 'user-hash/UserBook.epub',
        managedByProvider: false,
      };
      const book = makeMockBook({
        hash: 'user-hash',
        title: 'UserBook',
        sourceTitle: 'UserBook',
        format: 'EPUB',
      });

      const plan = planShelfDeletions({
        absentEntries: [userEntry],
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['user-hash/UserBook.epub', 1]]),
        snapshotComplete: true,
      });

      expect(plan.toDelete).toHaveLength(0);
      expect(plan.toKeep).toHaveLength(1);
      expect(plan.toKeep[0]?.reason).toBe('not_managed_by_provider');
    });

    it('approves deletion when single managed reference, remove policy, and complete snapshot', () => {
      const entry = {
        bookId: 'm1',
        bookHash: 'm-hash',
        localPath: 'm-hash/Managed.epub',
        managedByProvider: true,
      };
      const book = makeMockBook({
        hash: 'm-hash',
        title: 'Managed',
        sourceTitle: 'Managed',
        format: 'EPUB',
      });

      const plan = planShelfDeletions({
        absentEntries: [entry],
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['m-hash/Managed.epub', 1]]),
        snapshotComplete: true,
      });

      expect(plan.toDelete).toHaveLength(1);
      expect(plan.toDelete[0]?.book?.hash).toBe('m-hash');
      expect(plan.toKeep).toHaveLength(0);
    });

    it('keeps managed copy when cleanupPolicy is keep_local', () => {
      const entry = {
        bookId: 'm1',
        bookHash: 'm-hash',
        localPath: 'm-hash/Managed.epub',
        managedByProvider: true,
      };
      const book = makeMockBook({
        hash: 'm-hash',
        title: 'Managed',
        sourceTitle: 'Managed',
        format: 'EPUB',
      });

      const plan = planShelfDeletions({
        absentEntries: [entry],
        cleanupPolicy: 'keep_local',
        library: [book],
        referenceCounts: new Map([['m-hash/Managed.epub', 1]]),
        snapshotComplete: true,
      });

      expect(plan.toDelete).toHaveLength(0);
      expect(plan.toKeep).toHaveLength(1);
      expect(plan.toKeep[0]?.reason).toBe('policy_keep_local');
    });

    it('preserves managed file when multiple references exist (two shelves or cross-provider)', () => {
      const entry = {
        bookId: 'm1',
        bookHash: 'm-hash',
        localPath: 'm-hash/Managed.epub',
        managedByProvider: true,
      };
      const book = makeMockBook({
        hash: 'm-hash',
        title: 'Managed',
        sourceTitle: 'Managed',
        format: 'EPUB',
      });

      // refCount = 2 (e.g. 2 shelves or BookOrbit + GrimmLink)
      const plan = planShelfDeletions({
        absentEntries: [entry],
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['m-hash/Managed.epub', 2]]),
        snapshotComplete: true,
      });

      expect(plan.toDelete).toHaveLength(0);
      expect(plan.toKeep).toHaveLength(1);
      expect(plan.toKeep[0]?.reason).toBe('multiple_references');
    });

    it('preserves book when user replaced the file with a different hash', () => {
      const entry = {
        bookId: 'm1',
        bookHash: 'm-hash',
        localPath: 'm-hash/Managed.epub',
        managedByProvider: true,
      };
      // Library book at the path has a different hash (replaced by user)
      const book = makeMockBook({
        hash: 'user-replaced-hash',
        title: 'Managed',
        sourceTitle: 'Managed',
        format: 'EPUB',
      });

      const plan = planShelfDeletions({
        absentEntries: [entry],
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['m-hash/Managed.epub', 1]]),
        snapshotComplete: true,
      });

      expect(plan.toDelete).toHaveLength(0);
      expect(plan.toKeep).toHaveLength(1);
      expect(plan.toKeep[0]?.reason).toBe('unmatched_managed_entry');
    });

    it('preserves book when multiple library books match the path (ambiguous path)', () => {
      const entry = {
        bookId: 'm1',
        bookHash: 'm-hash',
        localPath: 'm-hash/Managed.epub',
        managedByProvider: true,
      };
      const book1 = makeMockBook({
        hash: 'm-hash',
        title: 'Managed',
        sourceTitle: 'Managed',
        format: 'EPUB',
      });
      const book2 = makeMockBook({
        hash: 'm-hash',
        title: 'Managed Duplicate',
        sourceTitle: 'Managed',
        format: 'EPUB',
      });

      const plan = planShelfDeletions({
        absentEntries: [entry],
        cleanupPolicy: 'remove_managed_copy',
        library: [book1, book2],
        referenceCounts: new Map([['m-hash/Managed.epub', 1]]),
        snapshotComplete: true,
      });

      expect(plan.toDelete).toHaveLength(0);
      expect(plan.toKeep).toHaveLength(1);
      expect(plan.toKeep[0]?.reason).toBe('ambiguous_local_path');
    });

    it('keeps remote-only entry with nothing to delete', () => {
      const entry = {
        bookId: 'r1',
        bookHash: 'r-hash',
        localPath: null,
        managedByProvider: false,
      };

      const plan = planShelfDeletions({
        absentEntries: [entry],
        cleanupPolicy: 'remove_managed_copy',
        library: [],
        snapshotComplete: true,
      });

      expect(plan.toDelete).toHaveLength(0);
      expect(plan.toKeep).toHaveLength(1);
      expect(plan.toKeep[0]?.reason).toBe('not_managed_by_provider');

      // Even if managedByProvider was true, missing localPath keeps
      const managedRemoteOnly = {
        bookId: 'r2',
        bookHash: 'r-hash',
        localPath: null,
        managedByProvider: true,
      };

      const plan2 = planShelfDeletions({
        absentEntries: [managedRemoteOnly],
        cleanupPolicy: 'remove_managed_copy',
        library: [],
        snapshotComplete: true,
      });

      expect(plan2.toDelete).toHaveLength(0);
      expect(plan2.toKeep).toHaveLength(1);
      expect(plan2.toKeep[0]?.reason).toBe('missing_local_path');
    });

    it('keeps all entries when snapshot is failed, partial, cancelled, or restart_required', () => {
      const entry = {
        bookId: 'm1',
        bookHash: 'm-hash',
        localPath: 'm-hash/Managed.epub',
        managedByProvider: true,
      };
      const book = makeMockBook({
        hash: 'm-hash',
        title: 'Managed',
        sourceTitle: 'Managed',
        format: 'EPUB',
      });

      for (const status of ['failed', 'partial', 'cancelled', 'restart_required'] as const) {
        const plan = planShelfDeletions({
          absentEntries: [entry],
          cleanupPolicy: 'remove_managed_copy',
          library: [book],
          referenceCounts: new Map([['m-hash/Managed.epub', 1]]),
          snapshotStatus: status,
        });

        expect(plan.toDelete).toHaveLength(0);
        expect(plan.toKeep).toHaveLength(1);
        expect(plan.toKeep[0]?.reason).toBe('snapshot_incomplete');
      }
    });

    it('canDeleteObsoleteRevision strictly requires complete snapshot, remove policy, managed copy, and 0 references', () => {
      const prev = {
        bookId: 'b1',
        bookHash: 'h1',
        localPath: 'h1/book.epub',
        managedByProvider: true,
      };
      const importedBook = makeMockBook({
        hash: 'h2',
        title: 'book',
        sourceTitle: 'book',
        format: 'EPUB',
      });

      // Baseline: should succeed
      expect(
        canDeleteObsoleteRevision({
          previousEntry: prev,
          importedBook,
          cleanupPolicy: 'remove_managed_copy',
          referenceCount: 0,
          snapshotStatus: 'complete',
        }),
      ).toBe(true);

      // Incomplete snapshot -> false
      expect(
        canDeleteObsoleteRevision({
          previousEntry: prev,
          importedBook,
          cleanupPolicy: 'remove_managed_copy',
          referenceCount: 0,
          snapshotStatus: 'partial',
        }),
      ).toBe(false);

      // keep_local policy -> false
      expect(
        canDeleteObsoleteRevision({
          previousEntry: prev,
          importedBook,
          cleanupPolicy: 'keep_local',
          referenceCount: 0,
          snapshotStatus: 'complete',
        }),
      ).toBe(false);

      // not managed by provider -> false
      expect(
        canDeleteObsoleteRevision({
          previousEntry: { ...prev, managedByProvider: false },
          importedBook,
          cleanupPolicy: 'remove_managed_copy',
          referenceCount: 0,
          snapshotStatus: 'complete',
        }),
      ).toBe(false);

      // referenceCount > 0 (other shelf references it) -> false
      expect(
        canDeleteObsoleteRevision({
          previousEntry: prev,
          importedBook,
          cleanupPolicy: 'remove_managed_copy',
          referenceCount: 1,
          snapshotStatus: 'complete',
        }),
      ).toBe(false);

      // same path -> false
      const samePathBook = makeMockBook({
        hash: 'h1',
        title: 'book',
        sourceTitle: 'book',
        format: 'EPUB',
      });
      expect(
        canDeleteObsoleteRevision({
          previousEntry: prev,
          importedBook: samePathBook,
          cleanupPolicy: 'remove_managed_copy',
          referenceCount: 0,
          snapshotStatus: 'complete',
        }),
      ).toBe(false);
    });
  });
});
