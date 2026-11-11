'use client';

import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useEnv } from '@/context/EnvContext';
import { useGrimmLinkShelfSync } from '@/hooks/useGrimmLinkShelfSync';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useThemeStore } from '@/store/themeStore';
import { isTauriAppPlatform } from '@/services/environment';
import { tauriQuitApp } from '@/utils/window';
import useSimpleUIBottomBarIconSize from './useSimpleUIBottomBarIconSize';

export default function SimpleUIBottomBar({ active }: { active: 'home' | 'library' }) {
  const _ = useTranslation();
  const router = useRouter();
  const { settings, setSettingsDialogOpen, setRequestedPanel } = useSettingsStore();
  const { appService } = useEnv();
  const { safeAreaInsets } = useThemeStore();
  const { iconSize } = useSimpleUIBottomBarIconSize();
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
      'min-h-[4.5rem] touch-manipulation px-2 py-2 text-sm font-medium',
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
        className='simpleui-dock fixed inset-x-0 bottom-0 z-[30] flex border-t border-base-content/40 bg-base-100'
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
          <svg
            aria-hidden
            viewBox='0 0 48 48'
            style={{ width: iconSize, height: iconSize }}
            fill='none'
            stroke='currentColor'
            strokeWidth='2.4'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <path d='M6 10h9v29H6zM19 6h9v33h-9zM32 13h7l7 26h-9z' />
          </svg>
          <span className='sr-only'>{_('Library')}</span>
        </button>
        <button
          type='button'
          className={buttonClass(active === 'home')}
          aria-current={active === 'home' ? 'page' : undefined}
          aria-label={_('Home')}
          onClick={() => router.push('/simpleui')}
        >
          <svg
            aria-hidden
            viewBox='0 0 48 48'
            style={{ width: iconSize, height: iconSize }}
            fill='none'
            stroke='currentColor'
            strokeWidth='2.4'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <path d='m5 23 19-17 19 17h-6v18H27V29h-7v12H11V23z' />
          </svg>
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
          <svg
            aria-hidden
            viewBox='0 0 48 48'
            style={{ width: iconSize, height: iconSize }}
            fill='none'
            stroke='currentColor'
            strokeWidth='2.4'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <path d='M8 7h27l5 5v28H8zM35 7v6h5M17 35h14' />
            <path
              d='M24 16v13m-6-6 6 6 6-6'
              className={clsx(shelfSyncing && 'simpleui-download-arrow-active')}
            />
          </svg>
          <span className='sr-only'>{_('Shelf Sync')}</span>
        </button>
        <button
          type='button'
          className={buttonClass(false)}
          aria-label={_('Quit App')}
          onClick={() => void quit()}
          disabled={!isTauriAppPlatform()}
        >
          <svg
            aria-hidden
            viewBox='0 0 48 48'
            style={{ width: iconSize, height: iconSize }}
            fill='none'
            stroke='currentColor'
            strokeWidth='2.4'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <path d='M24 5v20M12 12a18 18 0 1 0 24 0' />
          </svg>
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
        @keyframes simpleui-download-arrow {
          0%, 100% { transform: translateY(0); opacity: 1; }
          65% { transform: translateY(3px); opacity: 0.65; }
        }
        @media (prefers-reduced-motion: no-preference) {
          html:not([data-eink='true']) .simpleui-download-arrow-active {
            animation: simpleui-download-arrow 1s ease-in-out infinite;
          }
        }
        .simpleui-clock {
          font-family: 'Sunday Market', sans-serif;
          font-weight: 400;
          font-size: clamp(3.5rem, 10dvh, 7rem);
          line-height: 1;
          letter-spacing: 0.06em;
        }
        /* The home page scrolls its own content, so it has to clear the dock
           and the bottom inset the same way the library does. */
        .simpleui-home .simpleui-home-content {
          padding-bottom: calc(
            4.5rem + max(env(safe-area-inset-bottom), var(--simpleui-safe-bottom, 0px))
          );
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
        #simpleui-library[data-book-title-mode='cover'] .simpleui-cover-title {
          display: -webkit-box;
          position: absolute;
          inset: auto 0 0;
          z-index: 1;
          overflow: hidden;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 3;
          overflow-wrap: anywhere;
          padding: 0.35rem 0.45rem;
          background: rgba(0, 0, 0, 0.8);
          color: white;
          font-size: 0.75rem;
          font-weight: 600;
          line-height: 1.25;
        }
        html[data-eink='true'] #simpleui-library[data-book-title-mode='cover'] .simpleui-cover-title {
          background: var(--color-base-100);
          color: var(--color-base-content);
          border-top: 0;
        }
        #simpleui-library[data-book-title-mode='cover'] .fallback-cover-title,
        #simpleui-library[data-book-title-mode='cover'] .fallback-cover > div:first-child span,
        #simpleui-library[data-book-title-mode='hidden'] .fallback-cover-title,
        #simpleui-library[data-book-title-mode='hidden'] .fallback-cover > div:first-child span,
        #simpleui-library[data-book-title-mode='below'] .fallback-cover-title,
        #simpleui-library[data-book-title-mode='below'] .fallback-cover > div:first-child span {
          display: none;
        }
        #simpleui-library .bookshelf [class~='not-eink:hidden'] {
          display: none;
        }
        .simpleui-home {
          --simpleui-current-cover-width: clamp(8rem, 42vw, 18rem);
        }
        .simpleui-recent-grid {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }
        .simpleui-current-cover {
          width: min(100%, var(--simpleui-current-cover-width));
          height: auto;
          aspect-ratio: 2 / 3;
          justify-self: center;
        }
        .simpleui-current-reading {
          grid-template-columns: minmax(0, 45%) minmax(0, 1fr);
        }
        .simpleui-continue-reading {
          min-height: 2.75rem;
          border: 1px solid currentColor;
          border-radius: 0.2rem;
          padding: 0 0.75rem;
        }
        .simpleui-continue-reading svg {
          width: 1.25rem;
          height: 1.25rem;
          flex: none;
        }
        .simpleui-home[data-home-display='current'] .simpleui-current-reading {
          flex: 1 0 auto;
          align-content: center;
        }
        @media (max-height: 760px) {
          .simpleui-clock {
            font-size: clamp(3rem, 10dvh, 5.25rem);
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
            1px 2px 2px rgba(0, 0, 0, 0.32),
            3px 8px 10px rgba(0, 0, 0, 0.20),
            7px 17px 22px rgba(0, 0, 0, 0.09);
        }
        @media (max-width: 540px) {
          .simpleui-home .simpleui-current-reading {
            grid-template-columns: minmax(0, 1fr);
            justify-items: center;
            row-gap: 1.25rem;
            padding-inline: 0;
          }
          .simpleui-home .simpleui-current-cover {
            width: min(72vw, 18rem);
          }
          .simpleui-home .simpleui-current-copy {
            width: min(100%, 32rem);
          }
        }
        @media (max-width: 420px) {
          .simpleui-home .simpleui-home-content {
            padding-inline: 1rem;
          }
          .simpleui-home {
            --simpleui-current-cover-width: clamp(6.25rem, 35.5vw, 9.5rem);
          }
          .simpleui-home .simpleui-current-reading {
            column-gap: 0.75rem;
            padding-inline-end: 0.5rem;
          }
          .simpleui-home .simpleui-current-copy > div:nth-of-type(2) {
            gap: 0.5rem;
          }
        }
        #simpleui-library .bookitem-main .cover-image,
        #simpleui-library .bookitem-main .fallback-cover {
          border: 0 !important;
          box-shadow: none !important;
        }
        /* Keep SimpleUI covers consistent across normal and e-ink modes. */
        html[data-eink='true'] .simpleui-cover-frame,
        html[data-eink='true'] #simpleui-library .bookitem-main {
          border: 0 !important;
          box-shadow:
            1px 2px 2px rgba(0, 0, 0, 0.32),
            3px 8px 10px rgba(0, 0, 0, 0.20),
            7px 17px 22px rgba(0, 0, 0, 0.09) !important;
        }
      `}</style>
    </>
  );
}
