import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import { getLocalBookFilename } from '@/utils/book';
import type { GrimmLinkSettings } from '@/types/settings';
import { GrimmLinkBookLinkStore } from './bookLinks';
import { GrimmLinkSyncStore } from './GrimmLinkSyncStore';

export type GrimmLinkLibraryStatus =
  | 'grimmory'
  | 'synced'
  | 'pending'
  | 'remote-only'
  | 'downloaded'
  | 'conflict'
  | 'error';

export interface GrimmLinkLibraryStatusInput {
  mapping: boolean;
  localFilePresent: boolean;
  managedDownload: boolean;
  pending: boolean;
  conflict: boolean;
  error: boolean;
}

/** Derive a display status without persisting a stale `isSynced` flag. */
export const deriveGrimmLinkLibraryStatus = ({
  mapping,
  localFilePresent,
  managedDownload,
  pending,
  conflict,
  error,
}: GrimmLinkLibraryStatusInput): GrimmLinkLibraryStatus | null => {
  if (!mapping && !managedDownload) return null;
  if (error) return 'error';
  if (conflict) return 'conflict';
  if (!localFilePresent) return 'remote-only';
  if (pending) return 'pending';
  if (managedDownload) return 'downloaded';
  return 'synced';
};

export interface GrimmLinkBookStatus {
  status: GrimmLinkLibraryStatus;
  shelfCount: number;
  pending: boolean;
  lastSuccessAt: number | null;
}

/** Detail-view query only; library tiles should use a cached/batched selector. */
export const loadGrimmLinkBookStatus = async (
  appService: AppService,
  settings: GrimmLinkSettings,
  book: Book,
  localFilePresent: boolean,
): Promise<GrimmLinkBookStatus | null> => {
  if (!settings.enabled || !settings.serverUrl || !settings.username) return null;
  const connectionId = `${settings.serverUrl}\u0000${settings.username}`;
  const store = new GrimmLinkSyncStore(appService, connectionId);
  const links = new GrimmLinkBookLinkStore(appService, connectionId);
  const [cachedLink, snapshot] = await Promise.all([
    links.get(book.hash),
    store.getBookStatusSnapshot(book.hash, getLocalBookFilename(book)),
  ]);
  const mapping = !!cachedLink && !('unmatchedAt' in cachedLink);
  const status = deriveGrimmLinkLibraryStatus({
    mapping,
    localFilePresent,
    managedDownload: snapshot.managedDownload,
    pending: snapshot.pending,
    conflict: snapshot.conflict,
    error: snapshot.error,
  });
  if (!status) return null;
  return {
    status,
    shelfCount: snapshot.shelfCount,
    pending: snapshot.pending,
    lastSuccessAt: snapshot.lastSuccessAt,
  };
};
