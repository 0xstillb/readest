'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'readest.simpleui.bottomBarIconSize';
const CHANGE_EVENT = 'readest:simpleui-iconsizechange';
const DEFAULT_SIZE = 36;
const MIN_SIZE = 24;
const MAX_SIZE = 48;
/** The settings slider steps by 2px, so stored sizes snap to the same grid. */
const STEP = 2;

const normalizeSize = (size: number) => {
  if (!Number.isFinite(size)) return DEFAULT_SIZE;
  const clamped = Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));
  const snapped = Math.round(clamped / STEP) * STEP;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, snapped));
};

const readSize = () => {
  const value = Number(window.localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(value) && value >= MIN_SIZE && value <= MAX_SIZE
    ? normalizeSize(value)
    : DEFAULT_SIZE;
};

export default function useSimpleUIBottomBarIconSize() {
  const [iconSize, setIconSizeState] = useState(DEFAULT_SIZE);

  useEffect(() => {
    const syncFromStorage = () => setIconSizeState(readSize());
    syncFromStorage();
    window.addEventListener('storage', syncFromStorage);
    window.addEventListener(CHANGE_EVENT, syncFromStorage);
    return () => {
      window.removeEventListener('storage', syncFromStorage);
      window.removeEventListener(CHANGE_EVENT, syncFromStorage);
    };
  }, []);

  const setIconSize = useCallback((size: number) => {
    const nextSize = normalizeSize(size);
    window.localStorage.setItem(STORAGE_KEY, String(nextSize));
    setIconSizeState(nextSize);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { iconSize, setIconSize, minIconSize: MIN_SIZE, maxIconSize: MAX_SIZE };
}
