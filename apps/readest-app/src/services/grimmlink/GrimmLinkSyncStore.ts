import type { AppService } from '@/types/system';
import type { GrimmLinkSessionEnvelope } from './sessions';
import { recordGrimmLinkPerformance } from './einkDiagnostics';

export type GrimmLinkOutboxCategory = 'progress' | 'sessions' | 'metadata' | 'status';

export interface GrimmLinkOutboxRow {
  id: string;
  category: GrimmLinkOutboxCategory;
  bookHash: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  attempts: number;
  createdAt: number;
  nextRetryAt: number;
  errorCategory: GrimmLinkDiagnosticsErrorCategory | null;
}

export type GrimmLinkDiagnosticsErrorCategory =
  | 'auth'
  | 'network'
  | 'server'
  | 'conflict'
  | 'invalid-data';

export interface GrimmLinkOutboxSummary {
  totalPending: number;
  pendingByCategory: Record<GrimmLinkOutboxCategory, number>;
  invalid: number;
  nextRetryAt: number | null;
}

export interface GrimmLinkPersistedDiagnostics {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastReplayDurationMs: number | null;
  lastReplayRows: number;
  lastReplaySucceeded: number;
  lastReplayFailed: number;
  lastError: {
    category: GrimmLinkDiagnosticsErrorCategory;
    message: string;
    action: string;
    at: number;
    retryable: boolean;
  } | null;
}

export interface GrimmLinkBookStatusSnapshot {
  shelfCount: number;
  managedDownload: boolean;
  pending: boolean;
  conflict: boolean;
  error: boolean;
  lastSuccessAt: number | null;
}

type Row = {
  id: string;
  category: GrimmLinkOutboxCategory;
  book_hash: string | null;
  payload: string;
  idempotency_key: string;
  attempts: number;
  created_at: number;
  next_retry_at: number;
  error_category: GrimmLinkDiagnosticsErrorCategory | null;
};

