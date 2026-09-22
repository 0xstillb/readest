import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { GrimmLinkSettings } from '@/types/settings';
import { normalizeCustomHeaders } from '@/utils/customHeaders';
import { isLanAddress } from '@/utils/network';
import { getAPIBaseUrl, isTauriAppPlatform } from '../environment';
import { GrimmLinkRequestError, type GrimmLinkErrorCategory } from './GrimmLinkRequestError';
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

/** Transport policy for GrimmLink. Keep these values explicit and auditable. */
export const GRIMMLINK_REQUEST_TIMEOUT_MS = 15_000;
export const GRIMMLINK_DOWNLOAD_TIMEOUT_MS = 120_000;
export const GRIMMLINK_MAX_RETRIES = 3;
export const GRIMMLINK_RETRY_BACKOFF_MS = [250, 500, 1_000] as const;

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

const isRetryableStatus = (status: number): boolean =>
  RETRYABLE_STATUSES.has(status) || status >= 500;

const retryAfterMs = (response: Response): number | undefined => {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(10_000, Math.max(0, timestamp - Date.now()))
    : undefined;
};

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
    ? response.capabilities.filter(
        (capability): capability is string => typeof capability === 'string',
      )
    : [];
  const add = (capability: string, enabled: unknown) => {
    if (enabled === true && !capabilities.some((item) => item.toLowerCase() === capability))
      capabilities.push(capability);
  };
  add('progress', response.progressSync);
  add('sessions', response.readingSessions);
  add('metadata', response.metadataSync);
  add('shelves', response.shelves);

  // Read status is a core Grimmory v1 endpoint, but its legacy capability
  // response omitted a corresponding boolean.  The endpoint itself still
  // advertises its accepted statuses before any write is queued.
  if (
    response.apiVersion === 'v1' &&
    !capabilities.some((item) => item.toLowerCase() === 'read-status')
  ) {
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
  const filename =
    nonEmptyString(value.filename) ??
    nonEmptyString(value.fileName) ??
    nonEmptyString(value.originalFileName) ??
    (extension ? `book-${value.bookId}.${extension}` : `book-${value.bookId}`);
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

const errorCategoryForStatus = (status: number): GrimmLinkErrorCategory => {
  if (status === 401 || status === 403) return 'auth';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'invalid-data';
  return 'server';
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

  private allowsInvalidCertificate(serverUrl: string): boolean {
    // Never let a persisted flag weaken public/Tunnel TLS.  The exception is
    // deliberately restricted to a private endpoint and is opt-in.
    return this.config.allowSelfSignedCertificate === true && isLanAddress(serverUrl);
  }

  private async send(
    serverUrl: string,
    endpoint: string,
    method: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers = this.headers();
    if (body) headers['Content-Type'] = 'application/json';
    if (isLanAddress(serverUrl) || isTauriAppPlatform()) {
      const request = isTauriAppPlatform() ? tauriFetch : window.fetch;
      const danger = this.allowsInvalidCertificate(serverUrl)
        ? { acceptInvalidCerts: true, acceptInvalidHostnames: true }
        : undefined;
      return await request(`${serverUrl}${API_PREFIX}${endpoint}`, {
        method,
        headers,
        body,
        signal,
        ...(danger ? { danger } : {}),
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

  private async requestWithTimeout(
    serverUrl: string,
    endpoint: string,
    method: string,
    body: string | undefined,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.send(serverUrl, endpoint, method, body, controller.signal);
    } catch (cause) {
      if (cause instanceof GrimmLinkRequestError) throw cause;
      if (signal?.aborted) throw new GrimmLinkRequestError('transport', 'Request was cancelled.');
      if (controller.signal.aborted) {
        throw new GrimmLinkRequestError('transport', `Request timed out after ${timeoutMs} ms.`);
      }
      throw new GrimmLinkRequestError('transport', 'Network request failed.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private async requestWithRetry(
    serverUrl: string,
    endpoint: string,
    method: string,
    body: string | undefined,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    let lastError: GrimmLinkRequestError | undefined;
    for (let attempt = 0; attempt <= GRIMMLINK_MAX_RETRIES; attempt += 1) {
      try {
        const response = await this.requestWithTimeout(
          serverUrl,
          endpoint,
          method,
          body,
          signal,
          timeoutMs,
        );
        if (attempt < GRIMMLINK_MAX_RETRIES && isRetryableStatus(response.status)) {
          const delay =
            retryAfterMs(response) ??
            GRIMMLINK_RETRY_BACKOFF_MS[attempt] ??
            GRIMMLINK_RETRY_BACKOFF_MS.at(-1)!;
          await this.waitBeforeRetry(delay, signal);
          continue;
        }
        return response;
      } catch (error) {
        lastError =
          error instanceof GrimmLinkRequestError
            ? error
            : new GrimmLinkRequestError('transport', 'Network request failed.');
        if (attempt >= GRIMMLINK_MAX_RETRIES || lastError.category !== 'network') throw lastError;
        await this.waitBeforeRetry(
          GRIMMLINK_RETRY_BACKOFF_MS[attempt] ?? GRIMMLINK_RETRY_BACKOFF_MS.at(-1)!,
          signal,
        );
      }
    }
    throw lastError ?? new GrimmLinkRequestError('transport', 'Network request failed.');
  }

  private async waitBeforeRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new GrimmLinkRequestError('transport', 'Request was cancelled.');
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let abort: () => void;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const finish = () => {
        cleanup();
        resolve();
      };
      timer = setTimeout(finish, delayMs);
      abort = () => {
        clearTimeout(timer);
        cleanup();
        reject(new GrimmLinkRequestError('transport', 'Request was cancelled.'));
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private async requestWithFallback(
    endpoint: string,
    method: string,
    body: string | undefined,
    signal?: AbortSignal,
    timeoutMs = GRIMMLINK_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    try {
      return await this.requestWithRetry(this.serverUrl, endpoint, method, body, signal, timeoutMs);
    } catch (error) {
      if (
        !(error instanceof GrimmLinkRequestError) ||
        error.category !== 'network' ||
        !this.fallbackUrl
      )
        throw error;
      return await this.requestWithRetry(
        this.fallbackUrl,
        endpoint,
        method,
        body,
        signal,
        timeoutMs,
      );
    }
  }

  private async requestJson<T>(
    endpoint: string,
    method = 'GET',
    body?: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const serializedBody = body ? JSON.stringify(body) : undefined;
    const response = await this.requestWithFallback(endpoint, method, serializedBody, signal);
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const message =
        data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
          ? data.message
          : data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : `GrimmLink request failed with status ${response.status}`;
      throw new GrimmLinkRequestError(
        errorKindForStatus(response.status),
        message,
        response.status,
        errorCategoryForStatus(response.status),
      );
    }
    try {
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object') throw new Error('Expected JSON data');
      return data as T;
    } catch {
      throw new GrimmLinkRequestError(
        'response',
        'Invalid data: expected a JSON response from GrimmLink.',
        response.status,
      );
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
      const data = await this.requestJson<GrimmLinkBookLink>(
        `/books/by-hash/${encodeURIComponent(bookHash)}`,
      );
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
    const params = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    );
    return this.requestJson(`/syncs/metadata?${params.toString()}`);
  }

  async getShelves(type: GrimmLinkShelfType): Promise<GrimmLinkShelf[]> {
    const data = await this.requestJson<{ shelves?: GrimmLinkShelf[] } | GrimmLinkShelf[]>(
      `/shelves?type=${type}`,
    );
    const shelves = Array.isArray(data) ? data : data.shelves;
    if (!Array.isArray(shelves)) {
      throw new GrimmLinkRequestError('response', 'Invalid data: Grimmory returned no shelf list.');
    }
    if (
      shelves.some(
        (shelf) => !shelf || !Number.isFinite(shelf.id) || typeof shelf.name !== 'string',
      )
    ) {
      throw new GrimmLinkRequestError(
        'response',
        'Invalid data: Grimmory returned a malformed shelf.',
      );
    }
    return shelves.map((shelf) => ({ ...shelf, type }));
  }

  async getShelfBooks(type: GrimmLinkShelfType, shelfId: number): Promise<GrimmLinkShelfBook[]> {
    const data = await this.requestJson<
      { books?: GrimmoryShelfBookResponse[] } | GrimmoryShelfBookResponse[]
    >(`/shelves/${type}/${shelfId}/books`);
    const books = Array.isArray(data) ? data : data.books;
    if (!Array.isArray(books)) {
      throw new GrimmLinkRequestError(
        'response',
        'Invalid data: Grimmory returned no shelf books.',
      );
    }
    const normalized = books.map(normalizeShelfBook);
    if (normalized.some((book) => book === null)) {
      throw new GrimmLinkRequestError(
        'response',
        'Invalid data: Grimmory returned a malformed shelf book.',
      );
    }
    return normalized as GrimmLinkShelfBook[];
  }

  async downloadShelfBook(
    bookId: number,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const response = await this.requestWithFallback(
      `/books/${bookId}/download`,
      'GET',
      undefined,
      signal,
      GRIMMLINK_DOWNLOAD_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new GrimmLinkRequestError(
        errorKindForStatus(response.status),
        `GrimmLink download failed with status ${response.status}`,
        response.status,
        errorCategoryForStatus(response.status),
      );
    }
    if (!response.body || !onProgress)
      return this.withTimeout(response.arrayBuffer(), GRIMMLINK_DOWNLOAD_TIMEOUT_MS);
    return this.withTimeout(
      (async () => {
        const total = Number(
          response.headers.get('content-length') ?? response.headers.get('x-content-length') ?? 0,
        );
        const reader = response.body!.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        const startedAt = Date.now();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value);
          received += value.byteLength;
          onProgress({
            progress: received,
            total,
            transferSpeed: received / Math.max(1, (Date.now() - startedAt) / 1000),
          });
        }
        const combined = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return combined.buffer;
      })(),
      GRIMMLINK_DOWNLOAD_TIMEOUT_MS,
    );
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new GrimmLinkRequestError('transport', `Request timed out after ${timeoutMs} ms.`),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    if (!isTauriAppPlatform())
      throw new GrimmLinkRequestError('transport', 'Native download is unavailable.');
    if (signal?.aborted) throw new Error('Download aborted');

    const download = async (serverUrl: string) => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= GRIMMLINK_MAX_RETRIES; attempt += 1) {
        try {
          await this.withTimeout(
            tauriDownload(
              `${serverUrl}${API_PREFIX}/books/${bookId}/download`,
              filePath,
              onProgress,
              this.headers(),
              undefined,
              false,
              this.allowsInvalidCertificate(serverUrl),
            ),
            GRIMMLINK_DOWNLOAD_TIMEOUT_MS,
          );
          return;
        } catch (error) {
          lastError = error;
          if (signal?.aborted || attempt >= GRIMMLINK_MAX_RETRIES) throw error;
          await this.waitBeforeRetry(
            GRIMMLINK_RETRY_BACKOFF_MS[attempt] ?? GRIMMLINK_RETRY_BACKOFF_MS.at(-1)!,
            signal,
          );
        }
      }
      throw (
        lastError ??
        new GrimmLinkRequestError('transport', 'Network request failed while downloading the book.')
      );
    };

    try {
      await download(this.serverUrl);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!this.fallbackUrl) throw error;
      try {
        await download(this.fallbackUrl);
      } catch {
        throw new GrimmLinkRequestError(
          'transport',
          'Network request failed while downloading the book.',
        );
      }
    }
    if (signal?.aborted) throw new Error('Download aborted');
  }

  async connect(): Promise<GrimmLinkConnectionResult> {
    try {
      await this.authenticate();
      const { capabilities } = await this.getCapabilities();
      return { success: true, capabilities: Array.isArray(capabilities) ? capabilities : [] };
    } catch (cause) {
      return {
        success: false,
        message: cause instanceof Error ? cause.message : 'Connection error.',
        errorCategory: cause instanceof GrimmLinkRequestError ? cause.category : 'network',
      };
    }
  }
}
