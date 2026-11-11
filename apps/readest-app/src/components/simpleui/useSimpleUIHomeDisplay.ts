'use client';

import { useCallback, useEffect, useState } from 'react';

export type SimpleUIHomeDisplay = 'current' | 'both';

const STORAGE_KEY = 'readest.simpleui.homeDisplay';
const CHANGE_EVENT = 'readest:simpleui-homedisplaychange';

const readStoredDisplay = (): SimpleUIHomeDisplay =>
  window.localStorage.getItem(STORAGE_KEY) === 'current' ? 'current' : 'both';

/** Persist and broadcast which reading sections the SimpleUI Home displays. */
export default function useSimpleUIHomeDisplay() {
  const [display, setDisplayState] = useState<SimpleUIHomeDisplay>('both');

  useEffect(() => {
    const syncFromStorage = () => setDisplayState(readStoredDisplay());
    syncFromStorage();
    window.addEventListener('storage', syncFromStorage);
    window.addEventListener(CHANGE_EVENT, syncFromStorage);
    return () => {
      window.removeEventListener('storage', syncFromStorage);
      window.removeEventListener(CHANGE_EVENT, syncFromStorage);
    };
  }, []);

  const setDisplay = useCallback((value: SimpleUIHomeDisplay) => {
    window.localStorage.setItem(STORAGE_KEY, value);
    setDisplayState(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { display, setDisplay };
}
