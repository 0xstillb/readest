import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';
import { debounce } from '@/utils/debounce';
import { eventDispatcher } from '@/utils/event';
import { getCFIFromXPointer, getXPointerFromCFI } from '@/utils/xcfi';
import { FIXED_LAYOUT_FORMATS } from '@/types/book';
import { GrimmLinkClient } from '@/services/grimmlink/GrimmLinkClient';
import { GrimmLinkBookLinkStore } from '@/services/grimmlink/bookLinks';
import { GrimmLinkProgressProvider, progressPullDisposition, toGrimmLinkProgressPayload } from '@/services/grimmlink/progress';
import { GrimmLinkSyncStore } from '@/services/grimmlink/GrimmLinkSyncStore';
import { GrimmLinkOutbox } from '@/services/grimmlink/outbox';
import { GrimmLinkSessionTracker } from '@/services/grimmlink/sessions';
import { GrimmLinkRatingProvider } from '@/services/grimmlink/rating';
import { GrimmLinkMetadataProvider } from '@/services/grimmlink/metadataProvider';
import type { SyncDetails } from './useKOSync';

type SyncState = 'idle' | 'checking' | 'conflict' | 'synced';

/** Reader-only GrimmLink v1 progress, session, rating, annotation, and bookmark integration. */
export const useGrimmLinkSync = (bookKey: string) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const getProgress = useReaderStore((s) => s.getProgress);
  const getView = useReaderStore((s) => s.getView);
  const getBookData = useBookDataStore((s) => s.getBookData);
  const updateBooknotes = useBookDataStore((s) => s.updateBooknotes);
  const progress = useBookProgress(bookKey);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [conflictDetails, setConflictDetails] = useState<SyncDetails | null>(null);
  const pulled = useRef(false);
  const metadataPulled = useRef(false);
  const sessionTracker = useRef(new GrimmLinkSessionTracker());

  const client = useMemo(() => {
    const config = settings.grimmlink;
    return appService && config.enabled && config.serverUrl && config.userkey ? new GrimmLinkClient(config) : null;
  }, [appService, settings.grimmlink]);

  const store = useMemo(() => {
    const config = settings.grimmlink;
    return appService && config.enabled ? new GrimmLinkSyncStore(appService, `${config.serverUrl}\u0000${config.username}`) : null;
  }, [appService, settings.grimmlink]);

  const outbox = useMemo(() => client && store ? new GrimmLinkOutbox(store, client) : null, [client, store]);

  const provider = useMemo(() => {
    const config = settings.grimmlink;
    if (!appService || !client || !store || !config.enabled || !config.syncProgress || !config.serverUrl || !config.userkey) return null;
    return new GrimmLinkProgressProvider(
      client,
      new GrimmLinkBookLinkStore(appService, `${config.serverUrl}\u0000${config.username}`),
      config,
      store,
    );
  }, [appService, client, settings.grimmlink, store]);

  const makePosition = useCallback(async () => {
    const local = getProgress(bookKey);
    const data = getBookData(bookKey);
    if (!local || !data?.book) return null;
    if (FIXED_LAYOUT_FORMATS.has(data.book.format)) {
      return { currentPage: local.section?.current ?? 0, totalPages: local.section?.total ?? 0 };
    }
    if (!local.location) return null;
    try {
      const view = getView(bookKey);
      const content = view?.renderer.getContents().find((item) => item.index === view.renderer.primaryIndex);
      const result = await getXPointerFromCFI(local.location, content?.doc, content?.index, data.bookDoc ?? undefined);
      return { location: result.xpointer, fraction: local.pageinfo?.total ? ((local.pageinfo.current ?? 0) + 1) / local.pageinfo.total : 0 };
    } catch {
      return null;
    }
  }, [bookKey, getBookData, getProgress, getView]);

  const applyRemote = useCallback(async (remote: NonNullable<SyncDetails['remote']>) => {
    const data = getBookData(bookKey);
    const view = getView(bookKey);
    if (!data?.book || !view) return;
    if (FIXED_LAYOUT_FORMATS.has(data.book.format)) {
      const page = Number(remote.progress);
      if (Number.isFinite(page)) view.select(Math.max(0, page - 1));
    } else if (remote.progress?.startsWith('/body/DocFragment[')) {
      try {
        view.goTo(await getCFIFromXPointer(remote.progress, undefined, undefined, data.bookDoc ?? undefined));
      } catch {
        if (typeof remote.percentage === 'number') view.goToFraction(remote.percentage);
      }
    } else if (typeof remote.percentage === 'number') {
      view.goToFraction(remote.percentage);
    }
    eventDispatcher.dispatch('hint', { bookKey, message: _('Reading Progress Synced') });
  }, [_, bookKey, getBookData, getView]);

  const queueProgress = useCallback(async () => {
    if (!provider || !pulled.current || settings.grimmlink.strategy === 'receive') return;
    const book = getBookData(bookKey)?.book;
    const position = await makePosition();
    if (book && position && store && outbox) {
      const link = await provider.resolveLink(book);
      if (!link) return;
      await store.enqueueProgress(book.hash, toGrimmLinkProgressPayload(book, link, position, settings.grimmlink));
      void outbox.replay();
    }
  }, [bookKey, getBookData, makePosition, outbox, provider, settings.grimmlink.strategy, store]);

  const pushProgress = useMemo(() => debounce(() => { void queueProgress(); }, 5000), [queueProgress]);

  const pullProgress = useCallback(async (retryUnmatched = false) => {
    if (!provider || !progress) return;
    const data = getBookData(bookKey);
    const book = data?.book;
    const bookDoc = data?.bookDoc;
    if (!book || !bookDoc) return;
    pulled.current = true;
    if (settings.grimmlink.strategy === 'send') { setSyncState('synced'); return; }
    setSyncState('checking');
    const link = await provider.resolveLink(book, retryUnmatched);
    if (!link) {
      eventDispatcher.dispatch('toast', { type: 'info', message: _('Book not found in Grimmory'), timeout: 2500 });
      setSyncState('synced');
      return;
    }
    const remote = await provider.pull(book);
    if (!remote) { setSyncState('synced'); return; }
    const remoteFraction = typeof remote.percentage === 'number' ? remote.percentage / 100 : undefined;
    const localUpdatedAt = data?.config?.updatedAt ?? book.updatedAt;
    const remoteUpdatedAt = remote.updatedAt ? Date.parse(remote.updatedAt) : 0;
    const disposition = progressPullDisposition(settings.grimmlink.strategy, remoteUpdatedAt > localUpdatedAt);
    const details: SyncDetails = {
      book,
      bookDoc,
      local: { cfi: progress.location, preview: _('Current position') },
      remote: {
        progress: remote.location ?? remote.progress ?? String(remote.currentPage ?? ''),
        percentage: remoteFraction,
        device: remote.device,
        device_id: remote.device_id,
        preview: _('Remote position'),
      },
    };
    if (disposition === 'apply') await applyRemote(details.remote);
    if (disposition === 'prompt') setConflictDetails(details);
    setSyncState(disposition === 'prompt' ? 'conflict' : 'synced');
  }, [_, applyRemote, bookKey, getBookData, progress, provider, settings.grimmlink.strategy]);

  useEffect(() => {
    const push = async (event: CustomEvent) => {
      if (event.detail.bookKey === bookKey) await queueProgress();
    };
    const pull = (event: CustomEvent) => { if (event.detail.bookKey === bookKey) void pullProgress(true); };
    eventDispatcher.on('push-grimmlink', push);
    eventDispatcher.on('flush-grimmlink', push);
    eventDispatcher.on('pull-grimmlink', pull);
    return () => {
      eventDispatcher.off('push-grimmlink', push);
      eventDispatcher.off('flush-grimmlink', push);
      eventDispatcher.off('pull-grimmlink', pull);
      pushProgress.flush();
    };
  }, [bookKey, pullProgress, pushProgress, queueProgress]);

  useEffect(() => { if (provider && progress && !pulled.current) void pullProgress(); }, [progress, provider, pullProgress]);
  useEffect(() => { if (syncState === 'synced' && progress && settings.grimmlink.strategy !== 'receive') pushProgress(); }, [progress, pushProgress, settings.grimmlink.strategy, syncState]);

  useEffect(() => {
    if (!client || !store || !settings.grimmlink.syncMetadata) return;
    const book = getBookData(bookKey)?.book;
    if (!book) return;
    void client.getCapabilities().then(async ({ capabilities }) => {
      const ratings = new GrimmLinkRatingProvider(client, store, {
        capabilities,
        device: settings.grimmlink.deviceName,
        deviceId: settings.grimmlink.deviceId,
      });
      await ratings.pull(book.hash, await store.getRating(book.hash));
    }).catch(() => {});
  }, [bookKey, client, getBookData, settings.grimmlink, store]);

  useEffect(() => {
    if (!client || !store || !outbox || !settings.grimmlink.syncMetadata || metadataPulled.current) return;
    const data = getBookData(bookKey);
    const book = data?.book;
    if (!book) return;
    metadataPulled.current = true;
    void client.getCapabilities().then(async ({ capabilities }) => {
      const metadata = new GrimmLinkMetadataProvider(client, store, {
        capabilities, device: settings.grimmlink.deviceName, deviceId: settings.grimmlink.deviceId,
      });
      const notes = data?.config?.booknotes ?? [];
      await metadata.pull(book.hash, notes, async (merged) => {
        updateBooknotes(bookKey, merged);
      }, (note) => {
        console.warn('[GrimmLink] retained unresolved remote note', note.id);
      });
      if (settings.grimmlink.strategy !== 'receive') {
        const link = await provider?.resolveLink(book);
        if (link) {
          await metadata.queuePush(book.hash, link.bookId, getBookData(bookKey)?.config?.booknotes ?? [], link.bookFileId, book.format);
          void outbox.replay();
        }
      }
    }).catch(() => { metadataPulled.current = false; });
  }, [bookKey, client, getBookData, outbox, provider, settings.grimmlink, store, updateBooknotes]);

  // Queue the session locally on every lifecycle boundary. Link resolution and replay are deliberately fire-and-forget.
  useEffect(() => {
    if (!provider || !store || !outbox || !settings.grimmlink.syncSessions) return;
    void makePosition().then((position) => {
      const value = position as { fraction?: number; location?: string; currentPage?: number; totalPages?: number } | null;
      sessionTracker.current.startSession({ progress: value?.fraction, location: value?.location, currentPage: value?.currentPage, totalPages: value?.totalPages });
    });
    const closeSession = () => {
      void (async () => {
        const book = getBookData(bookKey)?.book;
        const position = await makePosition();
        if (!book || !position) return;
        const link = await provider.resolveLink(book);
        if (!link) return;
        const value = position as { fraction?: number; location?: string; currentPage?: number; totalPages?: number };
        const session = sessionTracker.current.finish(
          { progress: value.fraction, location: value.location, currentPage: value.currentPage, totalPages: value.totalPages },
          { bookId: link.bookId, bookHash: book.hash, bookType: book.format, device: settings.grimmlink.deviceName, deviceId: settings.grimmlink.deviceId },
        );
        if (session) { await store.enqueueSession(session); void outbox.replay(); }
      })();
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') closeSession(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); closeSession(); };
  }, [bookKey, getBookData, makePosition, outbox, provider, settings.grimmlink, store]);

  return {
    syncState, conflictDetails,
    resolveWithLocal: () => { pushProgress(); pushProgress.flush(); setConflictDetails(null); setSyncState('synced'); },
    resolveWithRemote: async () => { if (conflictDetails) await applyRemote(conflictDetails.remote); setConflictDetails(null); setSyncState('synced'); },
  };
};
