import type { AppService } from '@/types/system';
import type { ShelfCleanupPolicy, ShelfDownloadPolicy, ShelfSyncEntry } from './types';

export const DB_SCHEMA = 'shelf-sync';
export const DB_PATH = 'shelf-sync.db';

export const SQLITE_BIND_CHUNK_SIZE = 500;

export interface ShelfSubscriptionRecord {
  provider: string;
  connectionId: string;
  shelfType: string;
  shelfId: string;
  enabled: boolean;
  cleanupPolicy: ShelfCleanupPolicy;
  downloadPolicy: ShelfDownloadPolicy;
  createdAt: number;
  updatedAt: number;
}

export interface SaveShelfSubscriptionInput {
  provider?: string;
  connectionId?: string;
  shelfType?: string;
  shelfId: string | number;
  enabled?: boolean;
  cleanupPolicy?: ShelfCleanupPolicy;
  downloadPolicy?: ShelfDownloadPolicy;
}

export interface GetShelfSubscriptionsOptions {
  provider?: string;
  connectionId?: string;
  shelfType?: string;
  enabledOnly?: boolean;
  allProviders?: boolean;
  allConnections?: boolean;
}

export interface ShelfEntryRecord extends ShelfSyncEntry<string> {
  provider: string;
  connectionId: string;
  shelfType: string;
  shelfId: string;
  bookId: string;
  fileId: string | null;
  bookHash: string | null;
  contentVersion: string | null;
  localPath: string | null;
  managedByProvider: boolean;
  lastSeenAt: number;
}

export interface ShelfEntryWrite {
  provider?: string;
  connectionId?: string;
  shelfType?: string;
  shelfId: string | number;
  bookId: string | number;
  fileId?: string | null;
  bookHash?: string | null;
  contentVersion?: string | null;
  localPath?: string | null;
  managedByProvider?: boolean;
  lastSeenAt?: number;
}

export interface ShelfEntryKey {
  provider?: string;
  connectionId?: string;
  shelfType?: string;
  shelfId: string | number;
  bookId: string | number;
}

export interface GetShelfEntriesOptions {
  provider?: string;
  connectionId?: string;
  remoteOnly?: boolean;
}

