import { useCallback } from 'react';

export type EinkOptimizationMode = 'auto' | 'on' | 'off';

/** Keep detection conservative: an unknown Android/WebView must not lose the existing view setting. */
export const resolveEinkMode = (
  mode: EinkOptimizationMode | undefined,
  legacyIsEink: boolean,
  runtimeIsEink = false,
): boolean => {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return legacyIsEink || runtimeIsEink;
};

export const useEinkMode = () => {
  const applyEinkMode = useCallback((isEink: boolean) => {
    if (isEink) {
      document.body.classList.add('no-transitions');
    } else {
      document.body.classList.remove('no-transitions');
    }
    document.documentElement.setAttribute('data-eink', isEink.toString());
  }, []);

  return { applyEinkMode };
};
