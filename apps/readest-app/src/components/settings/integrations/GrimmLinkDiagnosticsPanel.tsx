import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MdCheckCircle,
  MdCloudOff,
  MdErrorOutline,
  MdRefresh,
  MdSyncProblem,
} from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { GrimmLinkClient, type GrimmLinkHealthCheck } from '@/services/grimmlink/GrimmLinkClient';
import { GrimmLinkOutbox } from '@/services/grimmlink/outbox';
import { GrimmLinkReplayScheduler } from '@/services/grimmlink/replayScheduler';
import {
  GrimmLinkSyncStore,
  type GrimmLinkPersistedDiagnostics,
  type GrimmLinkOutboxSummary,
} from '@/services/grimmlink/GrimmLinkSyncStore';
import { useSettingsStore } from '@/store/settingsStore';
import { GrimmLinkRequestError } from '@/services/grimmlink/GrimmLinkRequestError';
import { SectionTitle, Tips } from '../primitives';
import {
  collectGrimmLinkRuntimeDiagnostics,
  redactGrimmLinkDiagnosticSecrets,
  startGrimmLinkRuntimeDiagnostics,
  type GrimmLinkRuntimeDiagnostics,
} from '@/services/grimmlink/einkDiagnostics';

const emptySummary: GrimmLinkOutboxSummary = {
  totalPending: 0,
  pendingByCategory: { progress: 0, sessions: 0, metadata: 0, status: 0 },
  invalid: 0,
  nextRetryAt: null,
};

const safeOrigin = (value: string) => {
  try {
    return new URL(value).origin;
  } catch {
    return '[invalid server]';
  }
};

const formatTime = (value: number | null) => (value ? new Date(value).toLocaleString() : '—');

