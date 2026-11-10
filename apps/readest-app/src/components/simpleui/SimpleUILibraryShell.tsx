'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useThemeStore } from '@/store/themeStore';
import SimpleUIBottomBar from './SimpleUIBottomBar';
import useSimpleUIBookTitles from './useSimpleUIBookTitles';
import useSimpleUIMode from './useSimpleUIMode';

export default function SimpleUILibraryShell({ children }: { children: ReactNode }) {
  const { safeAreaInsets } = useThemeStore();
  const { enabled } = useSimpleUIMode();
  const { titleMode } = useSimpleUIBookTitles();

  if (!enabled) return children;

  return (
    <div
      id='simpleui-library'
      data-book-title-mode={titleMode}
      className='full-height'
      style={{ '--simpleui-safe-bottom': `${safeAreaInsets?.bottom ?? 0}px` } as CSSProperties}
    >
      {children}
      <SimpleUIBottomBar active='library' />
      <style jsx global>{`
        #simpleui-library .library-page {
          padding-bottom: calc(
            4.5rem + max(env(safe-area-inset-bottom), var(--simpleui-safe-bottom, 0px))
          );
        }
      `}</style>
    </div>
  );
}
