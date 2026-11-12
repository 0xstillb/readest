'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'readest.simpleui.libraryScrollEnabled';
const CHANGE_EVENT = 'readest:simpleui-libraryscrollchange';

/** Persist whether Simple UI Library uses continuous vertical scrolling. */
export default function useSimpleUILibraryScroll() {
  const [enabled, setEnabledState] = useState(false);

  useEffect(() => {
    const syncFromStorage = () =>
      setEnabledState(window.localStorage.getItem(STORAGE_KEY) === 'true');
    syncFromStorage();
    window.addEventListener('storage', syncFromStorage);
    window.addEventListener(CHANGE_EVENT, syncFromStorage);
    return () => {
      window.removeEventListener('storage', syncFromStorage);
      window.removeEventListener(CHANGE_EVENT, syncFromStorage);
    };
  }, []);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    window.localStorage.setItem(STORAGE_KEY, String(nextEnabled));
    setEnabledState(nextEnabled);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { enabled, setEnabled };
}
