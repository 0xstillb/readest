import type { AppService } from '@/types/system';
import type { GrimmLinkBookLink } from './types';

type BookLinkRow = {
  book_hash: string;
  book_id: number | null;
  book_file_id: number | null;
  format: string | null;
  unmatched_at: number | null;
};

export type GrimmLinkCachedBookLink = GrimmLinkBookLink | { bookHash: string; unmatchedAt: number };

const DB_SCHEMA = 'grimmlink-sync';
const DB_PATH = 'grimmlink-sync.db';

/** Device-local hash-to-Grimmory identity cache. */
export class GrimmLinkBookLinkStore {
  constructor(private readonly appService: AppService, private readonly connectionId = 'default') {}

  private async withDb<T>(fn: (db: Awaited<ReturnType<AppService['openDatabase']>>) => Promise<T>) {
    const db = await this.appService.openDatabase(DB_SCHEMA, DB_PATH, 'Data');
    try {
      await db.execute(`CREATE TABLE IF NOT EXISTS book_links (
        connection_id TEXT NOT NULL, book_hash TEXT NOT NULL, book_id INTEGER, book_file_id INTEGER, format TEXT, unmatched_at INTEGER,
        PRIMARY KEY (connection_id, book_hash)
      )`);
      return await fn(db);
    } finally {
      await db.close();
    }
  }

  async get(bookHash: string): Promise<GrimmLinkCachedBookLink | null> {
    return this.withDb(async (db) => {
      const row = (await db.select<BookLinkRow>(
        'SELECT book_hash, book_id, book_file_id, format, unmatched_at FROM book_links WHERE connection_id = ? AND book_hash = ?',
        [this.connectionId, bookHash],
      ))[0];
      if (!row) return null;
      if (row.unmatched_at) return { bookHash: row.book_hash, unmatchedAt: row.unmatched_at };
      if (row.book_id == null) return null;
      return {
        bookHash: row.book_hash,
        bookId: row.book_id,
        bookFileId: row.book_file_id ?? undefined,
        format: row.format ?? undefined,
      };
    });
  }

  async set(link: GrimmLinkBookLink): Promise<void> {
    await this.withDb((db) => db.execute(
      `INSERT INTO book_links (connection_id, book_hash, book_id, book_file_id, format, unmatched_at) VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(connection_id, book_hash) DO UPDATE SET book_id=excluded.book_id, book_file_id=excluded.book_file_id, format=excluded.format, unmatched_at=NULL`,
      [this.connectionId, link.bookHash, link.bookId, link.bookFileId ?? null, link.format ?? null],
    ));
  }

  async markUnmatched(bookHash: string): Promise<void> {
    await this.withDb((db) => db.execute(
      `INSERT INTO book_links (connection_id, book_hash, book_id, book_file_id, format, unmatched_at) VALUES (?, ?, NULL, NULL, NULL, ?)
       ON CONFLICT(connection_id, book_hash) DO UPDATE SET book_id=NULL, book_file_id=NULL, format=NULL, unmatched_at=excluded.unmatched_at`,
      [this.connectionId, bookHash, Date.now()],
    ));
  }
}
