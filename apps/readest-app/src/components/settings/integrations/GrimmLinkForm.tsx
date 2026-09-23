import clsx from 'clsx';
import { md5 } from 'js-md5';
import React, { useEffect, useState } from 'react';
import { MdCheckCircle, MdErrorOutline, MdLink } from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { GrimmLinkClient } from '@/services/grimmlink/GrimmLinkClient';
import { useSettingsStore } from '@/store/settingsStore';
import { KOSyncStrategy } from '@/types/settings';
import { eventDispatcher } from '@/utils/event';
import { isLanAddress } from '@/utils/network';
import SubPageHeader from '../SubPageHeader';
import { SectionTitle, SettingLabel, SettingsSelect, SettingsSwitchRow, Tips } from '../primitives';
import GrimmLinkShelfPanel from './GrimmLinkShelfPanel';
import GrimmLinkDiagnosticsPanel from './GrimmLinkDiagnosticsPanel';

interface GrimmLinkFormProps {
  onBack: () => void;
}

const GrimmLinkForm: React.FC<GrimmLinkFormProps> = ({ onBack }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const [serverUrl, setServerUrl] = useState(settings.grimmlink.serverUrl);
  const [fallbackUrl, setFallbackUrl] = useState(settings.grimmlink.fallbackUrl ?? '');
  const [username, setUsername] = useState(settings.grimmlink.username);
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState(settings.grimmlink.deviceName || 'Readest');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionFeedback, setConnectionFeedback] = useState<{
    kind: 'success' | 'error';
    title: string;
    message: string;
  } | null>(null);
  const isLanServer = isLanAddress(serverUrl);
  const isConfigured = Boolean(settings.grimmlink.enabled && settings.grimmlink.userkey);

  useEffect(() => {
    setDeviceName(settings.grimmlink.deviceName || 'Readest');
  }, [settings.grimmlink.deviceName]);

  const saveGrimmLink = async (patch: Partial<typeof settings.grimmlink>) => {
    const grimmlink = { ...settings.grimmlink, ...patch };
    const next = { ...settings, grimmlink };
    setSettings(next);
    await saveSettings(envConfig, next);
  };

  const connect = async () => {
    setIsConnecting(true);
    setConnectionFeedback(null);
    const grimmlink = {
      ...settings.grimmlink,
      enabled: true,
      serverUrl,
      fallbackUrl: fallbackUrl || undefined,
      allowSelfSignedCertificate: isLanServer
        ? settings.grimmlink.allowSelfSignedCertificate === true
        : false,
      username,
      userkey: md5(password),
      deviceName: deviceName.trim() || 'Readest',
    };
    try {
      const result = await new GrimmLinkClient(grimmlink).connect();
      if (result.success) {
        const next = { ...settings, grimmlink };
        setSettings(next);
        await saveSettings(envConfig, next);
        setConnectionFeedback({
          kind: 'success',
          title: _('Connected'),
          message: _('Your GrimmLink settings were verified and saved.'),
        });
        eventDispatcher.dispatch('toast', { message: _('Connected'), type: 'info' });
      } else {
        const category =
          result.errorCategory === 'auth'
            ? _('Authentication failed')
            : result.errorCategory === 'network'
              ? _('Network error')
              : result.errorCategory === 'server'
                ? _('Server error')
                : result.errorCategory === 'conflict'
                  ? _('Conflict')
                  : result.errorCategory === 'invalid-data'
                    ? _('Invalid data')
                    : _('Connection error');
        const message = _(result.message || 'Connection error');
        setConnectionFeedback({ kind: 'error', title: category, message });
        eventDispatcher.dispatch('toast', {
          message: `${_('Failed to connect')}${result.errorCategory ? ` [${result.errorCategory}]` : ''}: ${message}`,
          type: 'error',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : _('Connection error');
      setConnectionFeedback({ kind: 'error', title: _('Connection error'), message });
      eventDispatcher.dispatch('toast', {
        message: `${_('Failed to connect')}: ${message}`,
        type: 'error',
      });
    } finally {
      setPassword('');
      setIsConnecting(false);
    }
  };

  return (
    <div className='w-full'>
      <SubPageHeader
        parentLabel={_('Integrations')}
        currentLabel={_('GrimmLink')}
        description={_('Connect Readest to Grimmory and choose what stays in sync')}
        onBack={onBack}
      />
      <form
        className='space-y-4'
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <section className='space-y-2'>
          <div className='flex items-center justify-between gap-3'>
            <SectionTitle>{_('Connection')}</SectionTitle>
            {isConfigured && (
              <span className='badge badge-outline gap-1 text-xs'>
                <MdCheckCircle aria-hidden='true' className='h-3.5 w-3.5' />
                {_('Configured')}
              </span>
            )}
          </div>
          <div className='card eink-bordered border-base-200 bg-base-100 space-y-4 border p-4'>
            <Field
              label={_('Server URL')}
              id='grimmlink-server-url'
              value={serverUrl}
              onChange={setServerUrl}
            />
            <Field
              label={_('Fallback URL (optional)')}
              id='grimmlink-fallback-url'
              value={fallbackUrl}
              onChange={setFallbackUrl}
            />
            <div className='grid gap-4 sm:grid-cols-2'>
              <Field
                label={_('Username')}
                id='grimmlink-username'
                value={username}
                onChange={setUsername}
              />
              <Field
                label={_('Password')}
                id='grimmlink-password'
                value={password}
                onChange={setPassword}
                type='password'
              />
            </div>
            {connectionFeedback && (
              <div
                role={connectionFeedback.kind === 'error' ? 'alert' : 'status'}
                aria-live='polite'
                className={clsx(
                  'eink-bordered flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm',
                  connectionFeedback.kind === 'error'
                    ? 'border-error/40 bg-error/10'
                    : 'border-base-300 bg-base-200/40',
                )}
              >
                {connectionFeedback.kind === 'error' ? (
                  <MdErrorOutline
                    aria-hidden='true'
                    className='text-error mt-0.5 h-5 w-5 shrink-0'
                  />
                ) : (
                  <MdCheckCircle aria-hidden='true' className='mt-0.5 h-5 w-5 shrink-0' />
                )}
                <div className='min-w-0'>
                  <div className='font-medium'>{connectionFeedback.title}</div>
                  <div className='break-words text-[0.9em]'>{connectionFeedback.message}</div>
                </div>
              </div>
            )}
            <div className='flex flex-col gap-2 border-t border-base-200 pt-4 sm:flex-row sm:items-center sm:justify-between'>
              <div className='text-base-content/70 flex min-w-0 items-center gap-2 text-xs'>
                <MdLink aria-hidden='true' className='h-4 w-4 shrink-0' />
                <span className='truncate'>{serverUrl || _('Enter your Grimmory server URL')}</span>
              </div>
              <button
                type='submit'
                disabled={isConnecting || !serverUrl || !username || !password}
                className={clsx(
                  'btn btn-contrast h-11 min-h-11 rounded-lg px-5 text-sm sm:shrink-0',
                  isConnecting && 'opacity-60',
                )}
              >
                {isConnecting ? (
                  <>
                    <span className='loading loading-spinner loading-sm' />
                    {_('Connecting…')}
                  </>
                ) : isConfigured ? (
                  _('Update connection')
                ) : (
                  _('Connect')
                )}
              </button>
            </div>
          </div>
        </section>
        {isLanServer && (
          <section className='space-y-2'>
            <SectionTitle>{_('LAN security')}</SectionTitle>
            <div className='card eink-bordered border-base-200 bg-base-100 overflow-hidden border'>
              <SettingsSwitchRow
                label={_('Allow self-signed certificate')}
                checked={settings.grimmlink.allowSelfSignedCertificate === true}
                onChange={() =>
                  void saveGrimmLink({
                    allowSelfSignedCertificate: !settings.grimmlink.allowSelfSignedCertificate,
                  })
                }
              />
            </div>
            <Tips>
              <li>
                {_(
                  'Only applies to LAN addresses. Public and Cloudflare Tunnel connections always verify TLS certificates.',
                )}
              </li>
            </Tips>
          </section>
        )}
        <Tips>
          <li>
            {_(
              'Your password is used only to create the GrimmLink credential for this connection.',
            )}
          </li>
        </Tips>
        {settings.grimmlink.enabled && settings.grimmlink.userkey && (
          <section className='space-y-2'>
            <SectionTitle>{_('Device identity')}</SectionTitle>
            <div className='card eink-bordered border-base-200 bg-base-100 space-y-3 border p-4'>
              <Field
                label={_('Device name')}
                id='grimmlink-device-name'
                value={deviceName}
                onChange={setDeviceName}
                onBlur={() => void saveGrimmLink({ deviceName: deviceName.trim() || 'Readest' })}
              />
              <div className='space-y-1.5'>
                <SectionTitle as='label' htmlFor='grimmlink-device-id' className='block'>
                  {_('Device ID')}
                </SectionTitle>
                <input
                  id='grimmlink-device-id'
                  className='input input-bordered eink-bordered h-11 w-full text-sm opacity-70'
                  value={settings.grimmlink.deviceId || _('Not assigned yet')}
                  readOnly
                />
              </div>
              <Tips>
                <li>
                  {_(
                    'The device ID is stable across restarts and is used for progress, sessions, and conflicts.',
                  )}
                </li>
              </Tips>
            </div>
          </section>
        )}
        {settings.grimmlink.enabled && settings.grimmlink.userkey && (
          <section className='space-y-2'>
            <SectionTitle>{_('Sync Options')}</SectionTitle>
            <div className='card eink-bordered border-base-200 bg-base-100 overflow-hidden border'>
              <div className='divide-base-200 divide-y'>
                <div className='flex min-h-14 items-center justify-between gap-3 px-4'>
                  <SettingLabel>{_('Sync Strategy')}</SettingLabel>
                  <SettingsSelect
                    value={settings.grimmlink.strategy}
                    onChange={(event) =>
                      void saveGrimmLink({ strategy: event.target.value as KOSyncStrategy })
                    }
                    ariaLabel={_('Sync Strategy')}
                    options={[
                      { value: 'prompt', label: _('Ask on conflict') },
                      { value: 'silent', label: _('Always use latest') },
                      { value: 'send', label: _('Send only') },
                      { value: 'receive', label: _('Receive only') },
                    ]}
                  />
                </div>
                <SettingsSwitchRow
                  label={_('Sync Reading Progress')}
                  checked={settings.grimmlink.syncProgress}
                  onChange={() =>
                    void saveGrimmLink({ syncProgress: !settings.grimmlink.syncProgress })
                  }
                />
                <SettingsSwitchRow
                  label={_('Sync Highlights, Bookmarks, and Ratings')}
                  checked={settings.grimmlink.syncMetadata}
                  onChange={() =>
                    void saveGrimmLink({ syncMetadata: !settings.grimmlink.syncMetadata })
                  }
                />
                <SettingsSwitchRow
                  label={_('Sync Reading Sessions')}
                  checked={settings.grimmlink.syncSessions}
                  onChange={() =>
                    void saveGrimmLink({ syncSessions: !settings.grimmlink.syncSessions })
                  }
                />
                <SettingsSwitchRow
                  label={_('Sync Reading Status')}
                  checked={settings.grimmlink.syncReadStatus}
                  onChange={() =>
                    void saveGrimmLink({ syncReadStatus: !settings.grimmlink.syncReadStatus })
                  }
                />
              </div>
            </div>
          </section>
        )}
        <GrimmLinkShelfPanel />
        <GrimmLinkDiagnosticsPanel />
      </form>
    </div>
  );
};

const Field = ({
  label,
  id,
  value,
  onChange,
  onBlur,
  type = 'text',
}: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  type?: 'text' | 'password';
}) => (
  <div className='space-y-1.5'>
    <SectionTitle as='label' htmlFor={id} className='block'>
      {label}
    </SectionTitle>
    <input
      id={id}
      type={type}
      className={clsx(
        'input input-bordered eink-bordered h-11 w-full text-sm',
        'focus-visible:ring-base-content/20 focus-visible:outline-hidden focus-visible:ring-2',
      )}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      autoComplete={type === 'password' ? 'current-password' : undefined}
    />
  </div>
);

export default GrimmLinkForm;
