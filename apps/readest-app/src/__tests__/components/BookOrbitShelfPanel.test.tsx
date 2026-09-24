import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BookOrbitShelfPanel from '@/components/settings/integrations/BookOrbitShelfPanel';
import type {
  SaveShelfSubscriptionInput,
  ShelfSubscriptionRecord,
} from '@/services/shelfSync/types';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, params?: Record<string, unknown>) => {
    const count = params ? params['count'] : undefined;
    if (count !== undefined) {
      return key.replace('{{count}}', String(count));
    }
    return key;
  },
}));

const mockSubscriptions: ShelfSubscriptionRecord[] = [];
const mockSaveSubscription = vi.fn().mockImplementation(async (sub: SaveShelfSubscriptionInput) => {
  const shelfType = sub.shelfType ?? 'default';
  const shelfId = String(sub.shelfId);
  const idx = mockSubscriptions.findIndex(
    (s) => s.shelfType === shelfType && s.shelfId === shelfId,
  );
  const record: ShelfSubscriptionRecord = {
    provider: sub.provider ?? 'bookorbit',
    connectionId: sub.connectionId ?? 'conn1',
    shelfType,
    shelfId,
    enabled: sub.enabled ?? true,
    cleanupPolicy: sub.cleanupPolicy ?? 'keep_local',
    downloadPolicy: sub.downloadPolicy ?? 'always',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (idx >= 0) mockSubscriptions[idx] = record;
  else mockSubscriptions.push(record);
});

vi.mock('@/services/shelfSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shelfSync')>();
  class MockShelfSyncStore {
    async getShelfSubscriptions(filter?: { enabledOnly?: boolean }) {
      if (filter?.enabledOnly) return mockSubscriptions.filter((s) => s.enabled);
      return [...mockSubscriptions];
    }
    async saveShelfSubscription(sub: SaveShelfSubscriptionInput) {
      return mockSaveSubscription(sub);
    }
    async getShelfEntries() {
      return [];
    }
  }
  return {
    ...actual,
    ShelfSyncStore: MockShelfSyncStore,
  };
});

const mockGetCollections = vi.fn();
const mockGetSmartScopes = vi.fn();
const mockGetShelfBooks = vi.fn();

vi.mock('@/services/bookorbit/BookOrbitClient', () => {
  class MockBookOrbitClient {
    getCollections = mockGetCollections;
    getSmartScopes = mockGetSmartScopes;
    getShelfBooks = mockGetShelfBooks;
  }
  return {
    BookOrbitRequestError: class BookOrbitRequestError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
    },
    BookOrbitClient: MockBookOrbitClient,
  };
});

const mockSyncSubscribed = vi.fn();
vi.mock('@/services/bookorbit/shelfSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bookorbit/shelfSync')>();
  return {
    ...actual,
    syncSubscribedBookOrbitShelves: (...args: unknown[]) => mockSyncSubscribed(...args),
  };
});

const mockSettings = {
  bookorbit: {
    enabled: true,
    serverUrl: 'http://192.168.1.50:3000',
    username: 'alice',
    userkey: 'key123',
  },
};

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: mockSettings,
  }),
}));

const mockLibrary = [{ hash: 'hash-local-1', title: 'Local Book 1', format: 'epub' }];

vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: Object.assign(
    (selector: (state: { library: typeof mockLibrary; setLibrary: () => void }) => unknown) =>
      selector({ library: mockLibrary, setLibrary: vi.fn() }),
    {
      getState: () => ({ library: mockLibrary, setLibrary: vi.fn() }),
    },
  ),
}));

const mockAppService = {
  exists: vi.fn().mockResolvedValue(true),
  saveLibraryBooks: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    appService: mockAppService,
  }),
}));

const mockDispatch = vi.fn();
vi.mock('@/utils/event', () => ({
  eventDispatcher: {
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  },
}));

