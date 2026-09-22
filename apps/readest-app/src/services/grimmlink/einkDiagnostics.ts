export interface GrimmLinkRuntimeDiagnostics {
  generatedAt: string;
  platform: string;
  userAgent: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  screen: { width: number; height: number };
  lifecycle: { visibility: DocumentVisibilityState | 'unknown'; focused: boolean };
  recentLifecycleEvents: { type: string; at: number }[];
  recentInputEvents: { key: string; code: string; keyCode?: number; at: number }[];
}

const lifecycleEvents: { type: string; at: number }[] = [];
const inputEvents: { key: string; code: string; keyCode?: number; at: number }[] = [];
const remember = <T>(list: T[], value: T) => {
  list.push(value);
  if (list.length > 20) list.splice(0, list.length - 20);
};

/** Begin opt-in diagnostics capture while the settings panel is open. */
export const startGrimmLinkRuntimeDiagnostics = (): (() => void) | undefined => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
  const lifecycle = (event: Event) =>
    remember(lifecycleEvents, { type: event.type, at: Date.now() });
  const input = (event: KeyboardEvent) =>
    remember(inputEvents, {
      key: event.key.slice(0, 32),
      code: event.code.slice(0, 32),
      ...(event.keyCode ? { keyCode: event.keyCode } : {}),
      at: Date.now(),
    });
  document.addEventListener('visibilitychange', lifecycle);
  for (const type of ['focus', 'blur', 'pagehide', 'pageshow']) {
    window.addEventListener(type, lifecycle);
  }
  window.addEventListener('keydown', input);
  return () => {
    document.removeEventListener('visibilitychange', lifecycle);
    for (const type of ['focus', 'blur', 'pagehide', 'pageshow']) {
      window.removeEventListener(type, lifecycle);
    }
    window.removeEventListener('keydown', input);
  };
};

/**
 * Opt-in, content-free runtime diagnostics for e-ink tuning.  Keep this
 * deliberately independent from Grimmory requests so exports never contain
 * credentials, book text, or private sync payloads.
 */
export const collectGrimmLinkRuntimeDiagnostics = (): GrimmLinkRuntimeDiagnostics => {
  const win = typeof window === 'undefined' ? undefined : window;
  const doc = typeof document === 'undefined' ? undefined : document;
  const screen = win?.screen;
  return {
    generatedAt: new Date().toISOString(),
    platform: typeof navigator === 'undefined' ? 'unknown' : navigator.platform,
    userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    viewport: {
      width: win?.innerWidth ?? 0,
      height: win?.innerHeight ?? 0,
      devicePixelRatio: win?.devicePixelRatio ?? 1,
    },
    screen: { width: screen?.width ?? 0, height: screen?.height ?? 0 },
    lifecycle: {
      visibility: doc?.visibilityState ?? 'unknown',
      focused: doc ? doc.hasFocus() : false,
    },
    recentLifecycleEvents: [...lifecycleEvents],
    recentInputEvents: [...inputEvents],
  };
};
