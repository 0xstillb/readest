import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import useSimpleUIBottomBarIconSize from '@/components/simpleui/useSimpleUIBottomBarIconSize';

const STORAGE_KEY = 'readest.simpleui.bottomBarIconSize';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('useSimpleUIBottomBarIconSize', () => {
  test('falls back to the default size when nothing is stored', () => {
    const { result } = renderHook(() => useSimpleUIBottomBarIconSize());
    expect(result.current.iconSize).toBe(36);
    expect(result.current.minIconSize).toBe(24);
    expect(result.current.maxIconSize).toBe(48);
  });

  test('hydrates from the stored size', () => {
    window.localStorage.setItem(STORAGE_KEY, '44');
    const { result } = renderHook(() => useSimpleUIBottomBarIconSize());
    expect(result.current.iconSize).toBe(44);
  });

  test('ignores a stored size outside the supported range', () => {
    window.localStorage.setItem(STORAGE_KEY, '500');
    const { result } = renderHook(() => useSimpleUIBottomBarIconSize());
    expect(result.current.iconSize).toBe(36);
  });

  test('clamps and snaps the size to the slider step', () => {
    const { result } = renderHook(() => useSimpleUIBottomBarIconSize());
    act(() => result.current.setIconSize(4));
    expect(result.current.iconSize).toBe(24);
    act(() => result.current.setIconSize(200));
    expect(result.current.iconSize).toBe(48);
    act(() => result.current.setIconSize(25));
    expect(result.current.iconSize).toBe(26);
  });

  test('persists the size so it survives a reload', () => {
    const { result } = renderHook(() => useSimpleUIBottomBarIconSize());
    act(() => result.current.setIconSize(30));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('30');
  });

  test('rejects a non-numeric size', () => {
    const { result } = renderHook(() => useSimpleUIBottomBarIconSize());
    act(() => result.current.setIconSize(Number.NaN));
    expect(result.current.iconSize).toBe(36);
  });

  test('keeps every mounted consumer in sync', () => {
    const settings = renderHook(() => useSimpleUIBottomBarIconSize());
    const bottomBar = renderHook(() => useSimpleUIBottomBarIconSize());
    act(() => settings.result.current.setIconSize(42));
    expect(bottomBar.result.current.iconSize).toBe(42);
  });
});
