// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takeHomeLibraryAction } from '@/components/simpleui/homeLibraryAction';

const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { canReadExternalDir: true } }),
}));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
vi.mock('@/app/library/components/LibraryHeader', () => ({
  default: (props: {
    embeddedInHome: boolean;
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    onSearchQueryApply: (value: string) => void;
    onImportBooksFromFiles: () => void;
    onPullLibrary: () => void;
  }) => (
    <div data-embedded={String(props.embeddedInHome)}>
      <input
        aria-label='Search'
        value={props.searchQuery}
        onChange={(event) => props.onSearchQueryChange(event.currentTarget.value)}
      />
      <button type='button' onClick={() => props.onSearchQueryApply(props.searchQuery)}>
        Search library
      </button>
      <button type='button' onClick={props.onImportBooksFromFiles}>
        Import
      </button>
      <button type='button' onClick={props.onPullLibrary}>
        Sync
      </button>
    </div>
  ),
}));

import SimpleUIHomeToolbar from '@/components/simpleui/SimpleUIHomeToolbar';

beforeEach(() => {
  mocks.push.mockReset();
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe('Simple UI home toolbar', () => {
  it('uses the embedded Library header and submits search to the Library', () => {
    const { container } = render(<SimpleUIHomeToolbar />);
    expect(container.firstElementChild?.getAttribute('data-embedded')).toBe('true');
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'book & more' } });
    fireEvent.click(screen.getByText('Search library'));
    expect(mocks.push).toHaveBeenCalledWith('/library?q=book+%26+more');
  });

  it('hands import and sync to the real Library page', () => {
    render(<SimpleUIHomeToolbar />);
    fireEvent.click(screen.getByText('Import'));
    expect(mocks.push).toHaveBeenCalledWith('/library');
    expect(takeHomeLibraryAction()?.action).toBe('import-files');
    fireEvent.click(screen.getByText('Sync'));
    expect(takeHomeLibraryAction()?.action).toBe('sync');
  });
});
