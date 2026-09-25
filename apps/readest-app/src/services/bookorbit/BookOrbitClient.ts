import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { BookOrbitProxyPayload } from '@/types/bookorbit';
import type { BookOrbitSettings } from '@/types/settings';
import { isLanAddress } from '@/utils/network';
import { normalizeCustomHeaders } from '@/utils/customHeaders';
import { getAppVersion } from '@/utils/version';
import { getAPIBaseUrl, isTauriAppPlatform } from '../environment';
import { formatKoDatetime } from './noteMapping';
import type {
  BookOrbitVersionInfo,
  BookOrbitShelf,
  BookOrbitShelfClient,
  BookOrbitShelfType,
  BookStateEntry,
  BookmarkAckBook,
  BookmarkExchangeBookRequest,
  BookmarkExchangeResponse,
  ExchangeAckBook,
  ExchangeBookRequest,
  ExchangeResponse,
  MatchCheckBook,
  MatchCheckResponse,
  PageStatsBookWire,
  PluginDeviceFields,
} from './types';
import type { BookOrbitShelfBook } from './shelfDownload';

export class BookOrbitRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'BookOrbitRequestError';
    this.status = status;
  }
}

/**
 * Client for the BookOrbit KOReader plugin API at {server}/api/v1/koreader.
 * Auth is KOSync-style (x-auth-user / x-auth-key = md5(password)); credentials
 * are minted in BookOrbit's web UI (Settings > Integrations > KOReader) — this
 * client never self-registers.
 */
export class BookOrbitClient implements BookOrbitShelfClient {
  private config: BookOrbitSettings;
  private serverUrl: string;
  private isLanServer: boolean;
  private versionInfo: BookOrbitVersionInfo | null = null;

  constructor(config: BookOrbitSettings) {
    this.config = config;
    this.serverUrl = config.serverUrl.replace(/\/+$/, '');
    this.isLanServer = isLanAddress(this.serverUrl);
  }

  private deviceFields(): PluginDeviceFields {
    return {
      deviceId: this.config.deviceId,
      deviceModel: (this.config.deviceName || 'Readest').slice(0, 100),
      pluginVersion: `readest-${getAppVersion()}`.slice(0, 20),
      // Always the UTC frame — see formatKoDatetime; keys derived from
      // server-minted datetimes then agree across Readest devices.
      deviceTime: formatKoDatetime(Date.now()),
    };
  }

  private async request(
    endpoint: string,
    options: { method?: 'GET' | 'POST'; body?: string } = {},
  ): Promise<Response> {
    const { method = 'GET', body } = options;
    const headers: Record<string, string> = {
      ...normalizeCustomHeaders(this.config.customHeaders),
      Accept: 'application/json',
      'X-Auth-User': this.config.username,
      'X-Auth-Key': this.config.userkey,
    };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }

    if (this.isLanServer || isTauriAppPlatform()) {
      const fetch = isTauriAppPlatform() ? tauriFetch : window.fetch;
      return await fetch(`${this.serverUrl}/api/v1/koreader${endpoint}`, {
        method,
        headers,
        body,
        danger: {
          acceptInvalidCerts: true,
          acceptInvalidHostnames: true,
        },
      });
    }

