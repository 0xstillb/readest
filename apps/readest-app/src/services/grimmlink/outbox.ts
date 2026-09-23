import { GrimmLinkRequestError } from './GrimmLinkRequestError';
import { GrimmLinkSyncStore, type GrimmLinkOutboxRow } from './GrimmLinkSyncStore';

type ReplayClient = {
  updateProgress?(payload: Record<string, unknown>): Promise<unknown>;
  postSessionBatch?(payload: Record<string, unknown>): Promise<unknown>;
  updateReadStatus?(bookId: number, status: string): Promise<unknown>;
  syncMetadata?(payload: Record<string, unknown>): Promise<unknown>;
};

const retryAt = (attempts: number) =>
  Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));

/** Replays each category independently; one failed request never stalls another category. */
export class GrimmLinkOutbox {
  constructor(
    private readonly store: GrimmLinkSyncStore,
    private readonly client: ReplayClient,
  ) {}

  async replay(): Promise<void> {
    if (await this.store.isPaused()) return;
    await this.store.recordAttempt();
    const rows = await this.store.readyAll();
    const byCategory = new Map<GrimmLinkOutboxRow['category'], GrimmLinkOutboxRow[]>();
    for (const row of rows) {
      const categoryRows = byCategory.get(row.category) ?? [];
      categoryRows.push(row);
      byCategory.set(row.category, categoryRows);
    }
    let hadFailure = false;
    for (const category of ['progress', 'sessions', 'metadata', 'status'] as const) {
      const categoryRows = byCategory.get(category) ?? [];
      const successfulIds: string[] = [];
      if (category === 'sessions') {
        const categoryFailed = await this.replaySessions(categoryRows, successfulIds);
        hadFailure = hadFailure || categoryFailed;
      } else {
        for (const row of categoryRows) {
          const rowFailed = await this.replayRow(row, successfulIds);
          hadFailure = hadFailure || rowFailed;
        }
      }
      await this.store.remove(successfulIds);
      if (await this.store.isPaused()) break;
    }
    if (!hadFailure) await this.store.recordSuccess();
  }

  private async replaySessions(rows: GrimmLinkOutboxRow[], successfulIds: string[]): Promise<boolean> {
    let hadFailure = false;
    const byBook = new Map<string, GrimmLinkOutboxRow[]>();
    for (const row of rows) {
      const key = `${row.payload['bookId']}\u0000${row.payload['bookHash']}`;
      byBook.set(key, [...(byBook.get(key) ?? []), row]);
    }
    for (const rowsForBook of byBook.values()) {
      for (let start = 0; start < rowsForBook.length; start += 500) {
        const batch = rowsForBook.slice(start, start + 500);
        if (!batch.length || !this.client.postSessionBatch) continue;
        const first = batch[0]!.payload;
        const payload = {
          bookId: first['bookId'],
          bookHash: first['bookHash'],
          bookType: first['bookType'],
          device: first['device'],
          deviceId: first['deviceId'],
          sessions: batch.map((row) => row.payload['session']),
        };
        try {
          await this.client.postSessionBatch(payload);
          successfulIds.push(...batch.map((row) => row.id));
        } catch (error) {
          hadFailure = true;
          await this.handleFailure(batch, error);
        }
      }
    }
    return hadFailure;
  }

  private async replayRow(row: GrimmLinkOutboxRow, successfulIds: string[]): Promise<boolean> {
    try {
      if (row.category === 'progress') {
        if (!this.client.updateProgress) return false;
        await this.client.updateProgress(row.payload);
      }
      if (row.category === 'status') {
        if (!this.client.updateReadStatus) return false;
        await this.client.updateReadStatus(
          Number(row.payload['bookId']),
          String(row.payload['status']),
        );
      }
      if (row.category === 'metadata') {
        if (!this.client.syncMetadata) return false;
        await this.client.syncMetadata(row.payload);
      }
      successfulIds.push(row.id);
      return false;
    } catch (error) {
      await this.handleFailure([row], error);
      return true;
    }
  }

  private async handleFailure(rows: GrimmLinkOutboxRow[], error: unknown): Promise<void> {
    const requestError =
      error instanceof GrimmLinkRequestError
        ? error
        : new GrimmLinkRequestError('transport', 'Connection error.');
    if (requestError.category === 'auth') {
      await this.store.pause(requestError.message);
      await this.store.recordError({
        category: requestError.category,
        message: requestError.message,
        action: rows[0]?.category ?? 'sync',
        retryable: false,
      });
      return;
    }
    await this.store.recordError({
      category: requestError.category,
      message: requestError.message,
      action: rows[0]?.category ?? 'sync',
      retryable: requestError.category === 'network' || requestError.category === 'server',
    });
    if (requestError.category === 'invalid-data' || requestError.category === 'conflict') {
      await this.store.invalidateMany(
        rows.map((row) => row.id),
        requestError.category,
      );
    } else {
      await this.store.retryMany(
        rows.map((row) => ({
          id: row.id,
          attempts: row.attempts + 1,
          nextRetryAt: retryAt(row.attempts + 1),
        })),
      );
    }
  }
}
