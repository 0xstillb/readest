// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  convert: vi.fn<(src: string) => Promise<string>>(),
  setCover: vi.fn<(src: string | null) => Promise<{ status: string }>>(),
  toast: vi.fn(),
}));
vi.mock('@/libs/document', () => ({ convertBlobUrlToDataUrl: mocks.convert }));
vi.mock('@/utils/bridge', () => ({ setSleepCover: mocks.setCover }));
vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch: mocks.toast } }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (value: string) => value }));
import SleepCover from '@/app/reader/components/SleepCover';

beforeEach(() => {
  mocks.convert.mockReset();
  mocks.setCover.mockReset();
  mocks.setCover.mockResolvedValue({ status: 'ready' });
  mocks.toast.mockReset();
});
afterEach(async () => {
  cleanup();
  await act(async () => {});
});

describe('SleepCover', () => {
  it('prepares the current image for Android and clears it on close', async () => {
    mocks.convert.mockResolvedValue('data:image/png;base64,YQ==');
    const { unmount } = render(<SleepCover src='cover.png' />);
    await waitFor(() => expect(mocks.setCover).toHaveBeenCalledWith('data:image/png;base64,YQ=='));
    expect(mocks.convert).toHaveBeenCalledWith('cover.png');
    unmount();
    await waitFor(() => expect(mocks.setCover).toHaveBeenLastCalledWith(null));
  });

  it('tries the shelf thumbnail when the original images cannot be read', async () => {
    mocks.convert.mockRejectedValueOnce(new Error('offline'));
    mocks.convert.mockRejectedValueOnce(new Error('missing'));
    mocks.convert.mockResolvedValueOnce('data:image/png;base64,dGh1bWI=');
    render(<SleepCover src='remote' fallbackSrc='local' thumbnailSrc='thumbnail' />);
    await waitFor(() =>
      expect(mocks.setCover).toHaveBeenCalledWith('data:image/png;base64,dGh1bWI='),
    );
    expect(mocks.convert.mock.calls.map(([src]) => src)).toEqual(['remote', 'local', 'thumbnail']);
  });

  it('does not apply an image that finishes loading after the reader closes', async () => {
    let finish!: (data: string) => void;
    mocks.convert.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { unmount } = render(<SleepCover src='slow.png' />);
    unmount();
    await act(async () => {
      finish('data:image/png;base64,bGF0ZQ==');
    });
    await waitFor(() => expect(mocks.setCover).toHaveBeenLastCalledWith(null));
    expect(mocks.setCover).not.toHaveBeenCalledWith('data:image/png;base64,bGF0ZQ==');
  });

  it('explains how to select the cover on first setup', async () => {
    mocks.convert.mockResolvedValue('data:image/png;base64,YQ==');
    mocks.setCover.mockResolvedValue({ status: 'setup' });
    render(<SleepCover src='cover.png' />);
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({
          message: expect.stringContaining('Screensaver'),
        }),
      ),
    );
  });

  it('reports when the cover cannot be prepared', async () => {
    mocks.convert.mockRejectedValue(new Error('missing'));
    render(<SleepCover src='cover.png' />);
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({
          type: 'error',
        }),
      ),
    );
  });
});
