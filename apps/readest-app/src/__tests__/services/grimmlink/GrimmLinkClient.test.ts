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

const SESSION_BODY = {
  accessToken: 'adapter-token',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00.000Z',
  username: 'alice',
  userId: 7,
};

/** Every Adapter v2 call starts with a session request; answer it by default. */
const setFetch = (
  impl: (...args: unknown[]) => unknown,
  options: { interceptSession?: boolean } = {},
) => {
  const interceptSession = options.interceptSession !== false;
  const mock = vi.fn(async (...args: unknown[]) => {
    const [url, init] = args as [string, RequestInit];
    const payload =
      typeof init.body === 'string' ? (JSON.parse(init.body) as { endpoint?: string }) : undefined;
    const isSession =
      String(url).endsWith('/auth/session') || payload?.endpoint === '/auth/session';
    if (interceptSession && isSession) return jsonResponse(200, SESSION_BODY);
    return await impl(...args);
  });
  vi.stubGlobal('fetch', mock);
  window.fetch = mock as unknown as typeof window.fetch;
  return mock;
};

const calls = (mock: ReturnType<typeof setFetch>) =>
  mock.mock.calls as unknown as [string, RequestInit][];

const urls = (mock: ReturnType<typeof setFetch>) => calls(mock).map(([url]) => url);

afterEach(() => vi.unstubAllGlobals());

