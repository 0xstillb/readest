import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useTranslation } from '@/hooks/useTranslation';
import { DEFAULT_GRIMMLINK_SETTINGS } from '@/services/constants';
import { debounce } from '@/utils/debounce';
import { eventDispatcher } from '@/utils/event';
import { getCFIFromXPointer, XCFI } from '@/utils/xcfi';
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
import { GrimmLinkReadStatusProvider } from '@/services/grimmlink/readStatus';
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
 * Adapter v2 reports the reader-native locators explicitly: a CFI for EPUB
 * and a CREngine XPointer when it could not project the position into a CFI.
 * Both name a spine index, so do not round-trip the pointer through a
 * document/DOM here. Apart from being cheaper, this keeps the conflict dialog
 * useful when a remote XPointer points into a malformed or not-yet-loaded
 * section that cannot be converted to a full CFI.
 */
export const getRemoteChapterLabel = (
  remote: {
    progress?: string;
    location?: string;
    cfi?: string;
    xpointer?: string;
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

  // `location`/`progress` carry whichever locator the server had, so try the
  // explicit fields first and fall back to the generic ones.
  for (const candidate of [remote.cfi, remote.xpointer, remote.location, remote.progress]) {
    const position = candidate?.trim();
    if (!position) continue;
    try {
      const index = position.startsWith('epubcfi(')
        ? getIndexFromCfi(position)
        : position.startsWith('/body/DocFragment')
          ? XCFI.extractSpineIndex(position)
          : null;
      const chapter = chapterForIndex(bookDoc.toc ?? [], index);
      if (chapter) return chapter;
    } catch {
      // Try the next locator.
    }
  }
  return undefined;
};

/** The reader-side operations a remote position can ask for. */
export interface RemotePositionView {
  goTo: (target: string) => void;
  goToFraction: (fraction: number) => void;
  select: (target: number) => void;
}

/** The locators Adapter v2 can report for a remote position. */
export interface RemotePosition {
  cfi?: string;
  xpointer?: string;
  progress?: string;
  percentage?: number;
  currentPage?: number;
}

/**
 * Apply a remote position in Adapter v2 order and never invent one:
 * 1. the reader's own CFI, which the adapter converted for us;
 * 2. a KOReader XPointer, which this reader converts locally;
 * 3. a fixed-layout page (the adapter reports it 1-indexed);
 * 4. the reported fraction, as the last resort.
 */
export const applyRemotePosition = async (
  view: RemotePositionView,
  remote: RemotePosition,
  options: { fixedLayout: boolean; bookDoc?: BookDoc },
): Promise<void> => {
  const cfi = remote.cfi?.trim();
  // A legacy reply can still carry the XPointer in `progress` only.
  const xpointer =
    remote.xpointer?.trim() ||
    (remote.progress?.startsWith('/body/DocFragment[') ? remote.progress : undefined);
  const fraction =
    typeof remote.percentage === 'number' && Number.isFinite(remote.percentage)
      ? remote.percentage
      : undefined;
  // The adapter reports a fixed-layout page 1-indexed; a legacy reply can
  // carry it as the page number in `progress` only.
  const legacyPage = (() => {
    const raw = remote.progress?.trim();
    if (!raw) return Number.NaN;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  })();
  const page =
    typeof remote.currentPage === 'number' && Number.isFinite(remote.currentPage)
      ? remote.currentPage
      : legacyPage;

  if (cfi) {
    view.goTo(cfi);
    return;
  }
  if (xpointer) {
    try {
      view.goTo(await getCFIFromXPointer(xpointer, undefined, undefined, options.bookDoc));
    } catch {
      if (fraction !== undefined) view.goToFraction(fraction);
    }
    return;
  }
  if (options.fixedLayout && Number.isFinite(page)) {
    view.select(Math.max(0, page - 1));
    return;
  }
  if (fraction !== undefined) view.goToFraction(fraction);
};

/** Reader-only GrimmLink Adapter v2 progress, session, rating, annotation, and bookmark integration. */
export const useGrimmLinkSync = (bookKey: string) => {
  const _ = useTranslation();
  const { appService, envConfig } = useEnv();
  const { settings } = useSettingsStore();
  const grimmlink = settings.grimmlink ?? DEFAULT_GRIMMLINK_SETTINGS;
  const getProgress = useReaderStore((s) => s.getProgress);
  const getView = useReaderStore((s) => s.getView);
  const getBookData = useBookDataStore((s) => s.getBookData);
  const updateBooknotes = useBookDataStore((s) => s.updateBooknotes);
  const saveConfig = useBookDataStore((s) => s.saveConfig);
  const getLibraryBook = useLibraryStore((s) => s.getBookByHash);
  const updateLibraryBook = useLibraryStore((s) => s.updateBook);
  const progress = useBookProgress(bookKey);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [conflictDetails, setConflictDetails] = useState<SyncDetails | null>(null);
  const pulled = useRef(false);
  const metadataPulled = useRef(false);
  const ratingPullKey = useRef<string | null>(null);
  const statusPullKey = useRef<string | null>(null);
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

  // The ratings and the metadata both ask for the Adapter capabilities, so
  // the answer is fetched once and shared.
  const capabilitiesRequest = useRef<Promise<string[]> | null>(null);
  const loadCapabilities = useCallback(() => {
    if (!client) return Promise.resolve<string[]>([]);
    capabilitiesRequest.current ??= client
      .getCapabilities()
      .then(({ capabilities }) => capabilities)
      .catch((error) => {
        capabilitiesRequest.current = null;
        throw error;
      });
    return capabilitiesRequest.current;
  }, [client]);

  const store = useMemo(() => {
    const config = grimmlink;
    return appService && config.enabled
      ? new GrimmLinkSyncStore(appService, `${config.serverUrl}\u0000${config.username}`)
      : null;
  }, [appService, grimmlink]);

  const replayScheduler = useMemo(
    () =>
      client && store ? new GrimmLinkReplayScheduler(new GrimmLinkOutbox(store, client)) : null,
    [client, store],
  );

  const linkResolver = useMemo(() => {
    const config = grimmlink;
    if (!appService || !client || !store || !config.enabled) return null;
    return new GrimmLinkProgressProvider(
      client,
      new GrimmLinkBookLinkStore(appService, `${config.serverUrl}\u0000${config.username}`),
      config,
      store,
    );
  }, [appService, client, grimmlink, store]);
  const provider = useMemo(
    () => (grimmlink.syncProgress ? linkResolver : null),
    [grimmlink.syncProgress, linkResolver],
  );

  const queueMetadata = useCallback(async () => {
    if (
      !client ||
      !store ||
      !replayScheduler ||
      !linkResolver ||
      !grimmlink.syncMetadata ||
      grimmlink.strategy === 'receive'
    )
      return;
    const data = getBookData(bookKey);
    const book = data?.book;
    if (!book) return;
    try {
      const capabilities = await loadCapabilities();
      const metadata = new GrimmLinkMetadataProvider(client, store, {
        capabilities,
        device: grimmlink.deviceName,
        deviceId: grimmlink.deviceId,
      });
      const link = await linkResolver.resolveLink(book);
      if (!link) return;
      const queued = await metadata.queuePush(
        link.bookHash,
        link.bookId,
        data?.config?.booknotes ?? [],
        link.bookFileId,
        book.format,
      );
      if (queued) void replayScheduler.requestReplay(500);
    } catch (error) {
      console.warn('[GrimmLink] metadata push could not be queued', error);
    }
  }, [
    bookKey,
    client,
    getBookData,
    grimmlink,
    linkResolver,
    loadCapabilities,
    replayScheduler,
    store,
  ]);

  const pushMetadata = useMemo(
    () =>
      debounce(() => {
        void queueMetadata();
      }, 750),
    [queueMetadata],
  );

  const makePosition = useCallback(async () => {
    const local = getProgress(bookKey);
    const data = getBookData(bookKey);
    if (!local || !data?.book) return null;
    if (FIXED_LAYOUT_FORMATS.has(data.book.format)) {
      // A fixed-layout book only has a position once the reader has laid it
      // out.  Without a page total there is nothing to report, and a made-up
      // page would move the remote progress to the first page of the book.
      if (!local.section?.total) return null;
      return { currentPage: local.section.current ?? 0, totalPages: local.section.total };
    }
    if (!local.location) return null;
    // Adapter v2 keeps every reader's native locator: Readest pushes its own
    // CFI and the adapter converts it to a KOReader XPointer server-side.
    return {
      location: local.location,
      fraction: local.pageinfo?.total
        ? ((local.pageinfo.current ?? 0) + 1) / local.pageinfo.total
        : 0,
    };
  }, [bookKey, getBookData, getProgress]);

  const applyRemote = useCallback(
    async (remote: NonNullable<SyncDetails['remote']>) => {
      const data = getBookData(bookKey);
      const view = getView(bookKey);
      if (!data?.book || !view) return;
      await applyRemotePosition(view, remote, {
        fixedLayout: FIXED_LAYOUT_FORMATS.has(data.book.format),
        bookDoc: data.bookDoc ?? undefined,
      });
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

  useEffect(() => {
    if (!replayScheduler) return;
    // Resume durable writes left queued by an app shutdown or a short network
    // outage as soon as a reader is opened again.
    void replayScheduler.requestReplay().catch((error) => {
      console.warn('[GrimmLink] startup outbox replay failed', error);
    });
  }, [replayScheduler]);

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
            location: remote.location,
            cfi: remote.cfi,
            xpointer: remote.xpointer,
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
      if (event.detail.bookKey === bookKey) {
        await queueProgress();
        await queueMetadata();
      }
    };
    const flush = async (event: CustomEvent) => {
      if (event.detail.bookKey !== bookKey) return;
      pushProgress.cancel();
      pushMetadata.cancel();
      await queueProgress();
      await queueMetadata();
      // ReaderContent awaits this event before closing the live renderer. Send
      // now rather than leaving the final position on the 12-second debounce,
      // which can be lost if the app closes immediately after the book.
      const replay = replayScheduler?.flushNow().catch((error) => {
        console.warn('[GrimmLink] close-time progress replay failed', error);
      });
      if (replay) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            replay,
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, 3000);
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
    };
    const pull = (event: CustomEvent) => {
      if (event.detail.bookKey === bookKey) void pullProgress(true);
    };
    const pushMetadataEvent = async (event: CustomEvent) => {
      if (event.detail.bookKey === bookKey) pushMetadata();
    };
    eventDispatcher.on('push-grimmlink', push);
    eventDispatcher.on('push-grimmlink-metadata', pushMetadataEvent);
    eventDispatcher.on('flush-grimmlink', flush);
    eventDispatcher.on('pull-grimmlink', pull);
    return () => {
      eventDispatcher.off('push-grimmlink', push);
      eventDispatcher.off('push-grimmlink-metadata', pushMetadataEvent);
      eventDispatcher.off('flush-grimmlink', flush);
      eventDispatcher.off('pull-grimmlink', pull);
      pushProgress.flush();
      pushMetadata.flush();
    };
  }, [
    bookKey,
    pullProgress,
    pushMetadata,
    pushProgress,
    queueMetadata,
    queueProgress,
    replayScheduler,
  ]);

  useEffect(() => {
    if (provider && progress && !pulled.current) void pullProgress();
  }, [progress, provider, pullProgress]);
  useEffect(() => {
    if (syncState === 'synced' && progress && grimmlink.strategy !== 'receive') pushProgress();
  }, [progress, pushProgress, grimmlink.strategy, syncState]);

  useEffect(() => {
    if (!client || !store || !grimmlink.syncMetadata || !linkResolver) {
      ratingPullKey.current = null;
      return;
    }
    const book = getBookData(bookKey)?.book;
    if (!book) return;
    const pullKey = [
      bookKey,
      grimmlink.serverUrl,
      grimmlink.username,
      grimmlink.userkey,
      grimmlink.deviceId,
    ].join('\u0000');
    if (ratingPullKey.current === pullKey) return;
    ratingPullKey.current = pullKey;
    void loadCapabilities()
      .then(async (capabilities) => {
        const ratings = new GrimmLinkRatingProvider(client, store, {
          capabilities,
          device: grimmlink.deviceName,
          deviceId: grimmlink.deviceId,
        });
        const link = await linkResolver.resolveLink(book);
        if (!link) {
          if (ratingPullKey.current === pullKey) ratingPullKey.current = null;
          return;
        }
        await ratings.pull(link.bookHash, await store.getRating(link.bookHash));
      })
      .catch((error) => {
        console.warn('[GrimmLink] rating pull failed', error);
        if (ratingPullKey.current === pullKey) ratingPullKey.current = null;
      });
  }, [bookKey, client, getBookData, grimmlink, linkResolver, loadCapabilities, store]);

  useEffect(() => {
    if (
      !client ||
      !store ||
      !grimmlink.syncReadStatus ||
      !linkResolver ||
      grimmlink.strategy === 'send'
    ) {
      statusPullKey.current = null;
      return;
    }
    const book = getBookData(bookKey)?.book;
    if (!book) return;
    const pullKey = [
      bookKey,
      grimmlink.serverUrl,
      grimmlink.username,
      grimmlink.userkey,
      grimmlink.deviceId,
    ].join('\u0000');
    if (statusPullKey.current === pullKey) return;
    statusPullKey.current = pullKey;
    void loadCapabilities()
      .then(async (capabilities) => {
        const statuses = new GrimmLinkReadStatusProvider(client, store, capabilities);
        const link = await linkResolver.resolveLink(book);
        if (!link) {
          if (statusPullKey.current === pullKey) statusPullKey.current = null;
          return;
        }
        const local = getLibraryBook(book.hash) ?? book;
        const merged = await statuses.pullRemote(link.bookId, local);
        if (
          merged.readingStatus !== local.readingStatus ||
          merged.readingStatusUpdatedAt !== local.readingStatusUpdatedAt
        ) {
          await updateLibraryBook(envConfig, { ...local, ...merged });
        }
      })
      .catch((error) => {
        console.warn('[GrimmLink] reading status pull failed', error);
        if (statusPullKey.current === pullKey) statusPullKey.current = null;
      });
  }, [
    bookKey,
    client,
    envConfig,
    getBookData,
    getLibraryBook,
    grimmlink,
    linkResolver,
    loadCapabilities,
    store,
    updateLibraryBook,
  ]);

  useEffect(() => {
    if (
      !client ||
      !store ||
      !replayScheduler ||
      !grimmlink.syncMetadata ||
      !linkResolver ||
      metadataPulled.current
    )
      return;
    const data = getBookData(bookKey);
    const book = data?.book;
    if (!book) return;
    metadataPulled.current = true;
    void loadCapabilities()
      .then(async (capabilities) => {
        const metadata = new GrimmLinkMetadataProvider(client, store, {
          capabilities,
          device: grimmlink.deviceName,
          deviceId: grimmlink.deviceId,
        });
        const notes = data?.config?.booknotes ?? [];
        const link = await linkResolver.resolveLink(book);
        if (!link) {
          metadataPulled.current = false;
          return;
        }
        // Push local notes first. Pulling first can immediately echo notes that
        // were just mapped from Grimmory back as new local dedupe keys.
        if (grimmlink.strategy !== 'receive') await queueMetadata();
        await metadata.pull(
          link.bookHash,
          notes,
          async (merged) => {
            const updated = updateBooknotes(bookKey, merged, 'remote');
            if (updated) await saveConfig(envConfig, bookKey, updated, settings);
          },
          (note) => {
            console.warn('[GrimmLink] retained unresolved remote note', note.id);
          },
          link.format ?? book.format,
        );
      })
      .catch((error) => {
        console.warn('[GrimmLink] metadata pull failed', error);
        metadataPulled.current = false;
      });
  }, [
    bookKey,
    client,
    envConfig,
    getBookData,
    grimmlink,
    loadCapabilities,
    linkResolver,
    queueMetadata,
    replayScheduler,
    saveConfig,
    settings,
    store,
    updateBooknotes,
  ]);

  const startSession = useCallback(async () => {
    if (
      !linkResolver ||
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
  }, [makePosition, replayScheduler, linkResolver, grimmlink.syncSessions, store]);

  const closeSession = useCallback(async () => {
    if (sessionClosing.current) return sessionClosing.current;
    const run = (async () => {
      if (
        !linkResolver ||
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
        link = (await linkResolver.resolveLink(book)) ?? link;
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
          bookHash: link.bookHash,
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
  }, [bookKey, getBookData, makePosition, replayScheduler, linkResolver, grimmlink, store]);

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
      ratingPullKey.current = null;
      statusPullKey.current = null;
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
      // Choosing this device resolves the conflict by enqueueing its current
      // position. Unlike the automatic synced-state path, this manual branch
      // must explicitly flush the outbox or the selected position can remain
      // queued without ever reaching Grimmory.
      await replayScheduler?.flushNow();
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
