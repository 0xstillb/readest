import { describe, expect, it } from 'vitest';
import type { Book } from '@/types/book';
import {
  addToPresenceIndex,
  buildLibraryPresenceIndex,
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
    it('refuses to delete any files when snapshotComplete is false', () => {
      const absent = [
        {
          bookId: 1,
          bookHash: 'h1',
          localPath: 'h1/book.epub',
          managedByProvider: true,
        },
      ];
      const book = makeMockBook({ hash: 'h1' });

      const deletionPlan = planShelfDeletions({
        absentEntries: absent,
        cleanupPolicy: 'remove_managed_copy',
        library: [book],
        referenceCounts: new Map([['h1/book.epub', 1]]),
        snapshotComplete: false, // Incomplete snapshot (offline / error / cancel)
      });

      expect(deletionPlan.toDelete).toHaveLength(0);
      expect(deletionPlan.toKeep).toHaveLength(1);
      expect(deletionPlan.toKeep[0]?.reason).toBe('snapshot_incomplete');
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
});
