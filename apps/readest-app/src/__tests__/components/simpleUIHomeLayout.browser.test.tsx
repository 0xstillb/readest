import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@/styles/globals.css';

const cssSources = import.meta.glob<string>('../../components/simpleui/SimpleUIBottomBar.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const state = vi.hoisted(() => ({ display: 'both', clockSize: 100 }));
vi.mock('next/navigation', () => ({ useRouter: () => ({}) }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { isAndroidApp: true, hasSafeAreaInset: true } }),
}));
vi.mock('@/hooks/useLibrary', () => ({ useLibrary: () => ({ libraryLoaded: true }) }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({}) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/hooks/useUICSS', () => ({ useUICSS: () => {} }));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: () => ({
    library: Array.from({ length: 5 }, (_, i) => ({
      hash: `book${i}`,
      title: `Book ${i}`,
      author: 'An author',
      progress: [4, 100],
      updatedAt: 100 - i,
    })),
  }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: {}, isSettingsDialogOpen: false }),
}));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({
    safeAreaInsets: { top: 0, bottom: 0 },
    statusBarHeight: 24,
    systemUIVisible: true,
  }),
}));
vi.mock('@/components/simpleui/useSimpleUIHomeDisplay', () => ({
  default: () => ({ display: state.display }),
}));
vi.mock('@/components/simpleui/useSimpleUIClockAppearance', () => ({
  default: () => ({ appearance: { clockSize: state.clockSize, dateSize: 100, gap: 0 } }),
}));
vi.mock('@/components/simpleui/SimpleUIBottomBar', () => ({
  default: () => (
    <nav data-testid='dock' style={{ position: 'fixed', bottom: 0, height: 72, width: '100%' }} />
  ),
}));
vi.mock('@/components/simpleui/SimpleUIHomeToolbar', () => ({
  default: () => <div style={{ height: 48 }}>Toolbar</div>,
}));
vi.mock('@/components/settings/SettingsDialog', () => ({ default: () => null }));
vi.mock('@/components/BookCover', () => ({
  default: () => <div style={{ width: '100%', height: '100%', background: '#ccc' }} />,
}));
vi.mock('@/components/WindowButtons', () => ({ default: () => null }));
vi.mock('@/utils/nav', () => ({ navigateToReader: () => {} }));
import SimpleUIHome from '@/components/simpleui/SimpleUIHome';

afterEach(async () => {
  cleanup();
  document.querySelector('#home-layout-style')?.remove();
  state.display = 'both';
  state.clockSize = 100;
  await page.viewport(1920, 1080);
});

const installHomeStyles = () => {
  const style = document.createElement('style');
  style.id = 'home-layout-style';
  style.textContent = Object.values(cssSources)[0]!
    .split('<style jsx global>{`')[1]!
    .split('`}</style>')[0]!;
  document.head.append(style);
};

it.each([
  [800, 1200],
  [600, 800],
  [390, 844],
  [320, 568],
])('fits current and recent covers above the dock at %i x %i', async (width, height) => {
  await page.viewport(width, height);
  installHomeStyles();
  const { container, getByTestId } = render(<SimpleUIHome />);
  const recent = container.querySelector('.simpleui-recent-reading')!;
  const current = container.querySelector('.simpleui-current-reading')!;
  const dock = getByTestId('dock').getBoundingClientRect();
  expect(current.getBoundingClientRect().height).toBeGreaterThan(0);
  expect(recent.getBoundingClientRect().bottom).toBeLessThanOrEqual(dock.top + 1);
  expect(recent.querySelectorAll('.simpleui-cover-frame')).toHaveLength(4);
  for (const cover of recent.querySelectorAll('.simpleui-cover-frame')) {
    expect(cover.getBoundingClientRect().bottom).toBeLessThanOrEqual(dock.top + 1);
  }
});

it('keeps the recent covers accessible with a large clock and the toolbar open', async () => {
  await page.viewport(390, 844);
  state.clockSize = 200;
  installHomeStyles();
  const { container, getByRole, getByTestId } = render(<SimpleUIHome />);
  fireEvent.click(getByRole('button', { name: 'Show toolbar' }));
  const scroller = container.querySelector<HTMLElement>('.simpleui-home-content')!;
  const lastCover = container.querySelector('.simpleui-recent-grid button:last-child')!;
  scroller.scrollTop = scroller.scrollHeight;
  expect(lastCover.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    getByTestId('dock').getBoundingClientRect().top + 1,
  );
  expect(getByRole('button', { name: 'Hide toolbar' }).getAttribute('aria-expanded')).toBe('true');
});
