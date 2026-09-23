import { describe, expect, it } from 'vitest';
import {
  collectGrimmLinkRuntimeDiagnostics,
  recordGrimmLinkPerformance,
  redactGrimmLinkDiagnosticSecrets,
  startGrimmLinkRuntimeDiagnostics,
} from '@/services/grimmlink/einkDiagnostics';

describe('GrimmLink e-ink diagnostics', () => {
  it('exports runtime dimensions without credentials or content', () => {
    const result = collectGrimmLinkRuntimeDiagnostics();
    expect(result.viewport.width).toBeTypeOf('number');
    expect(result.viewport.height).toBeTypeOf('number');
    expect(result).not.toHaveProperty('userkey');
    expect(result).not.toHaveProperty('bookContent');
  });

  it('captures aggregate performance counters only while diagnostics is open', () => {
    recordGrimmLinkPerformance('dbOpens');
    expect(collectGrimmLinkRuntimeDiagnostics().performance.dbOpens).toBe(0);

    const stop = startGrimmLinkRuntimeDiagnostics();
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'private-password' }));
      recordGrimmLinkPerformance('dbOpens', 2);
      recordGrimmLinkPerformance('networkRequests');
      const diagnostics = collectGrimmLinkRuntimeDiagnostics();
      expect(diagnostics.performance).toMatchObject({
        dbOpens: 2,
        networkRequests: 1,
      });
      expect(diagnostics).not.toHaveProperty('userkey');
      expect(JSON.stringify(diagnostics)).not.toContain('private-password');
    } finally {
      stop?.();
    }

    recordGrimmLinkPerformance('dbOpens');
    expect(collectGrimmLinkRuntimeDiagnostics().performance.dbOpens).toBe(2);
  });

  it('redacts connection credentials and custom header values from diagnostics text', () => {
    const output = redactGrimmLinkDiagnosticSecrets(
      'Auth failed for user secret-user with key abcdef0123456789abcdef0123456789 and header secret-header',
      ['secret-user', 'secret-header'],
    );

    expect(output).not.toContain('secret-user');
    expect(output).not.toContain('secret-header');
    expect(output).not.toContain('abcdef0123456789abcdef0123456789');
    expect(output.match(/\[redacted\]/g)).toHaveLength(3);
  });
});
