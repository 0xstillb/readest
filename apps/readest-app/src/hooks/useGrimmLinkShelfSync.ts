import { useCallback, useRef, useState } from 'react';

import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { GrimmLinkClient } from '@/services/grimmlink/GrimmLinkClient';
import { migrateGrimmLinkShelfState, ShelfSyncStore } from '@/services/shelfSync';
import { syncSubscribedGrimmLinkShelves } from '@/services/grimmlink/shelfSync';
import { eventDispatcher } from '@/utils/event';
import { useLibraryStore } from '@/store/libraryStore';
import type { Book } from '@/types/book';
import type { GrimmLinkSettings } from '@/types/settings';

export type GrimmLinkShelfSyncStage =
  | 'starting'
  | 'downloading'
  | 'importing'
  | 'done'
  | 'error'
  | 'info';

export interface GrimmLinkShelfSyncStatus {
  stage: GrimmLinkShelfSyncStage;
  book?: string;
  progress?: number;
  total?: number;
  message?: string;
}

interface UseGrimmLinkShelfSyncOptions {
  settings: GrimmLinkSettings | undefined;
  closeMenu?: () => void;
  onConfigure?: () => void;
}

/**
 * Keeps the shelf-sync workflow outside upstream menus. Consumers only provide
 * their close/configure callbacks and render the returned state.
 */
export const useGrimmLinkShelfSync = ({
  settings,
  closeMenu,
  onConfigure,
}: UseGrimmLinkShelfSyncOptions) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const [shelfSyncing, setShelfSyncing] = useState(false);
  const [shelfSyncStatus, setShelfSyncStatus] = useState<GrimmLinkShelfSyncStatus | null>(null);
  const abortController = useRef<AbortController | null>(null);

  const runShelfSync = useCallback(async () => {
    if (!appService || !settings || shelfSyncing || abortController.current) return;

    const controller = new AbortController();
    abortController.current = controller;
    setShelfSyncing(true);
    setShelfSyncStatus({ stage: 'starting' });
    eventDispatcher.dispatch('toast', { message: _('Shelf sync started'), type: 'info' });

    try {
      const client = new GrimmLinkClient(settings);
      const connectionId = `${settings.serverUrl}\u0000${settings.username}`;
      const store = new ShelfSyncStore(appService, 'grimmlink', connectionId);
      await migrateGrimmLinkShelfState(appService, connectionId, store).catch(() => {});
      if ((await store.getShelfSubscriptions({ enabledOnly: true })).length === 0) {
        const message = _('Select at least one Grimmory shelf first.');
        setShelfSyncStatus({ stage: 'info', message });
        eventDispatcher.dispatch('toast', { message, type: 'info' });
        return;
      }

      const updateLibrary = async (nextLibrary: Book[]) => {
        useLibraryStore.getState().setLibrary(nextLibrary);
        await appService.saveLibraryBooks(nextLibrary);
      };

      const result = await syncSubscribedGrimmLinkShelves(
        client,
        store,
        () => useLibraryStore.getState().library,
        async (_book, nextLibrary) => updateLibrary(nextLibrary),
        appService,
        {
          signal: controller.signal,
          onStage: ({ stage, book }) =>
            setShelfSyncStatus({ stage, book: book.title || book.filename }),
          onProgress: ({ progress, total }) =>
            setShelfSyncStatus((current) => ({
              stage: current?.stage === 'importing' ? 'importing' : 'downloading',
              book: current?.book,
              progress,
              total,
            })),
        },
        async (_book, nextLibrary) => updateLibrary(nextLibrary),
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
        setShelfSyncStatus({ stage: 'info', message });
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
  }, [_, appService, settings, shelfSyncing]);

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
