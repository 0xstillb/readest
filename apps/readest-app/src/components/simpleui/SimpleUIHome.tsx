'use client';

import { useMemo, useState, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

import { useEnv } from '@/context/EnvContext';
import { useLibrary } from '@/hooks/useLibrary';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from '@/hooks/useTranslation';
import { useUICSS } from '@/hooks/useUICSS';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useThemeStore } from '@/store/themeStore';
import { navigateToReader } from '@/utils/nav';
import type { Book } from '@/types/book';
import SettingsDialog from '@/components/settings/SettingsDialog';
import BookCover from '@/components/BookCover';
import WindowButtons from '@/components/WindowButtons';
import SimpleUIBottomBar from './SimpleUIBottomBar';
import useSimpleUIHomeDisplay from './useSimpleUIHomeDisplay';

const progressPercent = (book: Book) => {
  const [current, total] = book.progress ?? [0, 0];
  return total > 0 ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : 0;
};

export default function SimpleUIHome() {
  const _ = useTranslation();
  const router = useRouter();
  const { appService } = useEnv();
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const { library } = useLibraryStore();
  const { libraryLoaded } = useLibrary();
  const { isSettingsDialogOpen, settings } = useSettingsStore();
  const { safeAreaInsets } = useThemeStore();
  const { display } = useSimpleUIHomeDisplay();
  const [now, setNow] = useState(() => new Date());

  useTheme({ systemUIVisible: true, appThemeColor: 'base-100' });
  useUICSS();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const activeBooks = useMemo(
    () =>
      library
        .filter(
          (book) =>
            !book.deletedAt && (book.readingStatus === 'reading' || progressPercent(book) > 0),
        )
        .sort(
          (a, b) =>
            Number(b.readingStatus === 'reading') - Number(a.readingStatus === 'reading') ||
            b.updatedAt - a.updatedAt,
        ),
    [library],
  );
  const currentBook = activeBooks[0];
  const recentBooks = activeBooks.slice(currentBook ? 1 : 0, (currentBook ? 1 : 0) + 4);

  const openBook = (book: Book) => navigateToReader(router, [book.hash]);

  return (
    <main
      className='simpleui-home full-height flex flex-col overflow-hidden bg-base-100 text-base-content'
      data-home-display={display}
      style={{ '--simpleui-safe-bottom': `${safeAreaInsets?.bottom ?? 0}px` } as CSSProperties}
    >
      <div className='simpleui-home-content flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-8'>
        <header
          ref={dragRegionRef}
          className='flex w-full shrink-0 flex-col items-center py-1 text-center'
        >
          <time className='simpleui-clock tabular-nums'>
            {new Intl.DateTimeFormat(undefined, {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }).format(now)}
          </time>
          <div className='mt-0 text-lg font-semibold sm:text-xl'>
            {new Intl.DateTimeFormat(undefined, {
              weekday: 'short',
              month: 'short',
              day: '2-digit',
              year: 'numeric',
            }).format(now)}
          </div>
        </header>
        {appService?.hasWindowBar && (
          <WindowButtons
            className='absolute h-0 w-0 overflow-hidden'
            headerRef={dragRegionRef}
            showMinimize={false}
            showMaximize={false}
            showClose={false}
          />
        )}

        {currentBook ? (
          <section className='simpleui-current-reading mx-auto mt-3 grid w-full max-w-3xl shrink-0 items-center gap-4 bg-transparent py-3 pe-3 ps-0 text-left sm:mt-4 sm:gap-8 sm:pe-5'>
            <div className='simpleui-cover-frame simpleui-current-cover flex items-center justify-center overflow-hidden rounded-xl bg-base-200'>
              <BookCover
                book={currentBook}
                coverFit={settings.libraryCoverFit}
                showSpine={settings.librarySkeuomorphicCovers}
              />
            </div>
            <div className='simpleui-current-copy min-w-0'>
              <div className='mb-2 text-sm font-semibold uppercase tracking-wide text-base-content/70'>
                {_('Currently Reading')}
              </div>
              <h1 className='text-xl font-bold [overflow-wrap:anywhere] sm:text-2xl'>
                {currentBook.title}
              </h1>
              <p className='mt-2 line-clamp-2 text-base text-base-content/75'>
                {currentBook.author}
              </p>
              <div
                className='simpleui-progress mt-4'
                role='progressbar'
                aria-label={_('Reading')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent(currentBook)}
                aria-valuetext={`${progressPercent(currentBook)}%`}
                style={
                  { '--simpleui-progress': `${progressPercent(currentBook)}%` } as CSSProperties
                }
              >
                <span className='simpleui-progress-track' aria-hidden='true'>
                  <span className='simpleui-progress-fill' />
                </span>
                <span className='simpleui-progress-label' aria-hidden='true'>
                  {progressPercent(currentBook)}%
                </span>
              </div>
              <button
                type='button'
                onClick={() => openBook(currentBook)}
                className='simpleui-continue-reading mt-4 flex w-full cursor-pointer items-center justify-between text-left text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current'
              >
                <span>{_('Continue Reading')}</span>
                <svg
                  aria-hidden='true'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='1.8'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <path d='M4 12h15m-6-6 6 6-6 6' />
                </svg>
              </button>
            </div>
          </section>
        ) : (
          <div className='mx-auto mt-4 max-w-3xl shrink-0 border border-base-content/45 p-5 text-center'>
            <p className='text-lg font-semibold'>
              {libraryLoaded ? _('No books') : _('Loading library...')}
            </p>
          </div>
        )}

        {display === 'both' && recentBooks.length > 0 && (
          <section className='mx-auto mt-2 w-full max-w-3xl shrink-0 pb-5'>
            <div className='mb-2 flex shrink-0 items-center'>
              <h2 className='text-base font-bold'>{_('Recently read')}</h2>
            </div>
            <div className='simpleui-recent-grid grid items-start gap-3'>
              {recentBooks.map((book) => (
                <button
                  type='button'
                  key={book.hash}
                  onClick={() => openBook(book)}
                  className='min-w-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current'
                >
                  <div className='simpleui-cover-frame flex aspect-[2/3] w-full items-center justify-center overflow-hidden rounded-lg bg-base-200'>
                    <BookCover
                      book={book}
                      coverFit={settings.libraryCoverFit}
                      showSpine={settings.librarySkeuomorphicCovers}
                    />
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
      <SimpleUIBottomBar active='home' />
      {isSettingsDialogOpen && <SettingsDialog bookKey='' />}
    </main>
  );
}
