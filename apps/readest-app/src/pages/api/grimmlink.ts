import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { isLanAddress } from '@/utils/network';
import type { GrimmLinkProxyPayload } from '@/services/grimmlink/types';

const allowedRequests: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/auth$/],
  ['GET', /^\/capabilities$/],
  ['GET', /^\/books\/by-hash\/[^/]+$/],
  ['GET', /^\/syncs\/progress\/[^/]+$/],
  ['PUT', /^\/syncs\/progress$/],
  ['POST', /^\/reading-sessions$/],
  ['POST', /^\/reading-sessions\/batch$/],
  ['GET', /^\/syncs\/metadata(?:\?[^#]*)?$/],
  ['POST', /^\/syncs\/metadata$/],
  ['POST', /^\/syncs\/metadata\/batch$/],
  ['GET', /^\/shelves$/],
  ['GET', /^\/shelves\/[^/]+\/books$/],
  ['GET', /^\/shelves\/(?:regular|magic)\/[^/]+\/books$/],
  ['GET', /^\/books\/[^/]+\/download$/],
  ['POST', /^\/shelves\/(?:regular|magic)\/[^/]+\/books\/[^/]+\/remove$/],
  ['GET', /^\/books\/read-statuses$/],
  ['PUT', /^\/books\/[^/]+\/status$/],
];

export const isValidGrimmLinkRequest = (endpoint: string, method: string): boolean =>
  allowedRequests.some(([allowedMethod, pattern]) => allowedMethod === method && pattern.test(endpoint));

const allowedHeader = (name: string): boolean =>
  ['x-auth-user', 'x-auth-key', 'cf-access-client-id', 'cf-access-client-secret'].includes(
    name.toLowerCase(),
  );

const safeHeaders = (headers?: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => allowedHeader(name)));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { serverUrl, endpoint, method, headers, body } = req.body as GrimmLinkProxyPayload;
  if (!serverUrl || !endpoint || !method) {
    return res.status(400).json({ error: 'serverUrl, endpoint, and method are required' });
  }
  if (!isValidGrimmLinkRequest(endpoint, method)) return res.status(400).json({ error: 'Invalid request' });

  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid serverUrl' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || isLanAddress(parsed.toString())) {
    return res.status(400).json({ error: 'Requests to private/internal addresses are not allowed' });
  }

  try {
    const response = await fetch(`${parsed.origin}/api/grimmlink/v1${endpoint}`, {
      method,
      headers: {
        ...safeHeaders(headers),
        Accept: endpoint.endsWith('/download') ? 'application/octet-stream' : 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(response.status);
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (!response.body) return res.end();
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);
  } catch {
    res.status(502).json({ error: 'GrimmLink proxy request failed' });
  }
}
