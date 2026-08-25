import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Book } from '@/types/book';
import { NodeAppService } from '@/services/nodeAppService';
import { GrimmLinkRequestError } from '@/services/grimmlink/GrimmLinkRequestError';
import { GrimmLinkSyncStore } from '@/services/grimmlink/GrimmLinkSyncStore';
import { GrimmLinkOutbox } from '@/services/grimmlink/outbox';
import { mapReadStatus, mergeRemoteReadStatus } from '@/services/grimmlink/status';
import { fromGrimmLinkRating, toGrimmLinkRating } from '@/services/grimmlink/metadata';
import { GrimmLinkReadStatusProvider, queueExplicitGrimmLinkReadStatus } from '@/services/grimmlink/readStatus';
import { GrimmLinkRatingProvider } from '@/services/grimmlink/rating';

const SANDBOX_DIR = path.join(process.cwd(), '.test-sandbox-grimmlink');

describe('GrimmLink durable outbox', () => {
  let root: string;
  let service: NodeAppService;

  beforeEach(async () => {
    await fsp.mkdir(SANDBOX_DIR, { recursive: true });
    root = await fsp.mkdtemp(path.join(SANDBOX_DIR, 'outbox-'));
    service = new NodeAppService(root);
    await service.init();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('coalesces progress and survives a kill/restart before replaying it exactly once', async () => {
    const firstProcess = new GrimmLinkSyncStore(service, 'connection-a');
    await firstProcess.enqueueProgress('book-a', { percentage: 10 });
    await firstProcess.enqueueProgress('book-a', { percentage: 80 });

    // Simulate a process kill: discard the first store without draining its durable SQLite row.
    const restartedProcess = new GrimmLinkSyncStore(service, 'connection-a');
    const client = { updateProgress: vi.fn().mockResolvedValue({ ok: true }) };
    await new GrimmLinkOutbox(restartedProcess, client).replay();
    await new GrimmLinkOutbox(restartedProcess, client).replay();

    expect(client.updateProgress).toHaveBeenCalledTimes(1);
    expect(client.updateProgress).toHaveBeenCalledWith({ percentage: 80 });
    await expect(restartedProcess.ready('progress')).resolves.toEqual([]);
  });

  it('backs off a failed category without blocking a different ready category', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueProgress('book-a', { percentage: 10 });
    await store.enqueueStatus('book-b', 7, 'reading');
    const client = {
      updateProgress: vi.fn().mockRejectedValue(new GrimmLinkRequestError('server', 'down', 503)),
      updateReadStatus: vi.fn().mockResolvedValue({ ok: true }),
    };

    await new GrimmLinkOutbox(store, client).replay();

    expect(client.updateReadStatus).toHaveBeenCalledWith(7, 'reading');
    expect(await store.ready('status')).toEqual([]);
    expect(await store.ready('progress')).toEqual([]);
    expect((await store.all('progress'))[0]).toMatchObject({ attempts: 1 });
  });

  it('pauses only the affected connection after an authentication failure', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueProgress('book-a', { percentage: 10 });
    const client = { updateProgress: vi.fn().mockRejectedValue(new GrimmLinkRequestError('authentication', 'nope', 401)) };

    await new GrimmLinkOutbox(store, client).replay();

    expect(await store.isPaused()).toBe(true);
    expect((await store.all('progress'))).toHaveLength(1);
  });

  it('uploads valid collected sessions in batches without waiting for the lifecycle caller', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueSession({
      bookId: 4, bookHash: 'book-a', bookType: 'EPUB', device: 'Readest Test', deviceId: 'd1',
      session: { startTime: '2026-08-23T00:00:00.000Z', endTime: '2026-08-23T00:00:11.000Z', durationSeconds: 11, startProgress: 0.1, endProgress: 0.2, progressDelta: 0.1 },
    });
    const client = { postSessionBatch: vi.fn().mockResolvedValue({ ok: true }) };

    await new GrimmLinkOutbox(store, client).replay();

    expect(client.postSessionBatch).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 4, bookHash: 'book-a', sessions: [expect.objectContaining({ durationSeconds: 11 })],
    }));
  });

  it('retains metadata when no replay handler is available', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueRating('book-a', { rating: { value: 8, scale: 10 } });

    await new GrimmLinkOutbox(store, {}).replay();

    await expect(store.all('metadata')).resolves.toHaveLength(1);
  });
});

