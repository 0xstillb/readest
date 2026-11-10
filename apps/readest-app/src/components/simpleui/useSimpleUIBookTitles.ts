'use client';

import { useCallback, useEffect, useState } from 'react';

export type SimpleUITitleMode = 'hidden' | 'cover' | 'below';

const STORAGE_KEY = 'readest.simpleui.bookTitleMode';
const LEGACY_STORAGE_KEY = 'readest.simpleui.showBookTitles';
const CHANGE_EVENT = 'readest:simpleui-titlemodechange';

const readStoredMode = (): SimpleUITitleMode => {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'hidden' || saved === 'cover' || saved === 'below') return saved;
  // Preserve the old show/hide choice during the move to three title modes.
  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy === 'false') return 'hidden';
  if (legacy === 'true') return 'below';
  return 'cover';
};

/**
 * The title mode of the SimpleUI library.  The mode lives in localStorage so
 * it survives a reload, and every mounted consumer follows it through a
 * change event: the menu writes it, the library shell renders it.
 */
export default function useSimpleUIBookTitles() {
  const [titleMode, setTitleModeState] = useState<SimpleUITitleMode>('cover');

  useEffect(() => {
    const syncFromStorage = () => setTitleModeState(readStoredMode());
    syncFromStorage();
    window.addEventListener('storage', syncFromStorage);
    window.addEventListener(CHANGE_EVENT, syncFromStorage);
    return () => {
      window.removeEventListener('storage', syncFromStorage);
      window.removeEventListener(CHANGE_EVENT, syncFromStorage);
    };
  }, []);

  const setTitleMode = useCallback((mode: SimpleUITitleMode) => {
    window.localStorage.setItem(STORAGE_KEY, mode);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    setTitleModeState(mode);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { titleMode, setTitleMode };
}
