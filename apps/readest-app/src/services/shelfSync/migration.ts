import type { AppService } from '@/types/system';
import type { ShelfSyncStore } from './ShelfSyncStore';
import type { ShelfCleanupPolicy, ShelfDownloadPolicy } from './types';

export interface GrimmLinkMigrationResult {
  migratedSubscriptions: number;
  migratedEntries: number;
  skipped: boolean;
}

/**
 * Idempotently migrates existing GrimmLink shelf subscriptions and entries
 * from `grimmlink-sync.db` into the generic provider-neutral `shelf-sync.db`.
 *
 * DATA SAFETY INVARIANT:
 * This migration NEVER deletes or drops `grimmlink-sync.db` or its tables,
 * preserving all outbox rows, ratings, cursors, and diagnostics indefinitely.
 */
export async function migrateGrimmLinkShelfState(
  appService: AppService,
  connectionId: string,
  targetStore: ShelfSyncStore,
): Promise<GrimmLinkMigrationResult> {
  if (typeof appService.openDatabase !== 'function') {
    return { migratedSubscriptions: 0, migratedEntries: 0, skipped: true };
  }

  let db: Awaited<ReturnType<AppService['openDatabase']>> | null = null;
  try {
    db = await appService.openDatabase('grimmlink-sync', 'grimmlink-sync.db', 'Data');
  } catch {
    return { migratedSubscriptions: 0, migratedEntries: 0, skipped: true };
  }

  try {
    const tables = await db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('shelf_subscriptions', 'shelf_entries')",
    );
    const tableNames = new Set(tables.map((t) => t.name));
    if (!tableNames.has('shelf_subscriptions') && !tableNames.has('shelf_entries')) {
      return { migratedSubscriptions: 0, migratedEntries: 0, skipped: true };
    }

    let migratedSubscriptions = 0;
    let migratedEntries = 0;

    if (tableNames.has('shelf_subscriptions')) {
      const subs = await db.select<{
        shelf_type: string;
        shelf_id: number | string;
        enabled: number;
        cleanup_policy: string;
        download_policy: string;
      }>(
        'SELECT shelf_type, shelf_id, enabled, cleanup_policy, download_policy FROM shelf_subscriptions WHERE connection_id = ?',
        [connectionId],
      );

      for (const sub of subs) {
        await targetStore.saveShelfSubscription({
          provider: 'grimmlink',
          connectionId,
          shelfType: sub.shelf_type,
          shelfId: String(sub.shelf_id),
          enabled: Number(sub.enabled) === 1,
          cleanupPolicy: (sub.cleanup_policy as ShelfCleanupPolicy) || 'keep_local',
          downloadPolicy: (sub.download_policy as ShelfDownloadPolicy) || 'always',
        });
        migratedSubscriptions++;
      }
    }

    if (tableNames.has('shelf_entries')) {
      const entries = await db.select<{
        shelf_type: string;
        shelf_id: number | string;
        book_id: number | string;
        book_hash: string;
        local_path: string | null;
        managed_by_grimmlink: number;
        last_seen_at: number;
      }>(
        'SELECT shelf_type, shelf_id, book_id, book_hash, local_path, managed_by_grimmlink, last_seen_at FROM shelf_entries WHERE connection_id = ?',
        [connectionId],
      );

      if (entries.length > 0) {
        await targetStore.markShelfEntries(
          entries.map((e) => ({
            provider: 'grimmlink',
            connectionId,
            shelfType: e.shelf_type,
            shelfId: String(e.shelf_id),
            bookId: String(e.book_id),
            bookHash: e.book_hash,
            localPath: e.local_path,
            managedByProvider: Number(e.managed_by_grimmlink) === 1,
            lastSeenAt: Number(e.last_seen_at) || Date.now(),
          })),
        );
        migratedEntries = entries.length;
      }
    }

    return { migratedSubscriptions, migratedEntries, skipped: false };
  } catch {
    return { migratedSubscriptions: 0, migratedEntries: 0, skipped: true };
  } finally {
    if (db) {
      await db.close().catch(() => {});
    }
  }
}
