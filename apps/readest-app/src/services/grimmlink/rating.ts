import { hasGrimmLinkCapability } from './capabilities';
import { GrimmLinkSyncStore } from './GrimmLinkSyncStore';
import { parseGrimmLinkRating, toGrimmLinkRating, type GrimmLinkRating } from './metadata';

type MetadataClient = {
  getMetadata(query: Record<string, string | number>): Promise<Record<string, unknown>>;
};

export class GrimmLinkRatingProvider {
  constructor(
    private readonly client: MetadataClient,
    private readonly store: GrimmLinkSyncStore,
    private readonly config: { capabilities: string[]; device: string; deviceId: string },
  ) {}

  async queuePush(bookHash: string, bookId: number, rating: GrimmLinkRating, bookFileId?: number, fileFormat?: string): Promise<boolean> {
    if (!hasGrimmLinkCapability(this.config.capabilities, 'metadata')) return false;
    if (!Number.isFinite(rating.value) || rating.value < 1 || rating.value > rating.scale) {
      throw new Error('Invalid GrimmLink rating');
    }
    await this.store.applyRatingPage(bookHash, rating, null);
    await this.store.enqueueRating(bookHash, {
      schemaVersion: 1, syncMode: 'incremental', bookId, bookHash, bookFileId, fileFormat,
      device: this.config.device, deviceId: this.config.deviceId,
      timestamp: new Date(rating.updatedAt).toISOString(),
      rating: toGrimmLinkRating(rating, this.store.connectionId, bookHash), annotations: [], bookmarks: [],
    });
    return true;
  }

  async pull(bookHash: string, local: GrimmLinkRating | null): Promise<GrimmLinkRating | null> {
    if (!hasGrimmLinkCapability(this.config.capabilities, 'metadata')) return local;
    const stored = await this.store.getRating(bookHash);
    let winner = !local || (stored && stored.updatedAt > local.updatedAt) ? stored : local;
    let cursor = await this.store.getMetadataCursor(bookHash, 'rating');
    while (true) {
      const query: Record<string, string | number> = { bookHash, type: 'rating', limit: 500 };
      if (cursor) query['cursor'] = cursor;
      const data = await this.client.getMetadata(query);
      if (!Array.isArray(data['items'])) throw new Error('Invalid GrimmLink metadata response');
      const ratings = data['items'].map(parseGrimmLinkRating);
      for (const candidate of ratings) {
        if (!winner || candidate.updatedAt > winner.updatedAt) winner = candidate;
      }
      const nextCursor = typeof data['nextCursor'] === 'string' && data['nextCursor'] ? data['nextCursor'] : null;
      await this.store.applyRatingPage(bookHash, winner, nextCursor);
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return winner;
  }
}
