'use client';

import { useCallback, useEffect, useState } from 'react';

export type SimpleUIClockAppearance = {
  clockSize: number;
  dateSize: number;
  gap: number;
};

export const CLOCK_APPEARANCE_DEFAULTS: SimpleUIClockAppearance = {
  clockSize: 100,
  dateSize: 100,
  gap: 0,
};
export const CLOCK_APPEARANCE_LIMITS = {
  clockSize: { min: 50, max: 200, step: 10 },
  dateSize: { min: 50, max: 200, step: 10 },
  gap: { min: -16, max: 48, step: 2 },
} as const;
const STORAGE_KEY = 'readest.simpleui.clockAppearance';
const CHANGE_EVENT = 'readest:simpleui-clockappearancechange';

const normalize = (key: keyof SimpleUIClockAppearance, value: unknown) => {
  const { min, max, step } = CLOCK_APPEARANCE_LIMITS[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return CLOCK_APPEARANCE_DEFAULTS[key];
  return Math.min(max, Math.max(min, Math.round(value / step) * step));
};

const readAppearance = (): SimpleUIClockAppearance => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      clockSize: normalize('clockSize', stored?.clockSize),
      dateSize: normalize('dateSize', stored?.dateSize),
      gap: normalize('gap', stored?.gap),
    };
  } catch {
    return { ...CLOCK_APPEARANCE_DEFAULTS };
  }
};

export default function useSimpleUIClockAppearance() {
  const [appearance, setAppearanceState] = useState(CLOCK_APPEARANCE_DEFAULTS);

  useEffect(() => {
    const syncFromStorage = () => setAppearanceState(readAppearance());
    syncFromStorage();
    window.addEventListener('storage', syncFromStorage);
    window.addEventListener(CHANGE_EVENT, syncFromStorage);
    return () => {
      window.removeEventListener('storage', syncFromStorage);
      window.removeEventListener(CHANGE_EVENT, syncFromStorage);
    };
  }, []);

  const setAppearance = useCallback((key: keyof SimpleUIClockAppearance, value: number) => {
    const next = { ...readAppearance(), [key]: normalize(key, value) };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setAppearanceState(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const resetAppearance = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setAppearanceState({ ...CLOCK_APPEARANCE_DEFAULTS });
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { appearance, setAppearance, resetAppearance };
}
