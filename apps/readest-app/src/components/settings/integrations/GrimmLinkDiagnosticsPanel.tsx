import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { GrimmLinkClient } from '@/services/grimmlink/GrimmLinkClient';
import { GrimmLinkOutbox } from '@/services/grimmlink/outbox';
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
  startGrimmLinkRuntimeDiagnostics,
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
  const [summary, setSummary] = useState(emptySummary);
  const [diagnostics, setDiagnostics] = useState<GrimmLinkPersistedDiagnostics>({
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
  });
  const [connection, setConnection] = useState<
    'idle' | 'checking' | 'connected' | 'offline' | 'error'
  >('idle');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!store) return;
    const [nextSummary, nextDiagnostics] = await Promise.all([
      store.getOutboxSummary(),
      store.getDiagnostics(),
    ]);
    setSummary(nextSummary);
    setDiagnostics(nextDiagnostics);
  }, [store]);

  const checkConnection = useCallback(async () => {
    if (!client) return;
    setConnection('checking');
    try {
      const result = await client.connect();
      if (result.success) setConnection('connected');
      else setConnection(result.errorCategory === 'network' ? 'offline' : 'error');
    } catch (error) {
      const category = error instanceof GrimmLinkRequestError ? error.category : 'error';
      setConnection(category === 'network' ? 'offline' : 'error');
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    void checkConnection();
    const timer = window.setInterval(() => {
      void refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [checkConnection, refresh]);

  useEffect(() => startGrimmLinkRuntimeDiagnostics(), []);

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

  const replay = async () => {
    setBusy(true);
    try {
      await store.retryPending();
      await new GrimmLinkOutbox(store, client).replay();
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
    const payload = {
      generatedAt: new Date().toISOString(),
      serverOrigin: safeOrigin(config.serverUrl),
      connection: { enabled: config.enabled, strategy: config.strategy },
      runtime: { status: connection, ...collectGrimmLinkRuntimeDiagnostics() },
      queue: summary,
      diagnostics,
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
    <section className='space-y-2 pt-2'>
      <div className='flex items-center justify-between gap-2'>
        <SectionTitle>{_('Sync diagnostics')}</SectionTitle>
        <button type='button' className='btn btn-ghost btn-sm' onClick={() => void refresh()}>
          {_('Refresh')}
        </button>
      </div>
      <div className='card eink-bordered border-base-200 bg-base-100 border p-3 text-sm'>
        <div className='flex justify-between'>
          <span>{_('Connection')}</span>
          <strong>
            {_(
              connection === 'connected'
                ? 'Connected'
                : connection === 'checking'
                  ? 'Checking…'
                  : connection === 'offline'
                    ? 'Offline'
                    : connection === 'error'
                      ? 'Error'
                      : 'Not checked',
            )}
          </strong>
        </div>
        <div className='mt-1 flex justify-between'>
          <span>{_('Pending items')}</span>
          <strong>{summary.totalPending}</strong>
        </div>
        <div className='mt-1 flex justify-between'>
          <span>{_('Invalid items')}</span>
          <strong>{summary.invalid}</strong>
        </div>
        <div className='mt-1 flex justify-between'>
          <span>{_('Sync status')}</span>
          <strong>{_(syncStatus)}</strong>
        </div>
        <div className='mt-1 flex justify-between'>
          <span>{_('Last successful sync')}</span>
          <span>{formatTime(diagnostics.lastSuccessAt)}</span>
        </div>
        <div className='mt-1 flex justify-between'>
          <span>{_('Last attempt')}</span>
          <span>{formatTime(diagnostics.lastAttemptAt)}</span>
        </div>
        {diagnostics.lastError && (
          <p className='text-error mt-2 break-words'>{`[${diagnostics.lastError.category}] ${diagnostics.lastError.message}`}</p>
        )}
      </div>
      <div className='flex flex-wrap gap-2'>
        <button
          type='button'
          className='btn btn-primary btn-sm'
          disabled={busy}
          onClick={() => void replay()}
        >
          {busy ? _('Retrying…') : _('Retry pending')}
        </button>
        <button
          type='button'
          className='btn btn-ghost btn-sm'
          disabled={!summary.invalid}
          onClick={() => void clearInvalid()}
        >
          {_('Clear invalid')}
        </button>
        <button
          type='button'
          className='btn btn-ghost btn-sm'
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

export default GrimmLinkDiagnosticsPanel;
