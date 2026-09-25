import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { isBlockedHost, isLanAddress } from '@/utils/network';
import type { BookOrbitProxyPayload } from '@/types/bookorbit';

const PROXY_TIMEOUT_MS = 15_000;
const PROXY_DOWNLOAD_TIMEOUT_MS = 120_000;

// Core plugin JSON endpoints
const coreJsonEndpoints: ReadonlyArray<RegExp> = [
  /^\/users\/auth$/,
  /^\/plugin\/version$/,
  /^\/plugin\/match-check$/,
  /^\/plugin\/annotations\/exchange(-ack)?$/,
  /^\/plugin\/bookmarks\/exchange(-ack)?$/,
  /^\/plugin\/page-stats$/,
  /^\/plugin\/book-states$/,
];

// Exact JSON routes for collections and smart-scopes
// Shelf identifiers are strictly alphanumeric/hyphen/underscore (rejects traversal, slashes, query params)
const shelfJsonEndpoints: ReadonlyArray<RegExp> = [
  /^\/plugin\/collections$/,
  /^\/plugin\/collections\/[a-zA-Z0-9_-]+$/,
  /^\/plugin\/collections\/[a-zA-Z0-9_-]+\/books$/,
  /^\/collections$/,
  /^\/collections\/[a-zA-Z0-9_-]+$/,
  /^\/collections\/[a-zA-Z0-9_-]+\/books$/,
  /^\/plugin\/smartscopes$/,
  /^\/plugin\/smartscopes\/[a-zA-Z0-9_-]+$/,
  /^\/plugin\/smartscopes\/[a-zA-Z0-9_-]+\/books$/,
  /^\/plugin\/smart-scopes$/,
  /^\/plugin\/smart-scopes\/[a-zA-Z0-9_-]+$/,
  /^\/plugin\/smart-scopes\/[a-zA-Z0-9_-]+\/books$/,
  /^\/smartscopes$/,
  /^\/smartscopes\/[a-zA-Z0-9_-]+$/,
  /^\/smartscopes\/[a-zA-Z0-9_-]+\/books$/,
  /^\/smart-scopes$/,
  /^\/smart-scopes\/[a-zA-Z0-9_-]+$/,
  /^\/smart-scopes\/[a-zA-Z0-9_-]+\/books$/,
];

// Exact JSON routes for manifest (no broad catalog wildcard)
const manifestJsonEndpoints: ReadonlyArray<RegExp> = [
  /^\/plugin\/catalog\/manifest$/,
  /^\/plugin\/manifest$/,
  /^\/manifest$/,
];

// Dedicated binary download route with strict numeric id
const binaryDownloadEndpoint = /^\/plugin\/catalog\/files\/\d+\/download$/;

export const isBookOrbitDownloadEndpoint = (endpoint: string): boolean =>
  binaryDownloadEndpoint.test(endpoint);

export const isValidBookOrbitEndpoint = (endpoint: string): boolean => {
  if (!endpoint || typeof endpoint !== 'string') return false;

  // Reject path traversal, backslashes, double slashes, query strings, and fragments
  if (
    endpoint.includes('..') ||
    endpoint.includes('\\') ||
    endpoint.includes('//') ||
    endpoint.includes('?') ||
    endpoint.includes('#')
  ) {
    return false;
  }

  // Check URL-decoded form to prevent %2e%2e or other percent-encoded injections
  try {
    const decoded = decodeURIComponent(endpoint);
    if (
      decoded.includes('..') ||
      decoded.includes('\\') ||
      decoded.includes('//') ||
      decoded.includes('?') ||
      decoded.includes('#')
    ) {
      return false;
    }
  } catch {
    return false;
  }

  return (
    coreJsonEndpoints.some((re) => re.test(endpoint)) ||
    shelfJsonEndpoints.some((re) => re.test(endpoint)) ||
    manifestJsonEndpoints.some((re) => re.test(endpoint)) ||
    binaryDownloadEndpoint.test(endpoint)
  );
};

const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cookie',
  'set-cookie',
  'content-length',
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const isSafeHeader = (name: string, value: string): boolean => {
  const lower = name.toLowerCase().trim();
  if (FORBIDDEN_HEADERS.has(lower)) return false;
  if (!HEADER_NAME_PATTERN.test(name.trim())) return false;
  // Prevent CRLF injection or control characters in header values
  if (/[\r\n\0]/.test(value)) return false;
  return true;
};

