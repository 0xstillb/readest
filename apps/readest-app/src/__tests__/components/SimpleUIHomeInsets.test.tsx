// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  library: [] as Array<Record<string, unknown>>,
  lastOpenBooks: [] as string[],
  appService: { isAndroidApp: true, hasSafeAreaInset: true },
  theme: {
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    statusBarHeight: 24,
    systemUIVisible: true,
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({}) }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: mocks.appService }) }));
vi.mock('@/hooks/useLibrary', () => ({ useLibrary: () => ({ libraryLoaded: true }) }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({}) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/hooks/useUICSS', () => ({ useUICSS: () => {} }));
vi.mock('@/store/libraryStore', () => ({ useLibraryStore: () => ({ library: mocks.library }) }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: { lastOpenBooks: mocks.lastOpenBooks },
    isSettingsDialogOpen: false,
  }),
}));
vi.mock('@/store/themeStore', () => ({ useThemeStore: () => mocks.theme }));
vi.mock('@/components/simpleui/useSimpleUIHomeDisplay', () => ({
  default: () => ({ display: 'both' }),
}));
vi.mock('@/components/simpleui/SimpleUIBottomBar', () => ({ default: () => null }));
vi.mock('@/components/simpleui/SimpleUIHomeToolbar', () => ({
  default: () => <button type='button'>Toolbar action</button>,
}));
vi.mock('@/components/settings/SettingsDialog', () => ({ default: () => null }));
vi.mock('@/components/BookCover', () => ({ default: () => null }));
vi.mock('@/components/WindowButtons', () => ({ default: () => null }));
vi.mock('@/utils/nav', () => ({ navigateToReader: () => {} }));

import SimpleUIHome from '@/components/simpleui/SimpleUIHome';

beforeEach(() => {
  window.localStorage.clear();
  mocks.library = [];
  mocks.lastOpenBooks = [];
  mocks.appService = { isAndroidApp: true, hasSafeAreaInset: true };
  mocks.theme = {
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    statusBarHeight: 24,
    systemUIVisible: true,
  };
});
afterEach(cleanup);

describe('Simple UI home top inset', () => {
  it('keeps the scroll area below the Android status bar even without a cutout', () => {
    const { container } = render(<SimpleUIHome />);
    expect(container.querySelector('main')?.style.paddingTop).toContain('24px');
    expect(container.querySelector('.simpleui-home-content')?.className).toContain('pt-2');
  });

  it('uses the larger cutout inset instead of adding it to the status bar', () => {
    mocks.theme.safeAreaInsets.top = 45;
    const { container } = render(<SimpleUIHome />);
    expect(container.querySelector('main')?.style.paddingTop).toContain('45px');
  });

  it('does not reserve the status bar height when the system UI is hidden', () => {
    mocks.theme.systemUIVisible = false;
    const { container } = render(<SimpleUIHome />);
    expect(container.querySelector('main')?.style.paddingTop).toBe('0px');
  });

  it('preserves the existing layout on desktop', () => {
    mocks.appService = { isAndroidApp: false, hasSafeAreaInset: false };
    const { container } = render(<SimpleUIHome />);
    expect(container.querySelector('main')?.style.paddingTop).toBe('');
    expect(container.querySelector('.simpleui-home-content')?.className).toContain(
      'pt-[max(0.5rem,env(safe-area-inset-top))]',
    );
  });

  it('applies saved clock, date, and spacing settings to home', () => {
    window.localStorage.setItem(
      'readest.simpleui.clockAppearance',
      JSON.stringify({ clockSize: 140, dateSize: 80, gap: 12 }),
    );
    const { container } = render(<SimpleUIHome />);
    const style = container.querySelector('main')?.style;
    expect(style?.getPropertyValue('--simpleui-clock-scale')).toBe('1.4');
    expect(style?.getPropertyValue('--simpleui-date-scale')).toBe('0.8');
    expect(style?.getPropertyValue('--simpleui-clock-date-gap')).toBe('12px');
  });

  it('toggles the toolbar from the clock without toggling on toolbar actions', () => {
    render(<SimpleUIHome />);
    expect(screen.queryByText('Toolbar action')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show toolbar' }));
    expect(screen.getByText('Toolbar action')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide toolbar' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    fireEvent.click(screen.getByText('Toolbar action'));
    expect(screen.getByText('Toolbar action')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide toolbar' }));
    expect(screen.queryByText('Toolbar action')).toBeNull();
  });

  it('shows a book whose real progress rounds down to zero percent', () => {
    mocks.library = [{ hash: 'long', title: 'Long book', progress: [1, 1000], updatedAt: 1 }];
    render(<SimpleUIHome />);
    expect(screen.getByText('Long book')).toBeTruthy();
    expect(screen.getByText('Continue Reading')).toBeTruthy();
  });

  it('prefers the most recently opened book even before progress is saved', () => {
    mocks.library = [
      {
        hash: 'older',
        title: 'Older book',
        readingStatus: 'reading',
        progress: [5, 100],
        updatedAt: 100,
      },
      { hash: 'latest', title: 'Latest book', progress: [0, 0], updatedAt: 1 },
    ];
    mocks.lastOpenBooks = ['latest'];
    const { container } = render(<SimpleUIHome />);
    expect(container.querySelector('.simpleui-current-reading')?.textContent).toContain(
      'Latest book',
    );
  });
});
