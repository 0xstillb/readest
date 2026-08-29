import { describe, expect, it } from 'vitest';
import { GrimmLinkShelfProvider, planShelfSync } from '@/services/grimmlink/shelfSync';
import { repairMalformedEpubOpfNamespace, validateShelfDownload } from '@/services/grimmlink/download';

describe('GrimmLink shelf sync safety', () => {
  it('reuses a local hash and downloads only missing remote shelf books', () => {
    expect(planShelfSync([
      { bookId: 1, bookHash: 'already-local', filename: 'one.epub', format: 'EPUB' },
      { bookId: 2, bookHash: 'missing', filename: 'two.epub', format: 'EPUB' },
    ], [], new Set(['already-local']))).toEqual({
      reuse: [1], download: [{ bookId: 2, bookHash: 'missing', filename: 'two.epub', format: 'EPUB' }], absent: [],
    });
  });

  it('reuses a tracked local import even when Readest and Grimmory hashes differ', () => {
    const remote = [{ bookId: 1, bookHash: 'grimory-hash', filename: 'one.epub', format: 'EPUB' }];
    const existing = [{ bookId: 1, bookHash: 'grimory-hash', localPath: 'local-hash/one.epub', managedByGrimmLink: true }];
    expect(planShelfSync(remote, existing, new Set(['local-hash']), new Set(['local-hash/one.epub']))).toMatchObject({
      reuse: [1], download: [],
    });
  });

  it('downloads again when the remembered shelf path is no longer present locally', () => {
    const remote = [{ bookId: 1, bookHash: 'grimory-hash', filename: 'one.epub', format: 'EPUB' }];
    const existing = [{ bookId: 1, bookHash: 'grimory-hash', localPath: 'local-hash/one.epub', managedByGrimmLink: true }];

    expect(planShelfSync(remote, existing, new Set(), new Set())).toMatchObject({
      reuse: [], download: remote,
    });
  });

  it('rejects corrupt downloads before import', () => {
    expect(() => validateShelfDownload('book.epub', new Uint8Array([1, 2, 3]).buffer)).toThrow('Invalid EPUB');
    expect(() => validateShelfDownload('book.pdf', new TextEncoder().encode('%PDF-1.7').buffer)).not.toThrow();
    expect(() => validateShelfDownload('book.pdf', new TextEncoder().encode('%PDF-1.7').buffer, 1)).toThrow('Unexpected download size');
  });

  it('repairs an OPF prefix which is declared too narrowly for a strict XML reader', async () => {
    const { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter } = await import('@zip.js/zip.js');
    const writer = new ZipWriter(new BlobWriter('application/epub+zip'));
    await writer.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
    await writer.add('META-INF/container.xml', new TextReader('<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'));
    await writer.add('content.opf', new TextReader('<package><metadata xmlns:opf="urn:opf"/><opf:meta name="broken"/></package>'));
    const broken = await (await writer.close()).arrayBuffer();

    const reader = new ZipReader(new BlobReader(new Blob([await repairMalformedEpubOpfNamespace(broken)])));
    const entry = (await reader.getEntries()).find((item) => item.filename === 'content.opf');
    if (!entry || entry.directory || !entry.getData) throw new Error('content.opf missing');
    const opf = await entry.getData(new TextWriter());
    await reader.close();
    expect(opf).toContain('<package xmlns:opf="http://www.idpf.org/2007/opf">');
  });

  it('reports the import stage after a shelf download completes', async () => {
    const stages: string[] = [];
    const client = {
      getShelfBooks: async () => [
        { bookId: 1, bookHash: 'remote-hash', filename: 'book.pdf', format: 'PDF' as const },
      ],
      downloadShelfBook: async () => new TextEncoder().encode('%PDF-1.7').buffer,
    };
    const store = {
      getShelfEntries: async () => [],
      markShelfEntry: async () => {},
    };
    const appService = {
      exists: async () => false,
      createDir: async () => {},
      writeFile: async () => {},
      openFile: async () => ({ name: 'book.pdf' }),
      deleteFile: async () => {},
      importBook: async () => ({ hash: 'local-hash', title: 'Book', format: 'PDF' }),
    };

    await new GrimmLinkShelfProvider(client, store as never).sync(
      'regular',
      1,
      [],
      async () => {},
      appService as never,
      'grimmlink',
      { onStage: ({ stage }) => stages.push(stage) },
    );

    expect(stages).toEqual(['downloading', 'importing']);
  });

});