const DB_SCHEMA = 'grimmlink-sync';
const DB_PATH = 'grimmlink-sync.db';
// Leave headroom for SQLite builds with the historical 999-variable limit.
const SQLITE_BIND_CHUNK_SIZE = 500;
const schema = [
  `CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, category TEXT NOT NULL, book_hash TEXT,
    payload TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_retry_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'ready', error_category TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS outbox_ready ON outbox(connection_id, category, state, next_retry_at)',
  'CREATE INDEX IF NOT EXISTS outbox_book_state ON outbox(connection_id, book_hash, state)',
  `CREATE TABLE IF NOT EXISTS grimmlink_connections (
    connection_id TEXT PRIMARY KEY, paused_at INTEGER, pause_reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS grimmlink_diagnostics (
    connection_id TEXT PRIMARY KEY, last_success_at INTEGER, last_attempt_at INTEGER,
    last_replay_duration_ms INTEGER, last_replay_rows INTEGER NOT NULL DEFAULT 0,
    last_replay_succeeded INTEGER NOT NULL DEFAULT 0, last_replay_failed INTEGER NOT NULL DEFAULT 0,
    last_error_category TEXT, last_error_message TEXT, last_error_action TEXT,
    last_error_at INTEGER, last_error_retryable INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS metadata_cursors (
    connection_id TEXT NOT NULL, book_hash TEXT NOT NULL, type TEXT NOT NULL, cursor TEXT NOT NULL,
    PRIMARY KEY (connection_id, book_hash, type)
  )`,
  `CREATE TABLE IF NOT EXISTS metadata_ratings (
    connection_id TEXT NOT NULL, book_hash TEXT NOT NULL, value REAL NOT NULL, scale INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY (connection_id, book_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS note_mappings (
    connection_id TEXT NOT NULL, book_hash TEXT NOT NULL, note_id TEXT NOT NULL, type TEXT NOT NULL,
    dedupe_key TEXT NOT NULL, PRIMARY KEY (connection_id, book_hash, note_id, type),
    UNIQUE (connection_id, book_hash, dedupe_key)
  )`,
  `CREATE TABLE IF NOT EXISTS metadata_unresolved (
    connection_id TEXT NOT NULL, book_hash TEXT NOT NULL, dedupe_key TEXT NOT NULL,
    payload TEXT NOT NULL, received_at INTEGER NOT NULL,
    PRIMARY KEY (connection_id, book_hash, dedupe_key)
  )`,
  `CREATE TABLE IF NOT EXISTS shelf_subscriptions (
    connection_id TEXT NOT NULL, shelf_type TEXT NOT NULL, shelf_id INTEGER NOT NULL, enabled INTEGER NOT NULL,
    cleanup_policy TEXT NOT NULL DEFAULT 'keep_local', download_policy TEXT NOT NULL DEFAULT 'always',
    PRIMARY KEY (connection_id, shelf_type, shelf_id)
  )`,
  `CREATE TABLE IF NOT EXISTS shelf_entries (
    connection_id TEXT NOT NULL, shelf_type TEXT NOT NULL, shelf_id INTEGER NOT NULL, book_id INTEGER NOT NULL,
    book_hash TEXT NOT NULL, local_path TEXT, managed_by_grimmlink INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (connection_id, shelf_type, shelf_id, book_id)
  )`,
  'CREATE INDEX IF NOT EXISTS shelf_entries_book_hash ON shelf_entries(connection_id, book_hash)',
  'CREATE INDEX IF NOT EXISTS shelf_entries_local_path ON shelf_entries(connection_id, local_path)',
];

const outboxId = (connectionId: string, category: GrimmLinkOutboxCategory, bookHash?: string) =>
  category === 'progress'
    ? `progress:${connectionId}:${bookHash}`
    : `${category}:${crypto.randomUUID()}`;

/** Provider-private SQLite state. It intentionally opens per operation so writes survive abrupt reader teardown. */
export class GrimmLinkSyncStore {
  private static readonly initialized = new WeakMap<object, Promise<void>>();

  constructor(
    private readonly appService: AppService,
    readonly connectionId = 'default',
  ) {}

  private async openInstrumentedDatabase(): Promise<
    Awaited<ReturnType<AppService['openDatabase']>>
  > {
    const database = await this.appService.openDatabase(DB_SCHEMA, DB_PATH, 'Data');
    recordGrimmLinkPerformance('dbOpens');
    return new Proxy(database, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        if (property === 'select') {
          return (...args: unknown[]) => {
            recordGrimmLinkPerformance('dbQueries');
            return Reflect.apply(value, target, args);
          };
        }
        if (property === 'execute') {
          return (...args: unknown[]) => {
            const statement = typeof args[0] === 'string' ? args[0].trimStart() : '';
            const isRead = /^(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(statement);
            recordGrimmLinkPerformance(isRead ? 'dbQueries' : 'dbWrites');
            return Reflect.apply(value, target, args);
          };
        }
        return value.bind(target);
      },
    });
  }

  private async initializeSchema(): Promise<void> {
    await this.appService.createDir('', 'Data', true);
    const db = await this.openInstrumentedDatabase();
    try {
      for (const statement of schema) await db.execute(statement);
      await db
        .execute(
          "ALTER TABLE shelf_subscriptions ADD COLUMN download_policy TEXT NOT NULL DEFAULT 'always'",
        )
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!/duplicate column|already exists/i.test(message)) throw error;
        });
      await db
        .execute('ALTER TABLE outbox ADD COLUMN error_category TEXT')
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!/duplicate column|already exists/i.test(message)) throw error;
        });
      for (const statement of [
        'ALTER TABLE grimmlink_diagnostics ADD COLUMN last_replay_duration_ms INTEGER',
        'ALTER TABLE grimmlink_diagnostics ADD COLUMN last_replay_rows INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE grimmlink_diagnostics ADD COLUMN last_replay_succeeded INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE grimmlink_diagnostics ADD COLUMN last_replay_failed INTEGER NOT NULL DEFAULT 0',
      ]) {
        await db.execute(statement).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!/duplicate column|already exists/i.test(message)) throw error;
        });
      }
      await db.execute(
        'CREATE INDEX IF NOT EXISTS outbox_book_state ON outbox(connection_id, book_hash, state)',
      );
      await db.execute(
        'CREATE INDEX IF NOT EXISTS shelf_entries_book_hash ON shelf_entries(connection_id, book_hash)',
      );
      await db.execute(
        'CREATE INDEX IF NOT EXISTS shelf_entries_local_path ON shelf_entries(connection_id, local_path)',
      );
    } finally {
      await db.close();
    }
  }

  private ensureSchema(): Promise<void> {
    const owner = this.appService as object;
    const existing = GrimmLinkSyncStore.initialized.get(owner);
    if (existing) return existing;
    const initialization = this.initializeSchema().catch((error) => {
      GrimmLinkSyncStore.initialized.delete(owner);
      throw error;
    });
    GrimmLinkSyncStore.initialized.set(owner, initialization);
    return initialization;
  }

  private async withDb<T>(
    fn: (db: Awaited<ReturnType<AppService['openDatabase']>>) => Promise<T>,
  ): Promise<T> {
    await this.ensureSchema();
    await this.appService.createDir('', 'Data', true);
    const db = await this.openInstrumentedDatabase();
    try {
      return await fn(db);
    } finally {
      await db.close();
    }
  }

  private async enqueue(
    category: GrimmLinkOutboxCategory,
    payload: object,
    bookHash?: string,
  ): Promise<void> {
    const now = Date.now();
    const id = outboxId(this.connectionId, category, bookHash);
    const idempotencyKey = `${this.connectionId}:${id}`;
    await this.withDb((db) =>
      db.execute(
        `INSERT INTO outbox (id, connection_id, category, book_hash, payload, idempotency_key, attempts, created_at, updated_at, next_retry_at, state)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'ready')
       ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at, next_retry_at=excluded.next_retry_at, attempts=0, state='ready', error_category=NULL`,
        [
          id,
          this.connectionId,
          category,
          bookHash ?? null,
          JSON.stringify(payload),
          idempotencyKey,
          now,
          now,
          now,
        ],
      ),
    );
  }

  enqueueProgress(bookHash: string, payload: Record<string, unknown>): Promise<void> {
    return this.enqueue('progress', payload, bookHash);
  }

  enqueueSession(payload: GrimmLinkSessionEnvelope): Promise<void> {
    return this.enqueue('sessions', payload, payload.bookHash);
  }

  enqueueStatus(bookHash: string, bookId: number, status: string): Promise<void> {
    return this.enqueue('status', { bookId, status }, bookHash);
  }

  enqueueRating(bookHash: string, payload: Record<string, unknown>): Promise<void> {
    return this.enqueue('metadata', payload, bookHash);
  }

  enqueueMetadata(bookHash: string, payload: Record<string, unknown>): Promise<void> {
    return this.enqueue('metadata', payload, bookHash);
  }

  async saveShelfSubscription(
    shelfType: string,
    shelfId: number,
    enabled: boolean,
    cleanupPolicy = 'keep_local',
    downloadPolicy = 'always',
  ): Promise<void> {
    await this.withDb((db) =>
      db.execute(
        `INSERT INTO shelf_subscriptions (connection_id, shelf_type, shelf_id, enabled, cleanup_policy, download_policy) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, shelf_type, shelf_id) DO UPDATE SET enabled=excluded.enabled, cleanup_policy=excluded.cleanup_policy, download_policy=excluded.download_policy`,
        [this.connectionId, shelfType, shelfId, enabled ? 1 : 0, cleanupPolicy, downloadPolicy],
      ),
    );
  }

  async getShelfSubscriptions(): Promise<
    { shelfType: string; shelfId: number; cleanupPolicy: string; downloadPolicy: string }[]
  > {
    return this.withDb(async (db) =>
      (
        await db.select<{
          shelf_type: string;
          shelf_id: number;
          cleanup_policy: string;
          download_policy: string;
        }>(
          'SELECT shelf_type, shelf_id, cleanup_policy, download_policy FROM shelf_subscriptions WHERE connection_id = ? AND enabled = 1',
          [this.connectionId],
        )
      ).map((row) => ({
        shelfType: row.shelf_type,
        shelfId: row.shelf_id,
        cleanupPolicy: row.cleanup_policy,
        downloadPolicy: row.download_policy || 'always',
      })),
    );
  }

  async getShelfEntries(
    shelfType: string,
    shelfId: number,
  ): Promise<
    { bookId: number; bookHash: string; localPath: string | null; managedByGrimmLink: boolean }[]
  > {
    return this.withDb(async (db) =>
      (
        await db.select<{
          book_id: number;
          book_hash: string;
          local_path: string | null;
          managed_by_grimmlink: number;
        }>(
          'SELECT book_id, book_hash, local_path, managed_by_grimmlink FROM shelf_entries WHERE connection_id = ? AND shelf_type = ? AND shelf_id = ?',
          [this.connectionId, shelfType, shelfId],
        )
      ).map((row) => ({
        bookId: row.book_id,
        bookHash: row.book_hash,
        localPath: row.local_path,
        managedByGrimmLink: !!row.managed_by_grimmlink,
      })),
    );
  }

  /** Finds the Grimmory identity for a locally imported shelf book. */
  async getShelfEntryByLocalPath(
    localPath: string,
  ): Promise<{ bookId: number; bookHash: string } | null> {
    return this.withDb(async (db) => {
      const row = (
        await db.select<{ book_id: number; book_hash: string }>(
          `SELECT book_id, book_hash FROM shelf_entries
         WHERE connection_id = ? AND local_path = ?
         ORDER BY last_seen_at DESC LIMIT 1`,
          [this.connectionId, localPath],
        )
      )[0];
      return row ? { bookId: row.book_id, bookHash: row.book_hash } : null;
    });
  }

  async getManagedShelfReferenceCounts(localPaths: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!localPaths.length) return result;
    await this.withDb(async (db) => {
      for (let start = 0; start < localPaths.length; start += SQLITE_BIND_CHUNK_SIZE) {
        const batch = localPaths.slice(start, start + SQLITE_BIND_CHUNK_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        const rows = await db.select<{ local_path: string; count: number | string }>(
          `SELECT local_path, COUNT(*) AS count FROM shelf_entries
         WHERE connection_id = ? AND managed_by_grimmlink = 1 AND local_path IN (${placeholders})
         GROUP BY local_path`,
          [this.connectionId, ...batch],
        );
        for (const row of rows) result.set(row.local_path, Number(row.count) || 0);
      }
    });
    return result;
  }

  async getManagedShelfEntryReferences(localPath: string): Promise<number> {
    return this.withDb(async (db) => {
      const row = (
        await db.select<{ count: number | string }>(
          `SELECT COUNT(*) AS count FROM shelf_entries
         WHERE connection_id = ? AND local_path = ? AND managed_by_grimmlink = 1`,
          [this.connectionId, localPath],
        )
      )[0];
      return Number(row?.count ?? 0);
    });
  }

  async getAllShelfReferenceCounts(localPaths: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const path of localPaths) result.set(path, 0);
    if (!localPaths.length) return result;
    await this.withDb(async (db) => {
      for (let start = 0; start < localPaths.length; start += SQLITE_BIND_CHUNK_SIZE) {
        const batch = localPaths.slice(start, start + SQLITE_BIND_CHUNK_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        const rows = await db.select<{ local_path: string; count: number | string }>(
          `SELECT local_path, COUNT(*) AS count FROM shelf_entries
         WHERE connection_id = ? AND local_path IN (${placeholders})
         GROUP BY local_path`,
          [this.connectionId, ...batch],
        );
        for (const row of rows) result.set(row.local_path, Number(row.count) || 0);
      }
    });
    return result;
  }

  async getAllShelfEntryReferences(localPath: string): Promise<number> {
    return this.withDb(async (db) => {
      const row = (
        await db.select<{ count: number | string }>(
          `SELECT COUNT(*) AS count FROM shelf_entries
         WHERE connection_id = ? AND local_path = ?`,
          [this.connectionId, localPath],
        )
      )[0];
      return Number(row?.count ?? 0);
    });
  }

  async markShelfEntry(
    shelfType: string,
    shelfId: number,
    bookId: number,
    bookHash: string,
    localPath: string | null,
    managedByGrimmLink: boolean,
  ): Promise<void> {
    await this.markShelfEntries([
      { shelfType, shelfId, bookId, bookHash, localPath, managedByGrimmLink },
    ]);
  }

  async markShelfEntries(
    entries: {
      shelfType: string;
      shelfId: number;
      bookId: number;
      bookHash: string;
      localPath: string | null;
      managedByGrimmLink: boolean;
    }[],
  ): Promise<void> {
    if (!entries.length) return;
    await this.withDb(async (db) => {
      await db.execute('BEGIN');
      try {
        for (const entry of entries) {
          await db.execute(
            `INSERT INTO shelf_entries (connection_id, shelf_type, shelf_id, book_id, book_hash, local_path, managed_by_grimmlink, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, shelf_type, shelf_id, book_id) DO UPDATE SET book_hash=excluded.book_hash, local_path=excluded.local_path, managed_by_grimmlink=excluded.managed_by_grimmlink, last_seen_at=excluded.last_seen_at`,
            [
              this.connectionId,
              entry.shelfType,
              entry.shelfId,
              entry.bookId,
              entry.bookHash,
              entry.localPath,
              entry.managedByGrimmLink ? 1 : 0,
              Date.now(),
            ],
          );
        }
        await db.execute('COMMIT');
      } catch (error) {
        await db.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  async removeShelfEntry(shelfType: string, shelfId: number, bookId: number): Promise<void> {
    await this.removeShelfEntries([{ shelfType, shelfId, bookId }]);
  }

  async removeShelfEntries(
    entries: { shelfType: string; shelfId: number; bookId: number }[],
  ): Promise<void> {
    if (!entries.length) return;
    await this.withDb(async (db) => {
      await db.execute('BEGIN');
      try {
        for (const entry of entries) {
          await db.execute(
            'DELETE FROM shelf_entries WHERE connection_id = ? AND shelf_type = ? AND shelf_id = ? AND book_id = ?',
            [this.connectionId, entry.shelfType, entry.shelfId, entry.bookId],
          );
        }
        await db.execute('COMMIT');
      } catch (error) {
        await db.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  async ready(category: GrimmLinkOutboxCategory, now = Date.now()): Promise<GrimmLinkOutboxRow[]> {
    return this.withDb(async (db) =>
      (
        await db.select<Row>(
          `SELECT id, category, book_hash, payload, idempotency_key, attempts, created_at, next_retry_at, error_category FROM outbox
       WHERE connection_id = ? AND category = ? AND state = 'ready' AND next_retry_at <= ? ORDER BY created_at`,
          [this.connectionId, category, now],
        )
      ).map((row) => ({
        id: row.id,
        category: row.category,
        bookHash: row.book_hash,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        idempotencyKey: row.idempotency_key,
        attempts: row.attempts,
        createdAt: row.created_at,
        nextRetryAt: row.next_retry_at,
        errorCategory: row.error_category,
      })),
    );
  }

  async readyAll(now = Date.now()): Promise<GrimmLinkOutboxRow[]> {
    return this.withDb(async (db) =>
      (
        await db.select<Row>(
          `SELECT id, category, book_hash, payload, idempotency_key, attempts, created_at, next_retry_at, error_category FROM outbox
           WHERE connection_id = ? AND state = 'ready' AND next_retry_at <= ? ORDER BY created_at`,
          [this.connectionId, now],
        )
      ).map((row) => ({
        id: row.id,
        category: row.category,
        bookHash: row.book_hash,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        idempotencyKey: row.idempotency_key,
        attempts: row.attempts,
        createdAt: row.created_at,
        nextRetryAt: row.next_retry_at,
        errorCategory: row.error_category,
      })),
    );
  }

  async all(category: GrimmLinkOutboxCategory): Promise<GrimmLinkOutboxRow[]> {
    return this.withDb(async (db) =>
      (
        await db.select<Row>(
          `SELECT id, category, book_hash, payload, idempotency_key, attempts, created_at, next_retry_at, error_category FROM outbox WHERE connection_id = ? AND category = ? ORDER BY created_at`,
          [this.connectionId, category],
        )
      ).map((row) => ({
        id: row.id,
        category: row.category,
        bookHash: row.book_hash,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        idempotencyKey: row.idempotency_key,
        attempts: row.attempts,
        createdAt: row.created_at,
        nextRetryAt: row.next_retry_at,
        errorCategory: row.error_category,
      })),
    );
  }

  async remove(ids: string[]): Promise<void> {
    if (!ids.length) return Promise.resolve();
    await this.withDb(async (db) => {
      await db.execute('BEGIN');
      try {
        for (let start = 0; start < ids.length; start += SQLITE_BIND_CHUNK_SIZE) {
          const batch = ids.slice(start, start + SQLITE_BIND_CHUNK_SIZE);
          await db.execute(
            `DELETE FROM outbox WHERE connection_id = ? AND id IN (${batch.map(() => '?').join(', ')})`,
            [this.connectionId, ...batch],
          );
        }
        await db.execute('COMMIT');
      } catch (error) {
        await db.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  async retry(id: string, attempts: number, nextRetryAt: number): Promise<void> {
    await this.withDb((db) =>
      db.execute(
        'UPDATE outbox SET attempts = ?, next_retry_at = ?, error_category = NULL WHERE connection_id = ? AND id = ?',
        [attempts, nextRetryAt, this.connectionId, id],
      ),
    );
  }

  async invalidate(
    id: string,
    category: GrimmLinkDiagnosticsErrorCategory = 'invalid-data',
  ): Promise<void> {
    await this.withDb((db) =>
      db.execute(
        "UPDATE outbox SET state = 'invalid', error_category = ? WHERE connection_id = ? AND id = ?",
        [category, this.connectionId, id],
      ),
    );
  }

  async invalidateMany(ids: string[], category: GrimmLinkDiagnosticsErrorCategory): Promise<void> {
    if (!ids.length) return;
    await this.withDb(async (db) => {
      await db.execute('BEGIN');
      try {
        for (let start = 0; start < ids.length; start += SQLITE_BIND_CHUNK_SIZE) {
          const batch = ids.slice(start, start + SQLITE_BIND_CHUNK_SIZE);
          await db.execute(
            `UPDATE outbox SET state = 'invalid', error_category = ? WHERE connection_id = ? AND id IN (${batch.map(() => '?').join(', ')})`,
            [category, this.connectionId, ...batch],
          );
        }
        await db.execute('COMMIT');
      } catch (error) {
        await db.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  async retryMany(rows: { id: string; attempts: number; nextRetryAt: number }[]): Promise<void> {
    if (!rows.length) return;
    await this.withDb(async (db) => {
      await db.execute('BEGIN');
      try {
        for (const row of rows) {
          await db.execute(
            'UPDATE outbox SET attempts = ?, next_retry_at = ?, error_category = NULL WHERE connection_id = ? AND id = ?',
            [row.attempts, row.nextRetryAt, this.connectionId, row.id],
          );
        }
        await db.execute('COMMIT');
      } catch (error) {
        await db.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  async pause(reason: string): Promise<void> {
    await this.withDb((db) =>
      db.execute(
        `INSERT INTO grimmlink_connections (connection_id, paused_at, pause_reason) VALUES (?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET paused_at=excluded.paused_at, pause_reason=excluded.pause_reason`,
        [this.connectionId, Date.now(), reason],
      ),
    );
  }

  async isPaused(): Promise<boolean> {
    return this.withDb(
      async (db) =>
        (
          await db.select<{ paused_at: number | null }>(
            'SELECT paused_at FROM grimmlink_connections WHERE connection_id = ?',
            [this.connectionId],
          )
        )[0]?.paused_at != null,
    );
  }

  async clearPause(): Promise<void> {
    await this.withDb((db) =>
      db.execute(
        'UPDATE grimmlink_connections SET paused_at = NULL, pause_reason = NULL WHERE connection_id = ?',
        [this.connectionId],
      ),
    );
  }

  async getOutboxSummary(): Promise<GrimmLinkOutboxSummary> {
    return this.withDb(async (db) => {
      const rows = await db.select<{
        category: GrimmLinkOutboxCategory;
        state: string;
        count: number;
        next_retry_at: number | null;
      }>(
        `SELECT category, state, COUNT(*) AS count, MIN(next_retry_at) AS next_retry_at
         FROM outbox WHERE connection_id = ? GROUP BY category, state`,
        [this.connectionId],
      );
      const pendingByCategory: Record<GrimmLinkOutboxCategory, number> = {
        progress: 0,
        sessions: 0,
        metadata: 0,
        status: 0,
      };
      let totalPending = 0;
      let invalid = 0;
      let nextRetryAt: number | null = null;
      for (const row of rows) {
        const count = Number(row.count) || 0;
        if (row.state === 'invalid') {
          invalid += count;
        } else if (row.state === 'ready') {
          pendingByCategory[row.category] += count;
          totalPending += count;
          if (row.next_retry_at != null && (nextRetryAt == null || row.next_retry_at < nextRetryAt))
            nextRetryAt = row.next_retry_at;
        }
      }
      return { totalPending, pendingByCategory, invalid, nextRetryAt };
    });
  }

  async retryPending(): Promise<void> {
    await this.withDb((db) =>
      db.execute(
        `UPDATE outbox SET state = 'ready', next_retry_at = ?, updated_at = ?
       WHERE connection_id = ? AND state = 'ready'`,
        [Date.now(), Date.now(), this.connectionId],
      ),
    );
    await this.clearPause();
  }

  async clearInvalid(): Promise<void> {
    await this.withDb((db) =>
      db.execute("DELETE FROM outbox WHERE connection_id = ? AND state = 'invalid'", [
        this.connectionId,
      ]),
    );
  }

  async recordAttempt(): Promise<void> {
    const now = Date.now();
    await this.withDb((db) =>
      db.execute(
        `INSERT INTO grimmlink_diagnostics (connection_id, last_attempt_at) VALUES (?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`,
        [this.connectionId, now],
      ),
    );
  }

  async recordSuccess(): Promise<void> {
    const now = Date.now();
    await this.withDb((db) =>
      db.execute(
        `INSERT INTO grimmlink_diagnostics (connection_id, last_success_at, last_attempt_at, last_error_category, last_error_message, last_error_action, last_error_at, last_error_retryable)
       VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT(connection_id) DO UPDATE SET last_success_at = excluded.last_success_at, last_attempt_at = excluded.last_attempt_at,
       last_error_category = NULL, last_error_message = NULL, last_error_action = NULL, last_error_at = NULL, last_error_retryable = NULL`,
        [this.connectionId, now, now],
      ),
    );
  }

  async recordReplay(result: {
    durationMs: number;
    rows: number;
    succeeded: number;
    failed: number;
  }): Promise<void> {
    await this.withDb((db) =>
      db.execute(
        `INSERT INTO grimmlink_diagnostics (
          connection_id, last_replay_duration_ms, last_replay_rows,
          last_replay_succeeded, last_replay_failed
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          last_replay_duration_ms = excluded.last_replay_duration_ms,
          last_replay_rows = excluded.last_replay_rows,
          last_replay_succeeded = excluded.last_replay_succeeded,
          last_replay_failed = excluded.last_replay_failed`,
        [
          this.connectionId,
          Math.max(0, Math.round(result.durationMs)),
          Math.max(0, Math.round(result.rows)),
          Math.max(0, Math.round(result.succeeded)),
          Math.max(0, Math.round(result.failed)),
        ],
      ),
    );
  }

  async recordError(error: {
    category: GrimmLinkDiagnosticsErrorCategory;
    message: string;
    action: string;
    retryable: boolean;
  }): Promise<void> {
    const now = Date.now();
    const message = error.message
      .replace(/\b(?:https?:\/\/|wss?:\/\/)[^\s]+/gi, '[server]')
      .slice(0, 500);
    await this.withDb((db) =>
      db.execute(
        `INSERT INTO grimmlink_diagnostics (connection_id, last_attempt_at, last_error_category, last_error_message, last_error_action, last_error_at, last_error_retryable)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error_category = excluded.last_error_category,
       last_error_message = excluded.last_error_message, last_error_action = excluded.last_error_action, last_error_at = excluded.last_error_at,
       last_error_retryable = excluded.last_error_retryable`,
        [
          this.connectionId,
          now,
          error.category,
          message,
          error.action.replace(/[^a-z0-9/_-]/gi, '').slice(0, 80),
          now,
          error.retryable ? 1 : 0,
        ],
      ),
    );
  }

  async getDiagnostics(): Promise<GrimmLinkPersistedDiagnostics> {
    return this.withDb(async (db) => {
      const row = (
        await db.select<{
          last_success_at: number | null;
          last_attempt_at: number | null;
          last_replay_duration_ms: number | null;
          last_replay_rows: number | null;
          last_replay_succeeded: number | null;
          last_replay_failed: number | null;
          last_error_category: GrimmLinkDiagnosticsErrorCategory | null;
          last_error_message: string | null;
          last_error_action: string | null;
          last_error_at: number | null;
          last_error_retryable: number | null;
        }>(
          `SELECT last_success_at, last_attempt_at, last_replay_duration_ms, last_replay_rows,
           last_replay_succeeded, last_replay_failed, last_error_category, last_error_message,
           last_error_action, last_error_at, last_error_retryable
         FROM grimmlink_diagnostics WHERE connection_id = ?`,
          [this.connectionId],
        )
      )[0];
      return {
        lastSuccessAt: row?.last_success_at ?? null,
        lastAttemptAt: row?.last_attempt_at ?? null,
        lastReplayDurationMs: row?.last_replay_duration_ms ?? null,
        lastReplayRows: Number(row?.last_replay_rows ?? 0),
        lastReplaySucceeded: Number(row?.last_replay_succeeded ?? 0),
        lastReplayFailed: Number(row?.last_replay_failed ?? 0),
        lastError:
          row?.last_error_category && row.last_error_at != null
            ? {
                category: row.last_error_category,
                message: row.last_error_message ?? 'Sync failed',
                action: row.last_error_action ?? 'sync',
                at: row.last_error_at,
                retryable: row.last_error_retryable === 1,
              }
            : null,
      };
    });
  }

  async getBookStatusSnapshot(
    bookHash: string,
    localPath: string | null,
  ): Promise<GrimmLinkBookStatusSnapshot> {
    return this.withDb(async (db) => {
      const shelfRow = (
        await db.select<{ shelf_count: number | string; managed_download: number | string }>(
          `SELECT COUNT(*) AS shelf_count,
             MAX(CASE WHEN managed_by_grimmlink = 1 AND local_path IS NOT NULL THEN 1 ELSE 0 END) AS managed_download
           FROM shelf_entries WHERE connection_id = ? AND (book_hash = ? OR (? IS NOT NULL AND local_path = ?))`,
          [this.connectionId, bookHash, localPath, localPath],
        )
      )[0];
      const queueRow = (
        await db.select<{
          pending: number | string;
          conflict: number | string;
          error: number | string;
        }>(
          `SELECT
             SUM(CASE WHEN state = 'ready' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN state = 'invalid' AND error_category = 'conflict' THEN 1 ELSE 0 END) AS conflict,
             SUM(CASE WHEN state = 'invalid' AND (error_category = 'invalid-data' OR error_category IS NULL) THEN 1 ELSE 0 END) AS error
           FROM outbox WHERE connection_id = ? AND book_hash = ?`,
          [this.connectionId, bookHash],
        )
      )[0];
      const diagnostic = (
        await db.select<{ last_success_at: number | null }>(
          'SELECT last_success_at FROM grimmlink_diagnostics WHERE connection_id = ?',
          [this.connectionId],
        )
      )[0];
      return {
        shelfCount: Number(shelfRow?.shelf_count ?? 0),
        managedDownload: Number(shelfRow?.managed_download ?? 0) === 1,
        pending: Number(queueRow?.pending ?? 0) > 0,
        conflict: Number(queueRow?.conflict ?? 0) > 0,
        error: Number(queueRow?.error ?? 0) > 0,
        lastSuccessAt: diagnostic?.last_success_at ?? null,
      };
    });
  }

  async getMetadataCursor(bookHash: string, type: string): Promise<string | null> {
    return this.withDb(
      async (db) =>
        (
          await db.select<{ cursor: string }>(
            'SELECT cursor FROM metadata_cursors WHERE connection_id = ? AND book_hash = ? AND type = ?',
            [this.connectionId, bookHash, type],
          )
        )[0]?.cursor ?? null,
    );
  }

  async getNoteMapping(bookHash: string, dedupeKey: string): Promise<string | null> {
    return this.withDb(
      async (db) =>
        (
          await db.select<{ note_id: string }>(
            'SELECT note_id FROM note_mappings WHERE connection_id = ? AND book_hash = ? AND dedupe_key = ?',
            [this.connectionId, bookHash, dedupeKey],
          )
        )[0]?.note_id ?? null,
    );
  }

  async recordUnresolvedMetadata(
    bookHash: string,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.withDb((db) =>
      db.execute(
        `INSERT INTO metadata_unresolved (connection_id, book_hash, dedupe_key, payload, received_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, book_hash, dedupe_key) DO UPDATE SET payload=excluded.payload, received_at=excluded.received_at`,
        [this.connectionId, bookHash, dedupeKey, JSON.stringify(payload), Date.now()],
      ),
    );
  }

  async applyMetadataPage(
    bookHash: string,
    type: string,
    mappings: { noteId: string; dedupeKey: string }[],
    nextCursor: string | null,
  ): Promise<void> {
    await this.withDb(async (db) => {
      await db.execute('BEGIN');
      try {
        for (const mapping of mappings) {
          await db.execute(
            `INSERT INTO note_mappings (connection_id, book_hash, note_id, type, dedupe_key) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(connection_id, book_hash, note_id, type) DO UPDATE SET dedupe_key=excluded.dedupe_key`,
            [this.connectionId, bookHash, mapping.noteId, type, mapping.dedupeKey],
          );
        }
        if (nextCursor)
          await db.execute(
            `INSERT INTO metadata_cursors (connection_id, book_hash, type, cursor) VALUES (?, ?, ?, ?)
           ON CONFLICT(connection_id, book_hash, type) DO UPDATE SET cursor=excluded.cursor`,
            [this.connectionId, bookHash, type, nextCursor],
          );
        await db.execute('COMMIT');
      } catch (error) {
        await db.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  async getRating(
    bookHash: string,
  ): Promise<{ value: number; scale: 5 | 10; updatedAt: number } | null> {
    return this.withDb(async (db) => {
      const row = (
        await db.select<{ value: number; scale: number; updated_at: number }>(
          'SELECT value, scale, updated_at FROM metadata_ratings WHERE connection_id = ? AND book_hash = ?',
          [this.connectionId, bookHash],
        )
      )[0];
      if (!row || (row.scale !== 5 && row.scale !== 10)) return null;
      return { value: row.value, scale: row.scale, updatedAt: row.updated_at };
    });
  }

  async applyRatingPage(
    bookHash: string,
    rating: { value: number; scale: 5 | 10; updatedAt: number } | null,
    nextCursor: string | null,
  ): Promise<void> {
    await this.withDb(async (db) => {
      await db.execute('BEGIN');
      try {
        if (rating) {
          await db.execute(
            `INSERT INTO metadata_ratings (connection_id, book_hash, value, scale, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(connection_id, book_hash) DO UPDATE SET value=excluded.value, scale=excluded.scale, updated_at=excluded.updated_at
             WHERE excluded.updated_at > metadata_ratings.updated_at`,
            [this.connectionId, bookHash, rating.value, rating.scale, rating.updatedAt],
          );
        }
        if (nextCursor) {
          await db.execute(
            `INSERT INTO metadata_cursors (connection_id, book_hash, type, cursor) VALUES (?, ?, 'rating', ?)
             ON CONFLICT(connection_id, book_hash, type) DO UPDATE SET cursor=excluded.cursor`,
            [this.connectionId, bookHash, nextCursor],
          );
        }
        await db.execute('COMMIT');
      } catch (error) {
        await db.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }
}
