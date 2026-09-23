import { describe, expect, it } from 'vitest';
import type { Book } from '@/types/book';
import {
  GrimmLinkShelfProvider,
  planShelfSync,
  reconcileShelfSnapshot,
  summarizeShelfReconciliation,
} from '@/services/grimmlink/shelfSync';
import {
  repairMalformedEpubOpfNamespace,
  validateShelfDownload,
} from '@/services/grimmlink/download';

describe('GrimmLink shelf sync safety', () => {
  it('reuses a local hash and downloads only missing remote shelf books', () => {
    expect(
      planShelfSync(
        [
          { bookId: 1, bookHash: 'already-local', filename: 'one.epub', format: 'EPUB' },
          { bookId: 2, bookHash: 'missing', filename: 'two.epub', format: 'EPUB' },
        ],
        [],
        new Set(['already-local']),
      ),
    ).toEqual({
      reuse: [1],
      download: [{ bookId: 2, bookHash: 'missing', filename: 'two.epub', format: 'EPUB' }],
      absent: [],
    });
  });

  it('reconciles added, unchanged, changed, and removed snapshot entries', () => {
    const result = reconcileShelfSnapshot(
      [
        { bookId: 1, bookHash: 'a', filename: 'a.epub', format: 'EPUB' },
        { bookId: 2, bookHash: 'b2', filename: 'b.epub', format: 'EPUB' },
        { bookId: 3, bookHash: 'c', filename: 'c.epub', format: 'EPUB' },
      ],
      [
        { bookId: 1, bookHash: 'a', localPath: 'a.epub', managedByGrimmLink: true },
        { bookId: 2, bookHash: 'b1', localPath: 'b.epub', managedByGrimmLink: true },
        { bookId: 4, bookHash: 'd', localPath: 'd.epub', managedByGrimmLink: true },
      ],
      new Set(['a']),
      new Set(['a.epub']),
    );
    expect(result).toMatchObject({
      unchanged: [{ bookId: 1 }],
      changed: [{ previous: { bookId: 2 }, next: { bookId: 2, bookHash: 'b2' } }],
      added: [{ bookId: 3 }],
      removed: [{ bookId: 4 }],
    });
    expect(summarizeShelfReconciliation(result)).toMatchObject({
      total: 3,
      added: 1,
      unchanged: 1,
      changed: 1,
      removed: 1,
      downloads: 2,
    });
  });

  it('reuses a tracked local import even when Readest and Grimmory hashes differ', () => {
    const remote = [{ bookId: 1, bookHash: 'grimory-hash', filename: 'one.epub', format: 'EPUB' }];
    const existing = [
      {
        bookId: 1,
        bookHash: 'grimory-hash',
        localPath: 'local-hash/one.epub',
        managedByGrimmLink: true,
      },
    ];
    expect(
      planShelfSync(remote, existing, new Set(['local-hash']), new Set(['local-hash/one.epub'])),
    ).toMatchObject({
      reuse: [1],
      download: [],
    });
  });

  it('reuses a changed remote revision already imported by another shelf', () => {
    const result = reconcileShelfSnapshot(
      [{ bookId: 1, bookHash: 'new-hash', filename: 'one.epub', format: 'EPUB' }],
      [{ bookId: 1, bookHash: 'old-hash', localPath: 'old.epub', managedByGrimmLink: true }],
      new Set(['new-hash']),
      new Set(['new.epub']),
    );
    expect(result.changed).toEqual([]);
    expect(result.unchanged.map((book) => book.bookId)).toEqual([1]);
  });

  it('downloads again when the remembered shelf path is no longer present locally', () => {
    const remote = [{ bookId: 1, bookHash: 'grimory-hash', filename: 'one.epub', format: 'EPUB' }];
    const existing = [
      {
        bookId: 1,
        bookHash: 'grimory-hash',
        localPath: 'local-hash/one.epub',
        managedByGrimmLink: true,
      },
    ];

    expect(planShelfSync(remote, existing, new Set(), new Set())).toMatchObject({
      reuse: [],
      download: remote,
    });
  });

  it('rejects corrupt downloads before import', () => {
    expect(() => validateShelfDownload('book.epub', new Uint8Array([1, 2, 3]).buffer)).toThrow(
      'Invalid EPUB',
    );
    expect(() =>
      validateShelfDownload('book.pdf', new TextEncoder().encode('%PDF-1.7').buffer),
    ).not.toThrow();
    expect(() =>
      validateShelfDownload('book.pdf', new TextEncoder().encode('%PDF-1.7').buffer, 1),
    ).toThrow('Unexpected download size');
  });

  it('repairs an OPF prefix which is declared too narrowly for a strict XML reader', async () => {
    const { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter } = await import(
      '@zip.js/zip.js'
    );
    const writer = new ZipWriter(new BlobWriter('application/epub+zip'));
    await writer.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
    await writer.add(
      'META-INF/container.xml',
      new TextReader(
        '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
      ),
    );
    await writer.add(
      'content.opf',
      new TextReader('<package><metadata xmlns:opf="urn:opf"/><opf:meta name="broken"/></package>'),
    );
    const broken = await (await writer.close()).arrayBuffer();

    const reader = new ZipReader(
      new BlobReader(new Blob([await repairMalformedEpubOpfNamespace(broken)])),
    );
    const entry = (await reader.getEntries()).find((item) => item.filename === 'content.opf');
    if (!entry || entry.directory || !entry.getData) throw new Error('content.opf missing');
    const opf = await entry.getData(new TextWriter());
    await reader.close();
    expect(opf).toContain('<package xmlns:opf="http://www.idpf.org/2007/opf">');
  });

  it('reports the import stage after a shelf download completes', async () => {
    const stages: string[] = [];
    let importedFile: unknown;
    const client = {
      getShelfBooks: async () => [
        { bookId: 1, bookHash: 'remote-hash', filename: 'book.pdf', format: 'PDF' as const },
      ],
      downloadShelfBook: async () => new TextEncoder().encode('%PDF-1.7').buffer,
    };
    const store = {
      getShelfEntries: async () => [],
      markShelfEntry: async () => {},
      removeShelfEntry: async () => {},
    };
    const appService = {
      exists: async () => false,
      createDir: async () => {},
      writeFile: async () => {},
      resolveFilePath: async () => '/tmp/book.pdf',
      deleteFile: async () => {},
      importBook: async (file: unknown) => {
        importedFile = file;
        return { hash: 'local-hash', title: 'Book', format: 'PDF' };
      },
      deleteBook: async () => {},
    };

    await new GrimmLinkShelfProvider(client, store as never).sync(
      'regular',
      1,
      [],
      async () => {},
      appService as never,
      { onStage: ({ stage }) => stages.push(stage) },
    );

    expect(stages).toEqual(['downloading', 'importing']);
    expect(importedFile).toBeInstanceOf(File);
  });

  it('removes a stale partial temp file before writing and cleans up after import failure', async () => {
    const data = new ArrayBuffer(8 * 1024 * 1024);
    new Uint8Array(data).set(new TextEncoder().encode('%PDF-1.7'));
    const events: string[] = [];
    let tempExists = true;
    const client = {
      getShelfBooks: async () => [
        { bookId: 1, bookHash: 'remote-hash', filename: 'book.pdf', format: 'PDF' as const },
      ],
      downloadShelfBook: async () => data,
    };
    const store = {
      getShelfEntries: async () => [],
      markShelfEntry: async () => events.push('mapped'),
      removeShelfEntry: async () => {},
    };
    const appService = {
      exists: async (_path: string, folder?: string) => (folder === 'Temp' ? tempExists : false),
      createDir: async () => {},
      writeFile: async () => {
        events.push('write');
        expect(tempExists).toBe(false);
      },
      resolveFilePath: async () => '/tmp/book.pdf',
      deleteFile: async () => {
        events.push('delete');
        tempExists = false;
      },
      importBook: async () => null,
      deleteBook: async () => {},
    };

    await expect(
      new GrimmLinkShelfProvider(client, store as never).sync(
        'regular',
        1,
        [],
        async () => {},
        appService as never,
      ),
    ).rejects.toThrow('Failed to import GrimmLink shelf book');

    expect(events).toEqual(['delete', 'write', 'delete']);
    expect(events).not.toContain('mapped');
  });

  it('reconciles an imported book when shelf mapping persistence fails', async () => {
    const data = new TextEncoder().encode('%PDF-1.7').buffer;
    const library: Book[] = [];
    const entries: Array<{
      bookId: number;
      bookHash: string;
      localPath: string | null;
      managedByGrimmLink: boolean;
    }> = [];
    let downloads = 0;
    let imports = 0;
    let failFirstMapping = true;
    let localFileExists = false;
    const client = {
      getShelfBooks: async () => [
        { bookId: 1, bookHash: 'remote-hash', filename: 'book.pdf', format: 'PDF' as const },
      ],
      downloadShelfBook: async () => {
        downloads++;
        return data;
      },
    };
    const store = {
      getShelfEntries: async () => entries,
      markShelfEntry: async (
        _type: string,
        _shelfId: number,
        bookId: number,
        bookHash: string,
        localPath: string | null,
        managedByGrimmLink: boolean,
      ) => {
        if (failFirstMapping) {
          failFirstMapping = false;
          throw new Error('simulated temporary database failure');
        }
        entries.push({ bookId, bookHash, localPath, managedByGrimmLink });
      },
      removeShelfEntry: async () => {},
    };
    const appService = {
      exists: async () => localFileExists,
      createDir: async () => {},
      writeFile: async () => {},
      resolveFilePath: async () => '/tmp/book.pdf',
      deleteFile: async () => {},
      importBook: async () => {
        imports++;
        return {
          hash: 'remote-hash',
          title: 'Book',
          author: '',
          format: 'PDF',
          createdAt: 0,
          updatedAt: 0,
        };
      },
      deleteBook: async () => {},
    };
    const onImported = async (_book: (typeof library)[number], books: typeof library) => {
      library.splice(0, library.length, ...books);
      localFileExists = true;
    };
    const provider = new GrimmLinkShelfProvider(client, store as never);

    await expect(
      provider.sync('regular', 1, library, onImported, appService as never),
    ).rejects.toThrow('simulated temporary database failure');
    await provider.sync('regular', 1, library, onImported, appService as never);

    expect(downloads).toBe(1);
    expect(imports).toBe(1);
    expect(library).toHaveLength(1);
    expect(entries).toHaveLength(1);
  });

  it('purges GrimmLink-managed books only with explicit cleanup policy', async () => {
    const removedEntries: number[] = [];
    const purged: string[] = [];
    const book = { hash: 'local-hash', title: 'Book', sourceTitle: 'Book', format: 'PDF' };
    const client = {
      getShelfBooks: async () => [],
      downloadShelfBook: async () => new ArrayBuffer(0),
    };
    const store = {
      getShelfEntries: async () => [
        {
          bookId: 7,
          bookHash: 'remote-hash',
          localPath: 'local-hash/Book.pdf',
          managedByGrimmLink: true,
        },
      ],
      markShelfEntry: async () => {},
      removeShelfEntry: async (_type: string, _shelfId: number, bookId: number) => {
        removedEntries.push(bookId);
      },
      getManagedShelfEntryReferences: async () => 1,
    };
    const appService = {
      exists: async () => true,
      createDir: async () => {},
      writeFile: async () => {},
      openFile: async () => ({ name: 'book.pdf' }),
      deleteFile: async () => {},
      importBook: async () => null,
      deleteBook: async (target: typeof book) => {
        purged.push(target.hash);
      },
    };

    const result = await new GrimmLinkShelfProvider(client, store as never).sync(
      'regular',
      1,
      [book as never],
      async () => {},
      appService as never,
      undefined,
      undefined,
      'remove_managed_copy',
    );

    expect(result.removed).toBe(1);
    expect(purged).toEqual(['local-hash']);
    expect(removedEntries).toEqual([7]);
  });

  it('keeps a managed file when another shelf still references it', async () => {
    let purged = 0;
    const client = {
      getShelfBooks: async () => [],
      downloadShelfBook: async () => new ArrayBuffer(0),
    };
    const store = {
      getShelfEntries: async () => [
        { bookId: 8, bookHash: 'remote-hash', localPath: 'shared.pdf', managedByGrimmLink: true },
      ],
      markShelfEntry: async () => {},
      removeShelfEntry: async () => {},
      getManagedShelfEntryReferences: async () => 2,
    };
    const appService = {
      exists: async () => true,
      createDir: async () => {},
      writeFile: async () => {},
      resolveFilePath: async () => '/tmp/shared.pdf',
      deleteFile: async () => {},
      importBook: async () => null,
      deleteBook: async () => {
        purged += 1;
      },
    };
    const book = { hash: 'local-hash', title: 'Shared', sourceTitle: 'Shared', format: 'PDF' };
    const result = await new GrimmLinkShelfProvider(client, store as never).sync(
      'magic',
      2,
      [book as never],
      async () => {},
      appService as never,
      undefined,
      undefined,
      'remove_managed_copy',
    );
    expect(result.removed).toBe(0);
    expect(purged).toBe(0);
  });

  it('does not delete user-imported entries even with destructive cleanup', async () => {
    let purged = 0;
    const client = {
      getShelfBooks: async () => [],
      downloadShelfBook: async () => new ArrayBuffer(0),
    };
    const store = {
      getShelfEntries: async () => [
        { bookId: 9, bookHash: 'remote-hash', localPath: 'user.pdf', managedByGrimmLink: false },
      ],
      markShelfEntry: async () => {},
      removeShelfEntry: async () => {},
      getManagedShelfEntryReferences: async () => 1,
    };
    const appService = {
      exists: async () => true,
      createDir: async () => {},
      writeFile: async () => {},
      resolveFilePath: async () => '/tmp/user.pdf',
      deleteFile: async () => {},
      importBook: async () => null,
      deleteBook: async () => {
        purged += 1;
      },
    };
    const book = { hash: 'local-hash', title: 'User', sourceTitle: 'User', format: 'PDF' };
    await new GrimmLinkShelfProvider(client, store as never).sync(
      'regular',
      3,
      [book as never],
      async () => {},
      appService as never,
      undefined,
      undefined,
      'remove_managed_copy',
    );
    expect(purged).toBe(0);
  });
});
