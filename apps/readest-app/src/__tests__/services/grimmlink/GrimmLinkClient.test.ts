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
      jsonResponse(200, String(url).endsWith('/auth') ? { user: 'alice' } : { capabilities: ['sessions'] }),
    );
    const result = await new GrimmLinkClient(makeConfig()).connect();

    expect(result).toEqual({ success: true, capabilities: ['sessions'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects HTML success pages and classifies HTTP errors', async () => {
    setFetch(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new Error('HTML'); } }));
    await expect(new GrimmLinkClient(makeConfig()).authenticate()).rejects.toThrow(GrimmLinkRequestError);

    setFetch(async () => jsonResponse(401, { message: 'Nope' }));
    const error = await new GrimmLinkClient(makeConfig()).authenticate().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 401, kind: 'authentication', message: 'Nope' });
  });

  it('routes public servers through the GrimmLink proxy', async () => {
    const fetchMock = setFetch(async () => jsonResponse(200, { capabilities: [] }));
    await new GrimmLinkClient(makeConfig({ serverUrl: 'https://books.example.com' })).getCapabilities();

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
      if (String(url).includes('by-hash')) return jsonResponse(200, { bookHash: 'a/b', bookId: 42, bookFileId: 9 });
      if (String(url).includes('/syncs/progress/a%2Fb')) return jsonResponse(200, { progress: '/body/DocFragment[1]/body', percentage: 50 });
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
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ bookHash: 'a/b', percentage: 50 }) });
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
      ['http://192.168.1.50:3000/api/grimmlink/v1/syncs/metadata?bookHash=a%2Fb&type=rating&limit=1', 'GET'],
    ]);
  });

  it('normalizes Grimmory shelf-book fields before downloading or importing', async () => {
    setFetch(async () => jsonResponse(200, [{
      bookId: 42,
      bookHash: 'server-hash',
      fileName: 'Ocean 5.epub',
      fileFormat: 'EPUB',
      fileSize: 1024,
      title: 'Ocean 5',
    }]));

    await expect(new GrimmLinkClient(makeConfig()).getShelfBooks('regular', 7)).resolves.toEqual([{
      bookId: 42,
      bookHash: 'server-hash',
      filename: 'Ocean 5.epub',
      format: 'EPUB',
      size: undefined,
      title: 'Ocean 5',
      author: undefined,
    }]);
  });
});
