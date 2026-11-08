'use client';

import { useCallback, useEffect, useState } from 'react';

export type SimpleUITitleMode = 'hidden' | 'cover' | 'below';

const STORAGE_KEY = 'readest.simpleui.bookTitleMode';
const LEGACY_STORAGE_KEY = 'readest.simpleui.showBookTitles';

export default function useSimpleUIBookTitles() {
  const [titleMode, setTitleModeState] = useState<SimpleUITitleMode>('cover');

  const setTitleMode = useCallback((mode: SimpleUITitleMode) => {
    window.localStorage.setItem(STORAGE_KEY, mode);
    setTitleModeState(mode);
    document.getElementById('simpleui-library')?.setAttribute('data-book-title-mode', mode);
  }, []);

  useEffect(() => {
    const savedMode = window.localStorage.getItem(STORAGE_KEY);
    if (savedMode === 'hidden' || savedMode === 'cover' || savedMode === 'below') {
      setTitleMode(savedMode);
      return;
    }

    // Preserve the old show/hide choice during the move to three title modes.
    const legacyChoice = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    setTitleMode(legacyChoice === 'false' ? 'hidden' : legacyChoice === 'true' ? 'below' : 'cover');
  }, [setTitleMode]);

  return { titleMode, setTitleMode };
}