export interface ReferenceQueryOptions {
  provider?: string;
  connectionId?: string;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS shelf_subscriptions (
    provider TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    shelf_type TEXT NOT NULL DEFAULT 'default',
    shelf_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    cleanup_policy TEXT NOT NULL DEFAULT 'keep_local',
    download_policy TEXT NOT NULL DEFAULT 'always',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, connection_id, shelf_type, shelf_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_shelf_subscriptions_active ON shelf_subscriptions (provider, connection_id, enabled)',
  `CREATE TABLE IF NOT EXISTS shelf_entries (
    provider TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    shelf_type TEXT NOT NULL DEFAULT 'default',
    shelf_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    file_id TEXT,
    book_hash TEXT,
    content_version TEXT,
    local_path TEXT,
    managed_by_provider INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (provider, connection_id, shelf_type, shelf_id, book_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_shelf_entries_local_path ON shelf_entries (local_path)',
  'CREATE INDEX IF NOT EXISTS idx_shelf_entries_book_hash ON shelf_entries (book_hash)',
  'CREATE INDEX IF NOT EXISTS idx_shelf_entries_file_id ON shelf_entries (file_id)',
  'CREATE INDEX IF NOT EXISTS idx_shelf_entries_managed_path ON shelf_entries (managed_by_provider, local_path)',
];

type OpenDatabase = Awaited<ReturnType<AppService['openDatabase']>>;

type EntryDbRow = {
  provider: string;
  connection_id: string;
  shelf_type: string;
  shelf_id: string;
  book_id: string;
  file_id: string | null;
  book_hash: string | null;
  content_version: string | null;
  local_path: string | null;
  managed_by_provider: number;
  last_seen_at: number;
};

const mapEntryRow = (row: EntryDbRow): ShelfEntryRecord => ({
  provider: row.provider,
  connectionId: row.connection_id,
  shelfType: row.shelf_type,
  shelfId: row.shelf_id,
  bookId: row.book_id,
  fileId: row.file_id ?? null,
  bookHash: row.book_hash ?? null,
  contentVersion: row.content_version ?? null,
  localPath: row.local_path ?? null,
  managedByProvider: Number(row.managed_by_provider) === 1,
  lastSeenAt: Number(row.last_seen_at),
});

/**
 * Provider-neutral persistent store for shelf subscriptions and shelf entry tracking.
 * Backed by `shelf-sync.db`.
 *
 * Supports provider + connection + shelf isolation, remote-only membership,
 * nullable hashes, versions, file IDs, and cross-shelf / cross-provider
 * reference count queries required by the Data Safety Invariant.
 */
export class ShelfSyncStore {
  private static readonly initialized = new WeakMap<object, Promise<void>>();

  constructor(
    private readonly appService: AppService,
    readonly provider = 'default',
    readonly connectionId = 'default',
  ) {}

  /**
   * Return a scoped store instance targeting a specific provider and connection ID.
   */
  withScope(provider: string, connectionId = 'default'): ShelfSyncStore {
    return new ShelfSyncStore(this.appService, provider, connectionId);
  }

  private async initializeSchema(): Promise<void> {
    if (typeof this.appService.createDir === 'function') {
      await this.appService.createDir('', 'Data', true).catch(() => {});
    }
    const db = await this.appService.openDatabase(DB_SCHEMA, DB_PATH, 'Data');
    try {
      for (const statement of SCHEMA_STATEMENTS) {
        await db.execute(statement);
      }
    } finally {
      await db.close();
    }
  }

  /**
   * Idempotent schema initialization memoized per AppService.
   */
  ensureSchema(): Promise<void> {
    const owner = this.appService as object;
    const existing = ShelfSyncStore.initialized.get(owner);
    if (existing) return existing;
    const initialization = this.initializeSchema().catch((error) => {
      ShelfSyncStore.initialized.delete(owner);
      throw error;
    });
    ShelfSyncStore.initialized.set(owner, initialization);
    return initialization;
  }

  private async withDb<T>(fn: (db: OpenDatabase) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    const db = await this.appService.openDatabase(DB_SCHEMA, DB_PATH, 'Data');
    try {
      return await fn(db);
    } finally {
      await db.close();
    }
  }

  private async withTransaction<T>(fn: (db: OpenDatabase) => Promise<T>): Promise<T> {
    return this.withDb(async (db) => {
      await db.execute('BEGIN');
      try {
        const result = await fn(db);
        await db.execute('COMMIT');
        return result;
      } catch (error) {
        await db.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Shelf Subscriptions
  // ---------------------------------------------------------------------------

  async saveShelfSubscription(
    shelfIdOrInput: string | number | SaveShelfSubscriptionInput,
    enabled?: boolean,
    cleanupPolicy: ShelfCleanupPolicy = 'keep_local',
    downloadPolicy: ShelfDownloadPolicy = 'always',
    shelfType = 'default',
  ): Promise<void> {
    const now = Date.now();
    let provider = this.provider;
    let connectionId = this.connectionId;
    let sType = shelfType;
    let sId: string;
    let isEnabled = enabled ?? true;
    let cPolicy = cleanupPolicy;
    let dPolicy = downloadPolicy;

    if (typeof shelfIdOrInput === 'object') {
      provider = shelfIdOrInput.provider ?? this.provider;
      connectionId = shelfIdOrInput.connectionId ?? this.connectionId;
      sType = shelfIdOrInput.shelfType ?? 'default';
      sId = String(shelfIdOrInput.shelfId);
      isEnabled = shelfIdOrInput.enabled ?? true;
      cPolicy = shelfIdOrInput.cleanupPolicy ?? 'keep_local';
      dPolicy = shelfIdOrInput.downloadPolicy ?? 'always';
    } else {
      sId = String(shelfIdOrInput);
    }

    await this.withDb((db) =>
      db.execute(
        `INSERT INTO shelf_subscriptions (
          provider, connection_id, shelf_type, shelf_id, enabled,
          cleanup_policy, download_policy, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, connection_id, shelf_type, shelf_id) DO UPDATE SET
          enabled = excluded.enabled,
          cleanup_policy = excluded.cleanup_policy,
          download_policy = excluded.download_policy,
          updated_at = excluded.updated_at`,
        [provider, connectionId, sType, sId, isEnabled ? 1 : 0, cPolicy, dPolicy, now, now],
      ),
    );
  }

  async getShelfSubscription(
    shelfId: string | number,
    shelfType = 'default',
    options?: { provider?: string; connectionId?: string },
  ): Promise<ShelfSubscriptionRecord | null> {
    const provider = options?.provider ?? this.provider;
    const connectionId = options?.connectionId ?? this.connectionId;
    return this.withDb(async (db) => {
      const rows = await db.select<{
        provider: string;
        connection_id: string;
        shelf_type: string;
        shelf_id: string;
        enabled: number;
        cleanup_policy: string;
        download_policy: string;
        created_at: number;
        updated_at: number;
      }>(
        `SELECT provider, connection_id, shelf_type, shelf_id, enabled, cleanup_policy, download_policy, created_at, updated_at
         FROM shelf_subscriptions
         WHERE provider = ? AND connection_id = ? AND shelf_type = ? AND shelf_id = ?`,
        [provider, connectionId, shelfType, String(shelfId)],
      );
      if (!rows.length) return null;
      const row = rows[0]!;
      return {
        provider: row.provider,
        connectionId: row.connection_id,
        shelfType: row.shelf_type,
        shelfId: row.shelf_id,
        enabled: Number(row.enabled) === 1,
        cleanupPolicy: (row.cleanup_policy as ShelfCleanupPolicy) || 'keep_local',
        downloadPolicy: (row.download_policy as ShelfDownloadPolicy) || 'always',
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      };
    });
  }

  async getShelfSubscriptions(
    options: GetShelfSubscriptionsOptions = {},
  ): Promise<ShelfSubscriptionRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!options.allProviders) {
      conditions.push('provider = ?');
      params.push(options.provider ?? this.provider);
    }
    if (!options.allConnections) {
      conditions.push('connection_id = ?');
      params.push(options.connectionId ?? this.connectionId);
    }
    if (options.shelfType != null) {
      conditions.push('shelf_type = ?');
      params.push(options.shelfType);
    }
    if (options.enabledOnly != null) {
      conditions.push('enabled = ?');
      params.push(options.enabledOnly ? 1 : 0);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT provider, connection_id, shelf_type, shelf_id, enabled, cleanup_policy, download_policy, created_at, updated_at
                 FROM shelf_subscriptions
                 ${whereClause}
                 ORDER BY created_at ASC`;

    return this.withDb(async (db) => {
      const rows = await db.select<{
        provider: string;
        connection_id: string;
        shelf_type: string;
        shelf_id: string;
        enabled: number;
        cleanup_policy: string;
        download_policy: string;
        created_at: number;
        updated_at: number;
      }>(sql, params);

      return rows.map((row) => ({
        provider: row.provider,
        connectionId: row.connection_id,
        shelfType: row.shelf_type,
        shelfId: row.shelf_id,
        enabled: Number(row.enabled) === 1,
        cleanupPolicy: (row.cleanup_policy as ShelfCleanupPolicy) || 'keep_local',
        downloadPolicy: (row.download_policy as ShelfDownloadPolicy) || 'always',
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }));
    });
  }

