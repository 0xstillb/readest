import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const [progress, setProgress] = useState<number | null>(null);
  const [syncStage, setSyncStage] = useState<{
    stage: 'downloading' | 'importing';
    filename: string;
  } | null>(null);
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
    abortController.current = new AbortController();
    try {
      const subscriptions = await store.getShelfSubscriptions();
      if (subscriptions.length === 0) {
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
            setProgress(total > 0 ? Math.round((done / total) * 100) : null),
          onStage: ({ stage, book }) => {
            setSyncStage({ stage, filename: book.filename });
            if (stage === 'downloading') setProgress(0);
          },
        },
        async (_book, nextLibrary) => {
          setLibrary(nextLibrary);
          await appService.saveLibraryBooks(nextLibrary);
        },
      );
      const { downloaded, reused, removed } = result;
      if (downloaded > 0) {
        eventDispatcher.dispatch('toast', {
          message: _('Imported {{count}} books.', { count: downloaded }),
          type: 'success',
        });
      } else if (reused > 0) {
        eventDispatcher.dispatch('toast', {
          message: _('All selected shelf books are already in your library.'),
          type: 'info',
        });
      } else if (removed > 0) {
        eventDispatcher.dispatch('toast', {
          message: _('Removed {{count}} books no longer in selected shelves.', { count: removed }),
          type: 'info',
        });
      } else {
        eventDispatcher.dispatch('toast', {
          message: _('No books found in selected shelves.'),
          type: 'info',
        });
      }
    } catch (error) {
      const category = error instanceof GrimmLinkRequestError ? `[${error.category}] ` : '';
      const message = error instanceof Error ? error.message : _('Connection error');
      eventDispatcher.dispatch('toast', {
        message: `${_('Shelf sync failed')}: ${category}${message}`,
        type: 'error',
      });
    } finally {
      abortController.current = null;
      setProgress(null);
      setSyncStage(null);
      setSyncing(false);
    }
  };

  return (
    <section className='space-y-2 pt-2'>
      <div className='flex items-center justify-between'>
        <SectionTitle>{_('Grimmory Shelves')}</SectionTitle>
        <div className='flex gap-1'>
          <button
            type='button'
            className='btn btn-ghost btn-sm'
            disabled={loading || syncing}
            onClick={() => void refresh()}
          >
            {_('Refresh')}
          </button>
          {syncing ? (
            <button
              type='button'
              className='btn btn-ghost btn-sm eink-bordered'
              onClick={() => abortController.current?.abort()}
            >
              {_('Cancel')}
            </button>
          ) : (
            <button
              type='button'
              className='btn btn-contrast btn-sm'
              disabled={loading}
              onClick={() => void sync()}
            >
              {_('Sync')}
            </button>
          )}
        </div>
      </div>
      {shelves.map((shelf) => {
        const key = `${shelf.type}:${shelf.id}`;
        return (
          <label key={key} className='flex items-center gap-3 rounded-lg px-2 py-2 eink-bordered'>
            <input
              type='checkbox'
              className='toggle toggle-sm'
              checked={enabled.has(key)}
              onChange={(event) => void toggle(shelf, event.target.checked)}
            />
            <span className='text-sm'>
              {shelf.name}{' '}
              <span className='opacity-60'>
                ({shelf.type === 'magic' ? _('Magic Shelf') : _('Shelf')})
              </span>
            </span>
            {enabled.has(key) && (
              <div className='ms-auto flex flex-wrap justify-end gap-1'>
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
            )}
          </label>
        );
      })}
      {!loading && shelves.length === 0 && (
        <Tips>
          <li>{_('No Grimmory shelves found.')}</li>
        </Tips>
      )}
      {preview && shelves.length > 0 && (
        <div className='rounded-lg border border-base-300 px-3 py-2 text-xs eink-bordered'>
          <strong>{_('Next sync')}</strong>{' '}
          {_('{{total}} books · {{downloads}} downloads · {{removed}} removed', {
            total: preview.total,
            downloads: preview.downloads,
            removed: preview.removed,
          })}
        </div>
      )}
      {syncing && (
        <div className='text-xs opacity-70'>
          {syncStage?.stage === 'importing'
            ? _('Importing {{filename}}…', { filename: syncStage.filename })
            : syncStage
              ? _('Downloading {{filename}}: {{percent}}%', {
                  filename: syncStage.filename,
                  percent: progress ?? 0,
                })
              : _('Downloading…')}
        </div>
      )}
    </section>
  );
};

export default GrimmLinkShelfPanel;
