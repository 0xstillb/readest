import { describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import {
  GrimmLinkProgressProvider,
  normalizeGrimmLinkProgressPayload,
  progressPullDisposition,
  toGrimmLinkProgressPayload,
} from '@/services/grimmlink/progress';

const epub = { hash: 'epub-hash', format: 'EPUB', title: 'Epub', author: 'A' } as Book;
const pdf = { hash: 'pdf-hash', format: 'PDF', title: 'Pdf', author: 'A' } as Book;

const link = { bookHash: 'epub-hash', bookId: 42, bookFileId: 9, format: 'EPUB' };

describe('GrimmLink progress', () => {
  it('does not replay a legacy EPUB XPointer as a CFI', () => {
    const normalized = normalizeGrimmLinkProgressPayload({
      document: 'legacy-epub-hash',
      fileFormat: 'EPUB',
      percentage: 37,
      location: '/body/DocFragment[4]/body/p/text().12',
    });

    expect(normalized).toMatchObject({
      bookHash: 'legacy-epub-hash',
      fraction: 0.37,
      position: { format: 'epub' },
    });
    expect(normalized?.position.cfi).toBeUndefined();
  });
  it('caches a hash match and does not match it again', async () => {
    const links = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), markUnmatched: vi.fn() };
    const client = {
      matchBook: vi.fn().mockResolvedValue(link),
      getProgress: vi.fn(),
      updateProgress: vi.fn(),
    };
    const provider = new GrimmLinkProgressProvider(client, links, {
      deviceId: 'device-1',
      deviceName: 'Readest Test',
      strategy: 'prompt',
    });

    await provider.resolveLink(epub);
    links.get.mockResolvedValue(link);
    await provider.resolveLink(epub);

    expect(client.matchBook).toHaveBeenCalledTimes(1);
    expect(links.set).toHaveBeenCalledWith(link);
  });

  it('caches an unmatched book without retrying on subsequent reader events', async () => {
    const unmatched = { bookHash: epub.hash, unmatchedAt: Date.now() };
    const links = {
      get: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(unmatched),
      set: vi.fn(),
      markUnmatched: vi.fn(),
    };
    const client = {
      matchBook: vi.fn().mockResolvedValue(null),
      getProgress: vi.fn(),
      updateProgress: vi.fn(),
    };
    const provider = new GrimmLinkProgressProvider(client, links, {
      deviceId: 'device-1',
      deviceName: 'Readest Test',
      strategy: 'prompt',
    });

    await expect(provider.resolveLink(epub)).resolves.toBeNull();
    await expect(provider.resolveLink(epub)).resolves.toBeNull();

    expect(client.matchBook).toHaveBeenCalledTimes(1);
    expect(links.markUnmatched).toHaveBeenCalledWith(epub.hash);
  });

  it('retries an unmatched hash only when the user explicitly asks to pull again', async () => {
    const unmatched = { bookHash: epub.hash, unmatchedAt: Date.now() };
    const links = {
      get: vi.fn().mockResolvedValue(unmatched),
      set: vi.fn(),
      markUnmatched: vi.fn(),
    };
    const client = {
      matchBook: vi.fn().mockResolvedValue(link),
      getProgress: vi.fn(),
      updateProgress: vi.fn(),
    };
    const provider = new GrimmLinkProgressProvider(client, links, {
      deviceId: 'device-1',
      deviceName: 'Readest Test',
      strategy: 'prompt',
    });

    await provider.resolveLink(epub, true);

    expect(client.matchBook).toHaveBeenCalledWith(epub.hash);
  });

  it('uses the persisted Grimmory identity for a shelf-imported book', async () => {
    const shelfLink = { bookHash: 'grimory-hash', bookId: 77 };
    const links = { get: vi.fn(), set: vi.fn(), markUnmatched: vi.fn() };
    const client = {
      matchBook: vi.fn(),
      getProgress: vi.fn().mockResolvedValue({ percentage: 40 }),
      updateProgress: vi.fn(),
    };
    const provider = new GrimmLinkProgressProvider(
      client,
      links,
      {
        deviceId: 'device-1',
        deviceName: 'Readest Test',
        strategy: 'prompt',
      },
      { getShelfEntryByLocalPath: vi.fn().mockResolvedValue(shelfLink) },
    );

    await expect(provider.resolveLink(epub)).resolves.toMatchObject(shelfLink);
    await expect(provider.pull(epub)).resolves.toEqual({ percentage: 40 });

    expect(client.matchBook).not.toHaveBeenCalled();
    expect(client.getProgress).toHaveBeenCalledWith('grimory-hash');
    expect(
      toGrimmLinkProgressPayload(
        epub,
        { ...shelfLink, format: 'EPUB' },
        {
          location: '/body/DocFragment[2]',
          fraction: 0.5,
        },
        { deviceId: 'device-1', deviceName: 'Readest Test' },
      ),
    ).toMatchObject({
      bookHash: 'grimory-hash',
      source: 'readest',
      fraction: 0.5,
      position: { format: 'epub', cfi: '/body/DocFragment[2]' },
    });
  });

  it('serializes the reader-native CFI as an Adapter v2 position', () => {
    expect(
      toGrimmLinkProgressPayload(
        epub,
        link,
        {
          location: 'epubcfi(/6/4!/4/2/4)',
          fraction: 0.25,
        },
        { deviceId: 'device-1', deviceName: 'Readest Test' },
      ),
    ).toMatchObject({
      bookHash: 'epub-hash',
      source: 'readest',
      fraction: 0.25,
      device: { id: 'device-1', name: 'Readest Test' },
      position: { format: 'epub', cfi: 'epubcfi(/6/4!/4/2/4)' },
    });
  });

  it('serializes fixed-page payloads with a 1-indexed page and its ratio', () => {
    expect(
      toGrimmLinkProgressPayload(
        pdf,
        { ...link, bookHash: pdf.hash, format: 'PDF' },
        {
          currentPage: 9,
          totalPages: 100,
        },
        { deviceId: 'device-1', deviceName: 'Readest Test' },
      ),
    ).toMatchObject({
      source: 'readest',
      fraction: 0.1,
      position: { format: 'pdf', page: 10, totalPages: 100 },
    });
  });

  it('never invents a page for a fixed-layout book that has no position yet', () => {
    // Adapter v2 rejects `totalPages` below 1 and reads `page` as the
    // 1-indexed location, so a made-up page 1 would move the remote
    // progress to the first page instead of leaving it alone.
    const payload = toGrimmLinkProgressPayload(
      pdf,
      { ...link, bookHash: pdf.hash, format: 'PDF' },
      { currentPage: undefined, totalPages: undefined },
      { deviceId: 'device-1', deviceName: 'Readest Test' },
    );

    expect(payload.position.page).toBeUndefined();
    expect(payload.position.totalPages).toBeUndefined();
    expect(payload.fraction).toBe(0);
  });

  it('omits a page total the Adapter would reject', () => {
    const payload = toGrimmLinkProgressPayload(
      pdf,
      { ...link, bookHash: pdf.hash, format: 'PDF' },
      { currentPage: 0, totalPages: 0 },
      { deviceId: 'device-1', deviceName: 'Readest Test' },
    );

    expect(payload.position.totalPages).toBeUndefined();
    expect(payload.fraction).toBe(0);
  });

  it.each([
    ['prompt', 'prompt'],
    ['silent', 'apply'],
    ['send', 'ignore'],
    ['receive', 'apply'],
  ] as const)('uses the %s pull strategy', (strategy, expected) => {
    expect(progressPullDisposition(strategy, true)).toBe(expected);
  });

  it('never silently applies a remote conflict in prompt mode', () => {
    expect(progressPullDisposition('prompt', true)).toBe('prompt');
    expect(progressPullDisposition('silent', false)).toBe('ignore');
  });

  it('does not reopen a prompt for an older or equal remote acknowledgement', () => {
    expect(progressPullDisposition('prompt', false)).toBe('ignore');
  });

  it('does not reopen a conflict for the originating device acknowledgement', () => {
    expect(progressPullDisposition('prompt', true, 'device-a', 'device-a')).toBe('ignore');
    expect(progressPullDisposition('prompt', true, 'device-b', 'device-a')).toBe('prompt');
    expect(progressPullDisposition('prompt', true, undefined, 'device-a')).toBe('prompt');
  });
});
