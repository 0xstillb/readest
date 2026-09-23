import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Book } from '@/types/book';
import { NodeAppService } from '@/services/nodeAppService';
import { GrimmLinkRequestError } from '@/services/grimmlink/GrimmLinkRequestError';
import { GrimmLinkSyncStore } from '@/services/grimmlink/GrimmLinkSyncStore';
import { GrimmLinkOutbox } from '@/services/grimmlink/outbox';
import { GrimmLinkReplayScheduler } from '@/services/grimmlink/replayScheduler';
import {
  fromGrimmoryReadStatus,
  mapReadStatus,
  mergeRemoteReadStatus,
} from '@/services/grimmlink/status';
import { fromGrimmLinkRating, toGrimmLinkRating } from '@/services/grimmlink/metadata';
import {
  GrimmLinkReadStatusProvider,
  queueExplicitGrimmLinkReadStatus,
} from '@/services/grimmlink/readStatus';
import { GrimmLinkRatingProvider } from '@/services/grimmlink/rating';
import { GrimmLinkSessionTracker } from '@/services/grimmlink/sessions';

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

  it('retries schema initialization after a temporary database failure without losing queued rows', async () => {
    const firstProcess = new GrimmLinkSyncStore(service, 'connection-a');
    await firstProcess.enqueueProgress('book-a', { percentage: 64 });

    const restartedService = new NodeAppService(root);
    await restartedService.init();
    const openDatabase = restartedService.openDatabase.bind(restartedService);
    let failNextOpen = true;
    restartedService.openDatabase = async (...args) => {
      if (failNextOpen) {
        failNextOpen = false;
        throw new Error('simulated temporary database unavailability');
      }
      return await openDatabase(...args);
    };
    const restartedProcess = new GrimmLinkSyncStore(restartedService, 'connection-a');

    await expect(restartedProcess.enqueueProgress('book-b', { percentage: 20 })).rejects.toThrow(
      'simulated temporary database unavailability',
    );
    await restartedProcess.enqueueProgress('book-b', { percentage: 20 });

    await expect(restartedProcess.ready('progress')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bookHash: 'book-a', payload: { percentage: 64 } }),
        expect.objectContaining({ bookHash: 'book-b', payload: { percentage: 20 } }),
      ]),
    );
  });

  it('surfaces a failed outbox write and preserves existing rows for a safe retry', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueProgress('book-a', { percentage: 64 });
    const openDatabase = service.openDatabase.bind(service);
    let failNextInsert = true;
    service.openDatabase = async (...args) => {
      const database = await openDatabase(...args);
      return new Proxy(database, {
        get: (target, property) => {
          if (property === 'execute') {
            return async (sql: string, params?: unknown[]) => {
              if (failNextInsert && /^INSERT INTO outbox/.test(sql)) {
                failNextInsert = false;
                throw new Error('simulated database write failure');
              }
              return await target.execute(sql, params);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    await expect(store.enqueueProgress('book-b', { percentage: 20 })).rejects.toThrow(
      'simulated database write failure',
    );
    await expect(store.ready('progress')).resolves.toEqual([
      expect.objectContaining({ bookHash: 'book-a', payload: { percentage: 64 } }),
    ]);

    await store.enqueueProgress('book-b', { percentage: 20 });
    await expect(store.ready('progress')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bookHash: 'book-a', payload: { percentage: 64 } }),
        expect.objectContaining({ bookHash: 'book-b', payload: { percentage: 20 } }),
      ]),
    );
  });

  it('recovers after a process stops between remote acknowledgement and local queue removal', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueProgress('book-a', { percentage: 35 });
    const remove = store.remove.bind(store);
    let simulateCrash = true;
    store.remove = async (ids) => {
      if (simulateCrash) {
        simulateCrash = false;
        throw new Error('simulated process stop before local acknowledgement');
      }
      await remove(ids);
    };
    const client = { updateProgress: vi.fn().mockResolvedValue({ ok: true }) };

    await expect(new GrimmLinkOutbox(store, client).replay()).rejects.toThrow(
      'simulated process stop',
    );

    // Remote APIs must tolerate the retry: local durable delivery is at least once
    // across a crash in the acknowledgement window.
    const restartedProcess = new GrimmLinkSyncStore(service, 'connection-a');
    await new GrimmLinkOutbox(restartedProcess, client).replay();
    expect(client.updateProgress).toHaveBeenCalledTimes(2);
    await expect(restartedProcess.ready('progress')).resolves.toEqual([]);
  });

  it('rolls back an interrupted outbox transaction and preserves the queued row', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueProgress('book-a', { percentage: 55 });
    const [queued] = await store.all('progress');
    const openDatabase = service.openDatabase.bind(service);
    let interruptDelete = true;
    service.openDatabase = async (...args) => {
      const database = await openDatabase(...args);
      return new Proxy(database, {
        get: (target, property) => {
          if (property === 'execute') {
            return async (sql: string, params?: unknown[]) => {
              if (interruptDelete && /^DELETE FROM outbox/.test(sql)) {
                interruptDelete = false;
                throw new Error('simulated interruption during transaction');
              }
              return await target.execute(sql, params);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    await expect(store.remove([queued!.id])).rejects.toThrow(
      'simulated interruption during transaction',
    );
    await expect(store.ready('progress')).resolves.toHaveLength(1);
    await store.remove([queued!.id]);
    await expect(store.ready('progress')).resolves.toEqual([]);
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

  it('replays every offline category after restart and retries only the failed category', async () => {
    const firstProcess = new GrimmLinkSyncStore(service, 'connection-a');
    await firstProcess.enqueueProgress('book-a', { percentage: 70, device_id: 'device-a' });
    await firstProcess.enqueueSession({
      bookId: 4,
      bookHash: 'book-a',
      bookType: 'EPUB',
      device: 'Readest Test',
      deviceId: 'device-a',
      session: { durationSeconds: 60, startProgress: 0.4, endProgress: 0.7 },
    });
    await firstProcess.enqueueRating('book-a', {
      bookId: 4,
      bookHash: 'book-a',
      rating: { value: 8, scale: 10 },
      annotations: [],
      bookmarks: [],
    });
    await firstProcess.enqueueMetadata('book-a', {
      bookId: 4,
      bookHash: 'book-a',
      rating: null,
      annotations: [{ dedupeKey: 'highlight-a', text: 'quoted text' }],
      bookmarks: [{ dedupeKey: 'bookmark-a', location: 'chapter 2' }],
    });
    await firstProcess.enqueueStatus('book-a', 4, 'reading');

    let sessionRequestKey: string | undefined;
    let sessionAttempts = 0;
    const client = {
      updateProgress: vi.fn().mockResolvedValue({ ok: true }),
      postSessionBatch: vi.fn(async (_payload: Record<string, unknown>, key?: string) => {
        sessionAttempts += 1;
        sessionRequestKey ??= key;
        if (sessionAttempts === 1) {
          throw new GrimmLinkRequestError('server', 'temporarily unavailable', 503);
        }
        return { ok: true };
      }),
      syncMetadata: vi.fn().mockResolvedValue({ ok: true }),
      updateReadStatus: vi.fn().mockResolvedValue({ ok: true }),
    };

    // The first process was offline: its durable outbox is the source of truth
    // after reopening, not the in-memory providers that queued each change.
    const restartedProcess = new GrimmLinkSyncStore(service, 'connection-a');
    await new GrimmLinkOutbox(restartedProcess, client).replay();

    expect(client.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ percentage: 70, device_id: 'device-a' }),
    );
    expect(client.syncMetadata).toHaveBeenCalledTimes(2);
    expect(client.updateReadStatus).toHaveBeenCalledWith(4, 'reading');
    expect(await restartedProcess.all('progress')).toEqual([]);
    expect(await restartedProcess.all('metadata')).toEqual([]);
    expect(await restartedProcess.all('status')).toEqual([]);
    expect(await restartedProcess.all('sessions')).toHaveLength(1);
    expect((await restartedProcess.all('sessions'))[0]).toMatchObject({ attempts: 1 });

    await restartedProcess.retryPending();
    const nextProcess = new GrimmLinkSyncStore(service, 'connection-a');
    await new GrimmLinkOutbox(nextProcess, client).replay();

    expect(client.postSessionBatch).toHaveBeenCalledTimes(2);
    expect(client.postSessionBatch.mock.calls[1]?.[1]).toBe(sessionRequestKey);
    expect(await nextProcess.readyAll()).toEqual([]);
  });

  it('keeps multi-device progress conflicts durable until local or remote is explicitly chosen', async () => {
    const firstProcess = new GrimmLinkSyncStore(service, 'connection-a');
    await firstProcess.enqueueProgress('book-local-choice', {
      percentage: 40,
      device_id: 'device-a',
      bookHash: 'book-local-choice',
    });
    await firstProcess.enqueueProgress('book-local-choice', {
      percentage: 70,
      device_id: 'device-a',
      bookHash: 'book-local-choice',
    });
    await firstProcess.enqueueProgress('book-remote-choice', {
      percentage: 80,
      device_id: 'device-a',
      bookHash: 'book-remote-choice',
    });

    const attempted: Array<{ bookHash: string; percentage: number }> = [];
    const attemptsByBook = new Map<string, number>();
    const client = {
      updateProgress: async (payload: Record<string, unknown>) => {
        const bookHash = String(payload['bookHash']);
        attempted.push({ bookHash, percentage: Number(payload['percentage']) });
        const count = (attemptsByBook.get(bookHash) ?? 0) + 1;
        attemptsByBook.set(bookHash, count);
        if (count === 1) throw new GrimmLinkRequestError('conflict', 'stale revision', 409);
        return { ok: true };
      },
    };

    await new GrimmLinkOutbox(firstProcess, client).replay();
    expect(attempted).toEqual([
      { bookHash: 'book-local-choice', percentage: 70 },
      { bookHash: 'book-remote-choice', percentage: 80 },
    ]);

    const restartedProcess = new GrimmLinkSyncStore(service, 'connection-a');
    expect(await restartedProcess.readyAll()).toEqual([]);
    expect(await restartedProcess.all('progress')).toHaveLength(2);

    // Choosing local reactivates the coalesced row with the latest local
    // position. Choosing remote leaves its conflicting row invalid, so a
    // restart/replay cannot push it over the remote 80% position.
    await restartedProcess.enqueueProgress('book-local-choice', {
      percentage: 70,
      device_id: 'device-a',
      bookHash: 'book-local-choice',
    });
    await new GrimmLinkOutbox(restartedProcess, client).replay();

    expect(attempted).toEqual([
      { bookHash: 'book-local-choice', percentage: 70 },
      { bookHash: 'book-remote-choice', percentage: 80 },
      { bookHash: 'book-local-choice', percentage: 70 },
    ]);
    expect(await restartedProcess.all('progress')).toEqual([
      expect.objectContaining({
        bookHash: 'book-remote-choice',
        payload: {
          percentage: 80,
          device_id: 'device-a',
          bookHash: 'book-remote-choice',
        },
        errorCategory: 'conflict',
      }),
    ]);
    await expect(restartedProcess.readyAll()).resolves.toEqual([]);
  });

  it('pauses only the affected connection after an authentication failure', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueProgress('book-a', { percentage: 10 });
    const client = {
      updateProgress: vi
        .fn()
        .mockRejectedValue(new GrimmLinkRequestError('authentication', 'nope', 401)),
    };

    await new GrimmLinkOutbox(store, client).replay();

    expect(await store.isPaused()).toBe(true);
    expect(await store.all('progress')).toHaveLength(1);
  });

  it('resumes a paused queue after credentials recover and persists replay metrics', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueProgress('book-a', { percentage: 10 });
    const client = {
      updateProgress: vi
        .fn()
        .mockRejectedValueOnce(new GrimmLinkRequestError('authentication', 'expired', 401))
        .mockResolvedValue({ ok: true }),
    };
    const outbox = new GrimmLinkOutbox(store, client);

    await outbox.replay();
    expect(await store.isPaused()).toBe(true);

    await store.retryPending();
    await outbox.replay();

    expect(await store.isPaused()).toBe(false);
    expect(await store.ready('progress')).toEqual([]);
    expect(await store.getDiagnostics()).toMatchObject({
      lastReplayRows: 1,
      lastReplaySucceeded: 1,
      lastReplayFailed: 0,
    });
  });

  it('batches large session replays and never sends more than 500 sessions per request', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      id: `session-${index}`,
      category: 'sessions' as const,
      bookHash: 'book-a',
      payload: {
        bookId: 4,
        bookHash: 'book-a',
        bookType: 'EPUB',
        device: 'Readest Test',
        deviceId: 'd1',
        session: { durationSeconds: 1, sequence: index },
      },
      idempotencyKey: `session-${index}`,
      attempts: 0,
      createdAt: index,
      nextRetryAt: 0,
      errorCategory: null,
    }));
    const removed: string[][] = [];
    const store = {
      isPaused: vi.fn().mockResolvedValue(false),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      readyAll: vi.fn().mockResolvedValue(rows),
      remove: vi.fn(async (ids: string[]) => removed.push([...ids])),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordReplay: vi.fn().mockResolvedValue(undefined),
      getOutboxSummary: vi.fn().mockResolvedValue({ totalPending: 0 }),
    };
    const client = { postSessionBatch: vi.fn().mockResolvedValue({ ok: true }) };

    await new GrimmLinkOutbox(store as unknown as GrimmLinkSyncStore, client).replay();

    expect(client.postSessionBatch.mock.calls.map(([payload]) => payload.sessions.length)).toEqual([
      500, 500, 1,
    ]);
    expect(client.postSessionBatch.mock.calls.map(([, key]) => key)).toEqual([
      'readest-session-session-0-session-499',
      'readest-session-session-500-session-999',
      'readest-session-session-1000-session-1000',
    ]);
    expect(removed.flat()).toHaveLength(1001);
    expect(store.recordReplay).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 1001, succeeded: 1001, failed: 0 }),
    );
  });

  it('chunks SQLite operations below the variable limit for large shelves and outboxes', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    const localPaths = Array.from({ length: 1001 }, (_, index) => `book-${index}.epub`);

    await expect(store.getManagedShelfReferenceCounts(localPaths)).resolves.toEqual(new Map());
    await expect(
      store.remove(localPaths.map((_, index) => `missing-${index}`)),
    ).resolves.toBeUndefined();
    await expect(store.invalidateMany(localPaths, 'invalid-data')).resolves.toBeUndefined();
  });

  it('uploads valid collected sessions in batches without waiting for the lifecycle caller', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueSession({
      bookId: 4,
      bookHash: 'book-a',
      bookType: 'EPUB',
      device: 'Readest Test',
      deviceId: 'd1',
      session: {
        startTime: '2026-08-23T00:00:00.000Z',
        endTime: '2026-08-23T00:00:11.000Z',
        durationSeconds: 11,
        startProgress: 0.1,
        endProgress: 0.2,
        progressDelta: 0.1,
      },
    });
    const client = { postSessionBatch: vi.fn().mockResolvedValue({ ok: true }) };

    await new GrimmLinkOutbox(store, client).replay();

    expect(client.postSessionBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 4,
        bookHash: 'book-a',
        sessions: [expect.objectContaining({ durationSeconds: 11 })],
      }),
      expect.stringMatching(/^readest-session-/),
    );
  });

  it('retains metadata when no replay handler is available', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueRating('book-a', { rating: { value: 8, scale: 10 } });

    await new GrimmLinkOutbox(store, {}).replay();

    await expect(store.all('metadata')).resolves.toHaveLength(1);
  });

  it('persists diagnostics without leaking server URLs and clears invalid rows only', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueProgress('book-a', { percentage: 10 });
    await store.enqueueStatus('book-b', 7, 'reading');
    await store.invalidate((await store.all('progress'))[0]!.id);
    await store.recordAttempt();
    await store.recordError({
      category: 'network',
      message: 'GET https://secret.example/api failed',
      action: 'progress',
      retryable: true,
    });

    expect(await store.getOutboxSummary()).toMatchObject({
      totalPending: 1,
      invalid: 1,
      pendingByCategory: { status: 1 },
    });
    expect((await store.getDiagnostics()).lastError).toMatchObject({
      category: 'network',
      message: 'GET [server] failed',
    });
    await store.clearInvalid();
    expect((await store.getOutboxSummary()).invalid).toBe(0);
  });

  it('isolates book-level invalid state from connection diagnostics', async () => {
    const store = new GrimmLinkSyncStore(service, 'connection-a');
    await store.enqueueProgress('book-a', { percentage: 10 });
    await store.enqueueProgress('book-b', { percentage: 20 });
    const [bookA, bookB] = await store.all('progress');
    await store.invalidate(bookA!.id, 'conflict');

    await expect(store.getBookStatusSnapshot('book-a', null)).resolves.toMatchObject({
      pending: false,
      conflict: true,
      error: false,
    });
    await expect(store.getBookStatusSnapshot('book-b', null)).resolves.toMatchObject({
      pending: true,
      conflict: false,
      error: false,
    });
    expect(bookB?.bookHash).toBe('book-b');
  });

  it('coalesces concurrent replay requests and runs one trailing replay', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replay = vi
      .fn()
      .mockImplementationOnce(() => gate)
      .mockResolvedValue(undefined);
    const scheduler = new GrimmLinkReplayScheduler({ replay } as unknown as GrimmLinkOutbox);

    const first = scheduler.requestReplay();
    const second = scheduler.requestReplay();
    expect(second).toBe(first);
    expect(replay).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(replay).toHaveBeenCalledTimes(2);
  });
});

