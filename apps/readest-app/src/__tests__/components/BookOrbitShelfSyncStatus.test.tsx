import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BookOrbitShelfSyncStatus from '@/components/settings/integrations/BookOrbitShelfSyncStatus';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

describe('BookOrbitShelfSyncStatus', () => {
  afterEach(() => cleanup());

  it('renders starting stage', () => {
    render(
      <BookOrbitShelfSyncStatus
        syncing
        status={{
          stage: 'starting',
        }}
      />,
    );

    expect(screen.getByText('Preparing shelf sync…')).toBeTruthy();
  });

  it('shows the current download, percentage, and determinate progress bar', () => {
    render(
      <BookOrbitShelfSyncStatus
        syncing
        status={{
          stage: 'downloading',
          book: 'sci-fi-novel.epub',
          progress: 55,
          total: 100,
        }}
      />,
    );

    expect(screen.getByText('Downloading sci-fi-novel.epub…')).toBeTruthy();
    expect(screen.getByText('55%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('55');
  });

  it('shows importing activity after download', () => {
    render(
      <BookOrbitShelfSyncStatus
        syncing
        status={{
          stage: 'importing',
          book: 'sci-fi-novel.epub',
        }}
      />,
    );

    expect(screen.getByText('Importing sci-fi-novel.epub…')).toBeTruthy();
    expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
  });

  it('keeps compact status card width stable for long titles', () => {
    render(
      <BookOrbitShelfSyncStatus
        compact
        syncing
        status={{
          stage: 'downloading',
          book: 'a-very-long-book-title-that-must-not-cause-horizontal-expansion-on-eink.epub',
          progress: 12,
          total: 100,
        }}
      />,
    );

    const status = screen.getByRole('status');
    expect(status.className).toContain('w-80');
    expect(status.className).toContain('overflow-hidden');
    expect(screen.getByText('12%')).toBeTruthy();
  });

  it('offers cancellation while active and reports done, error, and cancelled outcomes', () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <BookOrbitShelfSyncStatus syncing status={{ stage: 'starting' }} onCancel={onCancel} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel shelf sync' }));
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(
      <BookOrbitShelfSyncStatus
        syncing={false}
        status={{ stage: 'done', message: 'Imported 3 books.' }}
      />,
    );
    expect(screen.getByText('Imported 3 books.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel shelf sync' })).toBeNull();

    rerender(
      <BookOrbitShelfSyncStatus
        syncing={false}
        status={{ stage: 'error', message: 'Connection timeout' }}
      />,
    );
    expect(screen.getByText('Connection timeout')).toBeTruthy();

    rerender(
      <BookOrbitShelfSyncStatus
        syncing={false}
        status={{ stage: 'cancelled', message: 'Shelf sync cancelled' }}
      />,
    );
    expect(screen.getByText('Shelf sync cancelled')).toBeTruthy();
  });
});
