import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler, {
  isBookOrbitDownloadEndpoint,
  isValidBookOrbitEndpoint,
  safeHeaders,
} from '@/pages/api/bookorbit';
import { isLanAddress } from '@/utils/network';

class MockResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  body: unknown = undefined;
  chunks: Buffer[] = [];
  headersSent = false;

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.headersSent = true;
    if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) {
      this.chunks.push(Buffer.from(chunk));
    } else if (typeof chunk === 'string') {
      this.chunks.push(Buffer.from(chunk));
    }
    callback();
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(data: unknown) {
    this.headersSent = true;
    this.body = data;
    return this;
  }

  send(data: unknown) {
    this.headersSent = true;
    this.body = data;
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }

  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }
}

const makeReq = (body: Record<string, unknown>, method = 'POST') =>
  ({
    method,
    headers: {},
    body,
  }) as unknown as NextApiRequest;

describe('BookOrbit endpoint allowlist', () => {
  it('accepts exact core plugin JSON endpoints', () => {
    const valid = [
      '/users/auth',
      '/plugin/version',
      '/plugin/match-check',
      '/plugin/annotations/exchange',
      '/plugin/annotations/exchange-ack',
      '/plugin/bookmarks/exchange',
      '/plugin/bookmarks/exchange-ack',
      '/plugin/page-stats',
      '/plugin/book-states',
    ];
    for (const endpoint of valid) {
      expect(isValidBookOrbitEndpoint(endpoint)).toBe(true);
      expect(isBookOrbitDownloadEndpoint(endpoint)).toBe(false);
    }
  });

  it('accepts exact JSON routes for collections and smart-scopes', () => {
    const valid = [
      '/plugin/collections',
      '/plugin/collections/42',
      '/plugin/collections/42/books',
      '/plugin/collections/fav-books/books',
      '/collections',
      '/collections/42',
      '/collections/42/books',
      '/plugin/smartscopes',
      '/plugin/smartscopes/7',
      '/plugin/smartscopes/7/books',
      '/plugin/smart-scopes',
      '/plugin/smart-scopes/reading-list/books',
      '/smartscopes',
      '/smartscopes/99',
      '/smartscopes/99/books',
      '/smart-scopes',
      '/smart-scopes/favorites',
      '/smart-scopes/favorites/books',
    ];
    for (const endpoint of valid) {
      expect(isValidBookOrbitEndpoint(endpoint)).toBe(true);
      expect(isBookOrbitDownloadEndpoint(endpoint)).toBe(false);
    }
  });

  it('accepts exact JSON routes for manifest', () => {
    const valid = ['/plugin/catalog/manifest', '/plugin/manifest', '/manifest'];
    for (const endpoint of valid) {
      expect(isValidBookOrbitEndpoint(endpoint)).toBe(true);
      expect(isBookOrbitDownloadEndpoint(endpoint)).toBe(false);
    }
  });

  it('accepts dedicated binary streaming download route with numeric ID', () => {
    const valid = [
      '/plugin/catalog/files/1/download',
      '/plugin/catalog/files/42/download',
      '/plugin/catalog/files/99999/download',
    ];
    for (const endpoint of valid) {
      expect(isValidBookOrbitEndpoint(endpoint)).toBe(true);
      expect(isBookOrbitDownloadEndpoint(endpoint)).toBe(true);
    }
  });

  it('rejects broad catalog wildcards and arbitrary catalog routes', () => {
    const invalid = [
      '/plugin/catalog',
      '/plugin/catalog/root',
      '/plugin/catalog/browse',
      '/plugin/catalog/search',
      '/plugin/catalog/books',
      '/plugin/catalog/files',
      '/plugin/catalog/files/download',
      '/catalog',
      '/catalog/root',
    ];
    for (const endpoint of invalid) {
      expect(isValidBookOrbitEndpoint(endpoint)).toBe(false);
    }
  });

  it('rejects arbitrary, administrative, or non-allowlisted routes', () => {
    const invalid = [
      '/users/create',
      '/users/delete',
      '/admin',
      '/admin/settings',
      '/plugin/package',
      '/syncs/progress',
      '/api/v1/users',
      '',
    ];
    for (const endpoint of invalid) {
      expect(isValidBookOrbitEndpoint(endpoint)).toBe(false);
    }
  });

  it('rejects path injection, traversal, and query string / fragment variants', () => {
    const invalid = [
      '/plugin/version/../../../admin',
      '../users/auth',
      '/users/auth/..',
      '/plugin/collections/..%2fadmin/books',
      '/plugin/collections/../books',
      '/plugin/catalog/files/../download',
      '/plugin/catalog/files/123%2f..%2fdownload',
      '/plugin/version?admin=true',
      '/plugin/version#fragment',
      '/plugin/versionx',
      'plugin/version',
      '%2e%2e',
      '/plugin//version',
      '/plugin\\version',
    ];
    for (const endpoint of invalid) {
      expect(isValidBookOrbitEndpoint(endpoint)).toBe(false);
    }
  });

  it('rejects unexpected file ID or malformed file paths in download route', () => {
    const invalid = [
      '/plugin/catalog/files/abc/download',
      '/plugin/catalog/files/-1/download',
      '/plugin/catalog/files/1.5/download',
      '/plugin/catalog/files/123/extra',
      '/plugin/catalog/files/123',
      '/plugin/catalog/files//download',
      '/plugin/catalog/files/0x12/download',
    ];
    for (const endpoint of invalid) {
      expect(isValidBookOrbitEndpoint(endpoint)).toBe(false);
      expect(isBookOrbitDownloadEndpoint(endpoint)).toBe(false);
    }
  });
});

