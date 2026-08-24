import type { ReadingStatus } from '@/types/book';
import { hasGrimmLinkCapability } from './capabilities';
import { GrimmLinkSyncStore } from './GrimmLinkSyncStore';
import { mapReadStatus, mergeRemoteReadStatus } from './status';

type StatusClient = { getReadStatuses(): Promise<{ statuses: string[] }> };

export class GrimmLinkReadStatusProvider {
  private statuses: string[] | null = null;

  constructor(private readonly client: StatusClient, private readonly store: GrimmLinkSyncStore, private readonly capabilities: string[]) {}

  private async available(): Promise<string[]> {
    if (!hasGrimmLinkCapability(this.capabilities, 'read-status')) return [];
    this.statuses ??= (await this.client.getReadStatuses()).statuses;
    return this.statuses;
  }

  async queueExplicit(bookHash: string, bookId: number, status: ReadingStatus): Promise<boolean> {
    const mapped = mapReadStatus(status, await this.available());
    if (!mapped) return false;
    await this.store.enqueueStatus(bookHash, bookId, mapped);
    return true;
  }

  async mergeRemote<T extends { readingStatus?: ReadingStatus; readingStatusUpdatedAt?: number }>(local: T, remote: { status?: string; updatedAt?: string }): Promise<T> {
    return { ...local, ...mergeRemoteReadStatus(local, remote, await this.available()) };
  }
}