describe('GrimmLink status and rating contract', () => {
  it('maps only supported read statuses and keeps a newer explicit local status', () => {
    expect(mapReadStatus('finished', ['unread', 'reading'])).toBeNull();
    expect(mapReadStatus('finished', ['finished'])).toBe('finished');
    expect(mapReadStatus('finished', ['READ', 'READING'])).toBe('READ');
    expect(mergeRemoteReadStatus(
      { readingStatus: 'finished', readingStatusUpdatedAt: 200 },
      { status: 'reading', updatedAt: '1970-01-01T00:00:00.100Z' },
      ['reading'],
    )).toEqual({ readingStatus: 'finished', readingStatusUpdatedAt: 200 });
  });

  it('converts rating scales and preserves newer local ratings on pull', () => {
    expect(toGrimmLinkRating({ value: 4, scale: 5, updatedAt: 200 }, 'connection-a', 'book-a')).toMatchObject({ value: 8, scale: 10 });
    expect(fromGrimmLinkRating(
      { value: 6, scale: 10, updatedAt: '1970-01-01T00:00:00.100Z' },
      { value: 5, scale: 5, updatedAt: 200 },
    )).toEqual({ value: 5, scale: 5, updatedAt: 200 });
  });

  it('does not queue unsupported status or metadata writes', async () => {
    const root = await fsp.mkdtemp(path.join(SANDBOX_DIR, 'capabilities-'));
    try {
      const service = new NodeAppService(root);
      await service.init();
      const store = new GrimmLinkSyncStore(service, 'connection-a');
      const statuses = new GrimmLinkReadStatusProvider({ getReadStatuses: vi.fn() }, store, []);
      const ratings = new GrimmLinkRatingProvider(
        { getMetadata: vi.fn() }, store,
        { capabilities: [], device: 'Readest Test', deviceId: 'device-1' },
      );

      await expect(statuses.queueExplicit('book-a', 4, 'reading')).resolves.toBe(false);
      await expect(ratings.queuePush('book-a', 4, { value: 4, scale: 5, updatedAt: 100 })).resolves.toBe(false);
      await expect(store.all('status')).resolves.toEqual([]);
      await expect(store.all('metadata')).resolves.toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('uses a persisted shelf mapping when syncing an explicit local reading status', async () => {
    const root = await fsp.mkdtemp(path.join(SANDBOX_DIR, 'shelf-status-'));
    try {
      const service = new NodeAppService(root);
      await service.init();
      const store = new GrimmLinkSyncStore(service, 'connection-a');
      const book = { hash: 'readest-hash', title: 'Shelf title', author: 'Author', format: 'EPUB' } as Book;
      await store.markShelfEntry('regular', 7, 42, 'grimory-hash', 'readest-hash/Shelf title.epub', true);
      const client = {
        getCapabilities: vi.fn().mockResolvedValue({ capabilities: ['read-status'] }),
        getReadStatuses: vi.fn().mockResolvedValue({ statuses: ['finished'] }),
        matchBook: vi.fn().mockResolvedValue(null),
        updateReadStatus: vi.fn().mockResolvedValue({ ok: true }),
      };

      await expect(queueExplicitGrimmLinkReadStatus(
        book,
        'finished',
        { enabled: true, syncReadStatus: true, strategy: 'prompt' },
        store,
        client,
      )).resolves.toBe(true);

      await vi.waitFor(() => expect(client.updateReadStatus).toHaveBeenCalledWith(42, 'finished'));
      expect(client.matchBook).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('includes device identity in the documented rating envelope', async () => {
    await fsp.mkdir(SANDBOX_DIR, { recursive: true });
    const root = await fsp.mkdtemp(path.join(SANDBOX_DIR, 'rating-push-'));
    try {
      const service = new NodeAppService(root);
      await service.init();
      const store = new GrimmLinkSyncStore(service, 'connection-a');
      const ratings = new GrimmLinkRatingProvider(
        { getMetadata: vi.fn() }, store,
        { capabilities: ['metadata'], device: 'Readest Windows', deviceId: 'device-1' },
      );

      await ratings.queuePush('book-a', 4, { value: 4, scale: 5, updatedAt: 100 });

      expect((await store.all('metadata'))[0]?.payload).toMatchObject({
        device: 'Readest Windows', deviceId: 'device-1',
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('paginates rating pulls, selects the newest valid item, and persists its cursor', async () => {
    await fsp.mkdir(SANDBOX_DIR, { recursive: true });
    const root = await fsp.mkdtemp(path.join(SANDBOX_DIR, 'rating-pull-'));
    try {
      const service = new NodeAppService(root);
      await service.init();
      const store = new GrimmLinkSyncStore(service, 'connection-a');
      const getMetadata = vi.fn()
        .mockResolvedValueOnce({
          items: [{ type: 'rating', payload: { value: 4, scale: 10, updatedAt: '2026-08-23T00:00:01.000Z' } }],
          nextCursor: 'page-2',
        })
        .mockResolvedValueOnce({
          items: [{ type: 'rating', payload: { value: 8, scale: 10, updatedAt: '2026-08-23T00:00:02.000Z' } }],
          nextCursor: 'done',
        })
        .mockResolvedValueOnce({ items: [], nextCursor: null });
      const ratings = new GrimmLinkRatingProvider(
        { getMetadata }, store,
        { capabilities: ['metadata'], device: 'Readest Test', deviceId: 'device-1' },
      );

      await expect(ratings.pull('book-a', null)).resolves.toMatchObject({ value: 4, scale: 5 });
      await expect(store.getMetadataCursor('book-a', 'rating')).resolves.toBe('done');
      expect(getMetadata.mock.calls.map(([query]) => query)).toEqual([
        { bookHash: 'book-a', type: 'rating', limit: 500 },
        { bookHash: 'book-a', type: 'rating', limit: 500, cursor: 'page-2' },
        { bookHash: 'book-a', type: 'rating', limit: 500, cursor: 'done' },
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid remote rating values without advancing the cursor', async () => {
    await fsp.mkdir(SANDBOX_DIR, { recursive: true });
    const root = await fsp.mkdtemp(path.join(SANDBOX_DIR, 'rating-invalid-'));
    try {
      const service = new NodeAppService(root);
      await service.init();
      const store = new GrimmLinkSyncStore(service, 'connection-a');
      const ratings = new GrimmLinkRatingProvider(
        { getMetadata: vi.fn().mockResolvedValue({
          items: [{ type: 'rating', payload: { value: 12, scale: 10, updatedAt: '2026-08-23T00:00:02.000Z' } }],
          nextCursor: 'bad',
        }) },
        store,
        { capabilities: ['metadata'], device: 'Readest Test', deviceId: 'device-1' },
      );

      await expect(ratings.pull('book-a', null)).rejects.toThrow('Invalid GrimmLink rating');
      await expect(store.getMetadataCursor('book-a', 'rating')).resolves.toBeNull();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
