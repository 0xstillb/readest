import type { AppService } from '@/types/system';
import type { GrimmLinkSessionEnvelope } from './sessions';

export type GrimmLinkOutboxCategory = 'progress' | 'sessions' | 'metadata' | 'status' | 'shelf-removal';

export interface GrimmLinkOutboxRow {
  id: string;
  category: GrimmLinkOutboxCategory;
  bookHash: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  attempts: number;
  createdAt: number;
  nextRetryAt: number;
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
};

const DB_SCHEMA = 'grimmlink-sync';
const DB_PATH = 'grimmlink-sync.db';
const schema = [
  `CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, category TEXT NOT NULL, book_hash TEXT,
    payload TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_retry_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'ready'
  )`,
  'CREATE INDEX IF NOT EXISTS outbox_ready ON outbox(connection_id, category, state, next_retry_at)',
  `CREATE TABLE IF NOT EXISTS grimmlink_connections (
    connection_id TEXT PRIMARY KEY, paused_at INTEGER, pause_reason TEXT
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
    cleanup_policy TEXT NOT NULL DEFAULT 'keep_local', PRIMARY KEY (connection_id, shelf_type, shelf_id)
  )`,
  `CREATE TABLE IF NOT EXISTS shelf_entries (
    connection_id TEXT NOT NULL, shelf_type TEXT NOT NULL, shelf_id INTEGER NOT NULL, book_id INTEGER NOT NULL,
    book_hash TEXT NOT NULL, local_path TEXT, managed_by_grimmlink INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (connection_id, shelf_type, shelf_id, book_id)
  )`,
];

const outboxId = (connectionId: string, category: GrimmLinkOutboxCategory, bookHash?: string) =>
  category === 'progress' ? `progress:${connectionId}:${bookHash}` : `${category}:${crypto.randomUUID()}`;

/** Provider-private SQLite state. It intentionally opens per operation so writes survive abrupt reader teardown. */
export class GrimmLinkSyncStore {
  constructor(private readonly appService: AppService, readonly connectionId = 'default') {}

  private async withDb<T>(fn: (db: Awaited<ReturnType<AppService['openDatabase']>>) => Promise<T>): Promise<T> {
    await this.appService.createDir('', 'Data', true);
    const db = await this.appService.openDatabase(DB_SCHEMA, DB_PATH, 'Data');
    try {
      for (const statement of schema) await db.execute(statement);
      return await fn(db);
    } finally {
      await db.close();
    }
  }

