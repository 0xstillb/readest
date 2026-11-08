import { describe, expect, it, vi } from 'vitest';
import type { BookNote } from '@/types/book';
import {
  fromGrimmLinkMetadataNote,
  stableMetadataDedupeKey,
  toGrimmLinkMetadataNote,
} from '@/services/grimmlink/metadata';
import { GrimmLinkMetadataProvider } from '@/services/grimmlink/metadataProvider';

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
});
