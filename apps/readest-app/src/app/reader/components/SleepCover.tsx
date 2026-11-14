import React, { useEffect } from 'react';
import { convertBlobUrlToDataUrl } from '@/libs/document';
import { setSleepCover } from '@/utils/bridge';
import { eventDispatcher } from '@/utils/event';
import { useTranslation } from '@/hooks/useTranslation';

// Serialize native calls so a slow previous update cannot restore a stale cover
// after the reader closes or the user switches books.
let nativeUpdate: Promise<{ status: string } | undefined> = Promise.resolve(undefined);
const updateNativeCover = (dataUrl: string | null) => {
  nativeUpdate = nativeUpdate.catch(() => undefined).then(() => setSleepCover(dataUrl));
  return nativeUpdate;
};

const SleepCover: React.FC<{
  src?: string | null;
  fallbackSrc?: string | null;
  thumbnailSrc?: string | null;
}> = ({ src, fallbackSrc, thumbnailSrc }) => {
  const _ = useTranslation();
  useEffect(() => {
    let cancelled = false;
    let preparing = false;
    const prepare = async () => {
      if (preparing) return;
      preparing = true;
      let failed = false;
      try {
        for (const candidate of [src, fallbackSrc, thumbnailSrc]) {
          if (cancelled) return;
          if (!candidate) continue;
          try {
            const dataUrl = await convertBlobUrlToDataUrl(candidate);
            if (!cancelled) {
              const result = await updateNativeCover(dataUrl);
              if (!cancelled && result?.status === 'setup') {
                eventDispatcher.dispatch('toast', {
                  type: 'info',
                  message: _(
                    'On iReader, select the Readest cover in Settings → Display → Screensaver → Custom.',
                  ),
                  timeout: 12000,
                });
              }
            }
            return;
          } catch (error) {
            failed = true;
            console.info('Could not prepare sleep cover:', error);
          }
        }
        if (!cancelled) {
          await updateNativeCover(null);
          if (failed) {
            eventDispatcher.dispatch('toast', {
              type: 'error',
              message: _(
                'Could not prepare the sleep cover. Check the device screensaver settings.',
              ),
            });
          }
        }
      } finally {
        preparing = false;
      }
    };
    const onVisible = () => {
      if (!document.hidden) {
        void prepare().catch((error) => console.info('Could not update sleep cover:', error));
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    onVisible();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void updateNativeCover(null).catch((error) =>
        console.info('Could not clear sleep cover:', error),
      );
    };
  }, [src, fallbackSrc, thumbnailSrc, _]);
  return null;
};

export default SleepCover;
