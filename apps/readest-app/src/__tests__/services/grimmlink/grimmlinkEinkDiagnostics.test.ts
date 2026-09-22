import { describe, expect, it } from 'vitest';
import { collectGrimmLinkRuntimeDiagnostics } from '@/services/grimmlink/einkDiagnostics';

describe('GrimmLink e-ink diagnostics', () => {
  it('exports runtime dimensions without credentials or content', () => {
    const result = collectGrimmLinkRuntimeDiagnostics();
    expect(result.viewport.width).toBeTypeOf('number');
    expect(result.viewport.height).toBeTypeOf('number');
    expect(result).not.toHaveProperty('userkey');
    expect(result).not.toHaveProperty('bookContent');
  });
});
