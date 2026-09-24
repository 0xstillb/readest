import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MdClose, MdRefresh, MdSync } from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { BookOrbitClient, BookOrbitRequestError } from '@/services/bookorbit/BookOrbitClient';
import {
  fetchBookOrbitShelves,
  reconcileShelfSnapshot,
  summarizeShelfReconciliation,
  syncSubscribedBookOrbitShelves,
  type BookOrbitShelf,
  type BookOrbitShelfCleanupPolicy,
  type BookOrbitShelfDownloadPolicy,
} from '@/services/bookorbit/shelfSync';
import { ShelfSyncStore, type ShelfSyncPreview } from '@/services/shelfSync';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { getLocalBookFilename } from '@/utils/book';
import { throttle } from '@/utils/throttle';
import { SectionTitle, SettingsSelect, Tips } from '../primitives';
import BookOrbitShelfSyncStatus from './BookOrbitShelfSyncStatus';
import type { BookOrbitShelfSyncStatus as BookOrbitShelfSyncStatusValue } from '@/services/bookorbit/types';

/**
 * Subscription management and manual sync commands for BookOrbit Collections and SmartScopes.
 */
const BookOrbitShelfPanel = () => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const setLibrary = useLibraryStore((state) => state.setLibrary);

  const [shelves, setShelves] = useState<BookOrbitShelf[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [cleanupPolicies, setCleanupPolicies] = useState<Map<string, BookOrbitShelfCleanupPolicy>>(
    new Map(),
  );
  const [downloadPolicies, setDownloadPolicies] = useState<
    Map<string, BookOrbitShelfDownloadPolicy>
  >(new Map());
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<BookOrbitShelfSyncStatusValue | null>(null);
  const [preview, setPreview] = useState<ShelfSyncPreview | null>(null);
  const abortController = useRef<AbortController | null>(null);

  const connectionId = `${settings.bookorbit.serverUrl}\u0000${settings.bookorbit.username}`;

  const store = useMemo(
    () => (appService ? new ShelfSyncStore(appService, 'bookorbit', connectionId) : null),
    [appService, connectionId],
  );

  const client = useMemo(
    () =>
      settings.bookorbit.enabled && settings.bookorbit.serverUrl && settings.bookorbit.userkey
        ? new BookOrbitClient(settings.bookorbit)
        : null,
    [settings.bookorbit],
  );

  const throttledProgress = useMemo(
    () =>
      throttle(
        (done: number, total?: number) => {
          setSyncStatus((current) => {
            if (!current) return current;
            return {
              ...current,
              stage: current.stage === 'importing' ? 'importing' : 'downloading',
              progress: done,
              total: total ?? current.total,
            };
          });
        },
        200,
        { emitLast: true },
      ),
    [],
  );

  const refresh = useCallback(async () => {
    if (!client || !store || !appService) return;
    setLoading(true);
    try {
      const [fetchedShelves, subscriptions] = await Promise.all([
        fetchBookOrbitShelves(client),
        store.getShelfSubscriptions(),
      ]);

      setShelves(fetchedShelves);

      setEnabled(
        new Set(
          subscriptions
            .filter((subscription) => subscription.enabled)
            .map((subscription) => `${subscription.shelfType}:${subscription.shelfId}`),
        ),
      );

      setCleanupPolicies(
        new Map(
          subscriptions.map((subscription) => [
            `${subscription.shelfType}:${subscription.shelfId}`,
            subscription.cleanupPolicy === 'remove_managed_copy'
              ? 'remove_managed_copy'
              : 'keep_local',
          ]),
        ),
      );

      setDownloadPolicies(
        new Map(
          subscriptions.map((subscription) => [
            `${subscription.shelfType}:${subscription.shelfId}`,
            subscription.downloadPolicy === 'off' || subscription.downloadPolicy === 'wifi_only'
              ? subscription.downloadPolicy
              : 'always',
          ]),
        ),
      );

      const library = useLibraryStore.getState().library;
      const localHashes = new Set(library.map((book) => book.hash).filter(Boolean) as string[]);
      const localPaths = new Set(library.map(getLocalBookFilename));

      const enabledSubs = subscriptions.filter((s) => s.enabled);
      if (enabledSubs.length === 0) {
        setPreview(null);
      } else {
        const previews = await Promise.all(
          enabledSubs.map(async (subscription) => {
            try {
              const [remote, existing] = await Promise.all([
                client.getShelfBooks(subscription.shelfType, subscription.shelfId),
                store.getShelfEntries(subscription.shelfId, subscription.shelfType),
              ]);
              return summarizeShelfReconciliation(
                reconcileShelfSnapshot(remote, existing, localHashes, localPaths),
                subscription.downloadPolicy,
              );
            } catch {
              return { total: 0, added: 0, unchanged: 0, changed: 0, removed: 0, downloads: 0 };
            }
          }),
        );

        setPreview(
          previews.reduce(
            (total, current) => ({
              total: total.total + current.total,
              added: total.added + current.added,
              unchanged: total.unchanged + current.unchanged,
              changed: total.changed + current.changed,
              removed: total.removed + current.removed,
              downloads: total.downloads + current.downloads,
            }),
            { total: 0, added: 0, unchanged: 0, changed: 0, removed: 0, downloads: 0 },
          ),
        );
      }
    } catch (error) {
      if (abortController.current?.signal.aborted) {
        const message = _('Shelf sync cancelled');
        setSyncStatus({ stage: 'cancelled', message });
        eventDispatcher.dispatch('toast', { message, type: 'info' });
        return;
      }
      const category = error instanceof BookOrbitRequestError ? `[${error.status}] ` : '';
      const message = error instanceof Error ? error.message : _('Connection error');
      eventDispatcher.dispatch('toast', {
        message: `${_('Shelf refresh failed')}: ${category}${message}`,
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [client, store, appService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!client || !store) return null;

  const toggle = async (shelf: BookOrbitShelf, checked: boolean) => {
    const key = `${shelf.type}:${shelf.id}`;
    await store.saveShelfSubscription({
      shelfType: shelf.type,
      shelfId: String(shelf.id),
      enabled: checked,
      cleanupPolicy: cleanupPolicies.get(key) ?? 'keep_local',
      downloadPolicy: downloadPolicies.get(key) ?? 'always',
    });
    setEnabled((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
    void refresh();
  };

  const setCleanupPolicy = async (shelf: BookOrbitShelf, policy: BookOrbitShelfCleanupPolicy) => {
    const key = `${shelf.type}:${shelf.id}`;
    await store.saveShelfSubscription({
      shelfType: shelf.type,
      shelfId: String(shelf.id),
      enabled: enabled.has(key),
      cleanupPolicy: policy,
      downloadPolicy: downloadPolicies.get(key) ?? 'always',
    });
    setCleanupPolicies((current) => new Map(current).set(key, policy));
    void refresh();
  };

  const setDownloadPolicy = async (shelf: BookOrbitShelf, policy: BookOrbitShelfDownloadPolicy) => {
    const key = `${shelf.type}:${shelf.id}`;
    await store.saveShelfSubscription({
      shelfType: shelf.type,
      shelfId: String(shelf.id),
      enabled: enabled.has(key),
      cleanupPolicy: cleanupPolicies.get(key) ?? 'keep_local',
      downloadPolicy: policy,
    });
    setDownloadPolicies((current) => new Map(current).set(key, policy));
    void refresh();
  };

  const sync = async () => {
    if (!client || !store || !appService) return;
    setSyncing(true);
    setSyncStatus({ stage: 'starting' });
    abortController.current = new AbortController();

    try {
      const subscriptions = await store.getShelfSubscriptions({ enabledOnly: true });
      if (subscriptions.length === 0) {
        const message = _('Select at least one BookOrbit collection or smart scope first.');
        setSyncStatus({ stage: 'cancelled', message });
        eventDispatcher.dispatch('toast', { message, type: 'info' });
        return;
      }

      const updateLibrary = async (nextLibrary: typeof useLibraryStore.getState.arguments) => {
        setLibrary(nextLibrary);
        await appService.saveLibraryBooks(nextLibrary);
      };

      const result = await syncSubscribedBookOrbitShelves(
        client,
        store,
        () => useLibraryStore.getState().library,
        async (_book, nextLibrary) => updateLibrary(nextLibrary),
        appService,
        {
          signal: abortController.current.signal,
          onStage: ({ stage, book }) => setSyncStatus({ stage, book: book.title || book.filename }),
          onProgress: ({ progress: done, total }) => throttledProgress(done, total),
        },
        async (_book, nextLibrary) => updateLibrary(nextLibrary),
        {
          serverUrl: settings.bookorbit.serverUrl,
          username: settings.bookorbit.username,
          userkey: settings.bookorbit.userkey,
          customHeaders: settings.bookorbit.customHeaders,
        },
      );

      const { downloaded, reused, removed } = result;
      const message =
        downloaded > 0
          ? _('Imported {{count}} books.', { count: downloaded })
          : reused > 0
            ? _('All selected shelf books are already in your library.')
            : removed > 0
              ? _('Removed {{count}} books no longer in selected shelves.', { count: removed })
              : _('No books found in selected shelves.');

      setSyncStatus({ stage: 'done', message });
      if (downloaded > 0) {
        eventDispatcher.dispatch('toast', { message, type: 'success' });
      } else {
        eventDispatcher.dispatch('toast', { message, type: 'info' });
      }
    } catch (error) {
      if (abortController.current?.signal.aborted) {
        const message = _('Shelf sync cancelled');
        setSyncStatus({ stage: 'cancelled', message });
        eventDispatcher.dispatch('toast', { message, type: 'info' });
        return;
      }
      const category = error instanceof BookOrbitRequestError ? `[${error.status}] ` : '';
      const message = error instanceof Error ? error.message : _('Connection error');
      setSyncStatus({ stage: 'error', message: `${category}${message}` });
      eventDispatcher.dispatch('toast', {
        message: `${_('Shelf sync failed')}: ${category}${message}`,
        type: 'error',
      });
    } finally {
      abortController.current = null;
      setSyncing(false);
    }
  };

  return (
    <section className='space-y-3 pt-2'>
      <div className='flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between'>
        <div className='min-w-0'>
          <SectionTitle>{_('BookOrbit Shelves')}</SectionTitle>
          <p className='text-base-content/65 mt-0.5 text-xs'>
            {enabled.size > 0
              ? _('{{count}} selected', { count: enabled.size })
              : _('Choose the collections and smart scopes to mirror on this device')}
          </p>
        </div>
        <div className='flex shrink-0 justify-end gap-1'>
          <button
            type='button'
            className='btn btn-ghost h-10 min-h-10 gap-1.5 px-3'
            disabled={loading || syncing}
            onClick={() => void refresh()}
            aria-label={_('Refresh shelves')}
          >
            <MdRefresh aria-hidden='true' className={loading ? 'motion-safe:animate-spin' : ''} />
            {_('Refresh')}
          </button>
          {syncing ? (
            <button
              type='button'
              className='btn btn-ghost eink-bordered h-10 min-h-10 gap-1.5 px-3'
              onClick={() => abortController.current?.abort()}
              aria-label={_('Cancel shelf sync')}
            >
              <MdClose aria-hidden='true' />
              {_('Cancel')}
            </button>
          ) : (
            <button
              type='button'
              className='btn btn-contrast h-10 min-h-10 gap-1.5 px-4'
              disabled={loading || enabled.size === 0}
              onClick={() => void sync()}
              aria-label={_('Sync shelves')}
            >
              <MdSync aria-hidden='true' />
              {_('Sync')}
            </button>
          )}
        </div>
      </div>

      {loading && shelves.length === 0 && (
        <div className='card eink-bordered border-base-200 bg-base-100 flex min-h-24 items-center justify-center gap-2 border text-sm'>
          <span className='loading loading-spinner loading-sm' />
          {_('Loading shelves…')}
        </div>
      )}

      {shelves.length > 0 && (
        <div className='card eink-bordered border-base-200 bg-base-100 border'>
          <div className='divide-base-200 divide-y'>
            {shelves.map((shelf) => {
              const key = `${shelf.type}:${shelf.id}`;
              const selected = enabled.has(key);
              return (
                <div key={key}>
                  <label className='hover:bg-base-200/40 flex min-h-14 cursor-pointer items-center gap-3 px-4 py-3 transition-colors duration-150'>
                    <input
                      type='checkbox'
                      className='toggle shrink-0'
                      checked={selected}
                      onChange={(event) => void toggle(shelf, event.target.checked)}
                      aria-label={`${_('Subscribe to')} ${shelf.name}`}
                    />
                    <div className='min-w-0 flex-1 truncate'>
                      <span className='text-sm font-medium'>{shelf.name}</span>
                      {shelf.description && (
                        <p className='text-base-content/60 truncate text-xs'>{shelf.description}</p>
                      )}
                    </div>
                    <span className='badge badge-ghost badge-sm shrink-0'>
                      {shelf.type === 'smartscope' ? _('SmartScope') : _('Collection')}
                    </span>
                  </label>
                  {selected && (
                    <div className='border-base-200 bg-base-200/30 grid gap-2 border-t px-4 py-3 sm:grid-cols-2'>
                      <div className='flex min-h-9 items-center justify-between gap-3'>
                        <span className='text-base-content/70 text-xs'>{_('Download')}</span>
                        <SettingsSelect
                          value={downloadPolicies.get(key) ?? 'always'}
                          onChange={(event) =>
                            void setDownloadPolicy(
                              shelf,
                              event.target.value as BookOrbitShelfDownloadPolicy,
                            )
                          }
                          ariaLabel={`${_('Download policy for')} ${shelf.name}`}
                          options={[
                            { value: 'always', label: _('Always download') },
                            { value: 'wifi_only', label: _('Wi-Fi only') },
                            { value: 'off', label: _('Download off') },
                          ]}
                        />
                      </div>
                      <div className='flex min-h-9 items-center justify-between gap-3'>
                        <span className='text-base-content/70 text-xs'>{_('When removed')}</span>
                        <SettingsSelect
                          value={cleanupPolicies.get(key) ?? 'keep_local'}
                          onChange={(event) =>
                            void setCleanupPolicy(
                              shelf,
                              event.target.value as BookOrbitShelfCleanupPolicy,
                            )
                          }
                          ariaLabel={`${_('Cleanup policy for')} ${shelf.name}`}
                          options={[
                            { value: 'keep_local', label: _('Keep local') },
                            { value: 'remove_managed_copy', label: _('Remove managed copy') },
                          ]}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!loading && shelves.length === 0 && (
        <Tips>
          <li>{_('No BookOrbit collections or smart scopes found.')}</li>
        </Tips>
      )}

      {preview && shelves.length > 0 && enabled.size > 0 && (
        <div className='eink-bordered border-base-200 bg-base-200/40 rounded-lg border p-3'>
          <div className='mb-2 flex items-center justify-between gap-3 text-sm'>
            <strong>{_('Next sync')}</strong>
            <span className='text-base-content/70'>
              {_('{{count}} books', { count: preview.total })}
            </span>
          </div>
          <div className='grid grid-cols-3 gap-2 text-center'>
            <SyncPreviewValue label={_('Downloads')} value={preview.downloads} />
            <SyncPreviewValue label={_('Updates')} value={preview.changed} />
            <SyncPreviewValue label={_('Removals')} value={preview.removed} />
          </div>
        </div>
      )}

      <BookOrbitShelfSyncStatus
        syncing={syncing}
        status={syncStatus}
        onCancel={() => abortController.current?.abort()}
      />
    </section>
  );
};

const SyncPreviewValue = ({ label, value }: { label: string; value: number }) => (
  <div className='bg-base-100 rounded-md px-2 py-2'>
    <div className='text-base font-semibold tabular-nums'>{value}</div>
    <div className='text-base-content/65 truncate text-[0.7rem]'>{label}</div>
  </div>
);

export default BookOrbitShelfPanel;
