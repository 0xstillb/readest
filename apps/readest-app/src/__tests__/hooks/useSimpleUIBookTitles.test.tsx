import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import useSimpleUIBookTitles from '@/components/simpleui/useSimpleUIBookTitles';

const STORAGE_KEY = 'readest.simpleui.bookTitleMode';
const LEGACY_STORAGE_KEY = 'readest.simpleui.showBookTitles';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('useSimpleUIBookTitles', () => {
  test('falls back to the cover mode when nothing is stored', () => {
    const { result } = renderHook(() => useSimpleUIBookTitles());
    expect(result.current.titleMode).toBe('cover');
  });

  test('applies the stored mode on mount, without opening the menu', () => {
    window.localStorage.setItem(STORAGE_KEY, 'hidden');
    const { result } = renderHook(() => useSimpleUIBookTitles());
    expect(result.current.titleMode).toBe('hidden');
  });

  test('keeps the legacy show/hide choice during the move to three modes', () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, 'false');
    const { result } = renderHook(() => useSimpleUIBookTitles());
    expect(result.current.titleMode).toBe('hidden');
  });

  test('persists the mode so it survives a reload', () => {
    const { result } = renderHook(() => useSimpleUIBookTitles());
    act(() => result.current.setTitleMode('below'));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('below');
  });

  test('drops the legacy key once a mode is chosen', () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, 'true');
    const { result } = renderHook(() => useSimpleUIBookTitles());
    act(() => result.current.setTitleMode('cover'));
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  test('keeps every mounted consumer in sync', () => {
    const menu = renderHook(() => useSimpleUIBookTitles());
    const shell = renderHook(() => useSimpleUIBookTitles());
    act(() => menu.result.current.setTitleMode('below'));
    expect(shell.result.current.titleMode).toBe('below');
  });
});
