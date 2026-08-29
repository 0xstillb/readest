import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { GrimmLinkClient } from '@/services/grimmlink/GrimmLinkClient';
import { GrimmLinkSyncStore } from '@/services/grimmlink/GrimmLinkSyncStore';
import { GrimmLinkShelfProvider } from '@/services/grimmlink/shelfSync';
import type { GrimmLinkShelf } from '@/services/grimmlink/types';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { SectionTitle, Tips } from '../primitives';

/** Subscription selection and an explicit shelf sync command. */
const GrimmLinkShelfPanel = () => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const setLibrary = useLibraryStore((state) => state.setLibrary);
  const [shelves, setShelves] = useState<GrimmLinkShelf[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [syncStage, setSyncStage] = useState<{ stage: 'downloading' | 'importing'; filename: string } | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const store = useMemo(() => appService ? new GrimmLinkSyncStore(appService, `${settings.grimmlink.serverUrl}\u0000${settings.grimmlink.username}`) : null, [appService, settings.grimmlink.serverUrl, settings.grimmlink.username]);
  const client = useMemo(() => settings.grimmlink.enabled && settings.grimmlink.serverUrl && settings.grimmlink.userkey ? new GrimmLinkClient(settings.grimmlink) : null, [settings.grimmlink]);

  const refresh = useCallback(async () => {
    if (!client || !store) return;
    setLoading(true);
    try {
      const [regular, magic, subscriptions] = await Promise.all([
        client.getShelves('regular'), client.getShelves('magic'), store.getShelfSubscriptions(),
      ]);
      setShelves([...regular, ...magic]);
      setEnabled(new Set(subscriptions.map((subscription) => `${subscription.shelfType}:${subscription.shelfId}`)));
    } finally {
      setLoading(false);
    }
  }, [client, store]);

  useEffect(() => { void refresh(); }, [refresh]);
  if (!client || !store) return null;

  const toggle = async (shelf: GrimmLinkShelf, checked: boolean) => {
    const key = `${shelf.type}:${shelf.id}`;
    await store.saveShelfSubscription(shelf.type, shelf.id, checked);
    setEnabled((current) => {
      const next = new Set(current);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  };

  const sync = async () => {
    if (!client || !store || !appService) return;
    setSyncing(true);
    abortController.current = new AbortController();
    try {
      const provider = new GrimmLinkShelfProvider(client, store);
      const subscriptions = await store.getShelfSubscriptions();
      if (subscriptions.length === 0) {
        eventDispatcher.dispatch('toast', { message: _('Select at least one Grimmory shelf first.'), type: 'info' });
        return;
      }
      let downloaded = 0;
      let reused = 0;
      for (const subscription of subscriptions) {
        if (subscription.shelfType !== 'regular' && subscription.shelfType !== 'magic') continue;
        const result = await provider.sync(subscription.shelfType, subscription.shelfId, useLibraryStore.getState().library, async (_book, nextLibrary) => {
          setLibrary(nextLibrary);
          await appService.saveLibraryBooks(nextLibrary);
        }, appService, 'grimmlink', {
          signal: abortController.current.signal,
          onProgress: ({ progress: done, total }) => setProgress(total > 0 ? Math.round((done / total) * 100) : null),
          onStage: ({ stage, book }) => {
            setSyncStage({ stage, filename: book.filename });
            if (stage === 'downloading') setProgress(0);
          },
        });
        downloaded += result.downloaded;
        reused += result.reused;
      }
      if (downloaded > 0) {
        eventDispatcher.dispatch('toast', { message: _('Imported {{count}} books.', { count: downloaded }), type: 'success' });
      } else if (reused > 0) {
        eventDispatcher.dispatch('toast', { message: _('All selected shelf books are already in your library.'), type: 'info' });
      } else {
        eventDispatcher.dispatch('toast', { message: _('No books found in selected shelves.'), type: 'info' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : _('Connection error');
      eventDispatcher.dispatch('toast', { message: `${_('Shelf sync failed')}: ${message}`, type: 'error' });
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
          <button type='button' className='btn btn-ghost btn-sm' disabled={loading || syncing} onClick={() => void refresh()}>{_('Refresh')}</button>
          {syncing
            ? <button type='button' className='btn btn-ghost btn-sm eink-bordered' onClick={() => abortController.current?.abort()}>{_('Cancel')}</button>
            : <button type='button' className='btn btn-contrast btn-sm' disabled={loading} onClick={() => void sync()}>{_('Sync')}</button>}
        </div>
      </div>
      {shelves.map((shelf) => {
        const key = `${shelf.type}:${shelf.id}`;
        return <label key={key} className='flex items-center gap-3 rounded-lg px-2 py-2 eink-bordered'>
          <input type='checkbox' className='toggle toggle-sm' checked={enabled.has(key)} onChange={(event) => void toggle(shelf, event.target.checked)} />
          <span className='text-sm'>{shelf.name} <span className='opacity-60'>({shelf.type === 'magic' ? _('Magic Shelf') : _('Shelf')})</span></span>
        </label>;
      })}
      {!loading && shelves.length === 0 && <Tips><li>{_('No Grimmory shelves found.')}</li></Tips>}
      {syncing && <div className='text-xs opacity-70'>
        {syncStage?.stage === 'importing'
          ? _('Importing {{filename}}…', { filename: syncStage.filename })
          : syncStage
            ? _('Downloading {{filename}}: {{percent}}%', {
                filename: syncStage.filename,
                percent: progress ?? 0,
              })
            : _('Downloading…')}
      </div>}
    </section>
  );
};

export default GrimmLinkShelfPanel;
