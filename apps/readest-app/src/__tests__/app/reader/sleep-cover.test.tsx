// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SleepCover from '@/app/reader/components/SleepCover';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SleepCover', () => {
  it('preloads the current cover and restores the reader on visibility', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { container, rerender } = render(<SleepCover src='cover-one.png' />);
    const cover = container.firstElementChild as HTMLElement;
    expect(cover.style.visibility).toBe('hidden');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('cover-one.png');

    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cover.style.visibility).toBe('visible');

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cover.style.visibility).toBe('hidden');

    rerender(<SleepCover src='cover-two.png' />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('cover-two.png');
  });

  it('does not show an empty overlay without a cover', () => {
    const { container } = render(<SleepCover />);
    expect(container.firstElementChild).toBeNull();
  });
});
