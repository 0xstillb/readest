import { describe, expect, it, vi } from 'vitest';
import handler, { isValidGrimmLinkRequest } from '@/pages/api/grimmlink';

describe('GrimmLink proxy request allow-list', () => {
  it('accepts only documented v2 paths with their documented methods', () => {
    for (const [method, endpoint] of [
      ['POST', '/auth/session'],
      ['DELETE', '/auth/session'],
      ['GET', '/capabilities'],
      ['GET', '/books/resolve?hash=abc123'],
      ['GET', '/books/1/content'],
      ['GET', '/books/1/content?format=epub'],
      ['GET', '/books/1/hash'],
      ['GET', '/books/read-statuses'],
      ['PUT', '/books/1/status'],
      ['GET', '/books/1/metadata'],
      ['PUT', '/books/1/metadata'],
      ['GET', '/shelves'],
      ['GET', '/shelves/1/items'],
      ['GET', '/shelves/1/items?limit=50'],
      ['PUT', '/shelves/1/items/book-1'],
      ['DELETE', '/shelves/1/items/book-1'],
      ['GET', '/progress/book-1'],
      ['GET', '/progress/book-1?since=1'],
      ['PUT', '/progress/book-1'],
      ['POST', '/reading-sessions'],
      ['POST', '/reading-sessions/batch'],
      ['POST', '/syncs/metadata'],
      ['POST', '/syncs/metadata/batch'],
      ['GET', '/syncs/metadata'],
      ['GET', '/syncs/metadata?bookHash=abc&type=rating'],
    ] as const)
      expect(isValidGrimmLinkRequest(endpoint, method)).toBe(true);
  });

  it('rejects v1-only, traversal, and mismatched requests', () => {
    for (const [method, endpoint] of [
      ['GET', '/auth'],
      ['GET', '/books/by-hash/hash%2Fvalue'],
      ['PUT', '/syncs/progress'],
      ['GET', '/syncs/progress/hash'],
      ['GET', '/shelves/regular/1/books'],
      ['GET', '/shelves/1/books'],
      ['GET', '/books/1/download'],
      ['GET', '/api/koreader/auth'],
      ['POST', '/auth'],
      ['GET', '/books/1/status'],
      ['GET', '/shelves/regular/1/items/../../admin'],
      ['GET', '/books/resolve'],
      ['GET', '/books/resolve?hash='],
      ['DELETE', '/books/1'],
    ] as const)
      expect(isValidGrimmLinkRequest(endpoint, method)).toBe(false);
  });
});

const makeResponse = () => {
  const response = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(body: unknown) {
      response.body = body;
      return response;
    },
    setHeader: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
  };
  return response;
};

describe('GrimmLink proxy handler', () => {
  it('rejects private targets before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = makeResponse();
    await handler(
      {
        method: 'POST',
        headers: {},
        body: { serverUrl: 'http://127.0.0.1', endpoint: '/auth/session', method: 'POST' },
      } as never,
      response as never,
    );
    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('forwards to the v2 base path with only approved credential headers', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 204,
      headers: new Headers(),
      body: null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const response = makeResponse();
    await handler(
      {
        method: 'POST',
        headers: {},
        body: {
          serverUrl: 'https://books.example.com',
          endpoint: '/auth/session',
          method: 'POST',
          headers: {
            'X-Auth-User': 'reader',
            'X-Auth-Key': 'secret',
            Authorization: 'Bearer token-123',
            'Idempotency-Key': 'idem-1',
            Cookie: 'blocked',
          },
        },
      } as never,
      response as never,
    );
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://books.example.com/api/grimmlink/v2/auth/session');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({
      'X-Auth-User': 'reader',
      'X-Auth-Key': 'secret',
      Authorization: 'Bearer token-123',
      'Idempotency-Key': 'idem-1',
    });
    expect(init.headers).not.toHaveProperty('Cookie');
    vi.unstubAllGlobals();
  });

  it('forwards the v2 bearer token and requests binary for content downloads', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      body: null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const response = makeResponse();
    await handler(
      {
        method: 'POST',
        headers: {},
        body: {
          serverUrl: 'https://books.example.com',
          endpoint: '/books/1/content',
          method: 'GET',
          headers: { Authorization: 'Bearer token-123' },
        },
      } as never,
      response as never,
    );
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://books.example.com/api/grimmlink/v2/books/1/content');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token-123',
      Accept: 'application/octet-stream',
    });
    vi.unstubAllGlobals();
  });
});
