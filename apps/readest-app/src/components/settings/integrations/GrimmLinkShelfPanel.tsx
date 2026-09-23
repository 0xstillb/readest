import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MdClose, MdRefresh, MdSync } from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { GrimmLinkClient } from '@/services/grimmlink/GrimmLinkClient';
import { GrimmLinkRequestError } from '@/services/grimmlink/GrimmLinkRequestError';
import { GrimmLinkSyncStore } from '@/services/grimmlink/GrimmLinkSyncStore';
import {
  reconcileShelfSnapshot,
  summarizeShelfReconciliation,
  syncSubscribedGrimmLinkShelves,
  type GrimmLinkShelfPreview,
} from '@/services/grimmlink/shelfSync';
import type { GrimmLinkShelf } from '@/services/grimmlink/types';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { getLocalBookFilename } from '@/utils/book';
import { SectionTitle, SettingsSelect, Tips } from '../primitives';
import GrimmLinkShelfSyncStatus from './GrimmLinkShelfSyncStatus';
import type { GrimmLinkShelfSyncStatus as GrimmLinkShelfSyncStatusValue } from '@/hooks/useGrimmLinkShelfSync';

/** Subscription selection and an explicit shelf sync command. */
const GrimmLinkShelfPanel = () => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const setLibrary = useLibraryStore((state) => state.setLibrary);
  const [shelves, setShelves] = useState<GrimmLinkShelf[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [cleanupPolicies, setCleanupPolicies] = useState<
    Map<string, 'keep_local' | 'remove_managed_copy'>
  >(new Map());
  const [downloadPolicies, setDownloadPolicies] = useState<
    Map<string, 'off' | 'wifi_only' | 'always'>
  >(new Map());
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<GrimmLinkShelfSyncStatusValue | null>(null);
  const [preview, setPreview] = useState<GrimmLinkShelfPreview | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const store = useMemo(
    () =>
      appService
        ? new GrimmLinkSyncStore(
            appService,
            `${settings.grimmlink.serverUrl}\u0000${settings.grimmlink.username}`,
          )
        : null,
    [appService, settings.grimmlink.serverUrl, settings.grimmlink.username],
  );
  const client = useMemo(
    () =>
      settings.grimmlink.enabled && settings.grimmlink.serverUrl && settings.grimmlink.userkey
        ? new GrimmLinkClient(settings.grimmlink)
        : null,
    [settings.grimmlink],
  );

  const refresh = useCallback(async () => {
    if (!client || !store) return;
    setLoading(true);
    try {
      const [regular, magic, subscriptions] = await Promise.all([
        client.getShelves('regular'),
        client.getShelves('magic'),
        store.getShelfSubscriptions(),
      ]);
      setShelves([...regular, ...magic]);
      setEnabled(
        new Set(
          subscriptions.map((subscription) => `${subscription.shelfType}:${subscription.shelfId}`),
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
      const localHashes = new Set(library.map((book) => book.hash));
      const localPaths = new Set(library.map(getLocalBookFilename));
      const previews = await Promise.all(
        subscriptions.map(async (subscription) => {
          const type = subscription.shelfType as 'regular' | 'magic';
          const [remote, existing] = await Promise.all([
            client.getShelfBooks(type, subscription.shelfId),
            store.getShelfEntries(subscription.shelfType, subscription.shelfId),
          ]);
          return summarizeShelfReconciliation(
            reconcileShelfSnapshot(remote, existing, localHashes, localPaths),
            subscription.downloadPolicy as 'off' | 'wifi_only' | 'always',
          );
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
    } catch (error) {
      if (abortController.current?.signal.aborted) {
        const message = _('Shelf sync cancelled');
        setSyncStatus({ stage: 'info', message });
        eventDispatcher.dispatch('toast', { message, type: 'info' });
        return;
      }
      const category = error instanceof GrimmLinkRequestError ? `[${error.category}] ` : '';
      const message = error instanceof Error ? error.message : _('Connection error');
      eventDispatcher.dispatch('toast', {
        message: `${_('Shelf refresh failed')}: ${category}${message}`,
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [client, store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!client || !store) return null;

  const toggle = async (shelf: GrimmLinkShelf, checked: boolean) => {
    const key = `${shelf.type}:${shelf.id}`;
    await store.saveShelfSubscription(
      shelf.type,
      shelf.id,
      checked,
      cleanupPolicies.get(key) ?? 'keep_local',
      downloadPolicies.get(key) ?? 'always',
    );
    setEnabled((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
    void refresh();
  };

  const setCleanupPolicy = async (
    shelf: GrimmLinkShelf,
    policy: 'keep_local' | 'remove_managed_copy',
  ) => {
    const key = `${shelf.type}:${shelf.id}`;
    await store.saveShelfSubscription(
      shelf.type,
      shelf.id,
      enabled.has(key),
      policy,
      downloadPolicies.get(key) ?? 'always',
    );
    setCleanupPolicies((current) => new Map(current).set(key, policy));
    void refresh();
  };

  const setDownloadPolicy = async (
    shelf: GrimmLinkShelf,
    policy: 'off' | 'wifi_only' | 'always',
  ) => {
    const key = `${shelf.type}:${shelf.id}`;
    await store.saveShelfSubscription(
      shelf.type,
      shelf.id,
      enabled.has(key),
      cleanupPolicies.get(key) ?? 'keep_local',
      policy,
    );
    setDownloadPolicies((current) => new Map(current).set(key, policy));
    void refresh();
  };

  const sync = async () => {
    if (!client || !store || !appService) return;
    setSyncing(true);
    setSyncStatus({ stage: 'starting' });
    abortController.current = new AbortController();
    try {
      const subscriptions = await store.getShelfSubscriptions();
      if (subscriptions.length === 0) {
        setSyncStatus({ stage: 'info', message: _('Select at least one Grimmory shelf first.') });
        eventDispatcher.dispatch('toast', {
          message: _('Select at least one Grimmory shelf first.'),
          type: 'info',
        });
        return;
      }
      const result = await syncSubscribedGrimmLinkShelves(
        client,
        store,
        () => useLibraryStore.getState().library,
        async (_book, nextLibrary) => {
          setLibrary(nextLibrary);
          await appService.saveLibraryBooks(nextLibrary);
        },
        appService,
        {
          signal: abortController.current.signal,
          onProgress: ({ progress: done, total }) =>
            setSyncStatus((current) => ({
              stage: current?.stage === 'importing' ? 'importing' : 'downloading',
              book: current?.book,
              progress: done,
              total,
            })),
          onStage: ({ stage, book }) => setSyncStatus({ stage, book: book.title || book.filename }),
        },
        async (_book, nextLibrary) => {
          setLibrary(nextLibrary);
          await appService.saveLibraryBooks(nextLibrary);
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
        eventDispatcher.dispatch('toast', {
          message,
          type: 'success',
        });
      } else if (reused > 0) {
        eventDispatcher.dispatch('toast', {
          message,
          type: 'info',
        });
      } else if (removed > 0) {
        eventDispatcher.dispatch('toast', {
          message,
          type: 'info',
        });
      } else {
        eventDispatcher.dispatch('toast', {
          message,
          type: 'info',
        });
      }
    } catch (error) {
      const category = error instanceof GrimmLinkRequestError ? `[${error.category}] ` : '';
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
          <SectionTitle>{_('Grimmory Shelves')}</SectionTitle>
          <p className='text-base-content/65 mt-0.5 text-xs'>
            {enabled.size > 0
              ? _('{{count}} selected', { count: enabled.size })
              : _('Choose the shelves to keep on this device')}
          </p>
        </div>
        <div className='flex shrink-0 justify-end gap-1'>
          <button
            type='button'
            className='btn btn-ghost h-10 min-h-10 gap-1.5 px-3'
            disabled={loading || syncing}
            onClick={() => void refresh()}
          >
            <MdRefresh aria-hidden='true' className={loading ? 'animate-spin' : ''} />
            {_('Refresh')}
          </button>
          {syncing ? (
            <button
              type='button'
              className='btn btn-ghost eink-bordered h-10 min-h-10 gap-1.5 px-3'
              onClick={() => abortController.current?.abort()}
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
                    />
                    <span className='min-w-0 flex-1 truncate text-sm font-medium'>
                      {shelf.name}
                    </span>
                    <span className='badge badge-ghost badge-sm shrink-0'>
                      {shelf.type === 'magic' ? _('Magic Shelf') : _('Shelf')}
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
                              event.target.value as 'off' | 'wifi_only' | 'always',
                            )
                          }
                          ariaLabel={_('Download policy')}
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
                              event.target.value as 'keep_local' | 'remove_managed_copy',
                            )
                          }
                          ariaLabel={_('Cleanup policy')}
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
          <li>{_('No Grimmory shelves found.')}</li>
        </Tips>
      )}
      {preview && shelves.length > 0 && (
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
      <GrimmLinkShelfSyncStatus
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

export default GrimmLinkShelfPanel;
