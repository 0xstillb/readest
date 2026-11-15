// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import useSimpleUIClockAppearance from '@/components/simpleui/useSimpleUIClockAppearance';

const KEY = 'readest.simpleui.clockAppearance';

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('Simple UI clock appearance', () => {
  it('persists each control independently and synchronizes mounted views', () => {
    const settings = renderHook(() => useSimpleUIClockAppearance());
    const home = renderHook(() => useSimpleUIClockAppearance());
    act(() => {
      settings.result.current.setAppearance('clockSize', 140);
      settings.result.current.setAppearance('dateSize', 80);
      settings.result.current.setAppearance('gap', -8);
    });
    expect(home.result.current.appearance).toEqual({ clockSize: 140, dateSize: 80, gap: -8 });
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(home.result.current.appearance);
    const reopened = renderHook(() => useSimpleUIClockAppearance());
    expect(reopened.result.current.appearance).toEqual(home.result.current.appearance);
  });

  it('clamps invalid values and recovers from malformed storage', () => {
    window.localStorage.setItem(KEY, '{broken');
    const { result } = renderHook(() => useSimpleUIClockAppearance());
    expect(result.current.appearance).toEqual({ clockSize: 100, dateSize: 100, gap: 0 });
    act(() => {
      result.current.setAppearance('clockSize', 500);
      result.current.setAppearance('dateSize', Number.NaN);
      result.current.setAppearance('gap', -50);
    });
    expect(result.current.appearance).toEqual({ clockSize: 200, dateSize: 100, gap: -16 });
  });

  it('restores defaults across consumers when reset', () => {
    const settings = renderHook(() => useSimpleUIClockAppearance());
    const home = renderHook(() => useSimpleUIClockAppearance());
    act(() => settings.result.current.setAppearance('clockSize', 150));
    act(() => settings.result.current.resetAppearance());
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(home.result.current.appearance).toEqual({ clockSize: 100, dateSize: 100, gap: 0 });
  });
});
