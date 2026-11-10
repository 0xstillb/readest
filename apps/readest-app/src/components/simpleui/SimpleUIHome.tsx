'use client';

import { useMemo, useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

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
import SimpleUIBottomBar from './SimpleUIBottomBar';

const progressPercent = (book: Book) => {
  const [current, total] = book.progress ?? [0, 0];
  return total > 0 ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : 0;
};

export default function SimpleUIHome() {
  const _ = useTranslation();
  const router = useRouter();
  const { library } = useLibraryStore();
  const { libraryLoaded } = useLibrary();
  const { isSettingsDialogOpen } = useSettingsStore();
  const { safeAreaInsets } = useThemeStore();
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
  const recentBooks = activeBooks.slice(currentBook ? 1 : 0, 5);

  const openBook = (book: Book) => navigateToReader(router, [book.hash]);

  return (
    <main
      className='simpleui-home full-height flex flex-col overflow-hidden bg-base-100 text-base-content'
      style={{ '--simpleui-safe-bottom': `${safeAreaInsets?.bottom ?? 0}px` } as CSSProperties}
    >
      <div className='simpleui-home-content flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-8'>
        <header className='mx-auto flex max-w-3xl shrink-0 flex-col items-center py-1 text-center'>
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

        {currentBook ? (
          <button
            type='button'
            onClick={() => openBook(currentBook)}
            className='simpleui-current-reading mx-auto mt-3 grid w-full max-w-3xl shrink-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-9 bg-base-100 py-3 pe-3 ps-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current sm:mt-4 sm:pe-5'
          >
            <div className='simpleui-cover-frame simpleui-current-cover flex items-center justify-center overflow-hidden bg-base-200'>
              {currentBook.coverImageUrl ? (
                <img
                  src={currentBook.coverImageUrl}
                  alt=''
                  className='h-full w-full object-contain'
                />
              ) : (
                <span className='px-3 text-center text-sm font-semibold'>{currentBook.title}</span>
              )}
            </div>
            <div className='simpleui-current-copy min-w-0'>
              <div className='mb-2 text-sm font-semibold uppercase tracking-wide text-base-content/70'>
                {_('Currently Reading')}
              </div>
              <h1 className='line-clamp-3 text-xl font-bold sm:text-2xl'>{currentBook.title}</h1>
              <p className='mt-2 line-clamp-2 text-base text-base-content/75'>
                {currentBook.author}
              </p>
              <div className='mt-5 flex items-center gap-3'>
                <progress
                  className='progress h-2 flex-1 border border-base-content/40'
                  value={progressPercent(currentBook)}
                  max='100'
                />
                <span className='min-w-10 text-right text-sm tabular-nums'>
                  {progressPercent(currentBook)}%
                </span>
              </div>
              <div className='mt-4 text-sm font-semibold'>{_('Continue Reading')}</div>
            </div>
          </button>
        ) : (
          <div className='mx-auto mt-4 max-w-3xl shrink-0 border border-base-content/45 p-5 text-center'>
            <p className='text-lg font-semibold'>
              {libraryLoaded ? _('No books') : _('Loading library...')}
            </p>
          </div>
        )}

        {recentBooks.length > 0 && (
          <section className='mx-auto mt-2 flex min-h-0 w-full max-w-3xl flex-1 flex-col pb-5'>
            <div className='mb-2 flex shrink-0 items-center'>
              <h2 className='text-base font-bold'>{_('Recently read')}</h2>
            </div>
            <div className='auto-rows-fr grid min-h-0 flex-1 grid-cols-2 gap-3 sm:grid-cols-4'>
              {recentBooks.map((book) => (
                <button
                  type='button'
                  key={book.hash}
                  onClick={() => openBook(book)}
                  className='flex h-full min-h-0 min-w-0 flex-col bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current'
                >
                  <div className='simpleui-cover-frame flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden bg-base-200'>
                    {book.coverImageUrl ? (
                      <img
                        src={book.coverImageUrl}
                        alt=''
                        className='h-full w-full object-contain'
                      />
                    ) : (
                      <span className='line-clamp-3 px-2 text-center text-sm font-medium'>
                        {book.title}
                      </span>
                    )}
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
