import { describe, expect, it } from 'vitest';
import { deriveGrimmLinkLibraryStatus } from '@/services/grimmlink/libraryStatus';

const base = {
  mapping: true,
  localFilePresent: true,
  managedDownload: false,
  pending: false,
  conflict: false,
  error: false,
};

describe('deriveGrimmLinkLibraryStatus', () => {
  it.each([
    ['synced', base],
    ['downloaded', { ...base, managedDownload: true }],
    ['pending', { ...base, pending: true }],
    ['remote-only', { ...base, localFilePresent: false }],
    ['conflict', { ...base, conflict: true }],
    ['error', { ...base, error: true }],
  ] as const)('derives %s', (expected, input) => {
    expect(deriveGrimmLinkLibraryStatus(input)).toBe(expected);
  });

  it('does not show a GrimmLink badge for unrelated local books', () => {
    expect(deriveGrimmLinkLibraryStatus({ ...base, mapping: false })).toBeNull();
  });
});
