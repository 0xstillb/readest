import { describe, expect, it, vi } from 'vitest';
import handler, { isValidGrimmLinkRequest } from '@/pages/api/grimmlink';

describe('GrimmLink proxy request allow-list', () => {
  it('accepts only documented v1 paths with their documented methods', () => {
    for (const [method, endpoint] of [
      ['GET', '/auth'],
      ['GET', '/capabilities'],
      ['GET', '/books/by-hash/hash%2Fvalue'],
      ['GET', '/syncs/progress/hash'],
      ['PUT', '/syncs/progress'],
      ['POST', '/reading-sessions'],
      ['POST', '/reading-sessions/batch'],
      ['POST', '/syncs/metadata'],
      ['POST', '/syncs/metadata/batch'],
      ['GET', '/syncs/metadata'],
      ['GET', '/syncs/metadata?bookHash=abc&type=rating'],
      ['GET', '/shelves'],
      ['GET', '/shelves/regular/1/books'],
      ['GET', '/shelves/1/books'],
      ['GET', '/books/1/download'],
      ['GET', '/books/read-statuses'],
      ['PUT', '/books/1/status'],
    ] as const)
      expect(isValidGrimmLinkRequest(endpoint, method)).toBe(true);
  });

  it('rejects legacy, traversal, and mismatched requests', () => {
    for (const [method, endpoint] of [
      ['GET', '/api/koreader/auth'],
      ['POST', '/auth'],
      ['GET', '/books/1/status'],
      ['GET', '/shelves/regular/1/books/../../admin'],
      ['GET', '/books/by-hash/'],
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
        body: { serverUrl: 'http://127.0.0.1', endpoint: '/auth', method: 'GET' },
      } as never,
      response as never,
    );
    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('forwards only approved credential headers without redirects', async () => {
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
          endpoint: '/auth',
          method: 'GET',
          headers: { 'X-Auth-Key': 'secret', Cookie: 'blocked' },
        },
      } as never,
      response as never,
    );
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://books.example.com/api/grimmlink/v1/auth');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({ 'X-Auth-Key': 'secret' });
    expect(init.headers).not.toHaveProperty('Cookie');
    vi.unstubAllGlobals();
  });
});
