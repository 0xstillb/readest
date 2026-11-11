import type { Book } from '@/types/book';
import type { KOSyncStrategy } from '@/types/settings';
import type { GrimmLinkBookLink, GrimmLinkProgress, GrimmLinkProgressUpdate } from './types';
import type { GrimmLinkCachedBookLink } from './bookLinks';
import { getLocalBookFilename } from '@/utils/book';

export interface GrimmLinkProgressPosition {
  location?: string;
  fraction?: number;
  currentPage?: number;
  totalPages?: number;
}

export interface GrimmLinkProgressConfig {
  deviceId: string;
  deviceName: string;
  strategy: KOSyncStrategy;
}

/** Adapter v2 requires a UUID operation id so a retried write stays idempotent. */
const createOperationId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
};

const FIXED_LAYOUT_FORMATS = new Set(['PDF', 'CBZ']);

/**
 * The 1-indexed page of a fixed-layout position.  Adapter v2 reads `page` as
 * the location and rejects a page total below 1, so an unknown position has
 * to stay unknown: a made-up page 1 would move the remote progress to the
 * first page of the book.
 */
const fixedLayoutPosition = (currentPage?: number, totalPages?: number) => {
  if (currentPage === undefined || currentPage < 0) return {};
  if (totalPages === undefined || totalPages < 1) return {};
  return { page: currentPage + 1, totalPages };
};

export const toGrimmLinkProgressPayload = (
  book: Book,
  link: GrimmLinkBookLink,
  position: GrimmLinkProgressPosition,
  config: Pick<GrimmLinkProgressConfig, 'deviceId' | 'deviceName'>,
): GrimmLinkProgressUpdate => {
  const fixed = FIXED_LAYOUT_FORMATS.has(book.format);
  const { page, totalPages } = fixed
    ? fixedLayoutPosition(position.currentPage, position.totalPages)
    : {};
  const fraction = fixed
    ? page !== undefined && totalPages
      ? Math.min(1, page / totalPages)
      : 0
    : Math.max(0, Math.min(1, position.fraction ?? 0));
  return {
    // Shelf imports are assigned a Readest content hash, which can differ
    // from Grimmory's hash. The server must receive its own book identity.
    bookHash: link.bookHash,
    operationId: createOperationId(),
    source: 'readest',
    device: {
      id: config.deviceId || undefined,
      name: config.deviceName || undefined,
    },
    updatedAt: new Date().toISOString(),
    fraction,
    position: {
      format: (book.format || 'epub').toLowerCase(),
      // Adapter v2 keeps the reader's native locator: a CFI for EPUB and a
      // 1-indexed page for fixed-layout formats.
      cfi: fixed ? undefined : position.location,
      page,
      totalPages,
    },
  };
};

/**
 * Accept both the Adapter v2 payload and the legacy v1 payload that older
 * outbox rows still carry, so a queued write survives the protocol change.
 */
export const normalizeGrimmLinkProgressPayload = (
  payload: Record<string, unknown>,
): GrimmLinkProgressUpdate | null => {
  const bookHash =
    typeof payload['bookHash'] === 'string'
      ? payload['bookHash']
      : typeof payload['document'] === 'string'
        ? payload['document']
        : '';
  if (!bookHash) return null;
  const position = payload['position'];
  if (typeof payload['fraction'] === 'number' && position && typeof position === 'object') {
    return payload as unknown as GrimmLinkProgressUpdate;
  }
  const fileFormat =
    typeof payload['fileFormat'] === 'string' ? payload['fileFormat'].toUpperCase() : 'EPUB';
  const fixed = FIXED_LAYOUT_FORMATS.has(fileFormat);
  const percentage = typeof payload['percentage'] === 'number' ? payload['percentage'] : 0;
  const currentPage =
    typeof payload['currentPage'] === 'number' ? payload['currentPage'] : undefined;
  const pageTotal = typeof payload['totalPages'] === 'number' ? payload['totalPages'] : undefined;
  const location = typeof payload['location'] === 'string' ? payload['location'] : undefined;
  const { page, totalPages } = fixed ? fixedLayoutPosition(currentPage, pageTotal) : {};
  const hasLegacyXPointer = !fixed && location?.startsWith('/body/DocFragment[');
  return {
    bookHash,
    operationId: createOperationId(),
    source: 'readest',
    device: {
      id: typeof payload['device_id'] === 'string' ? payload['device_id'] : undefined,
      name: typeof payload['device'] === 'string' ? payload['device'] : undefined,
    },
    updatedAt:
      typeof payload['updatedAt'] === 'string' ? payload['updatedAt'] : new Date().toISOString(),
    fraction: Math.max(0, Math.min(1, percentage / 100)),
    position: {
      format: fileFormat.toLowerCase(),
      ...(fixed || hasLegacyXPointer || !location ? {} : { cfi: location }),
      page,
      totalPages,
    },
  };
};