describe('GrimmLink lifecycle sessions', () => {
  it('closes each active window interval instead of merging suspended time', () => {
    const tracker = new GrimmLinkSessionTracker();
    const link = {
      bookId: 1,
      bookHash: 'book',
      bookType: 'EPUB',
      device: 'Readest',
      deviceId: 'device',
    };
    expect(tracker.startSession({ progress: 0.1 }, 10 * 60 * 60 * 1000)).toBe(true);
    expect(tracker.startSession({ progress: 0.2 }, 10 * 60 * 60 * 1000 + 5_000)).toBe(false);
    const first = tracker.finish({ progress: 0.2 }, link, 10 * 60 * 60 * 1000 + 10 * 60 * 1000);
    expect(first?.session).toMatchObject({ durationSeconds: 600 });
    expect(tracker.startSession({ progress: 0.2 }, 10 * 60 * 60 * 1000 + 40 * 60 * 1000)).toBe(
      true,
    );
    const second = tracker.finish({ progress: 0.3 }, link, 10 * 60 * 60 * 1000 + 50 * 60 * 1000);
    expect(second?.session).toMatchObject({ durationSeconds: 600 });
  });

  it('does not restore an open in-memory session after a simulated process restart', () => {
    const link = {
      bookId: 1,
      bookHash: 'book',
      bookType: 'EPUB',
      device: 'Readest',
      deviceId: 'device',
    };
    const beforeBackground = new GrimmLinkSessionTracker();
    beforeBackground.startSession({ progress: 0.4 }, 1_000);
    const queued = beforeBackground.finish({ progress: 0.7 }, link, 61_000);
    expect(queued?.session).toMatchObject({
      durationSeconds: 60,
      startProgress: 0.4,
      endProgress: 0.7,
    });
    expect(queued?.session['progressDelta']).toBeCloseTo(0.3);

    // A new process has no active session to accidentally extend across sleep.
    const afterRestart = new GrimmLinkSessionTracker();
    expect(afterRestart.isActive()).toBe(false);
    expect(afterRestart.finish({ progress: 0.9 }, link, 3_661_000)).toBeNull();
  });
});

