import { describe, expect, it } from 'vitest';
import { resolveEinkMode } from '@/hooks/useEinkMode';

describe('resolveEinkMode', () => {
  it('keeps legacy/platform detection in auto mode', () => {
    expect(resolveEinkMode('auto', true, false)).toBe(true);
    expect(resolveEinkMode('auto', false, true)).toBe(true);
    expect(resolveEinkMode('auto', false, false)).toBe(false);
  });

  it('gives explicit overrides priority', () => {
    expect(resolveEinkMode('on', false, false)).toBe(true);
    expect(resolveEinkMode('off', true, true)).toBe(false);
  });
});