export const safeHeaders = (headers?: Record<string, string>): Record<string, string> => {
  if (!headers || typeof headers !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && isSafeHeader(key, value)) {
      result[key.trim()] = value.trim();
    }
  }
  return result;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const {
    serverUrl,
    endpoint,
    method = 'GET',
    headers: clientHeaders,
    body: clientBody,
  } = (req.body || {}) as BookOrbitProxyPayload;

  if (!serverUrl || !endpoint) {
    return res.status(400).json({ error: 'serverUrl and endpoint are required' });
  }

  if (!isValidBookOrbitEndpoint(endpoint)) {
    return res.status(400).json({ error: 'Invalid endpoint' });
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(serverUrl);
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only http and https URLs are allowed' });
    }
    if (
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash ||
      (baseUrl.pathname !== '/' && baseUrl.pathname !== '')
    ) {
      return res.status(400).json({ error: 'Invalid serverUrl' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid serverUrl' });
  }

  if (isLanAddress(serverUrl) || isBlockedHost(baseUrl.hostname)) {
    return res
      .status(400)
      .json({ error: 'Requests to private/internal addresses are not allowed' });
  }

  const targetUrl = `${baseUrl.origin}/api/v1/koreader${endpoint}`;
  if (isLanAddress(targetUrl)) {
    return res
      .status(400)
      .json({ error: 'Requests to private/internal addresses are not allowed' });
  }

  const isDownload = isBookOrbitDownloadEndpoint(endpoint);
  const timeoutMs = isDownload ? PROXY_DOWNLOAD_TIMEOUT_MS : PROXY_TIMEOUT_MS;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );
  let streamActive = false;

  try {
    const forwardHeaders: Record<string, string> = {
      ...safeHeaders(clientHeaders),
      Accept: isDownload
        ? 'application/octet-stream, application/epub+zip, application/pdf, */*'
        : 'application/json',
    };

    const upperMethod = (method || 'GET').toUpperCase();
    if (upperMethod !== 'GET' && upperMethod !== 'HEAD') {
      forwardHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetch(targetUrl, {
      method: upperMethod,
      headers: forwardHeaders,
      body:
        clientBody && upperMethod !== 'GET' && upperMethod !== 'HEAD'
          ? JSON.stringify(clientBody)
          : undefined,
      // Never follow redirects: a public server answering 3xx could steer the
      // proxy onto a private address that the isLanAddress gate above already
      // rejected (redirect-based SSRF).
      redirect: 'error',
      signal: controller.signal,
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      return res.status(500).json({
        error: 'Proxy request failed',
        details: 'Redirect destination is not allowed',
      });
    }

    if (isDownload) {
      if (!response.ok) {
        const errorText = await response.text();
        res.status(response.status);
        try {
          return res.json(JSON.parse(errorText));
        } catch {
          return res.send(errorText);
        }
      }

      res.status(response.status);
      res.setHeader('Cache-Control', 'no-store');
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      const contentLength = response.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      const contentDisposition = response.headers.get('content-disposition');
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);

      if (!response.body) {
        return res.end();
      }

      streamActive = true;
      const clearStreamTimeout = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      };
      res.once('close', clearStreamTimeout);

      if (response.body && 'pipe' in response.body && typeof response.body.pipe === 'function') {
        const nodeStream = response.body as unknown as NodeJS.ReadableStream;
        nodeStream.once('end', clearStreamTimeout);
        nodeStream.once('error', clearStreamTimeout);
        nodeStream.pipe(res);
        return;
      }

      const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
      stream.once('end', clearStreamTimeout);
      stream.once('error', clearStreamTimeout);
      stream.pipe(res);
      return;
    }

    const data = await response.text();
    res.status(response.status);
    try {
      res.json(JSON.parse(data));
    } catch {
      res.send(data);
    }
  } catch (error) {
    console.error('[BOOKORBIT PROXY] Error:', error);
    if (!res.headersSent) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      res.status(500).json({ error: 'Proxy request failed', details: errorMessage });
    } else {
      res.destroy();
    }
  } finally {
    if (!streamActive && timeout) {
      clearTimeout(timeout);
    }
  }
}