describe('BookOrbitShelfPanel', () => {
  beforeEach(() => {
    mockSubscriptions.length = 0;
    mockSaveSubscription.mockClear();
    mockDispatch.mockClear();
    mockSyncSubscribed.mockClear();
    mockGetCollections.mockReset();
    mockGetSmartScopes.mockReset();
    mockGetShelfBooks.mockReset();

    mockGetCollections.mockResolvedValue([
      {
        id: 'col-1',
        name: 'Summer Reading',
        type: 'collection',
        description: 'Books for vacation',
        bookCount: 3,
      },
    ]);
    mockGetSmartScopes.mockResolvedValue([
      { id: 'scope-1', name: 'Unread Hard Sci-Fi', type: 'smartscope', bookCount: 7 },
    ]);
    mockGetShelfBooks.mockResolvedValue([
      { bookId: 'b1', filename: 'b1.epub', format: 'epub', bookHash: 'hash-remote-1' },
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders shelf list with Collections and SmartScopes and their badges', async () => {
    render(<BookOrbitShelfPanel />);

    await waitFor(() => {
      expect(screen.getByText('Summer Reading')).toBeTruthy();
      expect(screen.getByText('Unread Hard Sci-Fi')).toBeTruthy();
    });

    expect(screen.getByText('Collection')).toBeTruthy();
    expect(screen.getByText('SmartScope')).toBeTruthy();
    expect(screen.getByText('Books for vacation')).toBeTruthy();

    // Verify source-of-truth invariant: No remote collection create/edit buttons exist
    expect(
      screen.queryByRole('button', { name: /create|add collection|new shelf|edit smartscope/i }),
    ).toBeNull();
  });

  it('shows empty state tip when no shelves are returned by server', async () => {
    mockGetCollections.mockResolvedValue([]);
    mockGetSmartScopes.mockResolvedValue([]);

    render(<BookOrbitShelfPanel />);

    await waitFor(() => {
      expect(screen.getByText('No BookOrbit collections or smart scopes found.')).toBeTruthy();
    });
  });

  it('allows toggling shelf subscription and updates policies in store', async () => {
    render(<BookOrbitShelfPanel />);

    await waitFor(() => {
      expect(screen.getByText('Summer Reading')).toBeTruthy();
    });

    const toggle = screen.getByLabelText('Subscribe to Summer Reading');
    expect(toggle).toBeTruthy();
    expect((toggle as HTMLInputElement).checked).toBe(false);

    // Toggle on
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockSaveSubscription).toHaveBeenCalledWith({
        shelfType: 'collection',
        shelfId: 'col-1',
        enabled: true,
        cleanupPolicy: 'keep_local',
        downloadPolicy: 'always',
      });
    });
  });

  it('allows configuring download policy and cleanup policy when shelf is enabled', async () => {
    mockSubscriptions.push({
      provider: 'bookorbit',
      connectionId: 'conn1',
      shelfType: 'collection',
      shelfId: 'col-1',
      enabled: true,
      cleanupPolicy: 'keep_local',
      downloadPolicy: 'always',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    render(<BookOrbitShelfPanel />);

    await waitFor(() => {
      expect(screen.getByLabelText('Download policy for Summer Reading')).toBeTruthy();
      expect(screen.getByLabelText('Cleanup policy for Summer Reading')).toBeTruthy();
    });

    const downloadSelect = screen.getByLabelText('Download policy for Summer Reading');
    fireEvent.change(downloadSelect, { target: { value: 'wifi_only' } });

    await waitFor(() => {
      expect(mockSaveSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          shelfType: 'collection',
          shelfId: 'col-1',
          downloadPolicy: 'wifi_only',
        }),
      );
    });

    const cleanupSelect = screen.getByLabelText('Cleanup policy for Summer Reading');
    fireEvent.change(cleanupSelect, { target: { value: 'remove_managed_copy' } });

    await waitFor(() => {
      expect(mockSaveSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          shelfType: 'collection',
          shelfId: 'col-1',
          cleanupPolicy: 'remove_managed_copy',
        }),
      );
    });
  });

  it('shows next sync preview with Downloads, Updates, and Removals counts', async () => {
    mockSubscriptions.push({
      provider: 'bookorbit',
      connectionId: 'conn1',
      shelfType: 'collection',
      shelfId: 'col-1',
      enabled: true,
      cleanupPolicy: 'keep_local',
      downloadPolicy: 'always',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    render(<BookOrbitShelfPanel />);

    await waitFor(() => {
      expect(screen.getByText('Next sync')).toBeTruthy();
      expect(screen.getByText('Downloads')).toBeTruthy();
      expect(screen.getByText('Updates')).toBeTruthy();
      expect(screen.getByText('Removals')).toBeTruthy();
    });
  });

  it('runs manual sync and handles completion toast', async () => {
    mockSubscriptions.push({
      provider: 'bookorbit',
      connectionId: 'conn1',
      shelfType: 'collection',
      shelfId: 'col-1',
      enabled: true,
      cleanupPolicy: 'keep_local',
      downloadPolicy: 'always',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    mockSyncSubscribed.mockResolvedValue({
      downloaded: 2,
      reused: 0,
      removed: 0,
    });

    render(<BookOrbitShelfPanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sync shelves' })).toBeTruthy();
    });

    const syncButton = screen.getByRole('button', { name: 'Sync shelves' });
    expect((syncButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(mockSyncSubscribed).toHaveBeenCalledOnce();
      expect(mockDispatch).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({
          type: 'success',
          message: 'Imported 2 books.',
        }),
      );
    });
  });

  it('notifies user when attempting to sync with zero enabled shelves', async () => {
    render(<BookOrbitShelfPanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sync shelves' })).toBeTruthy();
    });

    const syncButton = screen.getByRole('button', { name: 'Sync shelves' });
    // Disabled when enabled.size === 0
    expect((syncButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('refreshes shelf list when clicking Refresh button', async () => {
    render(<BookOrbitShelfPanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Refresh shelves' })).toBeTruthy();
    });

    const refreshButton = screen.getByRole('button', { name: 'Refresh shelves' });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(mockGetCollections).toHaveBeenCalledTimes(2);
      expect(mockGetSmartScopes).toHaveBeenCalledTimes(2);
    });
  });

  it('applies e-ink layout and large targets', async () => {
    render(<BookOrbitShelfPanel />);

    await waitFor(() => {
      expect(screen.getByText('Summer Reading')).toBeTruthy();
    });

    const labelRow = screen.getByLabelText('Subscribe to Summer Reading').closest('label');
    expect(labelRow?.className).toContain('min-h-14');
    expect(labelRow?.className).toContain('cursor-pointer');

    const card = labelRow?.closest('.card');
    expect(card?.className).toContain('eink-bordered');
  });
});
