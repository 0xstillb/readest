import clsx from 'clsx';
import { md5 } from 'js-md5';
import React, { useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { GrimmLinkClient } from '@/services/grimmlink/GrimmLinkClient';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import SubPageHeader from '../SubPageHeader';
import { SectionTitle, Tips } from '../primitives';
import GrimmLinkShelfPanel from './GrimmLinkShelfPanel';

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
  const [isConnecting, setIsConnecting] = useState(false);

  const connect = async () => {
    setIsConnecting(true);
    const grimmlink = {
      ...settings.grimmlink,
      enabled: true,
      serverUrl,
      fallbackUrl: fallbackUrl || undefined,
      username,
      userkey: md5(password),
    };
    const result = await new GrimmLinkClient(grimmlink).connect();
    if (result.success) {
      const next = { ...settings, grimmlink };
      setSettings(next);
      await saveSettings(envConfig, next);
      eventDispatcher.dispatch('toast', { message: _('Connected'), type: 'info' });
    } else {
      eventDispatcher.dispatch('toast', {
        message: `${_('Failed to connect')}: ${_(result.message || 'Connection error')}`,
        type: 'error',
      });
    }
    setPassword('');
    setIsConnecting(false);
  };

  return (
    <div className='w-full'>
      <SubPageHeader
        parentLabel={_('Integrations')}
        currentLabel={_('GrimmLink')}
        description={_('Connect Readest to a Grimmory server. Sync stays off until enabled later.')}
        onBack={onBack}
      />
      <form
        className='space-y-4'
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <Field label={_('Server URL')} id='grimmlink-server-url' value={serverUrl} onChange={setServerUrl} />
        <Field
          label={_('Fallback URL (optional)')}
          id='grimmlink-fallback-url'
          value={fallbackUrl}
          onChange={setFallbackUrl}
        />
        <Field label={_('Username')} id='grimmlink-username' value={username} onChange={setUsername} />
        <Field label={_('Password')} id='grimmlink-password' value={password} onChange={setPassword} type='password' />
        <Tips>
          <li>{_('Your password is used only to create the GrimmLink credential for this connection.')}</li>
        </Tips>
        <GrimmLinkShelfPanel />
        <div className='flex justify-end pt-1'>
          <button
            type='submit'
            disabled={isConnecting || !serverUrl || !username || !password}
            className={clsx('btn btn-primary h-10 min-h-10 rounded-lg px-5 text-sm', isConnecting && 'opacity-60')}
          >
            {isConnecting ? <span className='loading loading-spinner loading-sm' /> : _('Test connection')}
          </button>
        </div>
      </form>
    </div>
  );
};

const Field = ({
  label,
  id,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
}) => (
  <div className='space-y-1.5'>
    <SectionTitle as='label' htmlFor={id} className='block'>
      {label}
    </SectionTitle>
    <input
      id={id}
      type={type}
      className='input input-bordered eink-bordered h-11 w-full text-sm focus:outline-none'
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoComplete={type === 'password' ? 'current-password' : undefined}
    />
  </div>
);

export default GrimmLinkForm;
