import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import useSimpleUILibraryScroll from '@/components/simpleui/useSimpleUILibraryScroll';

const STORAGE_KEY = 'readest.simpleui.libraryScrollEnabled';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('useSimpleUILibraryScroll', () => {
  test('defaults to fixed pages', () => {
    const { result } = renderHook(() => useSimpleUILibraryScroll());
    expect(result.current.enabled).toBe(false);
  });

  test('persists the preference and synchronizes mounted consumers', () => {
    const settings = renderHook(() => useSimpleUILibraryScroll());
    const bookshelf = renderHook(() => useSimpleUILibraryScroll());
    act(() => settings.result.current.setEnabled(true));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true');
    expect(bookshelf.result.current.enabled).toBe(true);
  });
});
