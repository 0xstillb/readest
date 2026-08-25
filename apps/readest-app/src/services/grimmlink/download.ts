const bytes = (data: ArrayBuffer): Uint8Array => new Uint8Array(data);

const beginsWith = (data: Uint8Array, signature: number[]): boolean =>
  signature.every((byte, index) => data[index] === byte);

/**
 * Calibre occasionally writes `opf:` fields outside the element that declared
 * the prefix. Grimmory serves the original bytes, while Readest's XML parser
 * correctly rejects that EPUB. Add the standard declaration to the package
 * element and rebuild only that malformed archive.
 */
export const repairMalformedEpubOpfNamespace = async (data: ArrayBuffer): Promise<ArrayBuffer> => {
  const { configureZip } = await import('@/utils/zip');
  await configureZip();
  const { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new BlobReader(new Blob([data])));
  try {
    const entries = await reader.getEntries();
    const byName = new Map(entries.map((entry) => [entry.filename.toLowerCase(), entry]));
    const container = byName.get('meta-inf/container.xml');
    if (!container || container.directory || !container.getData) return data;
    const containerXml = await container.getData(new TextWriter());
    const rootfile = containerXml.match(/full-path\s*=\s*["']([^"']+\.opf)["']/i)?.[1];
    const opfEntry = rootfile ? byName.get(rootfile.toLowerCase()) : undefined;
    if (!opfEntry || opfEntry.directory || !opfEntry.getData) return data;
    const opf = await opfEntry.getData(new TextWriter());
    if (!/\bopf:/.test(opf) || /\bxmlns:opf\s*=/.test(opf.match(/<package\b[^>]*>/i)?.[0] ?? '')) return data;
    const repairedOpf = opf.replace(/<package\b/i, '<package xmlns:opf="http://www.idpf.org/2007/opf"');
    if (repairedOpf === opf) return data;

    const writer = new ZipWriter(new BlobWriter('application/epub+zip'));
    for (const entry of entries) {
      if (entry.directory) {
        await writer.add(entry.filename, undefined, { directory: true });
        continue;
      }
      if (entry.filename.toLowerCase() === opfEntry.filename.toLowerCase()) {
        await writer.add(entry.filename, new TextReader(repairedOpf));
        continue;
      }
      const blob = await entry.getData!(new BlobWriter());
      await writer.add(entry.filename, new BlobReader(blob), entry.filename === 'mimetype' ? { level: 0 } : undefined);
    }
    return await (await writer.close()).arrayBuffer();
  } finally {
    await reader.close();
  }
};

/** Rejects obvious corruption before an import can create a library record. */
export const validateShelfDownload = (filename: string, data: ArrayBuffer, expectedSize?: number): void => {
  const file = filename.toLowerCase();
  const value = bytes(data);
  if (value.byteLength === 0) throw new Error('Empty download');
  if (expectedSize !== undefined && expectedSize >= 0 && value.byteLength !== expectedSize) throw new Error('Unexpected download size');
  if (file.endsWith('.epub') && !beginsWith(value, [0x50, 0x4b])) throw new Error('Invalid EPUB');
  if (file.endsWith('.pdf') && !beginsWith(value, [0x25, 0x50, 0x44, 0x46])) throw new Error('Invalid PDF');
  if (file.endsWith('.cbz') && !beginsWith(value, [0x50, 0x4b])) throw new Error('Invalid CBZ');
};

export const safeShelfFilename = (filename: string, bookId: number): string => {
  const leaf = filename.replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '') || `book-${bookId}`;
  return `${bookId}-${leaf}`;
};
