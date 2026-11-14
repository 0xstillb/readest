// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
vi.mock('@/store/libraryStore', () => ({ useLibraryStore: () => ({ library: [] }) }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: {}, isSettingsDialogOpen: false }),
}));
vi.mock('@/store/themeStore', () => ({ useThemeStore: () => mocks.theme }));
vi.mock('@/components/simpleui/useSimpleUIHomeDisplay', () => ({
  default: () => ({ display: 'both' }),
}));
vi.mock('@/components/simpleui/SimpleUIBottomBar', () => ({ default: () => null }));
vi.mock('@/components/settings/SettingsDialog', () => ({ default: () => null }));
vi.mock('@/components/BookCover', () => ({ default: () => null }));
vi.mock('@/components/WindowButtons', () => ({ default: () => null }));
vi.mock('@/utils/nav', () => ({ navigateToReader: () => {} }));

import SimpleUIHome from '@/components/simpleui/SimpleUIHome';

beforeEach(() => {
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
});