describe('BookOrbit proxy SSRF address checks', () => {
  it('classifies private, loopback, link-local, and internal addresses as LAN', () => {
    expect(isLanAddress('http://169.254.169.254')).toBe(true);
    expect(isLanAddress('http://127.0.0.1:8000')).toBe(true);
    expect(isLanAddress('http://localhost:3000')).toBe(true);
    expect(isLanAddress('http://[::1]:3000')).toBe(true);
    expect(isLanAddress('http://10.0.0.5')).toBe(true);
    expect(isLanAddress('http://192.168.1.10')).toBe(true);
    expect(isLanAddress('http://172.16.0.1')).toBe(true);
    expect(isLanAddress('https://books.example.com')).toBe(false);
  });
});

describe('BookOrbit proxy safe headers', () => {
  it('allows safe and auth-related headers while dropping forbidden headers', () => {
    const input = {
      'X-Auth-User': 'user123',
      'X-Auth-Key': 'key123',
      Authorization: 'Bearer token123',
      'CF-Access-Client-Id': 'client-id',
      'CF-Access-Client-Secret': 'client-secret',
      Host: 'evil.internal',
      Cookie: 'session=secret',
      'Set-Cookie': 'auth=evil',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Content-Length': '100',
    };
    const cleaned = safeHeaders(input);
    expect(cleaned).toEqual({
      'X-Auth-User': 'user123',
      'X-Auth-Key': 'key123',
      Authorization: 'Bearer token123',
      'CF-Access-Client-Id': 'client-id',
      'CF-Access-Client-Secret': 'client-secret',
    });
  });

  it('rejects header injection with CRLF or control characters', () => {
    const input = {
      'X-Auth-User': 'user\r\nInjected: evil',
      'X-Auth-Key': 'key\nInjected: evil',
      'X-Null\0': 'val',
      'Injected\r\nHeader': 'val',
      'X-Clean': 'clean-value',
    };
    const cleaned = safeHeaders(input);
    expect(cleaned).toEqual({
      'X-Clean': 'clean-value',
    });
  });
});

