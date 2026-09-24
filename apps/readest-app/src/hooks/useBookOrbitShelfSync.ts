import { useCallback, useMemo, useRef, useState } from 'react';

import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { BookOrbitClient } from '@/services/bookorbit/BookOrbitClient';
import { syncSubscribedBookOrbitShelves } from '@/services/bookorbit/shelfSync';
import { ShelfSyncStore } from '@/services/shelfSync';
import { useLibraryStore } from '@/store/libraryStore';
import type { Book } from '@/types/book';
import type { BookOrbitSettings } from '@/types/settings';
import { eventDispatcher } from '@/utils/event';
import { throttle } from '@/utils/throttle';
import type { BookOrbitShelfSyncStatus } from '@/services/bookorbit/types';

export type { BookOrbitShelfSyncStatus, BookOrbitShelfSyncStage } from '@/services/bookorbit/types';

interface UseBookOrbitShelfSyncOptions {
  settings: BookOrbitSettings | undefined;
  closeMenu?: () => void;
  onConfigure?: () => void;
}

/**
 * Hook managing BookOrbit shelf synchronization workflow.
 */
export const useBookOrbitShelfSync = ({
  settings,
  closeMenu,
  onConfigure,
}: UseBookOrbitShelfSyncOptions) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const [shelfSyncing, setShelfSyncing] = useState(false);
  const [shelfSyncStatus, setShelfSyncStatus] = useState<BookOrbitShelfSyncStatus | null>(null);
  const abortController = useRef<AbortController | null>(null);

  const throttledProgress = useMemo(
    () =>
      throttle(
        (done: number, total?: number) => {
          setShelfSyncStatus((current) => {
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

  const runShelfSync = useCallback(async () => {
    if (!appService || !settings || shelfSyncing || abortController.current) return;

    const controller = new AbortController();
    abortController.current = controller;
    setShelfSyncing(true);
    setShelfSyncStatus({ stage: 'starting' });
    eventDispatcher.dispatch('toast', { message: _('Shelf sync started'), type: 'info' });

    try {
      const client = new BookOrbitClient(settings);
      const connectionId = `${settings.serverUrl}\u0000${settings.username}`;
      const store = new ShelfSyncStore(appService, 'bookorbit', connectionId);

      const subscriptions = await store.getShelfSubscriptions({ enabledOnly: true });
      if (subscriptions.length === 0) {
        const message = _('Select at least one BookOrbit collection or smart scope first.');
        setShelfSyncStatus({ stage: 'cancelled', message });
        eventDispatcher.dispatch('toast', { message, type: 'info' });
        return;
      }

      const updateLibrary = async (nextLibrary: Book[]) => {
        useLibraryStore.getState().setLibrary(nextLibrary);
        await appService.saveLibraryBooks(nextLibrary);
      };

      const result = await syncSubscribedBookOrbitShelves(
        client,
        store,
        () => useLibraryStore.getState().library,
        async (_book, nextLibrary) => updateLibrary(nextLibrary),
        appService,
        {
          signal: controller.signal,
          onStage: ({ stage, book }) =>
            setShelfSyncStatus({ stage, book: book.title || book.filename }),
          onProgress: ({ progress, total }) => throttledProgress(progress, total),
        },
        async (_book, nextLibrary) => updateLibrary(nextLibrary),
        {
          serverUrl: settings.serverUrl,
          username: settings.username,
          userkey: settings.userkey,
          customHeaders: settings.customHeaders,
        },
      );

      const message =
        result.downloaded > 0
          ? _('Imported {{count}} books.', { count: result.downloaded })
          : result.removed > 0
            ? _('Removed {{count}} books no longer in selected shelves.', { count: result.removed })
            : _('Shelf sync complete');
      setShelfSyncStatus({ stage: 'done', message });

      if (result.downloaded > 0) {
        eventDispatcher.dispatch('toast', { message, type: 'success' });
      } else if (result.reused > 0) {
        eventDispatcher.dispatch('toast', {
          message: _('All selected shelf books are already in your library.'),
          type: 'info',
        });
      } else if (result.removed > 0) {
        eventDispatcher.dispatch('toast', { message, type: 'info' });
      } else {
        eventDispatcher.dispatch('toast', {
          message: _('No books found in selected shelves.'),
          type: 'info',
        });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const message = _('Shelf sync cancelled');
        setShelfSyncStatus({ stage: 'cancelled', message });
        return;
      }
      const message = error instanceof Error ? error.message : _('Connection error');
      setShelfSyncStatus({ stage: 'error', message });
      eventDispatcher.dispatch('toast', {
        message: `${_('Shelf sync failed')}: ${message}`,
        type: 'error',
      });
    } finally {
      if (abortController.current === controller) abortController.current = null;
      setShelfSyncing(false);
    }
  }, [_, appService, settings, shelfSyncing, throttledProgress]);

  const cancelShelfSync = useCallback(() => {
    abortController.current?.abort();
  }, []);

  const handleShelfSync = useCallback(() => {
    if (!settings?.enabled || !settings.serverUrl || !settings.userkey) {
      closeMenu?.();
      onConfigure?.();
      return;
    }
    void runShelfSync();
  }, [closeMenu, onConfigure, runShelfSync, settings]);

  return { handleShelfSync, cancelShelfSync, shelfSyncing, shelfSyncStatus };
};
