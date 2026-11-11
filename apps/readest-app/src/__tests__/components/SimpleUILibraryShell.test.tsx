import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

import SimpleUILibraryShell from '@/components/simpleui/SimpleUILibraryShell';

vi.mock('@/components/simpleui/SimpleUIBottomBar', () => ({ default: () => null }));

const MODE_KEY = 'readest.simpleui.enabled';
const TITLE_MODE_KEY = 'readest.simpleui.bookTitleMode';

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(MODE_KEY, 'true');
});

afterEach(() => {
  cleanup();
});

describe('SimpleUILibraryShell', () => {
  test('applies the saved title mode without opening the menu', async () => {
    window.localStorage.setItem(TITLE_MODE_KEY, 'hidden');
    const { container } = render(
      <SimpleUILibraryShell>
        <div>library</div>
      </SimpleUILibraryShell>,
    );

    await waitFor(() =>
      expect(
        container.querySelector('#simpleui-library')?.getAttribute('data-book-title-mode'),
      ).toBe('hidden'),
    );
  });

  test('leaves the library untouched while Simple UI Mode is off', async () => {
    window.localStorage.setItem(MODE_KEY, 'false');
    const { container } = render(
      <SimpleUILibraryShell>
        <div>library</div>
      </SimpleUILibraryShell>,
    );

    await waitFor(() => expect(container.querySelector('#simpleui-library')).toBeNull());
  });
});
