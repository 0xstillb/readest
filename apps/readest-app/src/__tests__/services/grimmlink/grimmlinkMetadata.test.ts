import { describe, expect, it, vi } from 'vitest';
import type { BookNote } from '@/types/book';
import {
  fromGrimmLinkMetadataNote,
  stableMetadataDedupeKey,
  toGrimmLinkMetadataNote,
} from '@/services/grimmlink/metadata';
import { GrimmLinkMetadataProvider } from '@/services/grimmlink/metadataProvider';
import { GrimmLinkRatingProvider } from '@/services/grimmlink/rating';

const annotation: BookNote = {
  id: 'note-1',
  type: 'annotation',
  cfi: 'epubcfi(/6/4!/4/2)',
  xpointer0: '/body/p[1]',
  xpointer1: '/body/p[2]',
  text: 'A quote',
  note: 'A note',
  color: 'yellow',
  style: 'highlight',
  page: 3,
  createdAt: 100,
  updatedAt: 200,
};

const bookmark: BookNote = {
  id: 'bookmark-1',
  type: 'bookmark',
  cfi: 'epubcfi(/6/4!/4/2)',
  text: 'Chapter 2',
  note: '',
  page: 4,
  createdAt: 100,
  updatedAt: 200,
};

describe('GrimmLink metadata mapping', () => {
  it('serializes annotations with a stable retry-safe key and CFI/XPointer location', () => {
    const first = toGrimmLinkMetadataNote(annotation, 'connection-a', 'book-a');
    expect(first).toMatchObject({
      dedupeKey: stableMetadataDedupeKey('connection-a', 'book-a', annotation),
      type: 'annotation',
      text: 'A quote',
      note: 'A note',
      location: {
        cfi: annotation.cfi,
        pos0: annotation.xpointer0,
        pos1: annotation.xpointer1,
        pageno: 3,
      },
    });
    expect(toGrimmLinkMetadataNote(annotation, 'connection-a', 'book-a')).toEqual(first);
  });

  it('keeps the local note on equal timestamps and turns a remote tombstone into deletedAt', () => {
    const local = { ...annotation, id: 'local-id', updatedAt: 500 };
    expect(
      fromGrimmLinkMetadataNote(
        {
          type: 'annotation',
          dedupeKey: 'remote-a',
          payload: {
            type: 'annotation',
            updatedAt: '1970-01-01T00:00:00.500Z',
            deleted: true,
          },
        },
        local,
        'local-id',
      ),
    ).toEqual(local);

    expect(
      fromGrimmLinkMetadataNote(
        {
          type: 'annotation',
          dedupeKey: 'remote-a',
          payload: {
            type: 'annotation',
            updatedAt: '1970-01-01T00:00:01.000Z',
            deleted: true,
          },
        },
        local,
        'local-id',
      ),
    ).toMatchObject({ id: 'local-id', deletedAt: 1000, updatedAt: 1000 });
  });

  it('does not advance a cursor when a page cannot be applied', async () => {
    const store = {
      connectionId: 'connection-a',
      getMetadataCursor: vi.fn().mockResolvedValue(null),
      getNoteMapping: vi.fn().mockResolvedValue(null),
      applyMetadataPage: vi.fn(),
    };
    const provider = new GrimmLinkMetadataProvider(
      {
        getMetadata: vi.fn().mockResolvedValue({
          items: [
            {
              type: 'annotation',
              dedupeKey: 'remote-a',
              payload: {
                type: 'annotation',
                text: 'Quote',
                note: '',
                updatedAt: '2026-08-23T00:00:01.000Z',
                location: { cfi: 'epubcfi(/6/4)' },
              },
            },
          ],
          nextCursor: 'next',
        }),
      },
      store as never,
      { capabilities: ['metadata'], device: 'Readest Test', deviceId: 'device-1' },
    );

    await expect(
      provider.pull('book-a', [], async () => {
        throw new Error('save failed');
      }),
    ).rejects.toThrow('save failed');
    expect(store.applyMetadataPage).not.toHaveBeenCalled();
  });

  it('records local dedupe mappings when queuing a push, preventing retry duplicates', async () => {
    const store = {
      connectionId: 'connection-a',
      enqueueMetadata: vi.fn(),
      applyMetadataPage: vi.fn(),
    };
    const provider = new GrimmLinkMetadataProvider({ getMetadata: vi.fn() }, store as never, {
      capabilities: ['metadata'],
      device: 'Readest Test',
      deviceId: 'device-1',
    });

    await provider.queuePush('book-a', 4, [annotation]);
    expect(store.applyMetadataPage).toHaveBeenCalledWith(
      'book-a',
      'annotation',
      [
        {
          noteId: 'note-1',
          dedupeKey: stableMetadataDedupeKey('connection-a', 'book-a', annotation),
        },
      ],
      null,
    );
  });

  it('queues a locally added bookmark with its CFI for Grimmory', async () => {
    const store = {
      connectionId: 'connection-a',
      enqueueMetadata: vi.fn(),
      applyMetadataPage: vi.fn(),
    };
    const provider = new GrimmLinkMetadataProvider({ getMetadata: vi.fn() }, store as never, {
      capabilities: ['metadata'],
      device: 'Readest Test',
      deviceId: 'device-1',
    });

    await expect(provider.queuePush('book-a', 4, [bookmark])).resolves.toBe(true);
    expect(store.enqueueMetadata).toHaveBeenCalledWith(
      'book-a',
      expect.objectContaining({
        bookmarks: [
          expect.objectContaining({
            type: 'bookmark',
            title: 'Chapter 2',
            location: expect.objectContaining({ cfi: bookmark.cfi, pageno: 4 }),
          }),
        ],
      }),
    );
  });

  it('pulls a Grimmory bookmark into Readest with its CFI anchor', async () => {
    const store = {
      connectionId: 'connection-a',
      getMetadataCursor: vi.fn().mockResolvedValue(null),
      getNoteMapping: vi.fn().mockResolvedValue(null),
      applyMetadataPage: vi.fn(),
    };
    const getMetadata = vi.fn(async (query: Record<string, string | number>) =>
      query['type'] === 'bookmark'
        ? {
            items: [
              {
                type: 'bookmark',
                dedupeKey: 'grimmory-bookmark-21',
                payload: {
                  type: 'bookmark',
                  title: 'From Grimmory',
                  notes: '',
                  createdAt: '2026-11-10T12:00:00Z',
                  updatedAt: '2026-11-10T12:00:01Z',
                  location: { cfi: 'epubcfi(/6/8!/4/2)', pageno: 8 },
                },
              },
            ],
            nextCursor: 'bookmark-checkpoint-2',
            hasMore: false,
          }
        : { items: [], nextCursor: 'annotation-checkpoint-1', hasMore: false },
    );
    const provider = new GrimmLinkMetadataProvider(
      {
        getMetadata,
      },
      store as never,
      { capabilities: ['metadata'], device: 'Readest Test', deviceId: 'device-1' },
    );

    const apply = vi.fn();
    await expect(provider.pull('book-a', [], apply)).resolves.toMatchObject([
      {
        id: 'grimmlink:bookmark:grimmory-bookmark-21',
        type: 'bookmark',
        cfi: 'epubcfi(/6/8!/4/2)',
        text: 'From Grimmory',
        page: 8,
      },
    ]);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(getMetadata.mock.calls.map(([query]) => query['type'])).toEqual([
      'annotation',
      'bookmark',
    ]);
  });

  it('imports a page-only Grimmory bookmark when the server omits its timestamp', async () => {
    const store = {
      connectionId: 'connection-a',
      getMetadataCursor: vi.fn().mockResolvedValue(null),
      getNoteMapping: vi.fn().mockResolvedValue(null),
      applyMetadataPage: vi.fn(),
    };
    const getMetadata = vi.fn(async (query: Record<string, string | number>) =>
      query['type'] === 'bookmark'
        ? {
            items: [
              {
                type: 'bookmark',
                dedupeKey: 'web-bookmark-without-cfi-or-time',
                updatedAt: null,
                payload: {
                  type: 'bookmark',
                  title: 'Page only bookmark',
                  page: 12,
                  cfi: null,
                  location: null,
                },
              },
            ],
            nextCursor: 'bookmark-checkpoint-no-time',
            hasMore: false,
          }
        : { items: [], nextCursor: 'annotation-checkpoint-no-time', hasMore: false },
    );
    const provider = new GrimmLinkMetadataProvider({ getMetadata }, store as never, {
      capabilities: ['metadata'],
      device: 'Readest Test',
      deviceId: 'device-1',
    });
    const onUnresolved = vi.fn();

    await expect(provider.pull('book-a', [], vi.fn(), onUnresolved, 'PDF')).resolves.toMatchObject([
      {
        id: 'grimmlink:bookmark:web-bookmark-without-cfi-or-time',
        type: 'bookmark',
        cfi: '',
        text: 'Page only bookmark',
        page: 12,
      },
    ]);
    expect(onUnresolved).not.toHaveBeenCalled();
  });

  it('keeps an EPUB bookmark unresolved when Grimmory provides no CFI', async () => {
    const store = {
      connectionId: 'connection-a',
      getMetadataCursor: vi.fn().mockResolvedValue(null),
      getNoteMapping: vi.fn().mockResolvedValue(null),
      recordUnresolvedMetadata: vi.fn(),
      applyMetadataPage: vi.fn(),
    };
    const getMetadata = vi.fn(async (query: Record<string, string | number>) =>
      query['type'] === 'bookmark'
        ? {
            items: [
              {
                type: 'bookmark',
                dedupeKey: 'epub-bookmark-without-cfi',
                updatedAt: null,
                payload: { type: 'bookmark', title: 'EPUB bookmark', page: 12, location: null },
              },
            ],
            nextCursor: 'epub-bookmark-checkpoint',
            hasMore: false,
          }
        : { items: [], nextCursor: 'epub-annotation-checkpoint', hasMore: false },
    );
    const provider = new GrimmLinkMetadataProvider({ getMetadata }, store as never, {
      capabilities: ['metadata'],
      device: 'Readest Test',
      deviceId: 'device-1',
    });
    const apply = vi.fn();
    const onUnresolved = vi.fn();

    await expect(provider.pull('book-a', [], apply, onUnresolved, 'EPUB')).resolves.toEqual([]);
    expect(store.recordUnresolvedMetadata).toHaveBeenCalledOnce();
    expect(onUnresolved).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('stops rating pagination when the server returns a final checkpoint cursor', async () => {
    const store = {
      connectionId: 'connection-a',
      getRating: vi.fn().mockResolvedValue(null),
      getMetadataCursor: vi.fn().mockResolvedValue(null),
      applyRatingPage: vi.fn(),
    };
    const getMetadata = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: 'new-final-checkpoint',
      hasMore: false,
    });
    const provider = new GrimmLinkRatingProvider({ getMetadata }, store as never, {
      capabilities: ['metadata'],
      device: 'Readest Test',
      deviceId: 'device-1',
    });

    await provider.pull('book-a', null);

    expect(getMetadata).toHaveBeenCalledOnce();
    expect(store.applyRatingPage).toHaveBeenCalledWith('book-a', null, 'new-final-checkpoint');
  });
});
