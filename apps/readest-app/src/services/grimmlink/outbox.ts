import { GrimmLinkRequestError } from './GrimmLinkRequestError';
import { GrimmLinkSyncStore, type GrimmLinkOutboxRow } from './GrimmLinkSyncStore';

type ReplayClient = {
  updateProgress?(payload: Record<string, unknown>): Promise<unknown>;
  postSessionBatch?(payload: Record<string, unknown>): Promise<unknown>;
  updateReadStatus?(bookId: number, status: string): Promise<unknown>;
  syncMetadata?(payload: Record<string, unknown>): Promise<unknown>;
  removeShelfMembership?(shelfType: 'regular' | 'magic', shelfId: number, bookId: number): Promise<unknown>;
};

const retryAt = (attempts: number) => Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));

/** Replays each category independently; one failed request never stalls another category. */
export class GrimmLinkOutbox {
  constructor(private readonly store: GrimmLinkSyncStore, private readonly client: ReplayClient) {}

  async replay(): Promise<void> {
    if (await this.store.isPaused()) return;
    for (const category of ['progress', 'sessions', 'metadata', 'status', 'shelf-removal'] as const) {
      const rows = await this.store.ready(category);
      if (category === 'sessions') await this.replaySessions(rows);
      else for (const row of rows) await this.replayRow(row);
      if (await this.store.isPaused()) return;
    }
  }

  private async replaySessions(rows: GrimmLinkOutboxRow[]): Promise<void> {
    const byBook = new Map<string, GrimmLinkOutboxRow[]>();
    for (const row of rows) {
      const key = `${row.payload['bookId']}\u0000${row.payload['bookHash']}`;
      byBook.set(key, [...(byBook.get(key) ?? []), row]);
    }
    for (const rowsForBook of byBook.values()) {
      for (let start = 0; start < rowsForBook.length; start += 500) {
        const batch = rowsForBook.slice(start, start + 500);
        if (!batch.length || !this.client.postSessionBatch) return;
        const first = batch[0]!.payload;
        const payload = {
          bookId: first['bookId'], bookHash: first['bookHash'], bookType: first['bookType'],
          device: first['device'], deviceId: first['deviceId'],
          sessions: batch.map((row) => row.payload['session']),
        };
        try {
          await this.client.postSessionBatch(payload);
          await this.store.remove(batch.map((row) => row.id));
        } catch (error) {
          await this.handleFailure(batch, error);
        }
      }
    }
  }

  private async replayRow(row: GrimmLinkOutboxRow): Promise<void> {
    try {
      if (row.category === 'progress') {
        if (!this.client.updateProgress) return;
        await this.client.updateProgress(row.payload);
      }
      if (row.category === 'status') {
        if (!this.client.updateReadStatus) return;
        await this.client.updateReadStatus(Number(row.payload['bookId']), String(row.payload['status']));
      }
      if (row.category === 'metadata') {
        if (!this.client.syncMetadata) return;
        await this.client.syncMetadata(row.payload);
      }
      if (row.category === 'shelf-removal') {
        if (!this.client.removeShelfMembership) return;
        const type = row.payload['shelfType'];
        if ((type !== 'regular' && type !== 'magic') || !Number.isFinite(row.payload['shelfId']) || !Number.isFinite(row.payload['bookId'])) {
          throw new GrimmLinkRequestError('validation', 'Invalid GrimmLink shelf removal');
        }
        await this.client.removeShelfMembership(type, Number(row.payload['shelfId']), Number(row.payload['bookId']));
      }
      await this.store.remove([row.id]);
    } catch (error) {
      await this.handleFailure([row], error);
    }
  }

  private async handleFailure(rows: GrimmLinkOutboxRow[], error: unknown): Promise<void> {
    const requestError = error instanceof GrimmLinkRequestError ? error : new GrimmLinkRequestError('transport', 'Connection error.');
    if (requestError.kind === 'authentication') {
      await this.store.pause(requestError.message);
      return;
    }
    for (const row of rows) {
      if (requestError.kind === 'validation' || requestError.kind === 'conflict') await this.store.invalidate(row.id);
      else await this.store.retry(row.id, row.attempts + 1, retryAt(row.attempts + 1));
    }
  }
}
