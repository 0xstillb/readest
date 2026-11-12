// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_GRIMMLINK_SETTINGS, DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useBookDataStore, type BookData } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useGrimmLinkSync } from '@/app/reader/hooks/useGrimmLinkSync';
import type { SystemSettings } from '@/types/settings';
import type { BookNote } from '@/types/book';

const spies = vi.hoisted(() => ({
  pull: vi.fn(async (..._args: unknown[]) => []),
  rating: vi.fn(async () => {}),
  env: { appService: {}, envConfig: {} },
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => spies.env }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (value: string) => value }));
vi.mock('@/app/reader/hooks/useWindowActiveChanged', () => ({ useWindowActiveChanged: () => {} }));
vi.mock('@/services/grimmlink/GrimmLinkClient', () => ({
  GrimmLinkClient: class {
    getCapabilities() {
      return Promise.resolve({ capabilities: ['metadata'] });
    }
  },
}));
vi.mock('@/services/grimmlink/GrimmLinkSyncStore', () => ({
  GrimmLinkSyncStore: class {
    getRating() {
      return Promise.resolve(null);
    }
  },
}));
vi.mock('@/services/grimmlink/bookLinks', () => ({ GrimmLinkBookLinkStore: class {} }));
vi.mock('@/services/grimmlink/progress', async (original) => ({
  ...(await original<typeof import('@/services/grimmlink/progress')>()),
  GrimmLinkProgressProvider: class {
    resolveLink() {
      return Promise.resolve({ bookId: 42, bookHash: 'hash', format: 'PDF' });
    }
  },
}));
vi.mock('@/services/grimmlink/outbox', () => ({ GrimmLinkOutbox: class {} }));
vi.mock('@/services/grimmlink/replayScheduler', () => ({
  GrimmLinkReplayScheduler: class {
    requestReplay() {
      return Promise.resolve();
    }
    flushNow() {
      return Promise.resolve();
    }
  },
}));
vi.mock('@/services/grimmlink/metadataProvider', () => ({
  GrimmLinkMetadataProvider: class {
    pull = spies.pull;
  },
}));
vi.mock('@/services/grimmlink/rating', () => ({
  GrimmLinkRatingProvider: class {
    pull = spies.rating;
  },
}));

beforeEach(() => {
  spies.pull.mockClear();
  spies.rating.mockClear();
  useBookDataStore.setState({ booksData: {} });
  useSettingsStore.setState({
    settings: {
      ...DEFAULT_SYSTEM_SETTINGS,
      grimmlink: {
        ...DEFAULT_GRIMMLINK_SETTINGS,
        enabled: true,
        serverUrl: 'http://localhost',
        userkey: 'key',
        strategy: 'receive',
        syncMetadata: true,
      },
    } as SystemSettings,
  });
});
afterEach(() => useBookDataStore.setState({ booksData: {} }));

it('pulls bookmarks on the first open after the book and config become ready', async () => {
  const view = renderHook(() => useGrimmLinkSync('hash-view'));
  expect(spies.pull).not.toHaveBeenCalled();
  const data = {
    id: 'hash',
    book: { hash: 'hash', format: 'PDF' },
    config: null,
  } as unknown as BookData;
  act(() => useBookDataStore.setState({ booksData: { hash: data } }));
  expect(spies.pull).not.toHaveBeenCalled();
  act(() =>
    useBookDataStore.setState({
      booksData: {
        hash: { ...data, config: { updatedAt: 0, booknotes: [] } as BookData['config'] },
      },
    }),
  );
  await waitFor(() => expect(spies.pull).toHaveBeenCalledTimes(1));
  expect(spies.pull.mock.calls[0]?.[0]).toBe('hash');
  view.rerender();
  expect(spies.pull).toHaveBeenCalledTimes(1);
  view.unmount();
  const reopened = renderHook(() => useGrimmLinkSync('hash-view'));
  await waitFor(() => expect(spies.pull).toHaveBeenCalledTimes(2));
  reopened.unmount();
});

it('updates live notes and preserves an edit made during the pull', async () => {
  const originalSave = useBookDataStore.getState().saveConfig;
  const note = (id: string): BookNote => ({
    id,
    type: 'bookmark',
    cfi: 'epubcfi(/6/2!/4/2)',
    text: id,
    note: '',
    createdAt: 1,
    updatedAt: 1,
  });
  const local = note('local');
  const remote = note('remote');
  let finishPull: (() => void) | undefined;
  spies.pull.mockImplementationOnce(async (...args: unknown[]) => {
    await new Promise<void>((resolve) => {
      finishPull = resolve;
    });
    await (args[2] as (notes: BookNote[]) => Promise<void>)([remote]);
    return [];
  });
  useBookDataStore.setState({
    saveConfig: vi.fn(async () => {}),
    booksData: {
      hash: {
        id: 'hash',
        book: { hash: 'hash', format: 'PDF' },
        config: { booknotes: [] },
      } as unknown as BookData,
    },
  });
  const view = renderHook(() => useGrimmLinkSync('hash-view'));
  try {
    await waitFor(() => expect(finishPull).toBeDefined());
    act(() => {
      useBookDataStore.getState().updateBooknotes('hash-view', [local], 'remote');
    });
    await act(async () => {
      finishPull!();
    });
    await waitFor(() =>
      expect(
        useBookDataStore
          .getState()
          .getConfig('hash-view')
          ?.booknotes?.map((n) => n.id),
      ).toEqual(['local', 'remote']),
    );
  } finally {
    view.unmount();
    useBookDataStore.setState({ saveConfig: originalSave });
  }
});
