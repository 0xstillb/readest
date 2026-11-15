'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import LibraryHeader from '@/app/library/components/LibraryHeader';
import { useEnv } from '@/context/EnvContext';
import { isTauriAppPlatform } from '@/services/environment';
import type { LibrarySearchConfig, LibrarySearchTarget } from '@/types/book';
import { DEFAULT_NEARBY_WORDS } from '@/utils/searchConfig';
import { queueHomeLibraryAction, type HomeLibraryAction } from './homeLibraryAction';

/** The real Library toolbar, with Library-only actions handed off to that page. */
export default function SimpleUIHomeToolbar() {
  const router = useRouter();
  const { appService } = useEnv();
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<LibrarySearchTarget>('books');
  const [config, setConfig] = useState<LibrarySearchConfig>({
    scope: 'book',
    mode: 'contains',
    matchCase: false,
    matchDiacritics: false,
    nearbyWords: DEFAULT_NEARBY_WORDS,
  });

  const openLibraryAction = (
    action: HomeLibraryAction,
    options?: { fullRefresh?: boolean; verbose?: boolean },
  ) => {
    queueHomeLibraryAction(action, options);
    router.push('/library');
  };

  const searchLibrary = (value: string) => {
    const params = new URLSearchParams();
    if (value) params.set('q', value);
    if (target === 'text') params.set('search', 'text');
    if (config.mode !== 'contains') params.set('mode', config.mode);
    if (config.matchCase) params.set('matchCase', 'true');
    if (config.matchDiacritics) params.set('matchDiacritics', 'true');
    if (config.mode === 'nearby-words' && config.nearbyWords) {
      params.set('nearby', String(config.nearbyWords));
    }
    const suffix = params.toString();
    router.push(`/library${suffix ? `?${suffix}` : ''}`);
  };

  return (
    <LibraryHeader
      embeddedInHome
      isSelectMode={false}
      isSelectAll={false}
      onPullLibrary={() => openLibraryAction('sync')}
      onImportBooksFromFiles={() => openLibraryAction('import-files')}
      onImportPastedText={() => openLibraryAction('import-pasted-text')}
      onImportBooksFromDirectory={
        appService?.canReadExternalDir ? () => openLibraryAction('import-directory') : undefined
      }
      onImportFromWebBrowser={
        isTauriAppPlatform() ? () => openLibraryAction('import-web') : undefined
      }
      onImportBookFromNovelUrl={
        isTauriAppPlatform() ? () => openLibraryAction('import-novel') : undefined
      }
      onOpenCatalogManager={() => openLibraryAction('catalogs')}
      onOpenFeeds={() => openLibraryAction('feeds')}
      onToggleSelectMode={() => openLibraryAction('select')}
      onSelectAll={() => openLibraryAction('select')}
      onDeselectAll={() => openLibraryAction('select')}
      searchQuery={query}
      searchTarget={target}
      searchConfig={config}
      onSearchConfigChange={setConfig}
      onSearchQueryChange={setQuery}
      onSearchQueryApply={searchLibrary}
      onSearchTargetChange={setTarget}
    />
  );
}