describe('GrimmLink status and rating contract', () => {
  it('maps only supported read statuses and keeps a newer explicit local status', () => {
    expect(mapReadStatus('finished', ['unread', 'reading'])).toBeNull();
    expect(mapReadStatus('finished', ['finished'])).toBe('finished');
    expect(mapReadStatus('finished', ['READ', 'READING'])).toBe('READ');
    expect(
      mergeRemoteReadStatus(
        { readingStatus: 'finished', readingStatusUpdatedAt: 200 },
        { status: 'reading', updatedAt: '1970-01-01T00:00:00.100Z' },
        ['reading'],
      ),
    ).toEqual({ readingStatus: 'finished', readingStatusUpdatedAt: 200 });
    expect(fromGrimmoryReadStatus('READ')).toBe('finished');
    expect(
      mergeRemoteReadStatus(
        { readingStatus: 'reading', readingStatusUpdatedAt: 100 },
        { status: 'READ', updatedAt: '1970-01-01T00:00:00.200Z' },
        ['READ', 'READING'],
      ),
    ).toEqual({ readingStatus: 'finished', readingStatusUpdatedAt: 200 });
  });

  it('converts rating scales and preserves newer local ratings on pull', () => {
    expect(
      toGrimmLinkRating({ value: 4, scale: 5, updatedAt: 200 }, 'connection-a', 'book-a'),
    ).toMatchObject({ value: 8, scale: 10 });
    expect(
      fromGrimmLinkRating(
        { value: 6, scale: 10, updatedAt: '1970-01-01T00:00:00.100Z' },
        { value: 5, scale: 5, updatedAt: 200 },
      ),
    ).toEqual({ value: 5, scale: 5, updatedAt: 200 });
  });

  it('does not queue unsupported status or metadata writes', async () => {
    const root = await fsp.mkdtemp(path.join(SANDBOX_DIR, 'capabilities-'));
    try {
      const service = new NodeAppService(root);
      await service.init();
      const store = new GrimmLinkSyncStore(service, 'connection-a');
      const statuses = new GrimmLinkReadStatusProvider({ getReadStatuses: vi.fn() }, store, []);
      const ratings = new GrimmLinkRatingProvider({ getMetadata: vi.fn() }, store, {
        capabilities: [],
        device: 'Readest Test',
        deviceId: 'device-1',
      });

      await expect(statuses.queueExplicit('book-a', 4, 'reading')).resolves.toBe(false);
      await expect(
        ratings.queuePush('book-a', 4, { value: 4, scale: 5, updatedAt: 100 }),
      ).resolves.toBe(false);
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
      const book = {
        hash: 'readest-hash',
        title: 'Shelf title',
        author: 'Author',
        format: 'EPUB',
      } as Book;
      await store.markShelfEntry(
        'regular',
        7,
        42,
        'grimory-hash',
        'readest-hash/Shelf title.epub',
        true,
      );
      const client = {
        getCapabilities: vi.fn().mockResolvedValue({ capabilities: ['read-status'] }),
        getReadStatuses: vi.fn().mockResolvedValue({ statuses: ['finished'] }),
        matchBook: vi.fn().mockResolvedValue(null),
        updateReadStatus: vi.fn().mockResolvedValue({ ok: true }),
      };

      await expect(
        queueExplicitGrimmLinkReadStatus(
          book,
          'finished',
          { enabled: true, syncReadStatus: true, strategy: 'prompt' },
          store,
          client,
        ),
      ).resolves.toBe(true);

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
      const ratings = new GrimmLinkRatingProvider({ getMetadata: vi.fn() }, store, {
        capabilities: ['metadata'],
        device: 'Readest Windows',
        deviceId: 'device-1',
      });

      await ratings.queuePush('book-a', 4, { value: 4, scale: 5, updatedAt: 100 });

      expect((await store.all('metadata'))[0]?.payload).toMatchObject({
        device: 'Readest Windows',
        deviceId: 'device-1',
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
      const getMetadata = vi
        .fn()
        .mockResolvedValueOnce({
          items: [
            {
              type: 'rating',
              payload: { value: 4, scale: 10, updatedAt: '2026-08-23T00:00:01.000Z' },
            },
          ],
          nextCursor: 'page-2',
        })
        .mockResolvedValueOnce({
          items: [
            {
              type: 'rating',
              payload: { value: 8, scale: 10, updatedAt: '2026-08-23T00:00:02.000Z' },
            },
          ],
          nextCursor: 'done',
        })
        .mockResolvedValueOnce({ items: [], nextCursor: null });
      const ratings = new GrimmLinkRatingProvider({ getMetadata }, store, {
        capabilities: ['metadata'],
        device: 'Readest Test',
        deviceId: 'device-1',
      });

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
        {
          getMetadata: vi.fn().mockResolvedValue({
            items: [
              {
                type: 'rating',
                payload: { value: 12, scale: 10, updatedAt: '2026-08-23T00:00:02.000Z' },
              },
            ],
            nextCursor: 'bad',
          }),
        },
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
