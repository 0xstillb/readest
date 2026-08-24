import { describe, expect, it } from 'vitest';
import { DEFAULT_GRIMMLINK_SETTINGS, DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { SETTINGS_ENCRYPTED_FIELDS, SETTINGS_WHITELIST } from '@/services/sync/adapters/settings';

describe('GrimmLink settings', () => {
  it('is disabled by default with no sync category enabled', () => {
    expect(DEFAULT_GRIMMLINK_SETTINGS).toMatchObject({
      enabled: false,
      serverUrl: '',
      strategy: 'prompt',
      syncProgress: false,
      syncMetadata: false,
      syncSessions: false,
      syncReadStatus: false,
    });
    expect(DEFAULT_SYSTEM_SETTINGS.grimmlink).toEqual(DEFAULT_GRIMMLINK_SETTINGS);
  });

  it('replicates connection credentials through encrypted paths only', () => {
    for (const field of [
      'grimmlink.serverUrl',
      'grimmlink.fallbackUrl',
      'grimmlink.username',
      'grimmlink.userkey',
      'grimmlink.customHeaders',
    ]) {
      expect(SETTINGS_WHITELIST).toContain(field);
    }
    for (const field of [
      'grimmlink.username',
      'grimmlink.userkey',
      'grimmlink.customHeaders',
    ]) {
      expect(SETTINGS_ENCRYPTED_FIELDS).toContain(field);
    }
    for (const field of ['grimmlink.enabled', 'grimmlink.deviceId', 'grimmlink.deviceName']) {
      expect(SETTINGS_WHITELIST).not.toContain(field);
    }
  });
});
