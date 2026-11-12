import { useCallback } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import type { Book, ReadingStatus } from '@/types/book';
import { GrimmLinkClient } from '@/services/grimmlink/GrimmLinkClient';
import { GrimmLinkSyncStore } from '@/services/grimmlink/GrimmLinkSyncStore';
import { queueExplicitGrimmLinkReadStatus } from '@/services/grimmlink/readStatus';

export function useGrimmLinkLibraryReadStatus() {
  const { appService } = useEnv();
  const config = useSettingsStore((state) => state.settings.grimmlink);

  return useCallback(
    async (books: Book[], status: ReadingStatus | undefined) => {
      if (
        !appService ||
        !config.enabled ||
        !config.syncReadStatus ||
        !config.serverUrl ||
        !config.userkey
      )
        return;
      const store = new GrimmLinkSyncStore(
        appService,
        `${config.serverUrl}\u0000${config.username}`,
      );
      const client = new GrimmLinkClient(config);
      for (const book of books) {
        try {
          await queueExplicitGrimmLinkReadStatus(book, status, config, store, client);
        } catch (error) {
          console.warn('[GrimmLink] failed to queue reading status', error);
        }
      }
    },
    [appService, config],
  );
}
