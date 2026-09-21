import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { GrimmLinkSettings } from '@/types/settings';
import { normalizeCustomHeaders } from '@/utils/customHeaders';
import { isLanAddress } from '@/utils/network';
import { getAPIBaseUrl, isTauriAppPlatform } from '../environment';
import { GrimmLinkRequestError } from './GrimmLinkRequestError';
import type { ProgressHandler } from '@/utils/transfer';
import { tauriDownload } from '@/utils/transfer';
import type {
  GrimmLinkBookLink,
  GrimmLinkCapabilities,
  GrimmLinkConnectionResult,
  GrimmLinkProgress,
  GrimmLinkProxyPayload,
  GrimmLinkShelf,
  GrimmLinkShelfBook,
  GrimmLinkShelfType,
} from './types';

const API_PREFIX = '/api/grimmlink/v1';

type GrimmoryShelfBookResponse = Partial<GrimmLinkShelfBook> & {
  fileName?: unknown;
  originalFileName?: unknown;
  fileFormat?: unknown;
  fileSize?: unknown;
  fileSizeKb?: unknown;
  extension?: unknown;
};

/**
 * Grimmory v1 originally advertised features as individual boolean fields,
 * while newer GrimmLink peers use a `capabilities` array.  Keep accepting
 * both contracts so an older Grimmory server does not silently disable a
 * feature that its v1 endpoints already support.
 */
type GrimmoryCapabilitiesResponse = {
  capabilities?: unknown;
  apiVersion?: unknown;
  progressSync?: unknown;
  readingSessions?: unknown;
  metadataSync?: unknown;
  shelves?: unknown;
};

const normalizeCapabilities = (response: GrimmoryCapabilitiesResponse): string[] => {
  const capabilities = Array.isArray(response.capabilities)
    ? response.capabilities.filter((capability): capability is string => typeof capability === 'string')
    : [];
  const add = (capability: string, enabled: unknown) => {
    if (enabled === true && !capabilities.some((item) => item.toLowerCase() === capability)) capabilities.push(capability);
  };
  add('progress', response.progressSync);
  add('sessions', response.readingSessions);
  add('metadata', response.metadataSync);
  add('shelves', response.shelves);

  // Read status is a core Grimmory v1 endpoint, but its legacy capability
  // response omitted a corresponding boolean.  The endpoint itself still
  // advertises its accepted statuses before any write is queued.
  if (response.apiVersion === 'v1' && !capabilities.some((item) => item.toLowerCase() === 'read-status')) {
    capabilities.push('read-status');
  }
  return capabilities;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Normalize the field names used by Grimmory's shelf-book DTO to Readest's provider model. */
const normalizeShelfBook = (value: GrimmoryShelfBookResponse): GrimmLinkShelfBook | null => {
  if (!Number.isFinite(value.bookId) || !nonEmptyString(value.bookHash)) return null;
  const extension = nonEmptyString(value.extension);
  const filename = nonEmptyString(value.filename)
    ?? nonEmptyString(value.fileName)
    ?? nonEmptyString(value.originalFileName)
    ?? (extension ? `book-${value.bookId}.${extension}` : `book-${value.bookId}`);
  return {
    bookId: value.bookId!,
    bookHash: nonEmptyString(value.bookHash)!,
    filename,
    format: nonEmptyString(value.format) ?? nonEmptyString(value.fileFormat) ?? extension ?? '',
    // Grimmory derives these fields from its integer-KB database column, so
    // `fileSize` is not necessarily the exact byte count sent by download.
    // Keep the binary signature validation, but never reject a valid file for
    // that rounded metadata value.
    size: undefined,
    title: nonEmptyString(value.title),
    author: nonEmptyString(value.author),
  };
};

const errorKindForStatus = (status: number): GrimmLinkRequestError['kind'] => {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 400 || status === 422) return 'validation';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  return 'response';
};

export { GrimmLinkRequestError } from './GrimmLinkRequestError';

