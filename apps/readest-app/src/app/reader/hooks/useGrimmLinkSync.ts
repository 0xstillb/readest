import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';
import { DEFAULT_GRIMMLINK_SETTINGS } from '@/services/constants';
import { debounce } from '@/utils/debounce';
import { eventDispatcher } from '@/utils/event';
import { getCFIFromXPointer, getXPointerFromCFI, XCFI } from '@/utils/xcfi';
import { getIndexFromCfi } from '@/utils/cfi';
import { getLocalProgressPreview } from './kosyncPreview';
import type { BookDoc, TOCItem } from '@/libs/document';
import { FIXED_LAYOUT_FORMATS } from '@/types/book';
import { GrimmLinkClient } from '@/services/grimmlink/GrimmLinkClient';
import { GrimmLinkBookLinkStore } from '@/services/grimmlink/bookLinks';
import {
  GrimmLinkProgressProvider,
  progressPullDisposition,
  toGrimmLinkProgressPayload,
} from '@/services/grimmlink/progress';
import { GrimmLinkSyncStore } from '@/services/grimmlink/GrimmLinkSyncStore';
import { GrimmLinkOutbox } from '@/services/grimmlink/outbox';
import { GrimmLinkReplayScheduler } from '@/services/grimmlink/replayScheduler';
import { GrimmLinkSessionTracker } from '@/services/grimmlink/sessions';
import { GrimmLinkRatingProvider } from '@/services/grimmlink/rating';
import { GrimmLinkMetadataProvider } from '@/services/grimmlink/metadataProvider';
import { GrimmLinkRequestError } from '@/services/grimmlink/GrimmLinkRequestError';
import type { SyncDetails } from './useKOSync';
import { useWindowActiveChanged } from './useWindowActiveChanged';

type SyncState =
  | 'idle'
  | 'checking'
  | 'conflict'
  | 'synced'
  | 'queued'
  | 'retrying'
  | 'offline'
  | 'error';

const flattenToc = (items: TOCItem[]): TOCItem[] =>
  items.flatMap((item) => [item, ...(item.subitems ? flattenToc(item.subitems) : [])]);

const chapterForIndex = (toc: TOCItem[], index: number | null): string | undefined => {
  if (index == null) return undefined;
  return flattenToc(toc)
    .filter((item) => typeof item.index === 'number' && item.index <= index && item.label?.trim())
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .at(-1)
    ?.label?.trim();
};

/**
 * Resolve the remote position to the same TOC label used by This device.
 *
 * Grimmory stores EPUB progress as a CREngine XPointer. We only need its
 * `DocFragment[N]` spine index to find the chapter, so do not round-trip the
 * pointer through a document/DOM here. Apart from being cheaper, this keeps
 * the conflict dialog useful when a remote XPointer points into a malformed
 * or not-yet-loaded section that cannot be converted to a full CFI.
 */
export const getRemoteChapterLabel = (
  remote: {
    progress?: string;
    location?: string;
    chapter?: string;
    chapterTitle?: string;
    sectionLabel?: string;
  },
  bookDoc: BookDoc,
): string | undefined => {
  const explicitLabel = [remote.chapter, remote.chapterTitle, remote.sectionLabel]
    .map((label) => label?.trim())
    .find((label): label is string => Boolean(label));
  if (explicitLabel) return explicitLabel;

  const position = (remote.location ?? remote.progress)?.trim();
  if (!position) return undefined;

  try {
    const index = position.startsWith('epubcfi(')
      ? getIndexFromCfi(position)
      : position.startsWith('/body/DocFragment')
        ? XCFI.extractSpineIndex(position)
        : null;
    return chapterForIndex(bookDoc.toc ?? [], index);
  } catch {
    return undefined;
  }
};

