import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GrimmLinkShelfSyncStatus from '@/components/settings/integrations/GrimmLinkShelfSyncStatus';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

describe('GrimmLinkShelfSyncStatus', () => {
  afterEach(() => cleanup());

  it('shows the current download, percentage, and determinate progress bar', () => {
    render(
      <GrimmLinkShelfSyncStatus
        syncing
        status={{
          stage: 'downloading',
          book: 'chapter-38.epub',
          progress: 42,
          total: 100,
        }}
      />,
    );

    expect(screen.getByText('Downloading chapter-38.epub…')).toBeTruthy();
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('42');
  });

  it('keeps showing activity while import is running after download reaches 100%', () => {
    render(
      <GrimmLinkShelfSyncStatus syncing status={{ stage: 'importing', book: 'large-book.pdf' }} />,
    );

    expect(screen.getByText('Importing large-book.pdf…')).toBeTruthy();
    expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
  });

  it('keeps the compact status card width stable for long book names', () => {
    render(
      <GrimmLinkShelfSyncStatus
        compact
        syncing
        status={{
          stage: 'downloading',
          book: 'a-very-long-book-name-that-must-not-expand-the-status-card.epub',
          progress: 7,
          total: 100,
        }}
      />,
    );

    const status = screen.getByRole('status');
    expect(status.className).toContain('w-80');
    expect(status.className).toContain('overflow-hidden');
    expect(screen.getByText('7%')).toBeTruthy();
  });

  it('offers cancellation while active and reports the final outcome', () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <GrimmLinkShelfSyncStatus syncing status={{ stage: 'starting' }} onCancel={onCancel} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel shelf sync' }));
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(
      <GrimmLinkShelfSyncStatus
        syncing={false}
        status={{ stage: 'done', message: 'Imported 1 books.' }}
      />,
    );
    expect(screen.getByText('Imported 1 books.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel shelf sync' })).toBeNull();

    rerender(
      <GrimmLinkShelfSyncStatus
        syncing={false}
        status={{ stage: 'error', message: 'Network timeout' }}
      />,
    );
    expect(screen.getByText('Network timeout')).toBeTruthy();
  });
});
