import { describe, expect, it, vi } from 'vitest';
import { planShelfSync, mayRemoveManagedCopy } from '@/services/grimmlink/shelfSync';
import { validateShelfDownload } from '@/services/grimmlink/download';
import { GrimmLinkOutbox } from '@/services/grimmlink/outbox';

describe('GrimmLink shelf sync safety', () => {
  it('reuses a local hash and downloads only missing remote shelf books', () => {
    expect(planShelfSync([
      { bookId: 1, bookHash: 'already-local', filename: 'one.epub', format: 'EPUB' },
      { bookId: 2, bookHash: 'missing', filename: 'two.epub', format: 'EPUB' },
    ], [], new Set(['already-local']))).toEqual({
      reuse: [1], download: [{ bookId: 2, bookHash: 'missing', filename: 'two.epub', format: 'EPUB' }], absent: [],
    });
  });

  it('allows cleanup only for a tracked provider-managed file inside the managed root', () => {
    expect(mayRemoveManagedCopy({ managedByGrimmLink: true, localPath: 'grimmlink/book.epub' }, 'grimmlink')).toBe(true);
    expect(mayRemoveManagedCopy({ managedByGrimmLink: false, localPath: 'grimmlink/book.epub' }, 'grimmlink')).toBe(false);
    expect(mayRemoveManagedCopy({ managedByGrimmLink: true, localPath: '../user/book.epub' }, 'grimmlink')).toBe(false);
  });

  it('rejects corrupt downloads before import', () => {
    expect(() => validateShelfDownload('book.epub', new Uint8Array([1, 2, 3]).buffer)).toThrow('Invalid EPUB');
    expect(() => validateShelfDownload('book.pdf', new TextEncoder().encode('%PDF-1.7').buffer)).not.toThrow();
    expect(() => validateShelfDownload('book.pdf', new TextEncoder().encode('%PDF-1.7').buffer, 1)).toThrow('Unexpected download size');
  });

  it('replays only an explicitly queued remote shelf-membership removal', async () => {
    const removeShelfMembership = vi.fn().mockResolvedValue({ ok: true });
    const store = {
      isPaused: vi.fn().mockResolvedValue(false),
      ready: vi.fn()
        .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'remove-1', category: 'shelf-removal', payload: { shelfType: 'magic', shelfId: 2, bookId: 8 }, attempts: 0 }]),
      remove: vi.fn(),
    };
    await new GrimmLinkOutbox(store as never, { removeShelfMembership }).replay();
    expect(removeShelfMembership).toHaveBeenCalledWith('magic', 2, 8);
    expect(store.remove).toHaveBeenCalledWith(['remove-1']);
  });
});
