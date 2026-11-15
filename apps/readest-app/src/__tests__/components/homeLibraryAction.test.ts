// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queueHomeLibraryAction,
  takeHomeLibraryAction,
} from '@/components/simpleui/homeLibraryAction';

beforeEach(() => {
  window.sessionStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('home toolbar Library handoff', () => {
  it('hands off an action exactly once with its options', () => {
    queueHomeLibraryAction('sync', { fullRefresh: true, verbose: true });
    expect(takeHomeLibraryAction()).toMatchObject({
      action: 'sync',
      fullRefresh: true,
      verbose: true,
    });
    expect(takeHomeLibraryAction()).toBeNull();
  });

  it('does not run stale or invalid handoffs', () => {
    queueHomeLibraryAction('import-files');
    vi.advanceTimersByTime(60_000);
    expect(takeHomeLibraryAction()).toBeNull();
    window.sessionStorage.setItem('readest.simpleui.pendingLibraryAction', '{broken');
    expect(takeHomeLibraryAction()).toBeNull();
  });
});
