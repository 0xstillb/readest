'use client';

import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { PiArrowsClockwise, PiBooks, PiHouse, PiPower } from 'react-icons/pi';

import { useEnv } from '@/context/EnvContext';
import { useGrimmLinkShelfSync } from '@/hooks/useGrimmLinkShelfSync';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useThemeStore } from '@/store/themeStore';
import { isTauriAppPlatform } from '@/services/environment';
import { tauriQuitApp } from '@/utils/window';

export default function SimpleUIBottomBar({ active }: { active: 'home' | 'library' }) {
  const _ = useTranslation();
  const router = useRouter();
  const { settings, setSettingsDialogOpen, setRequestedPanel } = useSettingsStore();
  const { appService } = useEnv();
  const { safeAreaInsets } = useThemeStore();
  const { handleShelfSync, cancelShelfSync, shelfSyncing, shelfSyncStatus } = useGrimmLinkShelfSync(
    {
      settings: settings.grimmlink,
      onConfigure: () => {
        setRequestedPanel('Integrations');
        setSettingsDialogOpen(true);
      },
    },
  );

  const buttonClass = (selected: boolean) =>
    clsx(
      'flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-none border-x-0 border-b-0 border-t-2',
      'min-h-16 touch-manipulation px-2 py-2 text-sm font-medium',
      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-current',
      selected
        ? 'border-base-content text-base-content'
        : 'border-transparent text-base-content/65',
    );

  const quit = async () => {
    if (isTauriAppPlatform()) await tauriQuitApp();
  };

  const runSync = () => {
    if (!appService) return;
    if (shelfSyncing) cancelShelfSync();
    else handleShelfSync();
  };

  return (
    <>
      <nav
        aria-label={_('SimpleUI Navigation')}
        className='simpleui-dock fixed inset-x-0 bottom-0 z-[60] flex border-t border-base-content/40 bg-base-100'
        style={{
          paddingBottom: `max(env(safe-area-inset-bottom), ${safeAreaInsets?.bottom ?? 0}px)`,
        }}
      >
        <button
          type='button'
          className={buttonClass(active === 'library')}
          aria-current={active === 'library' ? 'page' : undefined}
          aria-label={_('Library')}
          onClick={() => router.push('/library')}
        >
          <PiBooks aria-hidden className='h-8 w-8' />
          <span className='sr-only'>{_('Library')}</span>
        </button>
        <button
          type='button'
          className={buttonClass(active === 'home')}
          aria-current={active === 'home' ? 'page' : undefined}
          aria-label={_('Home')}
          onClick={() => router.push('/simpleui')}
        >
          <PiHouse aria-hidden className='h-8 w-8' />
          <span className='sr-only'>{_('Home')}</span>
        </button>
        <button
          type='button'
          className={buttonClass(false)}
          aria-label={shelfSyncing ? _('Cancel shelf sync') : _('Shelf Sync')}
          aria-busy={shelfSyncing}
          title={shelfSyncStatus?.message || _('Shelf Sync')}
          onClick={runSync}
          disabled={!appService}
        >
          <PiArrowsClockwise
            aria-hidden
            className={clsx('h-8 w-8', shelfSyncing && 'not-eink:animate-spin')}
          />
          <span className='sr-only'>{_('Shelf Sync')}</span>
        </button>
        <button
          type='button'
          className={buttonClass(false)}
          aria-label={_('Quit App')}
          onClick={() => void quit()}
          disabled={!isTauriAppPlatform()}
        >
          <PiPower aria-hidden className='h-8 w-8' />
          <span className='sr-only'>{_('Quit App')}</span>
        </button>
      </nav>
      <style jsx global>{`
        @font-face {
          font-family: 'Noto Sans Thai';
          src: url('/fonts/simpleui/NotoSansThai-Thin.ttf') format('truetype');
          font-weight: 100;
          font-display: swap;
        }
        @font-face {
          font-family: 'Noto Sans Thai';
          src: url('/fonts/simpleui/NotoSansThai-ExtraLight.ttf') format('truetype');
          font-weight: 200;
          font-display: swap;
        }
        @font-face {
          font-family: 'Noto Sans Thai';
          src: url('/fonts/simpleui/NotoSansThai-Light.ttf') format('truetype');
          font-weight: 300;
          font-display: swap;
        }
        @font-face {
          font-family: 'Noto Sans Thai';
          src: url('/fonts/simpleui/NotoSansThai-Regular.ttf') format('truetype');
          font-weight: 400;
          font-display: swap;
        }
        @font-face {
          font-family: 'Noto Sans Thai';
          src: url('/fonts/simpleui/NotoSansThai-Medium.ttf') format('truetype');
          font-weight: 500;
          font-display: swap;
        }
        @font-face {
          font-family: 'Noto Sans Thai';
          src: url('/fonts/simpleui/NotoSansThai-SemiBold.ttf') format('truetype');
          font-weight: 600;
          font-display: swap;
        }
        @font-face {
          font-family: 'Noto Sans Thai';
          src: url('/fonts/simpleui/NotoSansThai-Bold.ttf') format('truetype');
          font-weight: 700;
          font-display: swap;
        }
        @font-face {
          font-family: 'Noto Sans Thai';
          src: url('/fonts/simpleui/NotoSansThai-ExtraBold.ttf') format('truetype');
          font-weight: 800;
          font-display: swap;
        }
        @font-face {
          font-family: 'Noto Sans Thai';
          src: url('/fonts/simpleui/NotoSansThai-Black.ttf') format('truetype');
          font-weight: 900;
          font-display: swap;
        }
        @font-face {
          font-family: 'Sunday Market';
          src: url('/fonts/SundayMarket-Script.ttf') format('truetype');
          font-display: swap;
        }
        .simpleui-clock {
          font-family: 'Sunday Market', sans-serif;
          font-weight: 400;
          font-size: clamp(3.5rem, 10dvh, 7rem);
          line-height: 1;
          letter-spacing: 0.06em;
        }
        .simpleui-home :not(.simpleui-clock),
        #simpleui-library :not(.simpleui-clock) {
          font-family: 'Noto Sans Thai', sans-serif;
        }
        #simpleui-library:not([data-book-title-mode='below'])
          .library-grid-item h4[title],
        #simpleui-library:not([data-book-title-mode='below'])
          .library-list-item h4[title] {
          display: none;
        }
        #simpleui-library[data-book-title-mode='hidden']
          .bookitem-main > span,
        #simpleui-library[data-book-title-mode='hidden']
          .fallback-cover > div:first-child span,
        #simpleui-library[data-book-title-mode='below']
          .bookitem-main > span,
        #simpleui-library[data-book-title-mode='below']
          .fallback-cover > div:first-child span {
          display: none;
        }
        #simpleui-library .bookshelf [class~='not-eink:hidden'] {
          display: none;
        }
        .simpleui-current-cover {
          width: auto;
          height: min(28dvh, 20rem);
          aspect-ratio: 2 / 3;
          justify-self: start;
        }
        @media (max-height: 760px) {
          .simpleui-clock {
            font-size: clamp(3rem, 10dvh, 5.25rem);
          }
          .simpleui-current-cover {
            height: min(16dvh, 7rem);
          }
          .simpleui-current-copy > div:first-child {
            margin-bottom: 0.25rem !important;
          }
          .simpleui-current-copy > h1 {
            font-size: 1.125rem;
            line-height: 1.2;
          }
          .simpleui-current-copy > p {
            margin-top: 0.25rem !important;
          }
          .simpleui-current-copy > div:nth-of-type(2),
          .simpleui-current-copy > div:last-child {
            margin-top: 0.5rem !important;
          }
        }
        .simpleui-cover-frame,
        #simpleui-library .bookitem-main {
          border: 0 !important;
          box-shadow:
            1px 2px 2px color-mix(in srgb, var(--color-base-content) 32%, transparent),
            3px 8px 10px color-mix(in srgb, var(--color-base-content) 20%, transparent),
            7px 17px 22px color-mix(in srgb, var(--color-base-content) 9%, transparent);
        }
        #simpleui-library .bookitem-main .cover-image,
        #simpleui-library .bookitem-main .fallback-cover {
          border: 0 !important;
          box-shadow: none !important;
        }
        html[data-eink='true'] .simpleui-cover-frame,
        html[data-eink='true'] #simpleui-library .bookitem-main {
          box-shadow:
            1px 2px 2px color-mix(in srgb, var(--color-base-content) 52%, transparent),
            3px 8px 10px color-mix(in srgb, var(--color-base-content) 34%, transparent),
            7px 17px 22px color-mix(in srgb, var(--color-base-content) 20%, transparent) !important;
        }
      `}</style>
    </>
  );
}
