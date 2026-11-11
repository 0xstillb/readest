import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { isLanAddress } from '@/utils/network';
import { publicFetch } from '@/utils/publicFetch';
import type { GrimmLinkProxyPayload } from '@/services/grimmlink/types';

const allowedRequests: ReadonlyArray<readonly [string, RegExp]> = [
  ['POST', /^\/auth\/session$/],
  ['DELETE', /^\/auth\/session$/],
  ['GET', /^\/capabilities$/],
  ['GET', /^\/books\/resolve\?hash=[^#]+$/],
  ['GET', /^\/books\/[^/]+\/content(?:\?[^#]*)?$/],
  ['GET', /^\/books\/[^/]+\/hash$/],
  ['GET', /^\/books\/read-statuses$/],
  ['PUT', /^\/books\/[^/]+\/status$/],
  ['GET', /^\/books\/[^/]+\/metadata$/],
  ['PUT', /^\/books\/[^/]+\/metadata$/],
  ['GET', /^\/shelves$/],
  ['GET', /^\/shelves\/[^/]+\/items(?:\?[^#]*)?$/],
  ['PUT', /^\/shelves\/[^/]+\/items\/[^/]+$/],
  ['DELETE', /^\/shelves\/[^/]+\/items\/[^/]+$/],
  ['GET', /^\/progress\/[^/]+(?:\?[^#]*)?$/],
  ['PUT', /^\/progress\/[^/]+$/],
  ['POST', /^\/reading-sessions$/],
  ['POST', /^\/reading-sessions\/batch$/],
  ['GET', /^\/syncs\/metadata(?:\?[^#]*)?$/],
  ['POST', /^\/syncs\/metadata$/],
  ['POST', /^\/syncs\/metadata\/batch$/],
];

const PROXY_TIMEOUT_MS = 15_000;
const PROXY_DOWNLOAD_TIMEOUT_MS = 120_000;

export const isValidGrimmLinkRequest = (endpoint: string, method: string): boolean =>
  allowedRequests.some(
    ([allowedMethod, pattern]) => allowedMethod === method && pattern.test(endpoint),
  );

const allowedHeader = (name: string): boolean =>
  [
    'x-auth-user',
    'x-auth-key',
    'authorization',
    'idempotency-key',
    'cf-access-client-id',
    'cf-access-client-secret',
  ].includes(name.toLowerCase());

const safeHeaders = (headers?: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => allowedHeader(name)));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { serverUrl, endpoint, method, headers, body } = req.body as GrimmLinkProxyPayload;
  if (!serverUrl || !endpoint || !method) {
    return res.status(400).json({ error: 'serverUrl, endpoint, and method are required' });
  }
  if (!isValidGrimmLinkRequest(endpoint, method))
    return res.status(400).json({ error: 'Invalid request' });

  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid serverUrl' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || isLanAddress(parsed.toString())) {
    return res
      .status(400)
      .json({ error: 'Requests to private/internal addresses are not allowed' });
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let streamActive = false;
  try {
    const controller = new AbortController();
    const isDownload = endpoint.includes('/content') || endpoint.endsWith('/download');
    const timeoutMs = isDownload ? PROXY_DOWNLOAD_TIMEOUT_MS : PROXY_TIMEOUT_MS;
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await publicFetch(`${parsed.origin}/api/grimmlink/v2${endpoint}`, {
      method,
      headers: {
        ...safeHeaders(headers),
        Accept: isDownload ? 'application/octet-stream' : 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    // The proxy forwards the Adapter credentials, so it must never follow a
    // redirect to another host.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('GrimmLink proxy refused a redirect');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(response.status);
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (!response.body) return res.end();
    streamActive = true;
    const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const clearStreamTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
    };
    stream.once('end', clearStreamTimeout);
    stream.once('error', clearStreamTimeout);
    res.once('close', clearStreamTimeout);
    stream.pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).json({ error: 'GrimmLink proxy request failed' });
    else res.destroy();
  } finally {
    if (!streamActive && timeout) clearTimeout(timeout);
  }
}