  private async enqueue(category: GrimmLinkOutboxCategory, payload: object, bookHash?: string): Promise<void> {
    const now = Date.now();
    const id = outboxId(this.connectionId, category, bookHash);
    const idempotencyKey = `${this.connectionId}:${id}`;
    await this.withDb((db) => db.execute(
      `INSERT INTO outbox (id, connection_id, category, book_hash, payload, idempotency_key, attempts, created_at, updated_at, next_retry_at, state)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'ready')
       ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at, next_retry_at=excluded.next_retry_at, attempts=0, state='ready'`,
      [id, this.connectionId, category, bookHash ?? null, JSON.stringify(payload), idempotencyKey, now, now, now],
    ));
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

  enqueueShelfRemoval(shelfType: string, shelfId: number, bookId: number): Promise<void> {
    return this.enqueue('shelf-removal', { shelfType, shelfId, bookId });
  }

  async saveShelfSubscription(shelfType: string, shelfId: number, enabled: boolean, cleanupPolicy = 'keep_local'): Promise<void> {
    await this.withDb((db) => db.execute(
      `INSERT INTO shelf_subscriptions (connection_id, shelf_type, shelf_id, enabled, cleanup_policy) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, shelf_type, shelf_id) DO UPDATE SET enabled=excluded.enabled, cleanup_policy=excluded.cleanup_policy`,
      [this.connectionId, shelfType, shelfId, enabled ? 1 : 0, cleanupPolicy],
    ));
  }

  async getShelfSubscriptions(): Promise<{ shelfType: string; shelfId: number; cleanupPolicy: string }[]> {
    return this.withDb(async (db) => (await db.select<{ shelf_type: string; shelf_id: number; cleanup_policy: string }>(
      'SELECT shelf_type, shelf_id, cleanup_policy FROM shelf_subscriptions WHERE connection_id = ? AND enabled = 1', [this.connectionId],
    )).map((row) => ({ shelfType: row.shelf_type, shelfId: row.shelf_id, cleanupPolicy: row.cleanup_policy })));
  }

  async getShelfEntries(shelfType: string, shelfId: number): Promise<{ bookId: number; bookHash: string; localPath: string | null; managedByGrimmLink: boolean }[]> {
    return this.withDb(async (db) => (await db.select<{ book_id: number; book_hash: string; local_path: string | null; managed_by_grimmlink: number }>(
      'SELECT book_id, book_hash, local_path, managed_by_grimmlink FROM shelf_entries WHERE connection_id = ? AND shelf_type = ? AND shelf_id = ?',
      [this.connectionId, shelfType, shelfId],
    )).map((row) => ({ bookId: row.book_id, bookHash: row.book_hash, localPath: row.local_path, managedByGrimmLink: !!row.managed_by_grimmlink })));
  }

  async markShelfEntry(shelfType: string, shelfId: number, bookId: number, bookHash: string, localPath: string | null, managedByGrimmLink: boolean): Promise<void> {
    await this.withDb((db) => db.execute(
      `INSERT INTO shelf_entries (connection_id, shelf_type, shelf_id, book_id, book_hash, local_path, managed_by_grimmlink, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, shelf_type, shelf_id, book_id) DO UPDATE SET book_hash=excluded.book_hash, local_path=excluded.local_path, managed_by_grimmlink=excluded.managed_by_grimmlink, last_seen_at=excluded.last_seen_at`,
      [this.connectionId, shelfType, shelfId, bookId, bookHash, localPath, managedByGrimmLink ? 1 : 0, Date.now()],
    ));
  }

  async removeShelfEntry(shelfType: string, shelfId: number, bookId: number): Promise<void> {
    await this.withDb((db) => db.execute(
      'DELETE FROM shelf_entries WHERE connection_id = ? AND shelf_type = ? AND shelf_id = ? AND book_id = ?',
      [this.connectionId, shelfType, shelfId, bookId],
    ));
  }

  async ready(category: GrimmLinkOutboxCategory, now = Date.now()): Promise<GrimmLinkOutboxRow[]> {
    return this.withDb(async (db) => (await db.select<Row>(
      `SELECT id, category, book_hash, payload, idempotency_key, attempts, created_at, next_retry_at FROM outbox
       WHERE connection_id = ? AND category = ? AND state = 'ready' AND next_retry_at <= ? ORDER BY created_at`,
      [this.connectionId, category, now],
    )).map((row) => ({
      id: row.id, category: row.category, bookHash: row.book_hash,
      payload: JSON.parse(row.payload) as Record<string, unknown>, idempotencyKey: row.idempotency_key,
      attempts: row.attempts, createdAt: row.created_at, nextRetryAt: row.next_retry_at,
    })));
  }

  async all(category: GrimmLinkOutboxCategory): Promise<GrimmLinkOutboxRow[]> {
    return this.withDb(async (db) => (await db.select<Row>(
      `SELECT id, category, book_hash, payload, idempotency_key, attempts, created_at, next_retry_at FROM outbox WHERE connection_id = ? AND category = ? ORDER BY created_at`,
      [this.connectionId, category],
    )).map((row) => ({ id: row.id, category: row.category, bookHash: row.book_hash, payload: JSON.parse(row.payload) as Record<string, unknown>, idempotencyKey: row.idempotency_key, attempts: row.attempts, createdAt: row.created_at, nextRetryAt: row.next_retry_at })));
  }

  async remove(ids: string[]): Promise<void> {
    if (!ids.length) return Promise.resolve();
    await this.withDb((db) => db.execute(`DELETE FROM outbox WHERE connection_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, [this.connectionId, ...ids]));
  }

  async retry(id: string, attempts: number, nextRetryAt: number): Promise<void> {
    await this.withDb((db) => db.execute('UPDATE outbox SET attempts = ?, next_retry_at = ? WHERE connection_id = ? AND id = ?', [attempts, nextRetryAt, this.connectionId, id]));
  }

  async invalidate(id: string): Promise<void> {
    await this.withDb((db) => db.execute("UPDATE outbox SET state = 'invalid' WHERE connection_id = ? AND id = ?", [this.connectionId, id]));
  }

  async pause(reason: string): Promise<void> {
    await this.withDb((db) => db.execute(
      `INSERT INTO grimmlink_connections (connection_id, paused_at, pause_reason) VALUES (?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET paused_at=excluded.paused_at, pause_reason=excluded.pause_reason`,
      [this.connectionId, Date.now(), reason],
    ));
  }

  async isPaused(): Promise<boolean> {
    return this.withDb(async (db) => (await db.select<{ paused_at: number | null }>('SELECT paused_at FROM grimmlink_connections WHERE connection_id = ?', [this.connectionId]))[0]?.paused_at != null);
  }

  async getMetadataCursor(bookHash: string, type: string): Promise<string | null> {
    return this.withDb(async (db) => (await db.select<{ cursor: string }>(
      'SELECT cursor FROM metadata_cursors WHERE connection_id = ? AND book_hash = ? AND type = ?',
      [this.connectionId, bookHash, type],
    ))[0]?.cursor ?? null);
  }

  async getNoteMapping(bookHash: string, dedupeKey: string): Promise<string | null> {
    return this.withDb(async (db) => (await db.select<{ note_id: string }>(
      'SELECT note_id FROM note_mappings WHERE connection_id = ? AND book_hash = ? AND dedupe_key = ?',
      [this.connectionId, bookHash, dedupeKey],
    ))[0]?.note_id ?? null);
  }

  async recordUnresolvedMetadata(bookHash: string, dedupeKey: string, payload: Record<string, unknown>): Promise<void> {
    await this.withDb((db) => db.execute(
      `INSERT INTO metadata_unresolved (connection_id, book_hash, dedupe_key, payload, received_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, book_hash, dedupe_key) DO UPDATE SET payload=excluded.payload, received_at=excluded.received_at`,
      [this.connectionId, bookHash, dedupeKey, JSON.stringify(payload), Date.now()],
    ));
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
        if (nextCursor) await db.execute(
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

  async getRating(bookHash: string): Promise<{ value: number; scale: 5 | 10; updatedAt: number } | null> {
    return this.withDb(async (db) => {
      const row = (await db.select<{ value: number; scale: number; updated_at: number }>(
        'SELECT value, scale, updated_at FROM metadata_ratings WHERE connection_id = ? AND book_hash = ?',
        [this.connectionId, bookHash],
      ))[0];
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