export const progressPullDisposition = (
  strategy: KOSyncStrategy,
  remoteIsNewer: boolean,
  remoteDeviceId?: string,
  localDeviceId?: string,
): 'apply' | 'prompt' | 'ignore' => {
  // Grimmory echoes the last write back to the originating device.  Treat an
  // acknowledged write as already settled; comparing display names would
  // create false conflicts when the user renames a device.
  if (remoteDeviceId && localDeviceId && remoteDeviceId === localDeviceId) return 'ignore';
  if (strategy === 'receive') return 'apply';
  if (strategy === 'send') return 'ignore';
  if (strategy === 'silent') return remoteIsNewer ? 'apply' : 'ignore';
  // Prompt mode only represents a conflict when Grimmory has a newer position.
  // Older/equal remote snapshots are stale acknowledgements after a successful
  // local push; prompting on every pull makes the same resolved state reappear
  // whenever the reader regains focus or the book is reopened.
  return remoteIsNewer ? 'prompt' : 'ignore';
};

type Client = {
  matchBook(bookHash: string): Promise<GrimmLinkBookLink | null>;
  getProgress(bookHash: string): Promise<GrimmLinkProgress | null>;
  updateProgress(payload: Record<string, unknown>): Promise<unknown>;
};
type Links = {
  get(bookHash: string): Promise<GrimmLinkCachedBookLink | null>;
  set(link: GrimmLinkBookLink): Promise<void>;
  markUnmatched(bookHash: string): Promise<void>;
};

type ShelfEntries = {
  getShelfEntryByLocalPath(localPath: string): Promise<{ bookId: number; bookHash: string } | null>;
};

const UNMATCHED_CACHE_MS = 5 * 60 * 1000;

export class GrimmLinkProgressProvider {
  constructor(
    private readonly client: Client,
    private readonly links: Links,
    private readonly config: GrimmLinkProgressConfig,
    private readonly shelfEntries?: ShelfEntries,
  ) {}

  async resolveLink(book: Book, retryUnmatched = false): Promise<GrimmLinkBookLink | null> {
    const shelfEntry = await this.shelfEntries?.getShelfEntryByLocalPath(
      getLocalBookFilename(book),
    );
    if (shelfEntry)
      return { bookId: shelfEntry.bookId, bookHash: shelfEntry.bookHash, format: book.format };
    const cached = await this.links.get(book.hash);
    if (cached && 'unmatchedAt' in cached) {
      if (!retryUnmatched && Date.now() - cached.unmatchedAt < UNMATCHED_CACHE_MS) return null;
    } else if (cached) {
      return cached;
    }
    const link = await this.client.matchBook(book.hash);
    if (!link) {
      await this.links.markUnmatched(book.hash);
      return null;
    }
    await this.links.set(link);
    return link;
  }

  async pull(book: Book, retryUnmatched = false): Promise<GrimmLinkProgress | null> {
    const link = await this.resolveLink(book, retryUnmatched);
    return link ? this.client.getProgress(link.bookHash) : null;
  }

  async push(book: Book, position: GrimmLinkProgressPosition): Promise<boolean> {
    const link = await this.resolveLink(book);
    if (!link) return false;
    await this.client.updateProgress(toGrimmLinkProgressPayload(book, link, position, this.config));
    return true;
  }
}
