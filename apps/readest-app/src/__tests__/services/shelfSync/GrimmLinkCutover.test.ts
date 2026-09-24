import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeAppService } from '@/services/nodeAppService';
import { ShelfSyncStore } from '@/services/shelfSync/ShelfSyncStore';
import { migrateGrimmLinkShelfState } from '@/services/shelfSync/migration';
import { syncSubscribedGrimmLinkShelves, type ShelfClient } from '@/services/grimmlink/shelfSync';
import { GrimmLinkSyncStore } from '@/services/grimmlink/GrimmLinkSyncStore';
import type { Book } from '@/types/book';

const SANDBOX_DIR = path.join(process.cwd(), '.test-sandbox-grimmlink-cutover');

describe('GrimmLink Generic-Store Cutover & Cross-Provider Reference Safety', () => {
  let root: string;
  let service: NodeAppService;

  beforeEach(async () => {
    await fsp.mkdir(SANDBOX_DIR, { recursive: true });
    root = await fsp.mkdtemp(path.join(SANDBOX_DIR, 'cutover-'));
    service = new NodeAppService(root);
    await service.init();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const setupLegacyGrimmLinkDb = async (connectionId = 'conn-1') => {
    await service.createDir('', 'Data', true);
    const db = await service.openDatabase('grimmlink-sync', 'grimmlink-sync.db', 'Data');
    try {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS shelf_subscriptions (
          connection_id TEXT NOT NULL,
          shelf_type TEXT NOT NULL,
          shelf_id INTEGER NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          cleanup_policy TEXT NOT NULL DEFAULT 'keep_local',
          download_policy TEXT NOT NULL DEFAULT 'always',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (connection_id, shelf_type, shelf_id)
        );
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS shelf_entries (
          connection_id TEXT NOT NULL,
          shelf_type TEXT NOT NULL,
          shelf_id INTEGER NOT NULL,
          book_id INTEGER NOT NULL,
          book_hash TEXT NOT NULL,
          local_path TEXT,
          managed_by_grimmlink INTEGER NOT NULL DEFAULT 0,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY (connection_id, shelf_type, shelf_id, book_id)
        );
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL,
          category TEXT NOT NULL,
          payload TEXT NOT NULL
        );
      `);

      // Seed legacy shelf subscription and entry
      await db.execute(
        `INSERT INTO shelf_subscriptions (connection_id, shelf_type, shelf_id, enabled, cleanup_policy, download_policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [connectionId, 'regular', 101, 1, 'remove_managed_copy', 'always', 1000, 1000],
      );
      await db.execute(
        `INSERT INTO shelf_entries (connection_id, shelf_type, shelf_id, book_id, book_hash, local_path, managed_by_grimmlink, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [connectionId, 'regular', 101, 202, 'legacy-hash', 'legacy-hash/book.epub', 1, 1000],
      );
      // Seed an unrelated outbox entry to prove grimmlink-sync.db is never dropped
      await db.execute(
        `INSERT INTO outbox (id, connection_id, category, payload) VALUES (?, ?, ?, ?)`,
        ['outbox-item-1', connectionId, 'rating', '{"rating":5}'],
      );
    } finally {
      await db.close();
    }
  };

  it('1. first migration copies legacy shelf subscriptions and entries into shelf-sync.db', async () => {
    const connectionId = 'conn-1';
    await setupLegacyGrimmLinkDb(connectionId);

    const genericStore = new ShelfSyncStore(service, 'grimmlink', connectionId);
    const result = await migrateGrimmLinkShelfState(service, connectionId, genericStore);

    expect(result.skipped).toBe(false);
    expect(result.migratedSubscriptions).toBe(1);
    expect(result.migratedEntries).toBe(1);

    // Verify shelf-sync.db has the subscription
    const sub = await genericStore.getShelfSubscription('101', 'regular');
    expect(sub).not.toBeNull();
    expect(sub).toMatchObject({
      provider: 'grimmlink',
      connectionId,
      shelfType: 'regular',
      shelfId: '101',
      enabled: true,
      cleanupPolicy: 'remove_managed_copy',
      downloadPolicy: 'always',
    });

    // Verify shelf-sync.db has the entry
    const entries = await genericStore.getShelfEntries('101', 'regular');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: 'grimmlink',
      connectionId,
      shelfType: 'regular',
      shelfId: '101',
      bookId: '202',
      bookHash: 'legacy-hash',
      localPath: 'legacy-hash/book.epub',
      managedByProvider: true,
    });
  });

  it('2. second migration is harmless and idempotent', async () => {
    const connectionId = 'conn-1';
    await setupLegacyGrimmLinkDb(connectionId);

    const genericStore = new ShelfSyncStore(service, 'grimmlink', connectionId);
    const result1 = await migrateGrimmLinkShelfState(service, connectionId, genericStore);
    expect(result1.migratedSubscriptions).toBe(1);
    expect(result1.migratedEntries).toBe(1);

    // Run second migration
    const result2 = await migrateGrimmLinkShelfState(service, connectionId, genericStore);
    expect(result2.skipped).toBe(false);
    expect(result2.migratedSubscriptions).toBe(0);
    expect(result2.migratedEntries).toBe(0);

    // State is intact
    const subs = await genericStore.getShelfSubscriptions();
    expect(subs).toHaveLength(1);
    const entries = await genericStore.getShelfEntries('101', 'regular');
    expect(entries).toHaveLength(1);
  });

  it('3. generic-store values modified after first migration are NOT reverted by stale legacy data', async () => {
    const connectionId = 'conn-1';
    await setupLegacyGrimmLinkDb(connectionId);

    const genericStore = new ShelfSyncStore(service, 'grimmlink', connectionId);
    await migrateGrimmLinkShelfState(service, connectionId, genericStore);

    // Modify subscription in generic store
    await genericStore.saveShelfSubscription({
      shelfType: 'regular',
      shelfId: '101',
      enabled: false,
      cleanupPolicy: 'keep_local',
      downloadPolicy: 'off',
    });

    // Modify entry in generic store
    await genericStore.updateShelfEntry(
      { shelfType: 'regular', shelfId: '101', bookId: '202' },
      {
        localPath: 'new-hash/book.epub',
        managedByProvider: false,
        lastSeenAt: 999999,
      },
    );

    // Re-run migration: stale legacy data in grimmlink-sync.db has enabled=1, cleanup_policy='remove_managed_copy', etc.
    const result = await migrateGrimmLinkShelfState(service, connectionId, genericStore);
    expect(result.migratedSubscriptions).toBe(0);
    expect(result.migratedEntries).toBe(0);

    // Verify generic store preserved newer values and was NOT reverted
    const sub = await genericStore.getShelfSubscription('101', 'regular');
    expect(sub?.enabled).toBe(false);
    expect(sub?.cleanupPolicy).toBe('keep_local');
    expect(sub?.downloadPolicy).toBe('off');

    const entries = await genericStore.getShelfEntries('101', 'regular');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.localPath).toBe('new-hash/book.epub');
    expect(entries[0]?.managedByProvider).toBe(false);
    expect(entries[0]?.lastSeenAt).toBe(999999);
  });

  it('4. legacy grimmlink-sync.db is never deleted', async () => {
    const connectionId = 'conn-1';
    await setupLegacyGrimmLinkDb(connectionId);

    const genericStore = new ShelfSyncStore(service, 'grimmlink', connectionId);
    await migrateGrimmLinkShelfState(service, connectionId, genericStore);
    await migrateGrimmLinkShelfState(service, connectionId, genericStore);

    // grimmlink-sync.db still exists and contains the outbox table and data
    const db = await service.openDatabase('grimmlink-sync', 'grimmlink-sync.db', 'Data');
    try {
      const outboxRows = await db.select<{ id: string; category: string }>(
        'SELECT id, category FROM outbox WHERE connection_id = ?',
        [connectionId],
      );
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]?.id).toBe('outbox-item-1');
      expect(outboxRows[0]?.category).toBe('rating');
    } finally {
      await db.close();
    }
  });

  it('5. GrimmLink runtime reads and writes Shelf Sync state from shelf-sync.db', async () => {
    const connectionId = 'conn-1';
    await setupLegacyGrimmLinkDb(connectionId);

    const client: ShelfClient = {
      getShelfBooks: async () => [
        {
          bookId: 303,
          bookHash: 'book-303-hash',
          filename: 'new-book.pdf',
          format: 'PDF',
        },
      ],
      downloadShelfBook: async () => new TextEncoder().encode('%PDF-1.7 dummy').buffer,
    };

    const legacyStore = new GrimmLinkSyncStore(service, connectionId);

    // Mock service.importBook to avoid node pdfjs-dist worker loading
    service.importBook = async () =>
      ({
        hash: 'book-303-hash',
        title: 'new-book',
        format: 'PDF',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }) as Book;

    // Call syncSubscribedGrimmLinkShelves with legacyStore
    const library: Book[] = [];
    const result = await syncSubscribedGrimmLinkShelves(
      client,
      legacyStore,
      () => library,
      (_book, nextLib) => {
        library.splice(0, library.length, ...nextLib);
      },
      service,
    );

    expect(result.downloaded).toBe(1);

    // Verify that the new shelf entry was written to shelf-sync.db
    const genericStore = new ShelfSyncStore(service, 'grimmlink', connectionId);
    const entries = await genericStore.getShelfEntries('101', 'regular');
    const newEntry = entries.find((e) => e.bookId === '303');
    expect(newEntry).toBeDefined();
    expect(newEntry?.managedByProvider).toBe(true);

    // Verify that grimmlink-sync.db was NOT dual-written to
    const legacyDb = await service.openDatabase('grimmlink-sync', 'grimmlink-sync.db', 'Data');
    try {
      const legacyEntries = await legacyDb.select<{ book_id: number }>(
        'SELECT book_id FROM shelf_entries WHERE book_id = 303',
      );
      expect(legacyEntries).toHaveLength(0); // No dual-write to legacy db
    } finally {
      await legacyDb.close();
    }
  });

  it('6. cross-provider reference counting sees both GrimmLink and fake BookOrbit in the same generic DB', async () => {
    const sharedPath = 'shared-hash/shared.epub';
    const genericStore = new ShelfSyncStore(service);

    const grimmlinkStore = genericStore.withScope('grimmlink', 'gl-conn');
    const bookorbitStore = genericStore.withScope('bookorbit', 'bo-conn');

    // GrimmLink: managed entry
    await grimmlinkStore.markShelfEntries([
      {
        shelfType: 'regular',
        shelfId: '10',
        bookId: 'gl-1',
        bookHash: 'shared-hash',
        localPath: sharedPath,
        managedByProvider: true,
      },
    ]);

    // BookOrbit: unmanaged entry referencing same localPath
    await bookorbitStore.markShelfEntries([
      {
        shelfType: 'collection',
        shelfId: 'favs',
        bookId: 'bo-1',
        bookHash: 'shared-hash',
        localPath: sharedPath,
        managedByProvider: false,
      },
    ]);

    // Query ALL shelf references across all providers:
    const allCounts = await genericStore.getAllShelfReferenceCounts([sharedPath]);
    expect(allCounts.get(sharedPath)).toBe(2);

    // Managed counts only count managed=1:
    const managedCounts = await genericStore.getManagedShelfReferenceCounts([sharedPath]);
    expect(managedCounts.get(sharedPath)).toBe(1);

    // Both providers can query their respective entries
    const glEntries = await grimmlinkStore.getShelfEntries('10', 'regular');
    expect(glEntries).toHaveLength(1);
    expect(glEntries[0]?.provider).toBe('grimmlink');

    const boEntries = await bookorbitStore.getShelfEntries('favs', 'collection');
    expect(boEntries).toHaveLength(1);
    expect(boEntries[0]?.provider).toBe('bookorbit');

    // Cross-provider query for path
    const pathRefs = await genericStore.getReferencesForPath(sharedPath);
    expect(pathRefs).toHaveLength(2);
    expect(pathRefs.map((r) => r.provider).sort()).toEqual(['bookorbit', 'grimmlink']);
  });
});
