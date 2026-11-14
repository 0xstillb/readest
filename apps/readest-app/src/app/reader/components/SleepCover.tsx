import React, { useEffect } from 'react';
import { convertBlobUrlToDataUrl } from '@/libs/document';
import { setSleepCover } from '@/utils/bridge';

// Serialize native calls so a slow previous update cannot restore a stale cover
// after the reader closes or the user switches books.
let nativeUpdate = Promise.resolve();
const updateNativeCover = (dataUrl: string | null) => {
  nativeUpdate = nativeUpdate.catch(() => undefined).then(() => setSleepCover(dataUrl));
  return nativeUpdate;
};

const SleepCover: React.FC<{
  src?: string | null;
  fallbackSrc?: string | null;
  thumbnailSrc?: string | null;
}> = ({ src, fallbackSrc, thumbnailSrc }) => {
  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      for (const candidate of [src, fallbackSrc, thumbnailSrc]) {
        if (cancelled) return;
        if (!candidate) continue;
        try {
          const dataUrl = await convertBlobUrlToDataUrl(candidate);
          if (!cancelled) await updateNativeCover(dataUrl);
          return;
        } catch (error) {
          console.info('Could not prepare sleep cover:', error);
        }
      }
      if (!cancelled) await updateNativeCover(null);
    };
    void prepare().catch((error) => console.info('Could not update sleep cover:', error));
    return () => {
      cancelled = true;
      void updateNativeCover(null).catch((error) =>
        console.info('Could not clear sleep cover:', error),
      );
    };
  }, [src, fallbackSrc, thumbnailSrc]);
  return null;
};

export default SleepCover;