/** Reader-only GrimmLink v1 progress, session, rating, annotation, and bookmark integration. */
export const useGrimmLinkSync = (bookKey: string) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const grimmlink = settings.grimmlink ?? DEFAULT_GRIMMLINK_SETTINGS;
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
  const pullInFlight = useRef<Promise<void> | null>(null);
  const sessionClosing = useRef<Promise<void> | null>(null);
  const suppressNextPush = useRef(false);
  const lastBookLink = useRef<{
    bookId: number;
    bookHash: string;
    bookFileId?: number;
    format?: string;
  } | null>(null);

  const client = useMemo(() => {
    const config = grimmlink;
    return appService && config.enabled && config.serverUrl && config.userkey
      ? new GrimmLinkClient(config)
      : null;
  }, [appService, grimmlink]);

  const store = useMemo(() => {
    const config = grimmlink;
    return appService && config.enabled
      ? new GrimmLinkSyncStore(appService, `${config.serverUrl}\u0000${config.username}`)
      : null;
  }, [appService, grimmlink]);

  const replayScheduler = useMemo(
    () =>
      client && store
        ? new GrimmLinkReplayScheduler(new GrimmLinkOutbox(store, client))
        : null,
    [client, store],
  );

  const provider = useMemo(() => {
    const config = grimmlink;
    if (
      !appService ||
      !client ||
      !store ||
      !config.enabled ||
      !config.syncProgress ||
      !config.serverUrl ||
      !config.userkey
    )
      return null;
    return new GrimmLinkProgressProvider(
      client,
      new GrimmLinkBookLinkStore(appService, `${config.serverUrl}\u0000${config.username}`),
      config,
      store,
    );
  }, [appService, client, grimmlink, store]);

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
      const content = view?.renderer
        .getContents()
        .find((item) => item.index === view.renderer.primaryIndex);
      const result = await getXPointerFromCFI(
        local.location,
        content?.doc,
        content?.index,
        data.bookDoc ?? undefined,
      );
      return {
        location: result.xpointer,
        fraction: local.pageinfo?.total
          ? ((local.pageinfo.current ?? 0) + 1) / local.pageinfo.total
          : 0,
      };
    } catch {
      return null;
    }
  }, [bookKey, getBookData, getProgress, getView]);

  const applyRemote = useCallback(
    async (remote: NonNullable<SyncDetails['remote']>) => {
      const data = getBookData(bookKey);
      const view = getView(bookKey);
      if (!data?.book || !view) return;
      if (FIXED_LAYOUT_FORMATS.has(data.book.format)) {
        const page = Number(remote.progress);
        if (Number.isFinite(page)) view.select(Math.max(0, page - 1));
      } else if (remote.progress?.startsWith('/body/DocFragment[')) {
        try {
          view.goTo(
            await getCFIFromXPointer(
              remote.progress,
              undefined,
              undefined,
              data.bookDoc ?? undefined,
            ),
          );
        } catch {
          if (typeof remote.percentage === 'number') view.goToFraction(remote.percentage);
        }
      } else if (typeof remote.percentage === 'number') {
        view.goToFraction(remote.percentage);
      }
      eventDispatcher.dispatch('hint', { bookKey, message: _('Reading Progress Synced') });
    },
    [_, bookKey, getBookData, getView],
  );

  const queueProgress = useCallback(async () => {
    if (suppressNextPush.current) {
      suppressNextPush.current = false;
      return;
    }
    if (!provider || !pulled.current || grimmlink.strategy === 'receive') return;
    const book = getBookData(bookKey)?.book;
    const position = await makePosition();
    if (book && position && store && replayScheduler) {
      try {
        const link = await provider.resolveLink(book);
        if (!link) return;
        lastBookLink.current = link;
        await store.enqueueProgress(
          book.hash,
          toGrimmLinkProgressPayload(book, link, position, grimmlink),
        );
        setSyncState('queued');
        void replayScheduler.requestReplay(12_000);
      } catch (error) {
        setSyncState(
          error instanceof GrimmLinkRequestError && error.category === 'network'
            ? 'offline'
            : 'error',
        );
      }
    }
  }, [bookKey, getBookData, makePosition, replayScheduler, provider, grimmlink.strategy, store]);

  const pushProgress = useMemo(
    () =>
      debounce(() => {
        void queueProgress();
      }, 5000),
    [queueProgress],
  );

  const pullProgress = useCallback(
    async (retryUnmatched = false) => {
      if (pullInFlight.current) return pullInFlight.current;
      const run = (async () => {
        if (!provider || !progress) return;
        const data = getBookData(bookKey);
        const book = data?.book;
        const bookDoc = data?.bookDoc;
        if (!book || !bookDoc) return;
        if (grimmlink.strategy === 'send') {
          pulled.current = true;
          setSyncState('synced');
          return;
        }
        setSyncState('checking');
        let link;
        try {
          link = await provider.resolveLink(book, retryUnmatched);
        } catch (error) {
          setSyncState(
            error instanceof GrimmLinkRequestError && error.category === 'network'
              ? 'offline'
              : 'error',
          );
          return;
        }
        if (!link) {
          eventDispatcher.dispatch('toast', {
            type: 'info',
            message: _('Book not found in Grimmory'),
            timeout: 2500,
          });
          setSyncState('synced');
          return;
        }
        lastBookLink.current = link;
        let remote;
        try {
          remote = await provider.pull(book);
        } catch (error) {
          setSyncState(
            error instanceof GrimmLinkRequestError && error.category === 'network'
              ? 'offline'
              : 'error',
          );
          return;
        }
        pulled.current = true;
        if (!remote) {
          setSyncState('synced');
          return;
        }
        const remoteFraction =
          typeof remote.percentage === 'number' ? remote.percentage / 100 : undefined;
        const localUpdatedAt = data?.config?.updatedAt ?? book.updatedAt;
        const remoteUpdatedAt = remote.updatedAt ? Date.parse(remote.updatedAt) : 0;
        const remoteChapter = await getRemoteChapterLabel(remote, bookDoc);
        const localPageInfo = FIXED_LAYOUT_FORMATS.has(book.format)
          ? progress.section
          : progress.pageinfo;
        const disposition = progressPullDisposition(
          grimmlink.strategy,
          remoteUpdatedAt > localUpdatedAt,
          remote.device_id,
          grimmlink.deviceId,
        );
        const details: SyncDetails = {
          book,
          bookDoc,
          local: {
            cfi: progress.location,
            preview: getLocalProgressPreview(progress, FIXED_LAYOUT_FORMATS.has(book.format), _),
            chapter: progress.sectionLabel?.trim() || undefined,
            percentage: localPageInfo?.total
              ? ((localPageInfo.current ?? 0) + 1) / localPageInfo.total
              : undefined,
            currentPage: progress.section?.current,
            totalPages: progress.section?.total,
            device: grimmlink.deviceName,
            updatedAt: localUpdatedAt,
          },
          remote: {
            progress: remote.location ?? remote.progress ?? String(remote.currentPage ?? ''),
            percentage: remoteFraction,
            chapter: remoteChapter,
            device: remote.device,
            device_id: remote.device_id,
            updatedAt: remote.updatedAt,
            currentPage: remote.currentPage,
            totalPages: remote.totalPages,
            preview: _('Remote position'),
          },
        };
        if (disposition === 'apply') await applyRemote(details.remote);
        if (disposition === 'prompt') setConflictDetails(details);
        setSyncState(disposition === 'prompt' ? 'conflict' : 'synced');
      })();
      pullInFlight.current = run;
      try {
        await run;
      } finally {
        if (pullInFlight.current === run) pullInFlight.current = null;
      }
    },
    [_, applyRemote, bookKey, getBookData, progress, provider, grimmlink.strategy],
  );

  useEffect(() => {
    const push = async (event: CustomEvent) => {
      if (event.detail.bookKey === bookKey) await queueProgress();
    };
    const pull = (event: CustomEvent) => {
      if (event.detail.bookKey === bookKey) void pullProgress(true);
    };
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

  useEffect(() => {
    if (provider && progress && !pulled.current) void pullProgress();
  }, [progress, provider, pullProgress]);
  useEffect(() => {
    if (syncState === 'synced' && progress && grimmlink.strategy !== 'receive') pushProgress();
  }, [progress, pushProgress, grimmlink.strategy, syncState]);

  useEffect(() => {
    if (!client || !store || !grimmlink.syncMetadata) return;
    const book = getBookData(bookKey)?.book;
    if (!book) return;
    void client
      .getCapabilities()
      .then(async ({ capabilities }) => {
        const ratings = new GrimmLinkRatingProvider(client, store, {
          capabilities,
          device: grimmlink.deviceName,
          deviceId: grimmlink.deviceId,
        });
        await ratings.pull(book.hash, await store.getRating(book.hash));
      })
      .catch(() => {});
  }, [bookKey, client, getBookData, grimmlink, store]);

  useEffect(() => {
    if (!client || !store || !replayScheduler || !grimmlink.syncMetadata || metadataPulled.current)
      return;
    const data = getBookData(bookKey);
    const book = data?.book;
    if (!book) return;
    metadataPulled.current = true;
    void client
      .getCapabilities()
      .then(async ({ capabilities }) => {
        const metadata = new GrimmLinkMetadataProvider(client, store, {
          capabilities,
          device: grimmlink.deviceName,
          deviceId: grimmlink.deviceId,
        });
        const notes = data?.config?.booknotes ?? [];
        await metadata.pull(
          book.hash,
          notes,
          async (merged) => {
            updateBooknotes(bookKey, merged);
          },
          (note) => {
            console.warn('[GrimmLink] retained unresolved remote note', note.id);
          },
        );
        if (grimmlink.strategy !== 'receive') {
          const link = await provider?.resolveLink(book);
          if (link) {
            await metadata.queuePush(
              book.hash,
              link.bookId,
              getBookData(bookKey)?.config?.booknotes ?? [],
              link.bookFileId,
              book.format,
            );
            void replayScheduler.requestReplay();
          }
        }
      })
      .catch(() => {
        metadataPulled.current = false;
      });
  }, [bookKey, client, getBookData, replayScheduler, provider, grimmlink, store, updateBooknotes]);

  const startSession = useCallback(async () => {
    if (
      !provider ||
      !store ||
      !replayScheduler ||
      !grimmlink.syncSessions ||
      sessionTracker.current.isActive()
    )
      return;
    const position = await makePosition();
    const value = position as {
      fraction?: number;
      location?: string;
      currentPage?: number;
      totalPages?: number;
    } | null;
    sessionTracker.current.startSession({
      progress: value?.fraction,
      location: value?.location,
      currentPage: value?.currentPage,
      totalPages: value?.totalPages,
    });
  }, [makePosition, replayScheduler, provider, grimmlink.syncSessions, store]);

  const closeSession = useCallback(async () => {
    if (sessionClosing.current) return sessionClosing.current;
    const run = (async () => {
      if (
        !provider ||
        !store ||
        !replayScheduler ||
        !grimmlink.syncSessions ||
        !sessionTracker.current.isActive()
      )
        return;
      const book = getBookData(bookKey)?.book;
      const position = await makePosition();
      if (!book || !position) return;
      let link = lastBookLink.current;
      try {
        link = (await provider.resolveLink(book)) ?? link;
      } catch (error) {
        if (!link) {
          setSyncState(
            error instanceof GrimmLinkRequestError && error.category === 'network'
              ? 'offline'
              : 'error',
          );
          return;
        }
      }
      if (!link) return;
      lastBookLink.current = link;
      const value = position as {
        fraction?: number;
        location?: string;
        currentPage?: number;
        totalPages?: number;
      };
      const session = sessionTracker.current.finish(
        {
          progress: value.fraction,
          location: value.location,
          currentPage: value.currentPage,
          totalPages: value.totalPages,
        },
        {
          bookId: link.bookId,
          bookHash: book.hash,
          bookType: book.format,
          device: grimmlink.deviceName,
          deviceId: grimmlink.deviceId,
        },
      );
      if (session) {
        await store.enqueueSession(session);
        setSyncState('queued');
        void replayScheduler.flushNow();
      }
    })();
    sessionClosing.current = run;
    try {
      await run;
    } finally {
      if (sessionClosing.current === run) sessionClosing.current = null;
    }
  }, [bookKey, getBookData, makePosition, replayScheduler, provider, grimmlink, store]);

  useEffect(() => {
    void startSession();
    return () => {
      void closeSession();
    };
  }, [closeSession, startSession]);

  useWindowActiveChanged((active) => {
    if (active) {
      pulled.current = false;
      metadataPulled.current = false;
      void startSession();
      void replayScheduler?.requestReplay();
      void pullProgress();
    } else {
      pushProgress.flush();
      void closeSession();
    }
  });

  useEffect(() => {
    if (!replayScheduler) return;
    const onOnline = () => {
      setSyncState('retrying');
      void replayScheduler.requestReplay();
      void pullProgress();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [replayScheduler, pullProgress]);

  return {
    syncState,
    conflictDetails,
    resolveWithLocal: async () => {
      await queueProgress();
      pushProgress.cancel();
      setConflictDetails(null);
      if (store) {
        const summary = await store.getOutboxSummary();
        setSyncState(summary.totalPending > 0 ? 'queued' : 'synced');
      } else {
        setSyncState('queued');
      }
    },
    resolveWithRemote: async () => {
      if (conflictDetails) await applyRemote(conflictDetails.remote);
      suppressNextPush.current = true;
      setConflictDetails(null);
      if (store) {
        const summary = await store.getOutboxSummary();
        setSyncState(summary.totalPending > 0 ? 'queued' : 'synced');
      } else {
        setSyncState('synced');
      }
    },
    // Closing the dialog is a dismissal, not a choice. Keep the remote
    // position untouched so an explicit Pull can show the same conflict again.
    dismissConflict: () => {
      setConflictDetails(null);
      setSyncState('idle');
    },
  };
};
