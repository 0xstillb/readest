export interface GrimmLinkRuntimeDiagnostics {
  generatedAt: string;
  platform: string;
  userAgent: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  screen: { width: number; height: number };
  lifecycle: { visibility: DocumentVisibilityState | 'unknown'; focused: boolean };
  recentLifecycleEvents: { type: string; at: number }[];
  recentInputEvents: { type: 'keyboard'; at: number }[];
  performance: GrimmLinkPerformanceCounters;
}

export interface GrimmLinkPerformanceCounters {
  dbOpens: number;
  dbQueries: number;
  dbWrites: number;
  replayRequested: number;
  replayExecuted: number;
  networkRequests: number;
  shelfFileChecks: number;
  shelfSyncDurationMs: number;
}

type GrimmLinkPerformanceCounter = keyof GrimmLinkPerformanceCounters;

const emptyPerformanceCounters = (): GrimmLinkPerformanceCounters => ({
  dbOpens: 0,
  dbQueries: 0,
  dbWrites: 0,
  replayRequested: 0,
  replayExecuted: 0,
  networkRequests: 0,
  shelfFileChecks: 0,
  shelfSyncDurationMs: 0,
});

const lifecycleEvents: { type: string; at: number }[] = [];
const inputEvents: { type: 'keyboard'; at: number }[] = [];
let performanceCaptureOwners = 0;
let performanceCounters = emptyPerformanceCounters();
const remember = <T>(list: T[], value: T) => {
  list.push(value);
  if (list.length > 20) list.splice(0, list.length - 20);
};

/** Begin opt-in runtime and performance capture while diagnostics is open. */
export const startGrimmLinkRuntimeDiagnostics = (): (() => void) | undefined => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
  if (performanceCaptureOwners === 0) performanceCounters = emptyPerformanceCounters();
  performanceCaptureOwners += 1;
  const lifecycle = (event: Event) =>
    remember(lifecycleEvents, { type: event.type, at: Date.now() });
  const input = () => remember(inputEvents, { type: 'keyboard', at: Date.now() });
  document.addEventListener('visibilitychange', lifecycle);
  for (const type of ['focus', 'blur', 'pagehide', 'pageshow']) {
    window.addEventListener(type, lifecycle);
  }
  window.addEventListener('keydown', input);
  return () => {
    performanceCaptureOwners = Math.max(0, performanceCaptureOwners - 1);
    document.removeEventListener('visibilitychange', lifecycle);
    for (const type of ['focus', 'blur', 'pagehide', 'pageshow']) {
      window.removeEventListener(type, lifecycle);
    }
    window.removeEventListener('keydown', input);
  };
};

/** Record content-free counters only while the user has diagnostics open. */
export const recordGrimmLinkPerformance = (
  counter: GrimmLinkPerformanceCounter,
  amount = 1,
): void => {
  if (performanceCaptureOwners === 0 || !Number.isFinite(amount)) return;
  performanceCounters[counter] += Math.max(0, amount);
};

/** Redact credentials and custom header values before a diagnostics export. */
export const redactGrimmLinkDiagnosticSecrets = (
  message: string,
  secrets: Array<string | undefined>,
): string => {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted.replace(/\b[a-f\d]{32}\b/gi, '[redacted]');
};

/**
 * Content-free runtime diagnostics. Counters are aggregate-only and never
 * retain request URLs, credentials, book text, or private sync payloads.
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
    performance: { ...performanceCounters },
  };
};