describe('GrimmLinkClient', () => {
  it('opens an Adapter v2 session and sends the bearer token afterwards', async () => {
    const fetchMock = setFetch(async () => jsonResponse(200, { capabilities: ['progress'] }));
    const client = new GrimmLinkClient(
      makeConfig({ customHeaders: { 'X-Auth-Key': 'override', 'CF-Access-Client-Id': 'id' } }),
    );

    await expect(client.authenticate()).resolves.toMatchObject({
      authenticated: true,
      username: 'alice',
      userId: 7,
    });
    await client.getCapabilities();

    const [sessionUrl, sessionInit] = calls(fetchMock)[0]!;
    expect(sessionUrl).toBe('http://192.168.1.50:3000/api/grimmlink/v2/auth/session');
    expect(sessionInit.method).toBe('POST');
    expect(sessionInit.headers).toMatchObject({
      Accept: 'application/json',
      'X-Auth-User': 'alice',
      'X-Auth-Key': 'a'.repeat(32),
      'CF-Access-Client-Id': 'id',
    });
    expect(sessionInit.headers).not.toHaveProperty('Authorization');

    const [, capabilitiesInit] = calls(fetchMock)[1]!;
    expect(capabilitiesInit.headers).toMatchObject({ Authorization: 'Bearer adapter-token' });
    expect(capabilitiesInit.headers).not.toHaveProperty('X-Auth-Key');
  });

  it('opens a new session and retries once after a 401', async () => {
    let capabilitiesCalls = 0;
    const fetchMock = setFetch(async () => {
      capabilitiesCalls += 1;
      if (capabilitiesCalls === 1) return jsonResponse(401, { detail: 'Session expired.' });
      return jsonResponse(200, { capabilities: ['progress'] });
    });
    const client = new GrimmLinkClient(makeConfig());

    await expect(client.getCapabilities()).resolves.toEqual({
      capabilities: ['progress', 'read-status'],
    });
    expect(urls(fetchMock)).toEqual([
      'http://192.168.1.50:3000/api/grimmlink/v2/auth/session',
      'http://192.168.1.50:3000/api/grimmlink/v2/capabilities',
      'http://192.168.1.50:3000/api/grimmlink/v2/auth/session',
      'http://192.168.1.50:3000/api/grimmlink/v2/capabilities',
    ]);
  });

  it('resolves a book by hash through the v2 identity route', async () => {
    const fetchMock = setFetch(async () =>
      jsonResponse(200, { id: 42, title: 'Dune', primaryFile: { id: 9, extension: 'epub' } }),
    );
    const client = new GrimmLinkClient(makeConfig());

    await expect(client.matchBook('a/b')).resolves.toEqual({
      bookHash: 'a/b',
      bookId: 42,
      bookFileId: 9,
      format: 'EPUB',
    });
    expect(urls(fetchMock)).toContain(
      'http://192.168.1.50:3000/api/grimmlink/v2/books/resolve?hash=a%2Fb',
    );
  });

  it('reads progress as a fraction and reports the reader-native locators', async () => {
    const fetchMock = setFetch(async () =>
      jsonResponse(200, {
        status: 'ok',
        bookHash: 'a/b',
        fraction: 0.5,
        updatedAt: '2026-11-09T00:00:00Z',
        device: 'Readest Desktop',
        deviceId: 'readest-device-1',
        position: {
          format: 'EPUB',
          cfi: 'epubcfi(/6/4!/4/2/2)',
          href: 'OEBPS/chapter-1.xhtml',
          page: null,
          totalPages: null,
        },
      }),
    );
    const client = new GrimmLinkClient(makeConfig());

    await expect(client.getProgress('a/b')).resolves.toMatchObject({
      bookHash: 'a/b',
      location: 'epubcfi(/6/4!/4/2/2)',
      cfi: 'epubcfi(/6/4!/4/2/2)',
      href: 'OEBPS/chapter-1.xhtml',
      percentage: 50,
      device: 'Readest Desktop',
      device_id: 'readest-device-1',
    });
    expect(urls(fetchMock)).toContain(
      'http://192.168.1.50:3000/api/grimmlink/v2/progress/a%2Fb?reader=readest',
    );
  });

  it('falls back to the KOReader projection when the adapter cannot return a CFI', async () => {
    const fetchMock = setFetch(async (url: unknown) => {
      if (String(url).includes('reader=readest')) return jsonResponse(424, { detail: 'No CFI.' });
      return jsonResponse(200, {
        status: 'ok',
        bookHash: 'a/b',
        fraction: 0.25,
        position: { format: 'EPUB', xpointer: '/body/DocFragment[3]/body' },
      });
    });
    const client = new GrimmLinkClient(makeConfig());

    await expect(client.getProgress('a/b')).resolves.toMatchObject({
      xpointer: '/body/DocFragment[3]/body',
      percentage: 25,
    });
    expect(urls(fetchMock)).toContain(
      'http://192.168.1.50:3000/api/grimmlink/v2/progress/a%2Fb?reader=koreader',
    );
  });

  it('never sends the raw KOSync key outside the session endpoint', async () => {
    const fetchMock = setFetch(async () => jsonResponse(200, { capabilities: ['progress'] }));
    const client = new GrimmLinkClient(makeConfig());

    await client.getCapabilities();
    await client.getProgress('a/b');

    for (const [url, init] of calls(fetchMock)) {
      if (String(url).endsWith('/auth/session')) continue;
      expect(init.headers).not.toHaveProperty('X-Auth-User');
      expect(init.headers).not.toHaveProperty('X-Auth-Key');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer adapter-token' });
    }
  });

  it('treats a missing file format as no progress at all', async () => {
    setFetch(async () => jsonResponse(501, { detail: 'A verified file format is required.' }));
    const client = new GrimmLinkClient(makeConfig());

    await expect(client.getProgress('a/b')).resolves.toBeNull();
  });

  it('writes progress with the v2 body and keeps the book hash in the URL', async () => {
    const fetchMock = setFetch(async () => jsonResponse(200, { status: 'ok' }));
    const client = new GrimmLinkClient(makeConfig());

    await client.updateProgress({
      bookHash: 'a/b',
      operationId: 'operation-1',
      source: 'readest',
      device: { id: 'device-1', name: 'Readest Test' },
      updatedAt: '2026-11-09T00:00:00.000Z',
      fraction: 0.25,
      position: { format: 'epub', cfi: 'epubcfi(/6/4!)' },
    });

    const [url, init] = calls(fetchMock).find(([target]) => target.includes('/progress/'))!;
    expect(url).toBe('http://192.168.1.50:3000/api/grimmlink/v2/progress/a%2Fb');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      operationId: 'operation-1',
      source: 'readest',
      fraction: 0.25,
      position: { format: 'epub', cfi: 'epubcfi(/6/4!)' },
    });
    expect(body).not.toHaveProperty('bookHash');
  });

  it('converts a queued v1 progress payload into the v2 body', async () => {
    const fetchMock = setFetch(async () => jsonResponse(200, { status: 'ok' }));
    const client = new GrimmLinkClient(makeConfig());

    await client.updateProgress({
      bookHash: 'a/b',
      document: 'a/b',
      percentage: 50,
      location: 'epubcfi(/6/4!)',
      fileFormat: 'EPUB',
      device: 'Readest Test',
      device_id: 'device-1',
      updatedAt: '2026-11-09T00:00:00.000Z',
    });

    const [, init] = calls(fetchMock).find(([target]) => target.includes('/progress/'))!;
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      source: 'readest',
      fraction: 0.5,
      position: { format: 'epub', cfi: 'epubcfi(/6/4!)' },
    });
    expect(body.device).toEqual({ id: 'device-1', name: 'Readest Test' });
  });

  it('lists regular shelves and resolves the hash of every shelf book', async () => {
    const fetchMock = setFetch(async (url: unknown) => {
      const path = String(url);
      if (path.endsWith('/shelves')) {
        return jsonResponse(200, [
          { id: 7, name: 'Sci-Fi', type: 'regular', visibility: 'personal', bookCount: 1 },
        ]);
      }
      if (path.includes('/shelves/7/items')) {
        return jsonResponse(200, [
          {
            bookId: 42,
            bookFileId: 9,
            title: 'Dune',
            author: 'Frank Herbert',
            fileName: 'dune.epub',
            extension: 'epub',
            fileFormat: 'EPUB',
            bookHash: null,
          },
        ]);
      }
      if (path.endsWith('/books/42/hash')) {
        return jsonResponse(200, { bookId: 42, bookFileId: 9, bookHash: 'server-hash' });
      }
      return jsonResponse(200, []);
    });
    const client = new GrimmLinkClient(makeConfig());

    await expect(client.getShelves()).resolves.toEqual([
      { id: 7, name: 'Sci-Fi', type: 'regular', visibility: 'personal', bookCount: 1 },
    ]);
    await expect(client.getShelfBooks(7)).resolves.toEqual([
      {
        bookId: 42,
        bookHash: 'server-hash',
        filename: 'dune.epub',
        format: 'EPUB',
        size: undefined,
        title: 'Dune',
        author: 'Frank Herbert',
      },
    ]);
    expect(urls(fetchMock)).toContain(
      'http://192.168.1.50:3000/api/grimmlink/v2/shelves/7/items?limit=100&offset=0',
    );
    expect(urls(fetchMock)).toContain('http://192.168.1.50:3000/api/grimmlink/v2/books/42/hash');
  });

  it('downloads book content through the v2 content route', async () => {
    const fetchMock = setFetch(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '4' }),
      body: null,
      arrayBuffer: async () => new ArrayBuffer(4),
    }));
    const client = new GrimmLinkClient(makeConfig());

    await expect(client.downloadShelfBook(42, 'a/b')).resolves.toBeInstanceOf(ArrayBuffer);
    const [url, init] = calls(fetchMock).find(([target]) => target.includes('/content'))!;
    expect(url).toBe('http://192.168.1.50:3000/api/grimmlink/v2/books/42/content?hash=a%2Fb');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer adapter-token' });
  });

  it('keeps the read-status, session-batch and metadata routes on the v2 prefix', async () => {
    const fetchMock = setFetch(async () => jsonResponse(200, { status: 'ok' }));
    const client = new GrimmLinkClient(makeConfig());

    await client.getReadStatuses();
    await client.updateReadStatus(1, 'reading');
    await client.postSessionBatch({ bookId: 1, sessions: [] }, 'readest-session-1');
    await client.syncMetadata({ schemaVersion: 1, rating: { value: 8, scale: 10 } });
    await client.getMetadata({ bookHash: 'a/b', type: 'rating', limit: 1 });

    const requested = urls(fetchMock).filter((url) => !url.endsWith('/auth/session'));
    expect(requested).toEqual([
      'http://192.168.1.50:3000/api/grimmlink/v2/books/read-statuses',
      'http://192.168.1.50:3000/api/grimmlink/v2/books/1/status',
      'http://192.168.1.50:3000/api/grimmlink/v2/reading-sessions/batch',
      'http://192.168.1.50:3000/api/grimmlink/v2/syncs/metadata/batch',
      'http://192.168.1.50:3000/api/grimmlink/v2/syncs/metadata?bookHash=a%2Fb&type=rating&limit=1',
    ]);
  });

  it('forwards a public server through the web proxy with the bearer token', async () => {
    const fetchMock = setFetch(async () => jsonResponse(200, { capabilities: [] }));
    const client = new GrimmLinkClient(makeConfig({ serverUrl: 'https://books.example.com' }));

    await client.getCapabilities();

    const proxyCalls = calls(fetchMock).filter(([target]) =>
      target.startsWith('https://web.readest.com'),
    );
    expect(proxyCalls.length).toBeGreaterThan(0);
    expect(proxyCalls[0]![0]).toBe('https://web.readest.com/api/grimmlink');
    const payloads = proxyCalls.map(
      ([, request]) =>
        JSON.parse(request.body as string) as { endpoint: string; headers: Record<string, string> },
    );
    expect(payloads.map((payload) => payload.endpoint)).toContain('/capabilities');
    const capabilitiesPayload = payloads.find((payload) => payload.endpoint === '/capabilities')!;
    expect(capabilitiesPayload.headers['Authorization']).toBe('Bearer adapter-token');
  });

  it('rejects HTML success pages and classifies HTTP errors', async () => {
    setFetch(
      async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new Error('HTML');
        },
      }),
      { interceptSession: false },
    );
    await expect(new GrimmLinkClient(makeConfig()).authenticate()).rejects.toThrow(
      GrimmLinkRequestError,
    );

    setFetch(async () => jsonResponse(401, { detail: 'Nope' }), { interceptSession: false });
    const error = await new GrimmLinkClient(makeConfig())
      .authenticate()
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      status: 401,
      kind: 'authentication',
      category: 'auth',
    });

    setFetch(async () => jsonResponse(409, { detail: 'Conflict' }), { interceptSession: false });
    const conflict = await new GrimmLinkClient(makeConfig())
      .authenticate()
      .catch((cause: unknown) => cause);
    expect(conflict).toMatchObject({ status: 409, kind: 'conflict', category: 'conflict' });

    setFetch(async () => jsonResponse(200, null), { interceptSession: false });
    await expect(new GrimmLinkClient(makeConfig()).authenticate()).rejects.toMatchObject({
      category: 'invalid-data',
    });
  });

  it('reports an empty shelf list as invalid data', async () => {
    setFetch(async () => jsonResponse(200, { shelves: 'nope' }));
    await expect(new GrimmLinkClient(makeConfig()).getShelves()).rejects.toMatchObject({
      category: 'invalid-data',
    });
  });
});
