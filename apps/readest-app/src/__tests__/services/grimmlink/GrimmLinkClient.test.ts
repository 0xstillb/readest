import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GrimmLinkSettings } from '@/types/settings';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => false,
  getAPIBaseUrl: () => 'https://web.readest.com/api',
}));

import { GrimmLinkClient, GrimmLinkRequestError } from '@/services/grimmlink/GrimmLinkClient';

const makeConfig = (overrides: Partial<GrimmLinkSettings> = {}): GrimmLinkSettings => ({
  enabled: true,
  serverUrl: 'http://192.168.1.50:3000/',
  username: 'alice',
  userkey: 'a'.repeat(32),
  deviceId: 'device-1',
  deviceName: 'Readest Test',
  strategy: 'prompt',
  syncProgress: false,
  syncMetadata: false,
  syncSessions: false,
  syncReadStatus: false,
  ...overrides,
});

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => body,
});

const setFetch = (impl: (...args: unknown[]) => unknown) => {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  window.fetch = mock as unknown as typeof window.fetch;
  return mock;
};

afterEach(() => vi.unstubAllGlobals());

describe('GrimmLinkClient', () => {
  it('uses the canonical v1 auth path and protects auth headers from custom headers', async () => {
    const fetchMock = setFetch(async () => jsonResponse(200, { user: 'alice' }));
    const client = new GrimmLinkClient(
      makeConfig({ customHeaders: { 'X-Auth-Key': 'override', 'CF-Access-Client-Id': 'id' } }),
    );

    await expect(client.authenticate()).resolves.toEqual({ user: 'alice' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://192.168.1.50:3000/api/grimmlink/v1/auth');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      'X-Auth-User': 'alice',
      'X-Auth-Key': 'a'.repeat(32),
      'CF-Access-Client-Id': 'id',
    });
  });

  it('tests authentication then returns server capabilities', async () => {
    const fetchMock = setFetch(async (url: unknown) =>
      jsonResponse(
        200,
        String(url).endsWith('/auth') ? { user: 'alice' } : { capabilities: ['sessions'] },
      ),
    );
    const result = await new GrimmLinkClient(makeConfig()).connect();

    expect(result).toEqual({ success: true, capabilities: ['sessions'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('runs a read-only health check without creating a session or writing data', async () => {
    const fetchMock = setFetch(async (url: unknown) => {
      const path = String(url);
      if (path.endsWith('/auth')) return jsonResponse(200, { user: 'alice' });
      if (path.endsWith('/capabilities'))
        return jsonResponse(200, { capabilities: ['progress', 'metadata', 'sessions', 'shelves'] });
      return jsonResponse(200, []);
    });

    await expect(new GrimmLinkClient(makeConfig()).healthCheck()).resolves.toEqual({
      authentication: 'ok',
      capabilities: 'ok',
      progress: 'available',
      metadata: 'available',
      sessions: 'available',
      shelves: 'available',
      download: 'available',
      capabilityNames: ['progress', 'metadata', 'sessions', 'shelves'],
    });
    expect(
      fetchMock.mock.calls.map(([url, init]) => [String(url), (init as RequestInit).method]),
    ).toEqual([
      ['http://192.168.1.50:3000/api/grimmlink/v1/auth', 'GET'],
      ['http://192.168.1.50:3000/api/grimmlink/v1/capabilities', 'GET'],
      ['http://192.168.1.50:3000/api/grimmlink/v1/shelves?type=regular', 'GET'],
    ]);
  });

  it('does not weaken TLS by default, and only opts into invalid certificates for LAN', async () => {
    const fetchMock = setFetch(async () => jsonResponse(200, { capabilities: [] }));
    await new GrimmLinkClient(makeConfig()).getCapabilities();
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('danger');

    fetchMock.mockClear();
    await new GrimmLinkClient(makeConfig({ allowSelfSignedCertificate: true })).getCapabilities();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
    });

    const publicFetch = setFetch(async () => jsonResponse(200, { capabilities: [] }));
    await new GrimmLinkClient(
      makeConfig({ serverUrl: 'https://books.example.com', allowSelfSignedCertificate: true }),
    ).getCapabilities();
    expect(publicFetch.mock.calls[0]?.[1]).not.toHaveProperty('danger');
  });

  it('retries transient server responses with exponential backoff', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const fetchMock = setFetch(async () => {
        attempts += 1;
        return attempts < 3
          ? jsonResponse(503, { message: 'busy' })
          : jsonResponse(200, { capabilities: [] });
      });
      const result = new GrimmLinkClient(makeConfig()).getCapabilities();
      await vi.runAllTimersAsync();
      await expect(result).resolves.toEqual({ capabilities: [] });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies exhausted timeouts as network errors', async () => {
    vi.useFakeTimers();
    try {
      setFetch(
        (_url, init) =>
          new Promise<Response>((_, reject) => {
            (init as RequestInit).signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      const result = new GrimmLinkClient(makeConfig()).authenticate();
      const assertion = expect(result).rejects.toMatchObject({
        kind: 'transport',
        category: 'network',
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes Grimmory v1 boolean capabilities, including its core read-status endpoint', async () => {
    setFetch(async () =>
      jsonResponse(200, {
        apiVersion: 'v1',
        progressSync: true,
        readingSessions: true,
        metadataSync: true,
        shelves: true,
      }),
    );

    await expect(new GrimmLinkClient(makeConfig()).getCapabilities()).resolves.toEqual({
      capabilities: ['progress', 'sessions', 'metadata', 'shelves', 'read-status'],
    });
  });

  it('rejects HTML success pages and classifies HTTP errors', async () => {
    setFetch(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new Error('HTML');
      },
    }));
    await expect(new GrimmLinkClient(makeConfig()).authenticate()).rejects.toThrow(
      GrimmLinkRequestError,
    );

    setFetch(async () => jsonResponse(401, { message: 'Nope' }));
    const error = await new GrimmLinkClient(makeConfig())
      .authenticate()
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      status: 401,
      kind: 'authentication',
      category: 'auth',
      message: 'Nope',
    });

    setFetch(async () => jsonResponse(409, { message: 'stale revision' }));
    await expect(
      new GrimmLinkClient(makeConfig()).updateProgress({ percentage: 20 }),
    ).rejects.toMatchObject({
      kind: 'conflict',
      category: 'conflict',
      status: 409,
    });

    setFetch(async () => jsonResponse(200, null));
    await expect(new GrimmLinkClient(makeConfig()).authenticate()).rejects.toMatchObject({
      category: 'invalid-data',
    });
  });

  it('routes public servers through the GrimmLink proxy', async () => {
    const fetchMock = setFetch(async () => jsonResponse(200, { capabilities: [] }));
    await new GrimmLinkClient(
      makeConfig({ serverUrl: 'https://books.example.com' }),
    ).getCapabilities();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://web.readest.com/api/grimmlink');
    expect(JSON.parse(init.body as string)).toMatchObject({
      serverUrl: 'https://books.example.com',
      endpoint: '/capabilities',
      method: 'GET',
    });
  });

  it('uses v1 hash matching and progress endpoints with encoded hashes and JSON payloads', async () => {
    const fetchMock = setFetch(async (url: unknown) => {
      if (String(url).includes('by-hash'))
        return jsonResponse(200, { bookHash: 'a/b', bookId: 42, bookFileId: 9 });
      if (String(url).includes('/syncs/progress/a%2Fb'))
        return jsonResponse(200, { progress: '/body/DocFragment[1]/body', percentage: 50 });
      return jsonResponse(200, { ok: true });
    });
    const client = new GrimmLinkClient(makeConfig());

    await expect(client.matchBook('a/b')).resolves.toMatchObject({ bookId: 42 });
    await expect(client.getProgress('a/b')).resolves.toMatchObject({ percentage: 50 });
    await client.updateProgress({ bookHash: 'a/b', percentage: 50 });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://192.168.1.50:3000/api/grimmlink/v1/books/by-hash/a%2Fb',
      'http://192.168.1.50:3000/api/grimmlink/v1/syncs/progress/a%2Fb',
      'http://192.168.1.50:3000/api/grimmlink/v1/syncs/progress',
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ bookHash: 'a/b', percentage: 50 }),
    });
  });

  it('uses the documented session, status, and rating metadata endpoints', async () => {
    const fetchMock = setFetch(async () => jsonResponse(200, { statuses: ['reading'], items: [] }));
    const client = new GrimmLinkClient(makeConfig());

    await client.postSessionBatch({ bookId: 1, sessions: [] });
    await client.getReadStatuses();
    await client.updateReadStatus(1, 'reading');
    await client.syncMetadata({ schemaVersion: 1, rating: { value: 8, scale: 10 } });
    await client.getMetadata({ bookHash: 'a/b', type: 'rating', limit: 1 });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([
      ['http://192.168.1.50:3000/api/grimmlink/v1/reading-sessions/batch', 'POST'],
      ['http://192.168.1.50:3000/api/grimmlink/v1/books/read-statuses', 'GET'],
      ['http://192.168.1.50:3000/api/grimmlink/v1/books/1/status', 'PUT'],
      ['http://192.168.1.50:3000/api/grimmlink/v1/syncs/metadata/batch', 'POST'],
      [
        'http://192.168.1.50:3000/api/grimmlink/v1/syncs/metadata?bookHash=a%2Fb&type=rating&limit=1',
        'GET',
      ],
    ]);
  });

  it('normalizes Grimmory shelf-book fields before downloading or importing', async () => {
    setFetch(async () =>
      jsonResponse(200, [
        {
          bookId: 42,
          bookHash: 'server-hash',
          fileName: 'Ocean 5.epub',
          fileFormat: 'EPUB',
          fileSize: 1024,
          title: 'Ocean 5',
        },
      ]),
    );

    await expect(new GrimmLinkClient(makeConfig()).getShelfBooks('regular', 7)).resolves.toEqual([
      {
        bookId: 42,
        bookHash: 'server-hash',
        filename: 'Ocean 5.epub',
        format: 'EPUB',
        size: undefined,
        title: 'Ocean 5',
        author: undefined,
      },
    ]);
  });

  it('rejects malformed shelf records instead of silently dropping them', async () => {
    setFetch(async () =>
      jsonResponse(200, [{ bookId: 'not-a-number', bookHash: 'missing-valid-id' }]),
    );
    await expect(
      new GrimmLinkClient(makeConfig()).getShelfBooks('regular', 7),
    ).rejects.toMatchObject({
      category: 'invalid-data',
    });
  });
});
