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
  const [cachedLink, subscriptions, diagnostics] = await Promise.all([
    links.get(book.hash),
    store.getShelfSubscriptions(),
    store.getDiagnostics(),
  ]);
  const shelfEntryGroups = await Promise.all(
    (['regular', 'magic'] as const).map(async (type) => {
      const rows = await Promise.all(
        subscriptionsForType(subscriptions, type).map((subscription) =>
          store.getShelfEntries(type, subscription.shelfId),
        ),
      );
      return rows.flat();
    }),
  );
  const localPath = getLocalBookFilename(book);
  const shelfEntries = shelfEntryGroups.flat();
  const matchingEntries = shelfEntries.filter((entry) => entry.localPath === localPath);
  const mapping = !!cachedLink && !('unmatchedAt' in cachedLink);
  const pendingRows = await Promise.all(
    (['progress', 'sessions', 'metadata', 'status'] as const).map((category) =>
      store.all(category),
    ),
  );
  const pending = pendingRows.flat().some((row) => row.bookHash === book.hash);
  const error = diagnostics.lastError?.category === 'invalid-data';
  const status = deriveGrimmLinkLibraryStatus({
    mapping,
    localFilePresent,
    managedDownload: matchingEntries.some((entry) => entry.managedByGrimmLink),
    pending,
    conflict: diagnostics.lastError?.category === 'conflict',
    error,
  });
  if (!status) return null;
  return {
    status,
    shelfCount: matchingEntries.length,
    pending,
    lastSuccessAt: diagnostics.lastSuccessAt,
  };
};

const subscriptionsForType = (
  subscriptions: { shelfType: string; shelfId: number }[],
  type: 'regular' | 'magic',
) => subscriptions.filter((subscription) => subscription.shelfType === type);