describe('BookOrbit proxy handler security boundaries', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects non-POST HTTP methods with 405', async () => {
    const res = new MockResponse();
    await handler(
      makeReq(
        {
          serverUrl: 'https://books.example.com',
          endpoint: '/plugin/version',
          method: 'GET',
        },
        'GET',
      ),
      res as unknown as NextApiResponse,
    );
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method Not Allowed' });
  });

  it('rejects private and internal targets before attempting any fetch', async () => {
    const targets = [
      'http://169.254.169.254',
      'http://127.0.0.1:8000',
      'http://localhost:3000',
      'http://10.0.0.1',
      'http://192.168.1.1',
      'http://[::1]:8080',
    ];

    for (const serverUrl of targets) {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const res = new MockResponse();
      await handler(
        makeReq({
          serverUrl,
          endpoint: '/plugin/version',
          method: 'GET',
        }),
        res as unknown as NextApiResponse,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Requests to private/internal addresses are not allowed',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('rejects non-http and non-https schemes', async () => {
    const nonHttp = [
      'file:///etc/passwd',
      'ftp://books.example.com',
      'gopher://evil.com',
      'javascript:alert(1)',
      'data:text/plain;base64,SGVsbG8=',
    ];

    for (const serverUrl of nonHttp) {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const res = new MockResponse();
      await handler(
        makeReq({
          serverUrl,
          endpoint: '/plugin/version',
          method: 'GET',
        }),
        res as unknown as NextApiResponse,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Only http and https URLs are allowed' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed server URLs (paths, userinfo, queries, fragments, bad encoding)', async () => {
    const malformed = [
      'not-a-valid-url',
      'http://',
      'https://books.example.com/admin',
      'https://books.example.com/?next=admin',
      'https://books.example.com/#frag',
      'https://user:password@books.example.com',
      'https://books.example.com/%ZZ',
    ];

    for (const serverUrl of malformed) {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const res = new MockResponse();
      await handler(
        makeReq({
          serverUrl,
          endpoint: '/plugin/version',
          method: 'GET',
        }),
        res as unknown as NextApiResponse,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid serverUrl' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('rejects arbitrary and unallowlisted routes before fetch', async () => {
    const arbitraryRoutes = [
      '/admin',
      '/users/create',
      '/plugin/catalog/root',
      '/plugin/catalog/browse',
      '/plugin/package',
      '/syncs/progress',
    ];

    for (const endpoint of arbitraryRoutes) {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const res = new MockResponse();
      await handler(
        makeReq({
          serverUrl: 'https://books.example.com',
          endpoint,
          method: 'GET',
        }),
        res as unknown as NextApiResponse,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid endpoint' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('rejects path injection attempts before fetch', async () => {
    const injectionRoutes = [
      '../users/auth',
      '/plugin/version/../../../admin',
      '/plugin/collections/..%2fadmin/books',
      '/plugin/catalog/files/../download',
      '/plugin/catalog/files/123%2f..%2fdownload',
      '/plugin/version?admin=true',
      '/plugin/version#admin',
      '%2e%2e',
    ];

    for (const endpoint of injectionRoutes) {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const res = new MockResponse();
      await handler(
        makeReq({
          serverUrl: 'https://books.example.com',
          endpoint,
          method: 'GET',
        }),
        res as unknown as NextApiResponse,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid endpoint' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('rejects unexpected file ID or paths in download route', async () => {
    const badDownloadRoutes = [
      '/plugin/catalog/files/abc/download',
      '/plugin/catalog/files/-1/download',
      '/plugin/catalog/files/1.5/download',
      '/plugin/catalog/files/123/extra',
      '/plugin/catalog/files/123',
      '/plugin/catalog/files//download',
    ];

    for (const endpoint of badDownloadRoutes) {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const res = new MockResponse();
      await handler(
        makeReq({
          serverUrl: 'https://books.example.com',
          endpoint,
          method: 'GET',
        }),
        res as unknown as NextApiResponse,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid endpoint' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('rejects redirects with 500 without following them', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      // Simulated redirect response
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = new MockResponse();
    await handler(
      makeReq({
        serverUrl: 'https://books.example.com',
        endpoint: '/plugin/version',
        method: 'GET',
      }),
      res as unknown as NextApiResponse,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Proxy request failed',
      details: 'Redirect destination is not allowed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects if fetch throws due to redirect: error', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch: redirect occurred'));
    vi.stubGlobal('fetch', fetchMock);

    const res = new MockResponse();
    await handler(
      makeReq({
        serverUrl: 'https://books.example.com',
        endpoint: '/plugin/version',
        method: 'GET',
      }),
      res as unknown as NextApiResponse,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'Proxy request failed',
      }),
    );
  });

  it('proxies valid JSON routes correctly with safe headers and redirect=error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', serverVersion: '2.5.0' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = new MockResponse();
    await handler(
      makeReq({
        serverUrl: 'https://books.example.com',
        endpoint: '/plugin/collections/42/books',
        method: 'GET',
        headers: {
          'X-Auth-User': 'reader',
          'X-Auth-Key': 'hash',
          Host: 'spoofed.host',
          Cookie: 'token=stolen',
        },
      }),
      res as unknown as NextApiResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'ok', serverVersion: '2.5.0' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [targetUrl, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(targetUrl).toBe('https://books.example.com/api/v1/koreader/plugin/collections/42/books');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({
      'X-Auth-User': 'reader',
      'X-Auth-Key': 'hash',
      Accept: 'application/json',
    });
  });

  it('proxies valid manifest JSON route correctly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ schema: 'bookorbit.catalog-manifest', version: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = new MockResponse();
    await handler(
      makeReq({
        serverUrl: 'https://books.example.com',
        endpoint: '/plugin/catalog/manifest',
        method: 'GET',
      }),
      res as unknown as NextApiResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ schema: 'bookorbit.catalog-manifest', version: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://books.example.com/api/v1/koreader/plugin/catalog/manifest',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('streams dedicated binary download without JSON parsing or giant buffering', async () => {
    const rawBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]);
    const webStream = new ReadableStream({
      start(controller) {
        controller.enqueue(rawBytes);
        controller.close();
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/epub+zip',
        'content-length': '8',
        'content-disposition': 'attachment; filename="book.epub"',
      }),
      body: webStream,
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = new MockResponse();
    await handler(
      makeReq({
        serverUrl: 'https://books.example.com',
        endpoint: '/plugin/catalog/files/101/download',
        method: 'GET',
        headers: {
          'X-Auth-User': 'reader',
          'X-Auth-Key': 'hash',
        },
      }),
      res as unknown as NextApiResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('cache-control')).toBe('no-store');
    expect(res.getHeader('content-type')).toBe('application/epub+zip');
    expect(res.getHeader('content-length')).toBe('8');
    expect(res.getHeader('content-disposition')).toBe('attachment; filename="book.epub"');

    // Wait for the stream to pipe into the mock response
    await new Promise((resolve) => setTimeout(resolve, 50));
    const receivedBuffer = Buffer.concat(res.chunks);
    expect(receivedBuffer).toEqual(Buffer.from(rawBytes));

    const [targetUrl, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(targetUrl).toBe(
      'https://books.example.com/api/v1/koreader/plugin/catalog/files/101/download',
    );
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual(
      expect.objectContaining({
        'X-Auth-User': 'reader',
        'X-Auth-Key': 'hash',
        Accept: 'application/octet-stream, application/epub+zip, application/pdf, */*',
      }),
    );
  });

  it('forwards error status and message when binary download fails upstream', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ message: 'Book file not found' }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = new MockResponse();
    await handler(
      makeReq({
        serverUrl: 'https://books.example.com',
        endpoint: '/plugin/catalog/files/999/download',
        method: 'GET',
      }),
      res as unknown as NextApiResponse,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ message: 'Book file not found' });
  });
});
