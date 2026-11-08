'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'readest.simpleui.enabled';
const CHANGE_EVENT = 'readest:simpleui-modechange';

export default function useSimpleUIMode() {
  const [enabled, setEnabledState] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const syncFromStorage = () => {
      setEnabledState(window.localStorage.getItem(STORAGE_KEY) === 'true');
      setReady(true);
    };

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

  return { enabled, ready, setEnabled };
}
