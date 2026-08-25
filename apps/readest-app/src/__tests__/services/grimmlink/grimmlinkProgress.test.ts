import { describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import {
  GrimmLinkProgressProvider,
  progressPullDisposition,
  toGrimmLinkProgressPayload,
} from '@/services/grimmlink/progress';

const epub = { hash: 'epub-hash', format: 'EPUB', title: 'Epub', author: 'A' } as Book;
const pdf = { hash: 'pdf-hash', format: 'PDF', title: 'Pdf', author: 'A' } as Book;

const link = { bookHash: 'epub-hash', bookId: 42, bookFileId: 9, format: 'EPUB' };

describe('GrimmLink progress', () => {
  it('caches a hash match and does not match it again', async () => {
    const links = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), markUnmatched: vi.fn() };
    const client = { matchBook: vi.fn().mockResolvedValue(link), getProgress: vi.fn(), updateProgress: vi.fn() };
    const provider = new GrimmLinkProgressProvider(client, links, {
      deviceId: 'device-1', deviceName: 'Readest Test', strategy: 'prompt',
    });

    await provider.resolveLink(epub);
    links.get.mockResolvedValue(link);
    await provider.resolveLink(epub);

    expect(client.matchBook).toHaveBeenCalledTimes(1);
    expect(links.set).toHaveBeenCalledWith(link);
  });

  it('caches an unmatched book without retrying on subsequent reader events', async () => {
    const unmatched = { bookHash: epub.hash, unmatchedAt: Date.now() };
    const links = { get: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(unmatched), set: vi.fn(), markUnmatched: vi.fn() };
    const client = { matchBook: vi.fn().mockResolvedValue(null), getProgress: vi.fn(), updateProgress: vi.fn() };
    const provider = new GrimmLinkProgressProvider(client, links, {
      deviceId: 'device-1', deviceName: 'Readest Test', strategy: 'prompt',
    });

    await expect(provider.resolveLink(epub)).resolves.toBeNull();
    await expect(provider.resolveLink(epub)).resolves.toBeNull();

    expect(client.matchBook).toHaveBeenCalledTimes(1);
    expect(links.markUnmatched).toHaveBeenCalledWith(epub.hash);
  });

  it('retries an unmatched hash only when the user explicitly asks to pull again', async () => {
    const unmatched = { bookHash: epub.hash, unmatchedAt: Date.now() };
    const links = { get: vi.fn().mockResolvedValue(unmatched), set: vi.fn(), markUnmatched: vi.fn() };
    const client = { matchBook: vi.fn().mockResolvedValue(link), getProgress: vi.fn(), updateProgress: vi.fn() };
    const provider = new GrimmLinkProgressProvider(client, links, {
      deviceId: 'device-1', deviceName: 'Readest Test', strategy: 'prompt',
    });

    await provider.resolveLink(epub, true);

    expect(client.matchBook).toHaveBeenCalledWith(epub.hash);
  });

  it('uses the persisted Grimmory identity for a shelf-imported book', async () => {
    const shelfLink = { bookHash: 'grimory-hash', bookId: 77 };
    const links = { get: vi.fn(), set: vi.fn(), markUnmatched: vi.fn() };
    const client = { matchBook: vi.fn(), getProgress: vi.fn().mockResolvedValue({ percentage: 40 }), updateProgress: vi.fn() };
    const provider = new GrimmLinkProgressProvider(client, links, {
      deviceId: 'device-1', deviceName: 'Readest Test', strategy: 'prompt',
    }, { getShelfEntryByLocalPath: vi.fn().mockResolvedValue(shelfLink) });

    await expect(provider.resolveLink(epub)).resolves.toMatchObject(shelfLink);
    await expect(provider.pull(epub)).resolves.toEqual({ percentage: 40 });

    expect(client.matchBook).not.toHaveBeenCalled();
    expect(client.getProgress).toHaveBeenCalledWith('grimory-hash');
    expect(toGrimmLinkProgressPayload(epub, { ...shelfLink, format: 'EPUB' }, {
      location: '/body/DocFragment[2]', fraction: 0.5,
    }, { deviceId: 'device-1', deviceName: 'Readest Test' })).toMatchObject({
      bookHash: 'grimory-hash', document: 'grimory-hash', bookId: 77,
    });
  });

  it('serializes reflowable locations as XPointer-compatible progress', () => {
    expect(toGrimmLinkProgressPayload(epub, link, {
      location: '/body/DocFragment[4]/body/p/text().12', fraction: 0.25,
    }, { deviceId: 'device-1', deviceName: 'Readest Test' })).toMatchObject({
      bookHash: 'epub-hash', bookId: 42, bookFileId: 9, fileFormat: 'EPUB',
      progress: '/body/DocFragment[4]/body/p/text().12', location: '/body/DocFragment[4]/body/p/text().12',
      percentage: 25, device: 'Readest Test', device_id: 'device-1',
    });
  });

  it('serializes fixed-page payloads with page, total, and server percentage', () => {
    expect(toGrimmLinkProgressPayload(pdf, { ...link, bookHash: pdf.hash, format: 'PDF' }, {
      currentPage: 9, totalPages: 100,
    }, { deviceId: 'device-1', deviceName: 'Readest Test' })).toMatchObject({
      fileFormat: 'PDF', progress: '9', currentPage: 9, totalPages: 100, percentage: 10,
    });
  });

  it.each([
    ['prompt', 'prompt'], ['silent', 'apply'], ['send', 'ignore'], ['receive', 'apply'],
  ] as const)('uses the %s pull strategy', (strategy, expected) => {
    expect(progressPullDisposition(strategy, true)).toBe(expected);
  });

  it('never silently applies a remote conflict in prompt mode', () => {
    expect(progressPullDisposition('prompt', true)).toBe('prompt');
    expect(progressPullDisposition('silent', false)).toBe('ignore');
  });
});