    const proxyBody: BookOrbitProxyPayload = {
      serverUrl: this.serverUrl,
      endpoint,
      method,
      headers,
      body: body ? (JSON.parse(body) as Record<string, unknown>) : undefined,
    };
    return await fetch(`${getAPIBaseUrl()}/bookorbit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyBody),
    });
  }

  private async requestJson<T>(
    endpoint: string,
    options: { method?: 'GET' | 'POST'; body?: string } = {},
  ): Promise<T> {
    const response = await this.request(endpoint, options);
    if (!response.ok) {
      let message = `BookOrbit request failed with status ${response.status}`;
      const data: unknown = await response.json().catch(() => null);
      if (data && typeof data === 'object' && 'message' in data) {
        const serverMessage = (data as { message: unknown }).message;
        if (typeof serverMessage === 'string' && serverMessage) message = serverMessage;
      }
      throw new BookOrbitRequestError(response.status, message);
    }
    return (await response.json()) as T;
  }

  private postJson<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
    return this.requestJson<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify({ ...this.deviceFields(), ...payload }),
    });
  }

  async connect(): Promise<{ success: boolean; message?: string; capabilities?: string[] }> {
    try {
      const authResponse = await this.request('/users/auth');
      if (!authResponse.ok) {
        if (authResponse.status === 401) {
          return { success: false, message: 'Invalid credentials.' };
        }
        return {
          success: false,
          message: `Authorization failed with status: ${authResponse.status}`,
        };
      }
      // A wrong Server URL can land on a web UI that answers 200 with HTML.
      const data: unknown = await authResponse.json().catch(() => null);
      if (typeof data !== 'object' || data === null) {
        return { success: false, message: 'Not a BookOrbit server. Check the Server URL.' };
      }
      try {
        const version = await this.getVersion();
        return { success: true, capabilities: version.capabilities };
      } catch {
        return {
          success: true,
          capabilities: [],
          message: 'Connected, but the server does not expose the BookOrbit plugin API.',
        };
      }
    } catch (e) {
      return { success: false, message: (e as Error).message || 'Connection error.' };
    }
  }

  async getVersion(): Promise<BookOrbitVersionInfo> {
    if (!this.versionInfo) {
      this.versionInfo = await this.requestJson<BookOrbitVersionInfo>('/plugin/version');
    }
    return this.versionInfo;
  }

  async matchCheck(books: MatchCheckBook[]): Promise<MatchCheckResponse> {
    return await this.postJson<MatchCheckResponse>('/plugin/match-check', {
      hashes: books.map((book) => book.hash),
      // The server validates title <= 500 and authors <= 1000 chars and rejects
      // the whole request otherwise, which would leave the book unregistered.
      books: books.map((book) => ({
        ...book,
        title: book.title?.slice(0, 500),
        authors: book.authors?.slice(0, 1000),
      })),
    });
  }

  async exchangeAnnotations(books: ExchangeBookRequest[]): Promise<ExchangeResponse> {
    return await this.postJson<ExchangeResponse>('/plugin/annotations/exchange', { books });
  }

  async ackAnnotations(books: ExchangeAckBook[]): Promise<void> {
    await this.postJson<unknown>('/plugin/annotations/exchange-ack', { books });
  }

  async exchangeBookmarks(books: BookmarkExchangeBookRequest[]): Promise<BookmarkExchangeResponse> {
    return await this.postJson<BookmarkExchangeResponse>('/plugin/bookmarks/exchange', { books });
  }

  async ackBookmarks(books: BookmarkAckBook[]): Promise<void> {
    await this.postJson<unknown>('/plugin/bookmarks/exchange-ack', { books });
  }

  async uploadPageStats(books: PageStatsBookWire[]): Promise<void> {
    await this.postJson<unknown>('/plugin/page-stats', { books });
  }

  async uploadBookStates(books: BookStateEntry[]): Promise<void> {
    await this.postJson<unknown>('/plugin/book-states', { books });
  }

  async getCollections(): Promise<BookOrbitShelf[]> {
    try {
      const data = await this.requestJson<unknown>('/plugin/collections').catch(async (err) => {
        if (err instanceof BookOrbitRequestError && err.status === 404) {
          return await this.requestJson<unknown>('/collections');
        }
        throw err;
      });
      return this.normalizeShelves(data, 'collection');
    } catch {
      return [];
    }
  }

  async getSmartScopes(): Promise<BookOrbitShelf[]> {
    try {
      const data = await this.requestJson<unknown>('/plugin/smartscopes').catch(async (err) => {
        if (err instanceof BookOrbitRequestError && err.status === 404) {
          return await this.requestJson<unknown>('/plugin/smart-scopes').catch(async () => {
            return await this.requestJson<unknown>('/smartscopes');
          });
        }
        throw err;
      });
      return this.normalizeShelves(data, 'smartscope');
    } catch {
      return [];
    }
  }

  async getShelves(type?: BookOrbitShelfType): Promise<BookOrbitShelf[]> {
    if (type === 'collection') return this.getCollections();
    if (type === 'smartscope') return this.getSmartScopes();
    const [collections, smartscopes] = await Promise.all([
      this.getCollections(),
      this.getSmartScopes(),
    ]);
    return [...collections, ...smartscopes];
  }

  async getShelfBooks(
    shelfType: BookOrbitShelfType | string,
    shelfId: string | number,
  ): Promise<BookOrbitShelfBook[]> {
    const isCollection = shelfType === 'collection' || shelfType === 'regular';
    const primaryEndpoint = isCollection
      ? `/plugin/collections/${encodeURIComponent(shelfId)}/books`
      : `/plugin/smartscopes/${encodeURIComponent(shelfId)}/books`;
    const fallbackEndpoint = isCollection
      ? `/collections/${encodeURIComponent(shelfId)}/books`
      : `/plugin/smart-scopes/${encodeURIComponent(shelfId)}/books`;

    const data = await this.requestJson<unknown>(primaryEndpoint).catch(async (err) => {
      if (err instanceof BookOrbitRequestError && err.status === 404) {
        return await this.requestJson<unknown>(fallbackEndpoint).catch(async () => {
          if (!isCollection) {
            return await this.requestJson<unknown>(
              `/smartscopes/${encodeURIComponent(shelfId)}/books`,
            );
          }
          throw err;
        });
      }
      throw err;
    });

    return this.normalizeShelfBooks(data);
  }

  private normalizeShelves(data: unknown, fallbackType: BookOrbitShelfType): BookOrbitShelf[] {
    if (!data) return [];
    let list: unknown[] = [];
    if (Array.isArray(data)) {
      list = data;
    } else if (typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      const collections = obj['collections'];
      const smartscopes = obj['smartscopes'];
      const smartScopes = obj['smartScopes'];
      const items = obj['items'];
      const results = obj['results'];
      const dataItems = obj['data'];
      if (Array.isArray(collections)) list = collections;
      else if (Array.isArray(smartscopes)) list = smartscopes;
      else if (Array.isArray(smartScopes)) list = smartScopes;
      else if (Array.isArray(items)) list = items;
      else if (Array.isArray(results)) list = results;
      else if (Array.isArray(dataItems)) list = dataItems;
    }
    const shelves: BookOrbitShelf[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const id =
        record['id'] ?? record['collectionId'] ?? record['smartscopeId'] ?? record['smartScopeId'];
      const name = record['name'] ?? record['title'] ?? `Shelf ${id}`;
      if (id == null) continue;
      const countVal =
        record['bookCount'] ?? record['count'] ?? record['total'] ?? record['booksCount'];
      const booksVal = record['books'];
      const bookCount =
        typeof countVal === 'number'
          ? countVal
          : Array.isArray(booksVal)
            ? booksVal.length
            : undefined;
      const typeVal = record['type'];
      const type: BookOrbitShelfType =
        typeVal === 'smartscope' || typeVal === 'smart_scope' ? 'smartscope' : fallbackType;
      const descVal = record['description'];
      shelves.push({
        id: String(id),
        name: String(name),
        type,
        description: typeof descVal === 'string' ? descVal : undefined,
        bookCount,
      });
    }
    return shelves;
  }

  private normalizeShelfBooks(data: unknown): BookOrbitShelfBook[] {
    if (data === null || data === undefined) {
      throw new BookOrbitRequestError(500, 'Malformed shelf response: received empty payload');
    }
    if (typeof data !== 'object') {
      throw new BookOrbitRequestError(
        500,
        'Malformed shelf response: expected JSON object or array',
      );
    }

    const obj = data as Record<string, unknown>;
    if (obj['restartRequired'] === true || obj['restart_required'] === true) {
      throw new BookOrbitRequestError(409, 'BookOrbit shelf pagination restart required');
    }

    let list: unknown[] | null = null;
    if (Array.isArray(data)) {
      list = data;
    } else {
      const books = obj['books'];
      const items = obj['items'];
      const results = obj['results'];
      const dataItems = obj['data'];
      if (Array.isArray(books)) list = books;
      else if (Array.isArray(items)) list = items;
      else if (Array.isArray(results)) list = results;
      else if (Array.isArray(dataItems)) list = dataItems;
    }

    if (list === null) {
      throw new BookOrbitRequestError(500, 'Malformed shelf response: missing books collection');
    }

    const books: BookOrbitShelfBook[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        throw new BookOrbitRequestError(
          500,
          'Malformed shelf response: invalid book entry in collection',
        );
      }
      const record = item as Record<string, unknown>;
      const bookId = record['bookId'] ?? record['id'];
      if (bookId == null) {
        throw new BookOrbitRequestError(500, 'Malformed shelf response: book missing identifier');
      }

      const fileId = record['fileId'] ?? record['bookFileId'] ?? record['primaryFileId'] ?? null;
      const contentVersion =
        record['contentVersion'] != null ? String(record['contentVersion']) : null;
      const formatVal = record['format'];
      const filenameVal = record['filename'];
      const format = (
        (typeof formatVal === 'string' ? formatVal : '') ||
        (typeof filenameVal === 'string' ? filenameVal.split('.').pop() : '') ||
        'epub'
      ).toLowerCase();

      const titleVal = record['title'];
      const filename =
        typeof filenameVal === 'string' && filenameVal
          ? filenameVal
          : typeof titleVal === 'string' && titleVal
            ? `${titleVal}.${format}`
            : `book-${bookId}.${format}`;

      const fileHash =
        (typeof record['fileHash'] === 'string' ? (record['fileHash'] as string) : null) ??
        (typeof record['hash'] === 'string' ? (record['hash'] as string) : null) ??
        (typeof record['bookHash'] === 'string' ? (record['bookHash'] as string) : null) ??
        null;
      const bookHash =
        (typeof record['bookHash'] === 'string' ? (record['bookHash'] as string) : null) ??
        (typeof record['hash'] === 'string' ? (record['hash'] as string) : null) ??
        (typeof record['fileHash'] === 'string' ? (record['fileHash'] as string) : null) ??
        null;

      const sizeBytesVal = record['sizeBytes'];
      const sizeVal = record['size'];
      const sizeBytes =
        typeof sizeBytesVal === 'number'
          ? sizeBytesVal
          : typeof sizeVal === 'number'
            ? sizeVal
            : null;

      const authorVal = record['author'];
      const authorsVal = record['authors'];
      const author =
        typeof authorVal === 'string'
          ? authorVal
          : Array.isArray(authorsVal)
            ? (authorsVal as string[]).join(', ')
            : undefined;

      const downloadUrlVal = record['downloadUrl'];
      books.push({
        bookId: String(bookId),
        fileId: fileId != null ? String(fileId) : null,
        contentVersion,
        filename,
        format,
        fileHash,
        bookHash,
        sizeBytes,
        size: sizeBytes ?? undefined,
        title: typeof titleVal === 'string' ? titleVal : undefined,
        author,
        downloadUrl: typeof downloadUrlVal === 'string' ? downloadUrlVal : undefined,
      });
    }
    return books;
  }
}
