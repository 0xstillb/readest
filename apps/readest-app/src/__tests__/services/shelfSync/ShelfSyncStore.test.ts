import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeAppService } from '@/services/nodeAppService';
import { ShelfSyncStore, type ShelfEntryWrite } from '@/services/shelfSync/ShelfSyncStore';

const SANDBOX_DIR = path.join(process.cwd(), '.test-sandbox-shelf-sync');

describe('ShelfSyncStore', () => {
  let root: string;
  let service: NodeAppService;

  beforeEach(async () => {
    await fsp.mkdir(SANDBOX_DIR, { recursive: true });
    root = await fsp.mkdtemp(path.join(SANDBOX_DIR, 'shelf-store-'));
    service = new NodeAppService(root);
    await service.init();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  describe('CRUD operations', () => {
    it('creates, retrieves, updates, and deletes shelf subscriptions', async () => {
      const store = new ShelfSyncStore(service, 'bookorbit', 'conn-1');

      // Create subscription
      await store.saveShelfSubscription({
        shelfType: 'collection',
        shelfId: 'fav-1',
        enabled: true,
        cleanupPolicy: 'keep_local',
        downloadPolicy: 'always',
      });

      // Retrieve single
      const sub = await store.getShelfSubscription('fav-1', 'collection');
      expect(sub).not.toBeNull();
      expect(sub).toMatchObject({
        provider: 'bookorbit',
        connectionId: 'conn-1',
        shelfType: 'collection',
        shelfId: 'fav-1',
        enabled: true,
        cleanupPolicy: 'keep_local',
        downloadPolicy: 'always',
      });
      expect(sub?.createdAt).toBeGreaterThan(0);
      expect(sub?.updatedAt).toBeGreaterThan(0);

      // Update subscription (disable, change policies)
      await store.saveShelfSubscription({
        shelfType: 'collection',
        shelfId: 'fav-1',
        enabled: false,
        cleanupPolicy: 'remove_managed_copy',
        downloadPolicy: 'wifi_only',
      });

      const updated = await store.getShelfSubscription('fav-1', 'collection');
      expect(updated?.enabled).toBe(false);
      expect(updated?.cleanupPolicy).toBe('remove_managed_copy');
      expect(updated?.downloadPolicy).toBe('wifi_only');

      // List subscriptions with filter
      const activeSubs = await store.getShelfSubscriptions({ enabledOnly: true });
      expect(activeSubs).toHaveLength(0);

      const allSubs = await store.getShelfSubscriptions();
      expect(allSubs).toHaveLength(1);
      expect(allSubs[0]?.shelfId).toBe('fav-1');

      // Delete subscription
      await store.deleteShelfSubscription('fav-1', 'collection');
      const deleted = await store.getShelfSubscription('fav-1', 'collection');
      expect(deleted).toBeNull();
    });

    it('creates, retrieves, updates, and removes shelf entries', async () => {
      const store = new ShelfSyncStore(service, 'bookorbit', 'conn-1');

      // Mark single entry with all fields populated
      await store.markShelfEntry({
        shelfType: 'tag',
        shelfId: 'scifi',
        bookId: 'book-101',
        fileId: 'file-201',
        bookHash: 'hash-abc-123',
        contentVersion: 'v1.0',
        localPath: 'books/dune.epub',
        managedByProvider: true,
      });

      // Retrieve
      const entries = await store.getShelfEntries('scifi', 'tag');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        provider: 'bookorbit',
        connectionId: 'conn-1',
        shelfType: 'tag',
        shelfId: 'scifi',
        bookId: 'book-101',
        fileId: 'file-201',
        bookHash: 'hash-abc-123',
        contentVersion: 'v1.0',
        localPath: 'books/dune.epub',
        managedByProvider: true,
      });

      // Update entry via markShelfEntry upsert
      await store.markShelfEntry({
        shelfType: 'tag',
        shelfId: 'scifi',
        bookId: 'book-101',
        fileId: 'file-201-updated',
        bookHash: 'hash-abc-updated',
        contentVersion: 'v2.0',
        localPath: 'books/dune-revised.epub',
        managedByProvider: true,
      });

      const updatedEntries = await store.getShelfEntries('scifi', 'tag');
      expect(updatedEntries).toHaveLength(1);
      expect(updatedEntries[0]).toMatchObject({
        bookId: 'book-101',
        fileId: 'file-201-updated',
        bookHash: 'hash-abc-updated',
        contentVersion: 'v2.0',
        localPath: 'books/dune-revised.epub',
      });

      // Partial update via updateShelfEntry
      const didUpdate = await store.updateShelfEntry(
        { shelfType: 'tag', shelfId: 'scifi', bookId: 'book-101' },
        { contentVersion: 'v2.1' },
      );
      expect(didUpdate).toBe(true);

      const partiallyUpdated = await store.getShelfEntries('scifi', 'tag');
      expect(partiallyUpdated[0]?.contentVersion).toBe('v2.1');
      expect(partiallyUpdated[0]?.bookHash).toBe('hash-abc-updated');

      // Remove single entry
      await store.removeShelfEntry('scifi', 'book-101', 'tag');
      const afterRemoval = await store.getShelfEntries('scifi', 'tag');
      expect(afterRemoval).toHaveLength(0);
    });

    it('supports positional arguments in saveShelfSubscription', async () => {
      const store = new ShelfSyncStore(service, 'bookorbit', 'conn-1');
      await store.saveShelfSubscription(
        'shelf-pos-1',
        true,
        'remove_managed_copy',
        'wifi_only',
        'custom_type',
      );

      const sub = await store.getShelfSubscription('shelf-pos-1', 'custom_type');
      expect(sub).toMatchObject({
        shelfId: 'shelf-pos-1',
        shelfType: 'custom_type',
        enabled: true,
        cleanupPolicy: 'remove_managed_copy',
        downloadPolicy: 'wifi_only',
      });
    });
  });

  describe('Provider and connection isolation', () => {
    it('isolates data between different providers and connections', async () => {
      const storeBo1 = new ShelfSyncStore(service, 'bookorbit', 'server-alpha');
      const storeBo2 = new ShelfSyncStore(service, 'bookorbit', 'server-beta');
      const storeGl = new ShelfSyncStore(service, 'grimmlink', 'server-alpha');

      // Add subscriptions in all 3
      await storeBo1.saveShelfSubscription({ shelfId: 'shelf-1', enabled: true });
      await storeBo2.saveShelfSubscription({ shelfId: 'shelf-1', enabled: true });
      await storeGl.saveShelfSubscription({ shelfId: 'shelf-1', enabled: true });

      // Add entries in all 3 with identical book IDs
      await storeBo1.markShelfEntry({
        shelfId: 'shelf-1',
        bookId: 'common-book',
        bookHash: 'hash-bo1',
      });
      await storeBo2.markShelfEntry({
        shelfId: 'shelf-1',
        bookId: 'common-book',
        bookHash: 'hash-bo2',
      });
      await storeGl.markShelfEntry({
        shelfId: 'shelf-1',
        bookId: 'common-book',
        bookHash: 'hash-gl',
      });

      // Verify each store sees only its own entry
      const bo1Entries = await storeBo1.getShelfEntries('shelf-1');
      const bo2Entries = await storeBo2.getShelfEntries('shelf-1');
      const glEntries = await storeGl.getShelfEntries('shelf-1');

      expect(bo1Entries).toHaveLength(1);
      expect(bo1Entries[0]?.bookHash).toBe('hash-bo1');
      expect(bo1Entries[0]?.connectionId).toBe('server-alpha');

      expect(bo2Entries).toHaveLength(1);
      expect(bo2Entries[0]?.bookHash).toBe('hash-bo2');
      expect(bo2Entries[0]?.connectionId).toBe('server-beta');

      expect(glEntries).toHaveLength(1);
      expect(glEntries[0]?.bookHash).toBe('hash-gl');
      expect(glEntries[0]?.provider).toBe('grimmlink');

      // Modifying one provider does not affect others
      await storeBo1.removeShelfEntry('shelf-1', 'common-book');
      expect(await storeBo1.getShelfEntries('shelf-1')).toHaveLength(0);
      expect(await storeBo2.getShelfEntries('shelf-1')).toHaveLength(1);
      expect(await storeGl.getShelfEntries('shelf-1')).toHaveLength(1);
    });

    it('creates scoped store instances using withScope', async () => {
      const baseStore = new ShelfSyncStore(service);
      const scopedStore = baseStore.withScope('bookorbit', 'conn-xyz');

      expect(scopedStore.provider).toBe('bookorbit');
      expect(scopedStore.connectionId).toBe('conn-xyz');

      await scopedStore.saveShelfSubscription({ shelfId: 'shelf-scoped', enabled: true });
      const subs = await scopedStore.getShelfSubscriptions();
      expect(subs).toHaveLength(1);
      expect(subs[0]?.provider).toBe('bookorbit');
      expect(subs[0]?.connectionId).toBe('conn-xyz');
    });
  });

  describe('Same shelf IDs across providers', () => {
    it('allows identical shelf IDs without collision across different providers', async () => {
      const grimmlink = new ShelfSyncStore(service, 'grimmlink', 'conn-1');
      const bookorbit = new ShelfSyncStore(service, 'bookorbit', 'conn-1');

      await grimmlink.saveShelfSubscription({
        shelfId: '42',
        shelfType: 'shelf',
        enabled: true,
        cleanupPolicy: 'keep_local',
      });
      await bookorbit.saveShelfSubscription({
        shelfId: '42',
        shelfType: 'shelf',
        enabled: true,
        cleanupPolicy: 'remove_managed_copy',
      });

      await grimmlink.markShelfEntry({
        shelfType: 'shelf',
        shelfId: '42',
        bookId: '10',
        bookHash: 'gl-hash',
      });
      await bookorbit.markShelfEntry({
        shelfType: 'shelf',
        shelfId: '42',
        bookId: '10',
        bookHash: 'bo-hash',
      });

      const glSub = await grimmlink.getShelfSubscription('42', 'shelf');
      const boSub = await bookorbit.getShelfSubscription('42', 'shelf');
      expect(glSub?.cleanupPolicy).toBe('keep_local');
      expect(boSub?.cleanupPolicy).toBe('remove_managed_copy');

      const glEntries = await grimmlink.getShelfEntries('42', 'shelf');
      const boEntries = await bookorbit.getShelfEntries('42', 'shelf');
      expect(glEntries[0]?.bookHash).toBe('gl-hash');
      expect(boEntries[0]?.bookHash).toBe('bo-hash');
    });
  });

  describe('Same local path across shelves/providers', () => {
    it('tracks multiple shelves and providers referencing the exact same local file path', async () => {
      const gl = new ShelfSyncStore(service, 'grimmlink', 'conn-1');
      const bo = new ShelfSyncStore(service, 'bookorbit', 'conn-1');

      const sharedPath = 'local_books/foundation.epub';

      // GrimmLink shelf 1 (favorites)
      await gl.markShelfEntry({
        shelfId: 'favorites',
        bookId: 'gl-book-1',
        bookHash: 'hash-foundation',
        localPath: sharedPath,
        managedByProvider: true,
      });

      // GrimmLink shelf 2 (isaac-asimov-series)
      await gl.markShelfEntry({
        shelfId: 'asimov',
        bookId: 'gl-book-1',
        bookHash: 'hash-foundation',
        localPath: sharedPath,
        managedByProvider: true,
      });

      // BookOrbit shelf 1 (audio-synced)
      await bo.markShelfEntry({
        shelfId: 'audiobooks',
        bookId: 'bo-book-99',
        bookHash: 'hash-foundation',
        localPath: sharedPath,
        managedByProvider: true,
      });

      // Query all references for that path
      const refs = await gl.getReferencesForPath(sharedPath);
      expect(refs).toHaveLength(3);

      const providers = refs.map((r) => r.provider).sort();
      expect(providers).toEqual(['bookorbit', 'grimmlink', 'grimmlink']);

      // Most recently seen lookup
      const latest = await gl.getShelfEntryByLocalPath(sharedPath);
      expect(latest).not.toBeNull();
      expect(latest?.localPath).toBe(sharedPath);

      // Book hash lookup
      const byHash = await gl.getShelfEntriesByBookHash('hash-foundation');
      expect(byHash).toHaveLength(3);
    });
  });

  describe('Managed reference counts (Data Safety Invariant)', () => {
    it('accurately counts managed references across shelves and providers', async () => {
      const storeA = new ShelfSyncStore(service, 'grimmlink', 'conn-1');
      const storeB = new ShelfSyncStore(service, 'bookorbit', 'conn-1');

      const managedShared = 'books/managed-both.epub';
      const userOwnedShared = 'books/user-owned.epub';
      const singleManaged = 'books/single-managed.epub';
      const unmanaged = 'books/untracked.epub';

      // managedShared: managed by Provider A AND managed by Provider B
      await storeA.markShelfEntry({
        shelfId: 'shelf-1',
        bookId: 'b1',
        localPath: managedShared,
        managedByProvider: true,
      });
      await storeB.markShelfEntry({
        shelfId: 'shelf-2',
        bookId: 'b2',
        localPath: managedShared,
        managedByProvider: true,
      });

      // userOwnedShared: matched local hash so managedByProvider = false on both shelves
      await storeA.markShelfEntry({
        shelfId: 'shelf-1',
        bookId: 'b3',
        localPath: userOwnedShared,
        managedByProvider: false,
      });
      await storeB.markShelfEntry({
        shelfId: 'shelf-2',
        bookId: 'b4',
        localPath: userOwnedShared,
        managedByProvider: false,
      });

      // singleManaged: managed by Provider A, but also present on Provider B unmanaged
      await storeA.markShelfEntry({
        shelfId: 'shelf-1',
        bookId: 'b5',
        localPath: singleManaged,
        managedByProvider: true,
      });
      await storeB.markShelfEntry({
        shelfId: 'shelf-2',
        bookId: 'b6',
        localPath: singleManaged,
        managedByProvider: false,
      });

      // Query managed reference counts globally across all providers
      const managedCounts = await storeA.getManagedShelfReferenceCounts([
        managedShared,
        userOwnedShared,
        singleManaged,
        unmanaged,
      ]);

      expect(managedCounts.get(managedShared)).toBe(2);
      expect(managedCounts.get(userOwnedShared)).toBe(0);
      expect(managedCounts.get(singleManaged)).toBe(1);
      expect(managedCounts.get(unmanaged)).toBe(0);

      // Single item helper
      expect(await storeA.getManagedShelfEntryReferences(managedShared)).toBe(2);
      expect(await storeA.getManagedShelfEntryReferences(userOwnedShared)).toBe(0);
      expect(await storeA.getManagedShelfEntryReferences(singleManaged)).toBe(1);
      expect(await storeA.getManagedShelfEntryReferences(unmanaged)).toBe(0);

      // Total references (managed + unmanaged)
      const allCounts = await storeA.getAllShelfReferenceCounts([
        managedShared,
        userOwnedShared,
        singleManaged,
        unmanaged,
      ]);
      expect(allCounts.get(managedShared)).toBe(2);
      expect(allCounts.get(userOwnedShared)).toBe(2);
      expect(allCounts.get(singleManaged)).toBe(2);
      expect(allCounts.get(unmanaged)).toBe(0);

      // Query scoped by provider
      const scopedToA = await storeA.getManagedShelfReferenceCounts(
        [managedShared, singleManaged],
        {
          provider: 'grimmlink',
        },
      );
      expect(scopedToA.get(managedShared)).toBe(1);
      expect(scopedToA.get(singleManaged)).toBe(1);

      const scopedToB = await storeA.getManagedShelfReferenceCounts(
        [managedShared, singleManaged],
        {
          provider: 'bookorbit',
        },
      );
      expect(scopedToB.get(managedShared)).toBe(1);
      expect(scopedToB.get(singleManaged)).toBe(0); // singleManaged is unmanaged in B
    });
  });

  describe('Remote-only membership', () => {
    it('persists and queries remote-only entries with localPath null and nullable hashes', async () => {
      const store = new ShelfSyncStore(service, 'bookorbit', 'conn-1');

      // Remote book in queue when downloads are off or pending
      await store.markShelfEntry({
        shelfId: 'shelf-remote',
        bookId: 'remote-1',
        fileId: 'file-r1',
        bookHash: null, // Nullable hash
        contentVersion: '1.0.0',
        localPath: null, // Remote only
        managedByProvider: false,
      });

      // Querying all shelf entries
      const allEntries = await store.getShelfEntries('shelf-remote');
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]?.localPath).toBeNull();
      expect(allEntries[0]?.bookHash).toBeNull();
      expect(allEntries[0]?.fileId).toBe('file-r1');

      // Helper specifically for remote-only entries
      const remoteOnly = await store.getRemoteOnlyShelfEntries('shelf-remote');
      expect(remoteOnly).toHaveLength(1);
      expect(remoteOnly[0]?.bookId).toBe('remote-1');

      // Filter via options
      const localOnly = await store.getShelfEntries('shelf-remote', 'default', {
        remoteOnly: false,
      });
      expect(localOnly).toHaveLength(0);

      // Transition: download completes, entry is updated with local path
      await store.markShelfEntry({
        shelfId: 'shelf-remote',
        bookId: 'remote-1',
        fileId: 'file-r1',
        bookHash: 'computed-sha256',
        localPath: 'books/downloaded-remote.epub',
        managedByProvider: true,
      });

      const afterDownloadRemoteOnly = await store.getRemoteOnlyShelfEntries('shelf-remote');
      expect(afterDownloadRemoteOnly).toHaveLength(0);

      const afterDownloadLocal = await store.getShelfEntries('shelf-remote', 'default', {
        remoteOnly: false,
      });
      expect(afterDownloadLocal).toHaveLength(1);
      expect(afterDownloadLocal[0]?.managedByProvider).toBe(true);
      expect(afterDownloadLocal[0]?.bookHash).toBe('computed-sha256');
    });

    it('queries entries by remote file_id', async () => {
      const store = new ShelfSyncStore(service, 'bookorbit', 'conn-1');

      await store.markShelfEntry({
        shelfId: 'shelf-files',
        bookId: 'book-42',
        fileId: 'server-file-999',
        localPath: null,
      });

      const byFile = await store.getShelfEntriesByFileId('server-file-999');
      expect(byFile).toHaveLength(1);
      expect(byFile[0]?.bookId).toBe('book-42');
    });
  });

  describe('Batches', () => {
    it('executes batch inserts and batch removals atomically', async () => {
      const store = new ShelfSyncStore(service, 'grimmlink', 'conn-1');

      const batch: ShelfEntryWrite[] = Array.from({ length: 40 }, (_, i) => ({
        shelfId: 'batch-shelf',
        bookId: `batch-book-${i}`,
        bookHash: `hash-${i}`,
        localPath: `books/batch-${i}.epub`,
        managedByProvider: i % 2 === 0,
      }));

      // Batch insert
      await store.markShelfEntries(batch);

      const entries = await store.getShelfEntries('batch-shelf');
      expect(entries).toHaveLength(40);

      // Batch removal of 15 entries
      const toRemove = Array.from({ length: 15 }, (_, i) => ({
        shelfId: 'batch-shelf',
        bookId: `batch-book-${i}`,
      }));
      await store.removeShelfEntries(toRemove);

      const remaining = await store.getShelfEntries('batch-shelf');
      expect(remaining).toHaveLength(25);
    });

    it('handles reference count queries exceeding SQLITE_BIND_CHUNK_SIZE seamlessly', async () => {
      const store = new ShelfSyncStore(service, 'bookorbit', 'conn-1');

      // Create 550 entries to test chunking beyond 500
      const paths: string[] = [];
      const entries: ShelfEntryWrite[] = [];
      for (let i = 0; i < 550; i++) {
        const p = `books/chunk-${i}.epub`;
        paths.push(p);
        entries.push({
          shelfId: 'large-shelf',
          bookId: `b-${i}`,
          localPath: p,
          managedByProvider: i % 3 === 0, // every 3rd is managed
        });
      }

      await store.markShelfEntries(entries);

      const counts = await store.getManagedShelfReferenceCounts(paths);
      expect(counts.size).toBe(550);

      for (let i = 0; i < 550; i++) {
        const p = paths[i]!;
        const expected = i % 3 === 0 ? 1 : 0;
        expect(counts.get(p)).toBe(expected);
      }
    });

    it('clears all entries in a shelf cleanly', async () => {
      const store = new ShelfSyncStore(service, 'bookorbit', 'conn-1');
      await store.markShelfEntries([
        { shelfId: 'to-clear', bookId: '1' },
        { shelfId: 'to-clear', bookId: '2' },
        { shelfId: 'to-keep', bookId: '3' },
      ]);

      await store.clearShelfEntries('to-clear');
      expect(await store.getShelfEntries('to-clear')).toHaveLength(0);
      expect(await store.getShelfEntries('to-keep')).toHaveLength(1);
    });
  });

  describe('Transaction failure & rollback', () => {
    it('rolls back all modifications in a batch if an error occurs mid-transaction', async () => {
      const store = new ShelfSyncStore(service, 'bookorbit', 'conn-1');

      // Initial state: 1 entry
      await store.markShelfEntry({
        shelfId: 'tx-shelf',
        bookId: 'existing-book',
        localPath: 'books/existing.epub',
      });

      // Prepare a batch where one entry fails due to an invalid insert or simulated failure
      // We test this by using withTransaction or custom invalid statement
      const db = await service.openDatabase('shelf-sync', 'shelf-sync.db', 'Data');
      await expect(
        (async () => {
          await db.execute('BEGIN');
          try {
            await db.execute(
              `INSERT INTO shelf_entries (
                provider, connection_id, shelf_type, shelf_id, book_id,
                managed_by_provider, last_seen_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              ['bookorbit', 'conn-1', 'default', 'tx-shelf', 'tx-new-1', 1, Date.now()],
            );

            // Intentionally fail second statement: non-existent table or constraint violation
            await db.execute('INSERT INTO non_existent_table VALUES (1)');
            await db.execute('COMMIT');
          } catch (error) {
            await db.execute('ROLLBACK').catch(() => {});
            throw error;
          }
        })(),
      ).rejects.toThrow();
      await db.close();

      // Verify that tx-new-1 was NOT persisted
      const entries = await store.getShelfEntries('tx-shelf');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.bookId).toBe('existing-book');
    });
  });

  describe('Idempotent init', () => {
    it('safely handles concurrent and repeated schema initializations', async () => {
      const store1 = new ShelfSyncStore(service, 'bookorbit', 'conn-1');
      const store2 = new ShelfSyncStore(service, 'bookorbit', 'conn-1');
      const store3 = new ShelfSyncStore(service, 'grimmlink', 'conn-2');

      // Concurrent ensureSchema calls
      await Promise.all([
        store1.ensureSchema(),
        store2.ensureSchema(),
        store3.ensureSchema(),
        store1.ensureSchema(),
      ]);

      // Write data
      await store1.markShelfEntry({
        shelfId: 'init-shelf',
        bookId: 'init-book-1',
        bookHash: 'init-hash',
      });

      // Re-initialize repeatedly
      await store1.ensureSchema();
      await store2.ensureSchema();

      // Create a new store instance on the same appService and verify data is intact
      const freshStore = new ShelfSyncStore(service, 'bookorbit', 'conn-1');
      const entries = await freshStore.getShelfEntries('init-shelf');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.bookHash).toBe('init-hash');
    });

    it('survives process re-open without data loss', async () => {
      const firstProcess = new ShelfSyncStore(service, 'grimmlink', 'default');
      await firstProcess.saveShelfSubscription({
        shelfId: 'shelf-survive',
        enabled: true,
        cleanupPolicy: 'remove_managed_copy',
      });
      await firstProcess.markShelfEntry({
        shelfId: 'shelf-survive',
        bookId: 'survive-1',
        localPath: 'books/survive.epub',
        managedByProvider: true,
      });

      // Simulate app restart with a fresh service instance on the same directory
      const restartedService = new NodeAppService(root);
      await restartedService.init();

      const secondProcess = new ShelfSyncStore(restartedService, 'grimmlink', 'default');
      const sub = await secondProcess.getShelfSubscription('shelf-survive');
      expect(sub?.cleanupPolicy).toBe('remove_managed_copy');

      const entries = await secondProcess.getShelfEntries('shelf-survive');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.localPath).toBe('books/survive.epub');
      expect(entries[0]?.managedByProvider).toBe(true);

      const refCount = await secondProcess.getManagedShelfEntryReferences('books/survive.epub');
      expect(refCount).toBe(1);
    });
  });
});
