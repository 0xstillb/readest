import type { Book } from '@/types/book';
import type { KOSyncStrategy } from '@/types/settings';
import type { GrimmLinkBookLink, GrimmLinkProgress } from './types';
import type { GrimmLinkCachedBookLink } from './bookLinks';

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

export const toGrimmLinkProgressPayload = (
  book: Book,
  link: GrimmLinkBookLink,
  position: GrimmLinkProgressPosition,
  config: Pick<GrimmLinkProgressConfig, 'deviceId' | 'deviceName'>,
): Record<string, unknown> => {
  const fixed = book.format === 'PDF' || book.format === 'CBZ';
  const percentage = fixed
    ? position.totalPages && position.totalPages > 0
      ? (((position.currentPage ?? 0) + 1) / position.totalPages) * 100
      : 0
    : Math.max(0, Math.min(1, position.fraction ?? 0)) * 100;
  return {
    bookHash: book.hash,
    document: book.hash,
    bookId: link.bookId,
    bookFileId: link.bookFileId,
    fileFormat: book.format,
    progress: fixed ? String(position.currentPage ?? 0) : position.location,
    ...(fixed ? { currentPage: position.currentPage, totalPages: position.totalPages } : { location: position.location }),
    percentage,
    device: config.deviceName,
    device_id: config.deviceId,
    updatedAt: new Date().toISOString(),
  };
};

export const progressPullDisposition = (
  strategy: KOSyncStrategy,
  remoteIsNewer: boolean,
): 'apply' | 'prompt' | 'ignore' => {
  if (strategy === 'receive') return 'apply';
  if (strategy === 'send') return 'ignore';
  if (strategy === 'silent') return remoteIsNewer ? 'apply' : 'ignore';
  return 'prompt';
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

const UNMATCHED_CACHE_MS = 5 * 60 * 1000;

export class GrimmLinkProgressProvider {
  constructor(
    private readonly client: Client,
    private readonly links: Links,
    private readonly config: GrimmLinkProgressConfig,
  ) {}

  async resolveLink(book: Book, retryUnmatched = false): Promise<GrimmLinkBookLink | null> {
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
    return (await this.resolveLink(book, retryUnmatched)) ? this.client.getProgress(book.hash) : null;
  }

  async push(book: Book, position: GrimmLinkProgressPosition): Promise<boolean> {
    const link = await this.resolveLink(book);
    if (!link) return false;
    await this.client.updateProgress(toGrimmLinkProgressPayload(book, link, position, this.config));
    return true;
  }
}
