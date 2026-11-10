// @vitest-environment happy-dom
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HardwarePageTurnerSettings } from '@/types/settings';
import { eventDispatcher } from '@/utils/event';
import { useLibraryPagination } from '@/app/library/hooks/useLibraryPagination';

const h = vi.hoisted(() => ({
  hardware: undefined as HardwarePageTurnerSettings | undefined,
  volumeKeysToFlip: false,
  acquire: vi.fn(),
  release: vi.fn(),
  acquireVolume: vi.fn(),
  releaseVolume: vi.fn(),
  forward: vi.fn(),
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: { isMobileApp: true } }) }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: (
    selector: (s: {
      settings: {
        hardwarePageTurner?: HardwarePageTurnerSettings;
        globalViewSettings: { volumeKeysToFlip: boolean };
      };
    }) => unknown,
  ) =>
    selector({
      settings: {
        hardwarePageTurner: h.hardware,
        globalViewSettings: { volumeKeysToFlip: h.volumeKeysToFlip },
      },
    }),
}));
vi.mock('@/store/deviceStore', () => ({
  useDeviceControlStore: {
    getState: () => ({
      acquirePageTurnerKeyInterception: h.acquire,
      releasePageTurnerKeyInterception: h.release,
      acquireVolumeKeyInterception: h.acquireVolume,
      releaseVolumeKeyInterception: h.releaseVolume,
      ensureKeyForwarding: h.forward,
    }),
  },
}));
let scroller: HTMLDivElement;
// happy-dom has no TouchEvent, so the gesture is a plain event carrying the
// one touch the handler reads.
const touchEvent = (type: string, clientX: number, clientY: number, touches = 1) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: Array.from({ length: touches }, () => ({ clientX, clientY })),
  });
  return event;
};
beforeEach(() => {
  vi.clearAllMocks();
  h.volumeKeysToFlip = false;
  h.hardware = {
    enabled: true,
    bindings: {
      pageNext: { source: 'dom', id: 'ArrowRight', label: 'Ctrl + Right', ctrlKey: true },
      pagePrev: { source: 'native', id: 'MediaPrevious', label: 'Media Previous' },
      sectionNext: null,
      sectionPrev: null,
      refresh: null,
    },
  };
  scroller = document.createElement('div');
  Object.defineProperty(scroller, 'clientHeight', { value: 500 });
  scroller.scrollTo = vi.fn();
});
afterEach(cleanup);

describe('library page-turn bindings', () => {
  it('respects modifiers, claims repeats without turning again, and leaves inputs alone', () => {
    renderHook(() => useLibraryPagination(scroller, true));
    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true });
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'instant' });
    const repeat = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      code: 'ArrowRight',
      ctrlKey: true,
      repeat: true,
      cancelable: true,
    });
    window.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: 'PageDown', code: 'PageDown' });
    input.remove();
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  });
  it('handles native page keys and releases interception on unmount', async () => {
    scroller.scrollTop = 500;
    const { unmount } = renderHook(() => useLibraryPagination(scroller, true));
    expect(h.acquire).toHaveBeenCalledOnce();
    expect(h.forward).toHaveBeenCalledOnce();
    await act(() => eventDispatcher.dispatch('native-key-down', { keyName: 'MediaPrevious' }));
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
    unmount();
    expect(h.release).toHaveBeenCalledOnce();
    vi.mocked(scroller.scrollTo).mockClear();
    await eventDispatcher.dispatch('native-key-down', { keyName: 'MediaPrevious' });
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('does not register navigation when disabled or intercept media keys for Pencil bindings', () => {
    const { rerender } = renderHook(({ enabled }) => useLibraryPagination(scroller, enabled), {
      initialProps: { enabled: false },
    });
    fireEvent.keyDown(window, { key: 'PageDown', code: 'PageDown' });
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(h.acquire).not.toHaveBeenCalled();
    h.hardware!.bindings.pagePrev = { source: 'native', id: 'PencilDoubleTap', label: 'Pencil' };
    rerender({ enabled: true });
    expect(h.forward).toHaveBeenCalledOnce();
    expect(h.acquire).not.toHaveBeenCalled();
  });
  it('turns a page instead of scrolling when the wheel moves vertically', () => {
    renderHook(() => useLibraryPagination(scroller, true));
    const wheel = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    scroller.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'instant' });
  });
  it('turns a page for a single Firefox wheel notch', () => {
    // Firefox reports a mouse notch as three lines, so the line delta has to
    // reach the page threshold on its own.
    renderHook(() => useLibraryPagination(scroller, true));
    const wheel = new WheelEvent('wheel', {
      deltaY: 3,
      deltaMode: 1,
      cancelable: true,
      bubbles: true,
    });
    scroller.dispatchEvent(wheel);
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'instant' });
  });
  it('ignores a gesture that a second finger took over', () => {
    renderHook(() => useLibraryPagination(scroller, true));
    scroller.dispatchEvent(touchEvent('touchstart', 100, 300));
    const move = touchEvent('touchmove', 100, 200, 2);
    scroller.dispatchEvent(move);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('leaves a horizontal wheel gesture to the carousel', () => {
    renderHook(() => useLibraryPagination(scroller, true));
    const wheel = new WheelEvent('wheel', {
      deltaX: 120,
      deltaY: 0,
      cancelable: true,
      bubbles: true,
    });
    scroller.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('turns one page per vertical drag and never scrolls the list', () => {
    renderHook(() => useLibraryPagination(scroller, true));
    scroller.dispatchEvent(touchEvent('touchstart', 100, 300));
    const move = touchEvent('touchmove', 100, 200);
    scroller.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'instant' });
    scroller.dispatchEvent(touchEvent('touchmove', 100, 50));
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  });
  it('leaves a horizontal drag to the carousel', () => {
    renderHook(() => useLibraryPagination(scroller, true));
    scroller.dispatchEvent(touchEvent('touchstart', 100, 300));
    const move = touchEvent('touchmove', 200, 310);
    scroller.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('leaves the pull-to-refresh drag at the top alone', () => {
    renderHook(() => useLibraryPagination(scroller, true));
    scroller.dispatchEvent(touchEvent('touchstart', 100, 100));
    const move = touchEvent('touchmove', 100, 200);
    scroller.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('leaves the pointer alone when paging is off', () => {
    renderHook(() => useLibraryPagination(scroller, false));
    const wheel = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    scroller.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('pages with volume keys only when Use Volume Keys is on', async () => {
    scroller.scrollTop = 500;
    const { rerender, unmount } = renderHook(() => useLibraryPagination(scroller, true));
    await act(() => eventDispatcher.dispatch('native-key-down', { keyName: 'VolumeDown' }));
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(h.acquireVolume).not.toHaveBeenCalled();
    h.volumeKeysToFlip = true;
    rerender();
    expect(h.acquireVolume).toHaveBeenCalledOnce();
    await act(() => eventDispatcher.dispatch('native-key-down', { keyName: 'VolumeDown' }));
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'instant' });
    await act(() => eventDispatcher.dispatch('native-key-down', { keyName: 'VolumeUp' }));
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
    unmount();
    expect(h.releaseVolume).toHaveBeenCalledOnce();
  });
});