  async deleteShelfSubscription(
    shelfId: string | number,
    shelfType = 'default',
    options?: { provider?: string; connectionId?: string },
  ): Promise<void> {
    const provider = options?.provider ?? this.provider;
    const connectionId = options?.connectionId ?? this.connectionId;
    await this.withDb((db) =>
      db.execute(
        `DELETE FROM shelf_subscriptions
         WHERE provider = ? AND connection_id = ? AND shelf_type = ? AND shelf_id = ?`,
        [provider, connectionId, shelfType, String(shelfId)],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Shelf Entries
  // ---------------------------------------------------------------------------

  async markShelfEntry(entry: ShelfEntryWrite): Promise<void> {
    await this.markShelfEntries([entry]);
  }

  async markShelfEntries(entries: ShelfEntryWrite[]): Promise<void> {
    if (!entries.length) return;
    const now = Date.now();
    await this.withTransaction(async (db) => {
      for (const entry of entries) {
        const provider = entry.provider ?? this.provider;
        const connectionId = entry.connectionId ?? this.connectionId;
        const shelfType = entry.shelfType ?? 'default';
        const shelfId = String(entry.shelfId);
        const bookId = String(entry.bookId);
        const fileId = entry.fileId != null ? String(entry.fileId) : null;
        const bookHash = entry.bookHash ?? null;
        const contentVersion = entry.contentVersion != null ? String(entry.contentVersion) : null;
        const localPath = entry.localPath ?? null;
        const managedByProvider = entry.managedByProvider ? 1 : 0;
        const lastSeenAt = entry.lastSeenAt ?? now;

        await db.execute(
          `INSERT INTO shelf_entries (
            provider, connection_id, shelf_type, shelf_id, book_id,
            file_id, book_hash, content_version, local_path,
            managed_by_provider, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, connection_id, shelf_type, shelf_id, book_id) DO UPDATE SET
            file_id = excluded.file_id,
            book_hash = excluded.book_hash,
            content_version = excluded.content_version,
            local_path = excluded.local_path,
            managed_by_provider = excluded.managed_by_provider,
            last_seen_at = excluded.last_seen_at`,
          [
            provider,
            connectionId,
            shelfType,
            shelfId,
            bookId,
            fileId,
            bookHash,
            contentVersion,
            localPath,
            managedByProvider,
            lastSeenAt,
          ],
        );
      }
    });
  }

  async updateShelfEntry(
    key: ShelfEntryKey,
    updates: {
      fileId?: string | null;
      bookHash?: string | null;
      contentVersion?: string | null;
      localPath?: string | null;
      managedByProvider?: boolean;
      lastSeenAt?: number;
    },
  ): Promise<boolean> {
    const provider = key.provider ?? this.provider;
    const connectionId = key.connectionId ?? this.connectionId;
    const shelfType = key.shelfType ?? 'default';
    const shelfId = String(key.shelfId);
    const bookId = String(key.bookId);

    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.fileId !== undefined) {
      setClauses.push('file_id = ?');
      params.push(updates.fileId);
    }
    if (updates.bookHash !== undefined) {
      setClauses.push('book_hash = ?');
      params.push(updates.bookHash);
    }
    if (updates.contentVersion !== undefined) {
      setClauses.push('content_version = ?');
      params.push(updates.contentVersion);
    }
    if (updates.localPath !== undefined) {
      setClauses.push('local_path = ?');
      params.push(updates.localPath);
    }
    if (updates.managedByProvider !== undefined) {
      setClauses.push('managed_by_provider = ?');
      params.push(updates.managedByProvider ? 1 : 0);
    }
    if (updates.lastSeenAt !== undefined) {
      setClauses.push('last_seen_at = ?');
      params.push(updates.lastSeenAt);
    }

    if (!setClauses.length) return false;

    params.push(provider, connectionId, shelfType, shelfId, bookId);

    return this.withDb(async (db) => {
      const result = await db.execute(
        `UPDATE shelf_entries
         SET ${setClauses.join(', ')}
         WHERE provider = ? AND connection_id = ? AND shelf_type = ? AND shelf_id = ? AND book_id = ?`,
        params,
      );
      return (result.rowsAffected ?? 0) > 0;
    });
  }

  async removeShelfEntry(
    shelfId: string | number,
    bookId: string | number,
    shelfType = 'default',
    options?: { provider?: string; connectionId?: string },
  ): Promise<void> {
    await this.removeShelfEntries([
      {
        provider: options?.provider ?? this.provider,
        connectionId: options?.connectionId ?? this.connectionId,
        shelfType,
        shelfId,
        bookId,
      },
    ]);
  }

  async removeShelfEntries(entries: ShelfEntryKey[]): Promise<void> {
    if (!entries.length) return;
    await this.withTransaction(async (db) => {
      for (const entry of entries) {
        const provider = entry.provider ?? this.provider;
        const connectionId = entry.connectionId ?? this.connectionId;
        const shelfType = entry.shelfType ?? 'default';
        const shelfId = String(entry.shelfId);
        const bookId = String(entry.bookId);

        await db.execute(
          `DELETE FROM shelf_entries
           WHERE provider = ? AND connection_id = ? AND shelf_type = ? AND shelf_id = ? AND book_id = ?`,
          [provider, connectionId, shelfType, shelfId, bookId],
        );
      }
    });
  }

  async getShelfEntries(
    shelfId: string | number,
    shelfType = 'default',
    options: GetShelfEntriesOptions = {},
  ): Promise<ShelfEntryRecord[]> {
    const provider = options.provider ?? this.provider;
    const connectionId = options.connectionId ?? this.connectionId;
    const conditions: string[] = [
      'provider = ?',
      'connection_id = ?',
      'shelf_type = ?',
      'shelf_id = ?',
    ];
    const params: unknown[] = [provider, connectionId, shelfType, String(shelfId)];

    if (options.remoteOnly === true) {
      conditions.push('local_path IS NULL');
    } else if (options.remoteOnly === false) {
      conditions.push('local_path IS NOT NULL');
    }

    const sql = `SELECT provider, connection_id, shelf_type, shelf_id, book_id, file_id, book_hash, content_version, local_path, managed_by_provider, last_seen_at
                 FROM shelf_entries
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY last_seen_at DESC`;

    return this.withDb(async (db) => {
      const rows = await db.select<EntryDbRow>(sql, params);
      return rows.map(mapEntryRow);
    });
  }

  async getRemoteOnlyShelfEntries(
    shelfId: string | number,
    shelfType = 'default',
    options?: { provider?: string; connectionId?: string },
  ): Promise<ShelfEntryRecord[]> {
    return this.getShelfEntries(shelfId, shelfType, { ...options, remoteOnly: true });
  }

  async clearShelfEntries(
    shelfId: string | number,
    shelfType = 'default',
    options?: { provider?: string; connectionId?: string },
  ): Promise<void> {
    const provider = options?.provider ?? this.provider;
    const connectionId = options?.connectionId ?? this.connectionId;
    await this.withDb((db) =>
      db.execute(
        `DELETE FROM shelf_entries
         WHERE provider = ? AND connection_id = ? AND shelf_type = ? AND shelf_id = ?`,
        [provider, connectionId, shelfType, String(shelfId)],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Reference & Safety Queries (Before Deletion / Cleanup)
  // ---------------------------------------------------------------------------

  /**
   * Counts managed references for the provided local paths.
   * By default, counts across ALL shelves and providers to satisfy the
   * Data Safety Invariant (never delete if referenced elsewhere).
   */
  async getManagedShelfReferenceCounts(
    localPaths: string[],
    options?: ReferenceQueryOptions,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const path of localPaths) {
      result.set(path, 0);
    }
    if (!localPaths.length) return result;

    await this.withDb(async (db) => {
      for (let start = 0; start < localPaths.length; start += SQLITE_BIND_CHUNK_SIZE) {
        const batch = localPaths.slice(start, start + SQLITE_BIND_CHUNK_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        const whereClauses: string[] = [
          'managed_by_provider = 1',
          `local_path IN (${placeholders})`,
        ];
        const params: unknown[] = [];

        if (options?.provider != null) {
          whereClauses.unshift('provider = ?');
          params.push(options.provider);
          if (options.connectionId != null) {
            whereClauses.splice(1, 0, 'connection_id = ?');
            params.push(options.connectionId);
          }
        }
        params.push(...batch);

        const rows = await db.select<{ local_path: string; count: number | string }>(
          `SELECT local_path, COUNT(*) AS count
           FROM shelf_entries
           WHERE ${whereClauses.join(' AND ')}
           GROUP BY local_path`,
          params,
        );

        for (const row of rows) {
          result.set(row.local_path, Number(row.count) || 0);
        }
      }
    });

    return result;
  }

  /**
   * Returns the count of managed references for a single local path.
   */
  async getManagedShelfEntryReferences(
    localPath: string,
    options?: ReferenceQueryOptions,
  ): Promise<number> {
    const map = await this.getManagedShelfReferenceCounts([localPath], options);
    return map.get(localPath) ?? 0;
  }

  /**
   * Counts ALL references (managed and unmanaged) for the provided local paths.
   */
  async getAllShelfReferenceCounts(
    localPaths: string[],
    options?: ReferenceQueryOptions,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const path of localPaths) {
      result.set(path, 0);
    }
    if (!localPaths.length) return result;

    await this.withDb(async (db) => {
      for (let start = 0; start < localPaths.length; start += SQLITE_BIND_CHUNK_SIZE) {
        const batch = localPaths.slice(start, start + SQLITE_BIND_CHUNK_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        const whereClauses: string[] = [`local_path IN (${placeholders})`];
        const params: unknown[] = [];

        if (options?.provider != null) {
          whereClauses.unshift('provider = ?');
          params.push(options.provider);
          if (options.connectionId != null) {
            whereClauses.splice(1, 0, 'connection_id = ?');
            params.push(options.connectionId);
          }
        }
        params.push(...batch);

        const rows = await db.select<{ local_path: string; count: number | string }>(
          `SELECT local_path, COUNT(*) AS count
           FROM shelf_entries
           WHERE ${whereClauses.join(' AND ')}
           GROUP BY local_path`,
          params,
        );

        for (const row of rows) {
          result.set(row.local_path, Number(row.count) || 0);
        }
      }
    });

    return result;
  }

  /**
   * Returns the count of all references (managed and unmanaged) for a single local path.
   */
  async getAllShelfEntryReferences(
    localPath: string,
    options?: ReferenceQueryOptions,
  ): Promise<number> {
    const map = await this.getAllShelfReferenceCounts([localPath], options);
    return map.get(localPath) ?? 0;
  }

  /**
   * Returns all shelf entries referencing the specified local path.
   */
  async getReferencesForPath(
    localPath: string,
    options?: ReferenceQueryOptions,
  ): Promise<ShelfEntryRecord[]> {
    const conditions = ['local_path = ?'];
    const params: unknown[] = [localPath];

    if (options?.provider != null) {
      conditions.push('provider = ?');
      params.push(options.provider);
      if (options.connectionId != null) {
        conditions.push('connection_id = ?');
        params.push(options.connectionId);
      }
    }

    return this.withDb(async (db) => {
      const rows = await db.select<EntryDbRow>(
        `SELECT provider, connection_id, shelf_type, shelf_id, book_id, file_id, book_hash, content_version, local_path, managed_by_provider, last_seen_at
         FROM shelf_entries
         WHERE ${conditions.join(' AND ')}
         ORDER BY last_seen_at DESC`,
        params,
      );
      return rows.map(mapEntryRow);
    });
  }

  /**
   * Returns the most recently seen shelf entry for the given local path.
   */
  async getShelfEntryByLocalPath(
    localPath: string,
    options?: ReferenceQueryOptions,
  ): Promise<ShelfEntryRecord | null> {
    const entries = await this.getReferencesForPath(localPath, options);
    return entries[0] ?? null;
  }

  /**
   * Finds all shelf entries matching a content book hash.
   */
  async getShelfEntriesByBookHash(
    bookHash: string,
    options?: ReferenceQueryOptions,
  ): Promise<ShelfEntryRecord[]> {
    const conditions = ['book_hash = ?'];
    const params: unknown[] = [bookHash];

    if (options?.provider != null) {
      conditions.push('provider = ?');
      params.push(options.provider);
      if (options.connectionId != null) {
        conditions.push('connection_id = ?');
        params.push(options.connectionId);
      }
    }

    return this.withDb(async (db) => {
      const rows = await db.select<EntryDbRow>(
        `SELECT provider, connection_id, shelf_type, shelf_id, book_id, file_id, book_hash, content_version, local_path, managed_by_provider, last_seen_at
         FROM shelf_entries
         WHERE ${conditions.join(' AND ')}
         ORDER BY last_seen_at DESC`,
        params,
      );
      return rows.map(mapEntryRow);
    });
  }

  /**
   * Finds all shelf entries matching a provider remote file ID.
   */
  async getShelfEntriesByFileId(
    fileId: string,
    options?: ReferenceQueryOptions,
  ): Promise<ShelfEntryRecord[]> {
    const conditions = ['file_id = ?'];
    const params: unknown[] = [fileId];

    if (options?.provider != null) {
      conditions.push('provider = ?');
      params.push(options.provider);
      if (options.connectionId != null) {
        conditions.push('connection_id = ?');
        params.push(options.connectionId);
      }
    }

    return this.withDb(async (db) => {
      const rows = await db.select<EntryDbRow>(
        `SELECT provider, connection_id, shelf_type, shelf_id, book_id, file_id, book_hash, content_version, local_path, managed_by_provider, last_seen_at
         FROM shelf_entries
         WHERE ${conditions.join(' AND ')}
         ORDER BY last_seen_at DESC`,
        params,
      );
      return rows.map(mapEntryRow);
    });
  }
}