/** Readest-only operational view. It deliberately exports no credentials or request headers. */
const GrimmLinkDiagnosticsPanel = () => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const config = settings.grimmlink;
  const store = useMemo(
    () =>
      appService
        ? new GrimmLinkSyncStore(appService, `${config.serverUrl}\u0000${config.username}`)
        : null,
    [appService, config.serverUrl, config.username],
  );
  const client = useMemo(
    () =>
      config.enabled && config.serverUrl && config.userkey ? new GrimmLinkClient(config) : null,
    [config],
  );
  const replayScheduler = useMemo(
    () =>
      client && store ? new GrimmLinkReplayScheduler(new GrimmLinkOutbox(store, client)) : null,
    [client, store],
  );
  const [summary, setSummary] = useState(emptySummary);
  const [diagnostics, setDiagnostics] = useState<GrimmLinkPersistedDiagnostics>({
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastReplayDurationMs: null,
    lastReplayRows: 0,
    lastReplaySucceeded: 0,
    lastReplayFailed: 0,
    lastError: null,
  });
  const [connection, setConnection] = useState<
    'idle' | 'checking' | 'connected' | 'offline' | 'auth-error' | 'server-error' | 'error'
  >('idle');
  const [health, setHealth] = useState<GrimmLinkHealthCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<GrimmLinkRuntimeDiagnostics>(() =>
    collectGrimmLinkRuntimeDiagnostics(),
  );

  const refresh = useCallback(async () => {
    if (!store) return;
    const [nextSummary, nextDiagnostics] = await Promise.all([
      store.getOutboxSummary(),
      store.getDiagnostics(),
    ]);
    setSummary(nextSummary);
    setDiagnostics(nextDiagnostics);
    setRuntimeDiagnostics(collectGrimmLinkRuntimeDiagnostics());
  }, [store]);

  const checkConnection = useCallback(async () => {
    if (!client) return;
    setConnection('checking');
    setHealth(null);
    try {
      setHealth(await client.healthCheck());
      setConnection('connected');
    } catch (error) {
      const category = error instanceof GrimmLinkRequestError ? error.category : 'error';
      setConnection(
        category === 'network'
          ? 'offline'
          : category === 'auth'
            ? 'auth-error'
            : category === 'server'
              ? 'server-error'
              : 'error',
      );
    }
  }, [client]);

  useEffect(() => startGrimmLinkRuntimeDiagnostics(), []);

  useEffect(() => {
    void refresh();
    void checkConnection();
    const timer = window.setInterval(() => {
      void refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [checkConnection, refresh]);

  if (!client || !store) return null;

  const syncStatus = diagnostics.lastError
    ? diagnostics.lastError.category === 'auth'
      ? 'auth-error'
      : diagnostics.lastError.category === 'network'
        ? 'offline'
        : diagnostics.lastError.category === 'server'
          ? 'server-error'
          : diagnostics.lastError.category
    : summary.totalPending > 0
      ? 'queued'
      : diagnostics.lastSuccessAt
        ? 'synced'
        : 'idle';
  const connectionLabel = _(
    connection === 'connected'
      ? 'Connected'
      : connection === 'checking'
        ? 'Checking…'
        : connection === 'offline'
          ? 'Offline'
          : connection === 'auth-error'
            ? 'Authentication required'
            : connection === 'server-error'
              ? 'Server problem'
              : connection === 'error'
                ? 'Connection problem'
                : 'Not checked',
  );
  const syncStatusLabel = _(
    syncStatus === 'auth-error'
      ? 'Authentication required'
      : syncStatus === 'server-error'
        ? 'Server error'
        : syncStatus === 'invalid-data'
          ? 'Invalid data'
          : syncStatus === 'queued'
            ? 'Waiting to sync'
            : syncStatus === 'synced'
              ? 'Up to date'
              : syncStatus === 'offline'
                ? 'Offline'
                : syncStatus === 'conflict'
                  ? 'Needs attention'
                  : 'Ready',
  );
  const pendingBreakdown = [
    summary.pendingByCategory.progress > 0
      ? _('{{count}} progress', { count: summary.pendingByCategory.progress })
      : null,
    summary.pendingByCategory.sessions > 0
      ? _('{{count}} sessions', { count: summary.pendingByCategory.sessions })
      : null,
    summary.pendingByCategory.metadata > 0
      ? _('{{count}} metadata', { count: summary.pendingByCategory.metadata })
      : null,
    summary.pendingByCategory.status > 0
      ? _('{{count}} status', { count: summary.pendingByCategory.status })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const replay = async () => {
    setBusy(true);
    try {
      await store.retryPending();
      await replayScheduler?.flushNow();
      await refresh();
      await checkConnection();
    } finally {
      setBusy(false);
    }
  };

  const clearInvalid = async () => {
    if (!window.confirm(_('Remove invalid queued GrimmLink items?'))) return;
    await store.clearInvalid();
    await refresh();
  };

  const exportDiagnostics = async () => {
    const secrets = [config.username, config.userkey, ...Object.values(config.customHeaders ?? {})];
    const payload = {
      generatedAt: new Date().toISOString(),
      serverOrigin: safeOrigin(config.serverUrl),
      connection: { enabled: config.enabled, strategy: config.strategy },
      runtime: { status: connection, ...collectGrimmLinkRuntimeDiagnostics() },
      queue: summary,
      diagnostics: {
        ...diagnostics,
        lastError: diagnostics.lastError
          ? {
              ...diagnostics.lastError,
              message: redactGrimmLinkDiagnosticSecrets(diagnostics.lastError.message, secrets),
            }
          : null,
      },
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'grimmlink-diagnostics.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className='space-y-3 pt-2'>
      <div className='flex items-end justify-between gap-3'>
        <div>
          <SectionTitle>{_('Sync diagnostics')}</SectionTitle>
          <p className='text-base-content/65 mt-0.5 text-xs'>
            {_('Connection health and items waiting to sync')}
          </p>
        </div>
        <button
          type='button'
          className='btn btn-ghost h-10 min-h-10 gap-1.5 px-3'
          disabled={connection === 'checking'}
          onClick={() => {
            void refresh();
            void checkConnection();
          }}
        >
          <MdRefresh
            aria-hidden='true'
            className={connection === 'checking' ? 'animate-spin' : ''}
          />
          {_('Refresh')}
        </button>
      </div>
      <div
        role='status'
        className='eink-bordered border-base-200 bg-base-200/40 flex items-center gap-3 rounded-lg border px-3 py-3'
      >
        {connection === 'connected' ? (
          <MdCheckCircle aria-hidden='true' className='h-6 w-6 shrink-0' />
        ) : connection === 'offline' ? (
          <MdCloudOff aria-hidden='true' className='h-6 w-6 shrink-0' />
        ) : connection === 'error' ||
          connection === 'auth-error' ||
          connection === 'server-error' ? (
          <MdSyncProblem aria-hidden='true' className='h-6 w-6 shrink-0' />
        ) : (
          <MdRefresh
            aria-hidden='true'
            className={`h-6 w-6 shrink-0 ${connection === 'checking' ? 'animate-spin' : ''}`}
          />
        )}
        <div className='min-w-0 flex-1'>
          <div className='font-medium'>{connectionLabel}</div>
          <div className='text-base-content/65 truncate text-xs'>
            {safeOrigin(config.serverUrl)}
          </div>
        </div>
        <span className='badge badge-outline shrink-0'>{syncStatusLabel}</span>
      </div>
      <div className='card eink-bordered border-base-200 bg-base-100 border text-sm'>
        <div className='divide-base-200 divide-y px-4'>
          <DiagnosticRow
            label={_('Pending items')}
            value={String(summary.totalPending)}
            description={pendingBreakdown || _('Nothing is waiting')}
          />
          <DiagnosticRow label={_('Invalid items')} value={String(summary.invalid)} />
          <DiagnosticRow
            label={_('Last replay')}
            value={
              diagnostics.lastReplayDurationMs == null
                ? '—'
                : `${diagnostics.lastReplayDurationMs} ms`
            }
            description={
              diagnostics.lastReplayDurationMs == null
                ? _('No replay recorded')
                : _('{{succeeded}} succeeded, {{failed}} failed of {{rows}}', {
                    succeeded: diagnostics.lastReplaySucceeded,
                    failed: diagnostics.lastReplayFailed,
                    rows: diagnostics.lastReplayRows,
                  })
            }
          />
          <DiagnosticRow
            label={_('Last successful sync')}
            value={formatTime(diagnostics.lastSuccessAt)}
          />
          <DiagnosticRow label={_('Last attempt')} value={formatTime(diagnostics.lastAttemptAt)} />
        </div>
      </div>
      {health && (
        <div className='card eink-bordered border-base-200 bg-base-100 border text-sm'>
          <div className='border-base-200 border-b px-4 py-3 font-medium'>
            {_('GrimmLink Health')}
          </div>
          <div className='divide-base-200 divide-y px-4'>
            <DiagnosticRow
              label={_('Authentication')}
              value={health.authentication === 'ok' ? _('Available') : _('Failed')}
            />
            <DiagnosticRow
              label={_('Capabilities')}
              value={health.capabilities === 'ok' ? _('Loaded') : _('Failed')}
            />
            <DiagnosticRow
              label={_('Progress API')}
              value={health.progress === 'available' ? _('Available') : _('Unsupported')}
            />
            <DiagnosticRow
              label={_('Metadata API')}
              value={health.metadata === 'available' ? _('Available') : _('Unsupported')}
            />
            <DiagnosticRow
              label={_('Sessions API')}
              value={health.sessions === 'available' ? _('Available') : _('Unsupported')}
            />
            <DiagnosticRow
              label={_('Shelves API')}
              value={
                health.shelves === 'available'
                  ? _('Available')
                  : health.shelves === 'failed'
                    ? _('Failed')
                    : _('Unsupported')
              }
            />
            <DiagnosticRow
              label={_('Download')}
              value={health.download === 'available' ? _('Available') : _('Unsupported')}
            />
            <DiagnosticRow label={_('Outbox')} value={String(summary.totalPending)} />
            <DiagnosticRow label={_('Last sync')} value={formatTime(diagnostics.lastSuccessAt)} />
            <DiagnosticRow
              label={_('Database activity')}
              value={`${runtimeDiagnostics.performance.dbOpens} / ${runtimeDiagnostics.performance.dbQueries} / ${runtimeDiagnostics.performance.dbWrites}`}
              description={_('Opens / queries / writes while diagnostics is open')}
            />
            <DiagnosticRow
              label={_('Replay activity')}
              value={`${runtimeDiagnostics.performance.replayRequested} / ${runtimeDiagnostics.performance.replayExecuted}`}
              description={_('Requested / executed')}
            />
            <DiagnosticRow
              label={_('Network requests')}
              value={String(runtimeDiagnostics.performance.networkRequests)}
            />
            <DiagnosticRow
              label={_('Shelf file checks')}
              value={String(runtimeDiagnostics.performance.shelfFileChecks)}
            />
            <DiagnosticRow
              label={_('Shelf sync duration')}
              value={`${runtimeDiagnostics.performance.shelfSyncDurationMs} ms`}
            />
          </div>
        </div>
      )}
      {diagnostics.lastError && (
        <div
          role='alert'
          className='eink-bordered border-error/40 bg-error/10 flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm'
        >
          <MdErrorOutline aria-hidden='true' className='text-error mt-0.5 h-5 w-5 shrink-0' />
          <div className='min-w-0'>
            <div className='font-medium'>{_('Last sync problem')}</div>
            <div className='break-words text-[0.9em]'>{`[${diagnostics.lastError.category}] ${diagnostics.lastError.message}`}</div>
          </div>
        </div>
      )}
      <div className='flex flex-wrap gap-2'>
        <button
          type='button'
          className='btn btn-contrast h-10 min-h-10'
          disabled={busy || summary.totalPending === 0}
          onClick={() => void replay()}
        >
          {busy ? _('Retrying…') : _('Retry pending')}
        </button>
        <button
          type='button'
          className='btn btn-ghost h-10 min-h-10 text-error'
          disabled={!summary.invalid}
          onClick={() => void clearInvalid()}
        >
          {_('Clear invalid')}
        </button>
        <button
          type='button'
          className='btn btn-ghost h-10 min-h-10'
          onClick={() => void exportDiagnostics()}
        >
          {_('Export diagnostics')}
        </button>
      </div>
      <Tips>
        <li>
          {_(
            'Diagnostics never include your password, user key, cookies, or authorization headers.',
          )}
        </li>
      </Tips>
    </section>
  );
};

const DiagnosticRow = ({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description?: string;
}) => (
  <div className='flex min-h-14 items-center justify-between gap-4 py-2.5'>
    <div className='min-w-0'>
      <div className='font-medium'>{label}</div>
      {description && <div className='text-base-content/65 truncate text-xs'>{description}</div>}
    </div>
    <span className='shrink-0 text-end tabular-nums'>{value}</span>
  </div>
);

export default GrimmLinkDiagnosticsPanel;