export class GrimmLinkClient {
  private readonly serverUrl: string;
  private readonly fallbackUrl?: string;

  constructor(private readonly config: GrimmLinkSettings) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, '');
    this.fallbackUrl = config.fallbackUrl?.replace(/\/+$/, '') || undefined;
  }

  private headers(): Record<string, string> {
    return {
      ...normalizeCustomHeaders(this.config.customHeaders),
      Accept: 'application/json',
      'X-Auth-User': this.config.username,
      'X-Auth-Key': this.config.userkey,
    };
  }

  private async send(serverUrl: string, endpoint: string, method: string, body?: string, signal?: AbortSignal): Promise<Response> {
    const headers = this.headers();
    if (body) headers['Content-Type'] = 'application/json';
    if (isLanAddress(serverUrl) || isTauriAppPlatform()) {
      const request = isTauriAppPlatform() ? tauriFetch : window.fetch;
      return await request(`${serverUrl}${API_PREFIX}${endpoint}`, {
        method,
        headers,
        body,
        signal,
        danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
      });
    }
    const payload: GrimmLinkProxyPayload = {
      serverUrl,
      endpoint,
      method,
      headers,
      body: body ? (JSON.parse(body) as Record<string, unknown>) : undefined,
    };
    return await fetch(`${getAPIBaseUrl()}/grimmlink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  }

  private async requestJson<T>(endpoint: string, method = 'GET', body?: object): Promise<T> {
    const serializedBody = body ? JSON.stringify(body) : undefined;
    let response: Response;
    try {
      response = await this.send(this.serverUrl, endpoint, method, serializedBody);
    } catch (_cause) {
      if (!this.fallbackUrl) throw new GrimmLinkRequestError('transport', 'Connection error.');
      try {
        response = await this.send(this.fallbackUrl, endpoint, method, serializedBody);
      } catch {
        throw new GrimmLinkRequestError('transport', 'Connection error.');
      }
    }
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const message =
        data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
          ? data.message
          : `GrimmLink request failed with status ${response.status}`;
      throw new GrimmLinkRequestError(errorKindForStatus(response.status), message, response.status);
    }
    try {
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object') throw new Error('Expected JSON object');
      return data as T;
    } catch {
      throw new GrimmLinkRequestError('response', 'Expected a JSON response from GrimmLink.', response.status);
    }
  }

  authenticate(): Promise<Record<string, unknown>> {
    return this.requestJson('/auth');
  }

  async getCapabilities(): Promise<GrimmLinkCapabilities> {
    const response = await this.requestJson<GrimmoryCapabilitiesResponse>('/capabilities');
    return { capabilities: normalizeCapabilities(response) };
  }

  async matchBook(bookHash: string): Promise<GrimmLinkBookLink | null> {
    try {
      const data = await this.requestJson<GrimmLinkBookLink>(`/books/by-hash/${encodeURIComponent(bookHash)}`);
      return typeof data.bookId === 'number' ? data : null;
    } catch (error) {
      if (error instanceof GrimmLinkRequestError && error.kind === 'not-found') return null;
      throw error;
    }
  }

  async getProgress(bookHash: string): Promise<GrimmLinkProgress | null> {
    try {
      const progress = await this.requestJson<GrimmLinkProgress>(
        `/syncs/progress/${encodeURIComponent(bookHash)}`,
      );
      const hasPosition =
        (typeof progress.location === 'string' && progress.location.length > 0) ||
        (typeof progress.progress === 'string' && progress.progress.length > 0) ||
        (typeof progress.percentage === 'number' && Number.isFinite(progress.percentage)) ||
        typeof progress.currentPage === 'number';
      return hasPosition ? progress : null;
    } catch (error) {
      if (error instanceof GrimmLinkRequestError && error.kind === 'not-found') return null;
      throw error;
    }
  }

  updateProgress(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson('/syncs/progress', 'PUT', payload);
  }

  postSessionBatch(payload: object): Promise<Record<string, unknown>> {
    return this.requestJson('/reading-sessions/batch', 'POST', payload);
  }

  getReadStatuses(): Promise<{ statuses: string[] }> {
    return this.requestJson('/books/read-statuses');
  }

  updateReadStatus(bookId: number, status: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/books/${bookId}/status`, 'PUT', { status });
  }

  syncMetadata(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson('/syncs/metadata/batch', 'POST', payload);
  }

  getMetadata(query: Record<string, string | number>): Promise<Record<string, unknown>> {
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    return this.requestJson(`/syncs/metadata?${params.toString()}`);
  }

  async getShelves(type: GrimmLinkShelfType): Promise<GrimmLinkShelf[]> {
    const data = await this.requestJson<{ shelves?: GrimmLinkShelf[] } | GrimmLinkShelf[]>(`/shelves?type=${type}`);
    const shelves = Array.isArray(data) ? data : data.shelves;
    return Array.isArray(shelves)
      ? shelves.filter((shelf) => Number.isFinite(shelf.id) && typeof shelf.name === 'string').map((shelf) => ({ ...shelf, type }))
      : [];
  }

  async getShelfBooks(type: GrimmLinkShelfType, shelfId: number): Promise<GrimmLinkShelfBook[]> {
    const data = await this.requestJson<{ books?: GrimmoryShelfBookResponse[] } | GrimmoryShelfBookResponse[]>(`/shelves/${type}/${shelfId}/books`);
    const books = Array.isArray(data) ? data : data.books;
    return Array.isArray(books) ? books.map(normalizeShelfBook).filter((book): book is GrimmLinkShelfBook => book !== null) : [];
  }

  async downloadShelfBook(bookId: number, onProgress?: ProgressHandler, signal?: AbortSignal): Promise<ArrayBuffer> {
    let response: Response;
    try {
      response = await this.send(this.serverUrl, `/books/${bookId}/download`, 'GET', undefined, signal);
    } catch {
      if (!this.fallbackUrl) throw new GrimmLinkRequestError('transport', 'Connection error.');
      response = await this.send(this.fallbackUrl, `/books/${bookId}/download`, 'GET', undefined, signal);
    }
    if (!response.ok) throw new GrimmLinkRequestError(errorKindForStatus(response.status), `GrimmLink download failed with status ${response.status}`, response.status);
    if (!response.body || !onProgress) return response.arrayBuffer();
    const total = Number(response.headers.get('content-length') ?? response.headers.get('x-content-length') ?? 0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    const startedAt = Date.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress({ progress: received, total, transferSpeed: received / Math.max(1, (Date.now() - startedAt) / 1000) });
    }
    const combined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    return combined.buffer;
  }

  /**
   * Stream a shelf book straight to a native file.  Android WebViews have a
   * relatively small and fragile IPC/memory budget; buffering the response in
   * JS and then copying it into a Temp file briefly holds two full copies of a
   * book (plus parser allocations).  The native downloader writes incrementally
   * and reports progress through the same channel used by other transfers.
   */
  async downloadShelfBookToFile(
    bookId: number,
    filePath: string,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isTauriAppPlatform()) throw new GrimmLinkRequestError('transport', 'Native download is unavailable.');
    if (signal?.aborted) throw new Error('Download aborted');

    const download = async (serverUrl: string) => {
      await tauriDownload(
        `${serverUrl}${API_PREFIX}/books/${bookId}/download`,
        filePath,
        onProgress,
        this.headers(),
        undefined,
        false,
        true,
      );
    };

    try {
      await download(this.serverUrl);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!this.fallbackUrl) throw error;
      await download(this.fallbackUrl);
    }
    if (signal?.aborted) throw new Error('Download aborted');
  }

  async connect(): Promise<GrimmLinkConnectionResult> {
    try {
      await this.authenticate();
      const { capabilities } = await this.getCapabilities();
      return { success: true, capabilities: Array.isArray(capabilities) ? capabilities : [] };
    } catch (cause) {
      return { success: false, message: cause instanceof Error ? cause.message : 'Connection error.' };
    }
  }
}
