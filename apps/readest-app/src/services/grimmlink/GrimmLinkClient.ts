import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { GrimmLinkSettings } from '@/types/settings';
import { normalizeCustomHeaders } from '@/utils/customHeaders';
import { isLanAddress } from '@/utils/network';
import { getAPIBaseUrl, isTauriAppPlatform } from '../environment';
import { GrimmLinkRequestError, type GrimmLinkErrorCategory } from './GrimmLinkRequestError';
import { recordGrimmLinkPerformance } from './einkDiagnostics';
import { normalizeGrimmLinkProgressPayload } from './progress';
import type { ProgressHandler } from '@/utils/transfer';
import { tauriDownload } from '@/utils/transfer';
import type {
  GrimmLinkBookLink,
  GrimmLinkCapabilities,
  GrimmLinkConnectionResult,
  GrimmLinkProgress,
  GrimmLinkProxyPayload,
  GrimmLinkSession,
  GrimmLinkShelf,
  GrimmLinkShelfBook,
} from './types';

const API_PREFIX = '/api/grimmlink/v2';
/** The only v2 route that accepts the raw KOSync credentials instead of a session token. */
const SESSION_ENDPOINT = '/auth/session';
/** Refresh the Adapter session a minute before it expires. */
const SESSION_REFRESH_MARGIN_MS = 60_000;
/** Adapter v2 caps a shelf page at 100 items, whatever limit the client asks for. */
const SHELF_PAGE_SIZE = 100;
const SHELF_MAX_PAGES = 50;
/** How many shelf books may ask the Adapter for their hash at the same time. */
const SHELF_HASH_LOOKUP_CONCURRENCY = 5;

/** Transport policy for GrimmLink. Keep these values explicit and auditable. */
export const GRIMMLINK_REQUEST_TIMEOUT_MS = 15_000;
export const GRIMMLINK_DOWNLOAD_TIMEOUT_MS = 120_000;
export const GRIMMLINK_MAX_RETRIES = 3;
export const GRIMMLINK_RETRY_BACKOFF_MS = [250, 500, 1_000] as const;

export interface GrimmLinkHealthCheck {
  authentication: 'ok' | 'failed';
  capabilities: 'ok' | 'failed';
  progress: 'available' | 'unsupported';
  metadata: 'available' | 'unsupported';
  sessions: 'available' | 'unsupported';
  shelves: 'available' | 'unsupported' | 'failed';
  /** Magic shelves are read-only upstream and are not part of Adapter v2. */
  magicShelves: 'available' | 'unsupported';
  download: 'available' | 'unsupported';
  capabilityNames: string[];
}

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
  features?: {
    magicShelfSync?: unknown;
    webReaderProjection?: unknown;
    readers?: unknown;
    [key: string]: unknown;
  } | null;
};

/** Adapter v2 book identity payload (`GET /books/resolve`). */
type GrimmoryBookDTO = {
  id?: number;
  title?: string | null;
  primaryFile?: { id?: number; extension?: string | null; fileName?: string | null } | null;
  metadata?: Record<string, unknown> | null;
  readStatus?: string | null;
};

/** Adapter v2 progress payload (`GET /progress/{hash}?reader=…`). */
type GrimmoryProgressDTO = {
  status?: string;
  bookHash?: string | null;
  fraction?: number | null;
  updatedAt?: string | null;
  device?: string | null;
  deviceId?: string | null;
  device_id?: string | null;
  reader?: string;
  source?: string;
  position?: {
    format?: string | null;
    cfi?: string | null;
    xpointer?: string | null;
    href?: string | null;
    page?: number | null;
    totalPages?: number | null;
  } | null;
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

  // Read status is a core endpoint on both contracts, but the legacy
  // capability response omitted a corresponding boolean.  The endpoint itself
  // still advertises its accepted statuses before any write is queued.
  if (!capabilities.some((item) => item.toLowerCase() === 'read-status')) {
    capabilities.push('read-status');
  }
  return capabilities;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Normalize the field names used by Grimmory's shelf-book DTO to Readest's provider model. */
const normalizeShelfBook = (value: GrimmoryShelfBookResponse): GrimmLinkShelfBook | null => {
  if (!Number.isFinite(value.bookId)) return null;
  const extension = nonEmptyString(value.extension);
  const filename =
    nonEmptyString(value.filename) ??
    nonEmptyString(value.fileName) ??
    nonEmptyString(value.originalFileName) ??
    (extension ? `book-${value.bookId}.${extension}` : `book-${value.bookId}`);
  return {
    bookId: value.bookId!,
    // Adapter v2 omits the hash from shelf listings; it is resolved separately.
    bookHash: nonEmptyString(value.bookHash) ?? '',
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

/**
 * Read the error text from an Adapter response.  FastAPI reports failures as
 * `detail`, while the older GrimmLink contract used `message`/`error`.
 */
const errorMessageFromPayload = (data: unknown): string | undefined => {
  if (!data || typeof data !== 'object') return undefined;
  for (const key of ['detail', 'message', 'error']) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
};

export { GrimmLinkRequestError } from './GrimmLinkRequestError';

export class GrimmLinkClient {
  private readonly serverUrl: string;
  private readonly fallbackUrl?: string;
  /** Adapter v2 issues a short-lived bearer token; every other route needs it. */
  private accessToken?: string;
  private expiresAtMs = 0;
  private sessionUser?: string;
  private sessionUserId?: number;
  private sessionRequest?: Promise<void>;

  constructor(private readonly config: GrimmLinkSettings) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, '');
    this.fallbackUrl = config.fallbackUrl?.replace(/\/+$/, '') || undefined;
  }

  private headers(): Record<string, string> {
    const custom = normalizeCustomHeaders(this.config.customHeaders);
    // A custom header must never shadow the Adapter credentials: v2
    // authenticates with a session token, and only the session endpoint
    // accepts the raw KOSync key.
    for (const name of Object.keys(custom)) {
      const lower = name.toLowerCase();
      if (lower === 'x-auth-user' || lower === 'x-auth-key' || lower === 'authorization') {
        delete custom[name];
      }
    }
    const headers: Record<string, string> = {
      ...custom,
      Accept: 'application/json',
    };
    // The raw KOSync key is never sent here: only POST /auth/session accepts
    // it, and that request passes it as an explicit header.
    if (this.accessToken && this.expiresAtMs > Date.now()) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    return headers;
  }

  private clearSession(): void {
    this.accessToken = undefined;
    this.expiresAtMs = 0;
  }

  /**
   * Exchange the KOSync credentials for an Adapter v2 session token.  The
   * token is short-lived, so it is refreshed a minute before it expires.
   */
  private async ensureSession(): Promise<void> {
    if (this.accessToken && this.expiresAtMs > Date.now() + SESSION_REFRESH_MARGIN_MS) return;
    if (this.sessionRequest) return this.sessionRequest;
    this.sessionRequest = (async () => {
      const response = await this.requestWithFallback(
        SESSION_ENDPOINT,
        'POST',
        undefined,
        undefined,
        GRIMMLINK_REQUEST_TIMEOUT_MS,
        {
          'X-Auth-User': this.config.username,
          'X-Auth-Key': this.config.userkey,
        },
      );
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        const message =
          errorMessageFromPayload(data) ??
          `GrimmLink session creation failed with status ${response.status}`;
        throw new GrimmLinkRequestError(
          errorKindForStatus(response.status),
          message,
          response.status,
          errorCategoryForStatus(response.status),
        );
      }
      let session: {
        accessToken?: unknown;
        expiresAt?: unknown;
        username?: unknown;
        userId?: unknown;
      };
      try {
        const data: unknown = await response.json();
        if (!data || typeof data !== 'object') throw new Error('Expected JSON data');
        session = data as typeof session;
      } catch {
        throw new GrimmLinkRequestError(
          'response',
          'Invalid data: expected a JSON response from GrimmLink.',
          response.status,
        );
      }
      const expiresAtMs =
        typeof session.expiresAt === 'string' ? Date.parse(session.expiresAt) : Number.NaN;
      if (typeof session.accessToken !== 'string' || !Number.isFinite(expiresAtMs)) {
        throw new GrimmLinkRequestError('response', 'Adapter returned an invalid session.');
      }
      this.accessToken = session.accessToken;
      this.expiresAtMs = expiresAtMs;
      this.sessionUser = typeof session.username === 'string' ? session.username : undefined;
      this.sessionUserId = typeof session.userId === 'number' ? session.userId : undefined;
    })().finally(() => {
      this.sessionRequest = undefined;
    });
    return this.sessionRequest;
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
    additionalHeaders?: Record<string, string>,
  ): Promise<Response> {
    recordGrimmLinkPerformance('networkRequests');
    // The Adapter credentials are applied last, so a caller-supplied header
    // can never shadow the session token.
    const headers: Record<string, string> = { ...additionalHeaders, ...this.headers() };
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
    additionalHeaders?: Record<string, string>,
  ): Promise<Response> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.send(
        serverUrl,
        endpoint,
        method,
        body,
        controller.signal,
        additionalHeaders,
      );
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
    additionalHeaders?: Record<string, string>,
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
          additionalHeaders,
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
    additionalHeaders?: Record<string, string>,
  ): Promise<Response> {
    try {
      return await this.requestWithRetry(
        this.serverUrl,
        endpoint,
        method,
        body,
        signal,
        timeoutMs,
        additionalHeaders,
      );
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
        additionalHeaders,
      );
    }
  }

  private async requestJson<T>(
    endpoint: string,
    method = 'GET',
    body?: object,
    signal?: AbortSignal,
    additionalHeaders?: Record<string, string>,
  ): Promise<T> {
    if (endpoint !== SESSION_ENDPOINT) await this.ensureSession();
    const serializedBody = body ? JSON.stringify(body) : undefined;
    let response = await this.requestWithFallback(
      endpoint,
      method,
      serializedBody,
      signal,
      GRIMMLINK_REQUEST_TIMEOUT_MS,
      additionalHeaders,
    );
    if (response.status === 401 && endpoint !== SESSION_ENDPOINT) {
      // The Adapter session expired or was revoked: open a new one and retry once.
      this.clearSession();
      await this.ensureSession();
      response = await this.requestWithFallback(
        endpoint,
        method,
        serializedBody,
        signal,
        GRIMMLINK_REQUEST_TIMEOUT_MS,
        additionalHeaders,
      );
    }
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const message =
        errorMessageFromPayload(data) ?? `GrimmLink request failed with status ${response.status}`;
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

  async authenticate(): Promise<GrimmLinkSession> {
    await this.ensureSession();
    return {
      authenticated: true,
      username: this.sessionUser,
      userId: this.sessionUserId,
      expiresAt: Number.isFinite(this.expiresAtMs)
        ? new Date(this.expiresAtMs).toISOString()
        : undefined,
    };
  }

  async getCapabilities(): Promise<GrimmLinkCapabilities> {
    const response = await this.requestJson<GrimmoryCapabilitiesResponse>('/capabilities');
    return { capabilities: normalizeCapabilities(response) };
  }

  async matchBook(bookHash: string): Promise<GrimmLinkBookLink | null> {
    try {
      const data = await this.requestJson<GrimmoryBookDTO>(
        `/books/resolve?hash=${encodeURIComponent(bookHash)}`,
      );
      if (!Number.isFinite(data.id)) return null;
      const extension = nonEmptyString(data.primaryFile?.extension);
      return {
        bookHash,
        bookId: data.id!,
        bookFileId: Number.isFinite(data.primaryFile?.id) ? data.primaryFile!.id : undefined,
        format: extension ? extension.toUpperCase() : undefined,
      };
    } catch (error) {
      if (error instanceof GrimmLinkRequestError && error.kind === 'not-found') return null;
      throw error;
    }
  }

  /** Resolve the verified Grimmory content hash of a shelf book. */
  async getBookHash(bookId: number): Promise<string> {
    const data = await this.requestJson<{ bookHash?: unknown }>(`/books/${bookId}/hash`);
    const hash = nonEmptyString(data.bookHash);
    if (!hash) {
      throw new GrimmLinkRequestError('response', 'Invalid data: Grimmory returned no book hash.');
    }
    return hash;
  }

  async getProgress(bookHash: string): Promise<GrimmLinkProgress | null> {
    const read = (reader: 'readest' | 'koreader') =>
      this.requestJson<GrimmoryProgressDTO>(
        `/progress/${encodeURIComponent(bookHash)}?reader=${reader}`,
      );
    let data: GrimmoryProgressDTO;
    try {
      data = await read('readest');
    } catch (error) {
      if (error instanceof GrimmLinkRequestError && error.kind === 'not-found') return null;
      // 501 means the Adapter has no verified file format for the book, so
      // there is no position it could report for either reader.
      if (error instanceof GrimmLinkRequestError && error.status === 501) return null;
      if (!(error instanceof GrimmLinkRequestError) || error.status !== 424) throw error;
      // The Adapter could not project the newest EPUB position into a CFI.
      // Fall back to the native KOReader locator and let the reader convert it
      // locally with its own CFI/XPointer helper.
      try {
        data = await read('koreader');
      } catch (fallbackError) {
        if (fallbackError instanceof GrimmLinkRequestError && fallbackError.kind === 'not-found')
          return null;
        throw fallbackError;
      }
    }
    return this.normalizeProgress(bookHash, data);
  }

  private normalizeProgress(bookHash: string, data: GrimmoryProgressDTO): GrimmLinkProgress | null {
    const position = data.position ?? {};
    const cfi = nonEmptyString(position.cfi);
    const xpointer = nonEmptyString(position.xpointer);
    const href = nonEmptyString(position.href);
    const page =
      typeof position.page === 'number' && Number.isFinite(position.page)
        ? position.page
        : undefined;
    const totalPages =
      typeof position.totalPages === 'number' && Number.isFinite(position.totalPages)
        ? position.totalPages
        : undefined;
    const location = cfi ?? xpointer ?? href ?? (page !== undefined ? String(page) : undefined);
    const percentage =
      typeof data.fraction === 'number' && Number.isFinite(data.fraction)
        ? data.fraction * 100
        : undefined;
    const progress: GrimmLinkProgress = {
      bookHash: nonEmptyString(data.bookHash) ?? bookHash,
      location,
      progress: location,
      cfi,
      xpointer,
      href,
      percentage,
      currentPage: page,
      totalPages,
      updatedAt: nonEmptyString(data.updatedAt),
      device: nonEmptyString(data.device) ?? nonEmptyString(data.source),
      device_id: nonEmptyString(data.deviceId) ?? nonEmptyString(data.device_id),
    };
    const hasPosition =
      !!location || percentage !== undefined || page !== undefined || !!progress.updatedAt;
    return hasPosition ? progress : null;
  }

  updateProgress(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const update = normalizeGrimmLinkProgressPayload(payload);
    if (!update) {
      throw new GrimmLinkRequestError(
        'validation',
        'Invalid data: the progress update has no Grimmory book hash.',
      );
    }
    const { bookHash, ...body } = update;
    return this.requestJson(`/progress/${encodeURIComponent(bookHash)}`, 'PUT', body);
  }

  postSessionBatch(payload: object, idempotencyKey?: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      '/reading-sessions/batch',
      'POST',
      payload,
      undefined,
      idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    );
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

  /** Adapter v2 lists regular shelves only; magic shelves are not available. */
  async getShelves(): Promise<GrimmLinkShelf[]> {
    const data = await this.requestJson<{ shelves?: GrimmLinkShelf[] } | GrimmLinkShelf[]>(
      '/shelves',
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
    return shelves.map((shelf) => ({ ...shelf, type: 'regular' }));
  }

  async getShelfBooks(shelfId: number): Promise<GrimmLinkShelfBook[]> {
    const collected: GrimmoryShelfBookResponse[] = [];
    for (let page = 0; page < SHELF_MAX_PAGES; page += 1) {
      const data = await this.requestJson<
        { books?: GrimmoryShelfBookResponse[] } | GrimmoryShelfBookResponse[]
      >(`/shelves/${shelfId}/items?limit=${SHELF_PAGE_SIZE}&offset=${page * SHELF_PAGE_SIZE}`);
      const books = Array.isArray(data) ? data : data.books;
      if (!Array.isArray(books)) {
        throw new GrimmLinkRequestError(
          'response',
          'Invalid data: Grimmory returned no shelf books.',
        );
      }
      collected.push(...books);
      if (books.length < SHELF_PAGE_SIZE) break;
    }
    const normalized = collected.map(normalizeShelfBook);
    if (normalized.some((book) => book === null)) {
      throw new GrimmLinkRequestError(
        'response',
        'Invalid data: Grimmory returned a malformed shelf book.',
      );
    }
    const books = normalized as GrimmLinkShelfBook[];
    // Adapter v2 does not include the content hash in shelf listings, but
    // Readest identifies books by their verified hash.  Resolve every missing
    // hash before the shelf is reconciled, otherwise an unreadable book could
    // be mistaken for a removed one.
    const resolved: GrimmLinkShelfBook[] = [];
    const pending = books.filter((book) => !book.bookHash);
    for (const book of books.filter((item) => item.bookHash)) resolved.push(book);
    // Keep the lookups bounded so a large shelf cannot flood the Adapter.
    for (let index = 0; index < pending.length; index += SHELF_HASH_LOOKUP_CONCURRENCY) {
      const chunk = pending.slice(index, index + SHELF_HASH_LOOKUP_CONCURRENCY);
      const hashes = await Promise.all(chunk.map((book) => this.getBookHash(book.bookId)));
      chunk.forEach((book, position) => resolved.push({ ...book, bookHash: hashes[position]! }));
    }
    return resolved;
  }

  async downloadShelfBook(
    bookId: number,
    bookHash: string,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    await this.ensureSession();
    const response = await this.requestWithFallback(
      `/books/${bookId}/content?hash=${encodeURIComponent(bookHash)}`,
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
    bookHash: string,
    filePath: string,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isTauriAppPlatform())
      throw new GrimmLinkRequestError('transport', 'Native download is unavailable.');
    if (signal?.aborted) throw new Error('Download aborted');
    await this.ensureSession();

    const download = async (serverUrl: string) => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= GRIMMLINK_MAX_RETRIES; attempt += 1) {
        try {
          recordGrimmLinkPerformance('networkRequests');
          await this.withTimeout(
            tauriDownload(
              `${serverUrl}${API_PREFIX}/books/${bookId}/content?hash=${encodeURIComponent(bookHash)}`,
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

  /** Read-only probes used by diagnostics. It never writes to the server. */
  async healthCheck(): Promise<GrimmLinkHealthCheck> {
    await this.authenticate();
    const { capabilities } = await this.getCapabilities();
    const has = (name: string) => capabilities.some((item) => item.toLowerCase() === name);
    let shelves: GrimmLinkHealthCheck['shelves'] = has('shelves') ? 'available' : 'unsupported';
    if (shelves === 'available') {
      try {
        await this.getShelves();
      } catch {
        shelves = 'failed';
      }
    }
    return {
      authentication: 'ok',
      capabilities: 'ok',
      progress: has('progress') ? 'available' : 'unsupported',
      metadata: has('metadata') ? 'available' : 'unsupported',
      sessions: has('sessions') ? 'available' : 'unsupported',
      shelves,
      magicShelves: 'unsupported',
      download: has('shelves') ? 'available' : 'unsupported',
      capabilityNames: capabilities,
    };
  }
}
