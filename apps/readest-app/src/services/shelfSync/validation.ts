import type { ShelfSyncAppService } from './types';

const bytes = (data: ArrayBuffer): Uint8Array => new Uint8Array(data);

const beginsWith = (data: Uint8Array, signature: number[]): boolean =>
  signature.every((byte, index) => data[index] === byte);

/** Rejects obvious corruption before an import can create a library record. */
export const validateShelfDownload = (
  filename: string,
  data: ArrayBuffer,
  expectedSize?: number,
): void => {
  const file = filename.toLowerCase();
  const value = bytes(data);
  if (value.byteLength === 0) throw new Error('Empty download');
  if (expectedSize !== undefined && expectedSize >= 0 && value.byteLength !== expectedSize)
    throw new Error('Unexpected download size');
  if (file.endsWith('.epub') && !beginsWith(value, [0x50, 0x4b])) throw new Error('Invalid EPUB');
  if (file.endsWith('.pdf') && !beginsWith(value, [0x25, 0x50, 0x44, 0x46]))
    throw new Error('Invalid PDF');
  if (file.endsWith('.cbz') && !beginsWith(value, [0x50, 0x4b])) throw new Error('Invalid CBZ');
};

/**
 * Validates header signature and size bounds for shelf downloads.
 */
export const validateShelfDownloadHeader = (
  filename: string,
  header: Uint8Array | ArrayBuffer,
  actualSize?: number,
  expectedSize?: number | null,
): void => {
  if (actualSize !== undefined && actualSize === 0) {
    throw new Error('Empty download');
  }

  if (expectedSize !== undefined && expectedSize !== null && expectedSize >= 0) {
    if (actualSize !== undefined && actualSize !== expectedSize) {
      throw new Error(`Unexpected download size: expected ${expectedSize}, got ${actualSize}`);
    }
  }

  const headerBytes = header instanceof Uint8Array ? header : new Uint8Array(header);
  if (headerBytes.length === 0) {
    throw new Error('Empty download');
  }

  const file = filename.toLowerCase();
  const isZipPk = headerBytes.length >= 2 && headerBytes[0] === 0x50 && headerBytes[1] === 0x4b;
  const isPdf =
    headerBytes.length >= 4 &&
    headerBytes[0] === 0x25 &&
    headerBytes[1] === 0x50 &&
    headerBytes[2] === 0x44 &&
    headerBytes[3] === 0x46;

  if (file.endsWith('.epub') && !isZipPk) throw new Error('Invalid EPUB');
  if (file.endsWith('.cbz') && !isZipPk) throw new Error('Invalid CBZ');
  if (file.endsWith('.pdf') && !isPdf) throw new Error('Invalid PDF');
};

/**
 * Inspects a downloaded file in Temp storage to extract header bytes and actual file size
 * without buffering large files into memory.
 */
export async function inspectShelfDownloadFile(
  appService: ShelfSyncAppService,
  tempPath: string,
): Promise<{ headerBytes?: Uint8Array; actualSize?: number }> {
  let actualSize: number | undefined;

  const app = appService as ShelfSyncAppService & {
    stats?: (path: string, baseDir?: string) => Promise<{ size?: number } | null>;
    openFile?: (path: string, baseDir?: string) => Promise<File>;
    readFile?: (path: string, baseDir?: string, encoding?: string) => Promise<ArrayBuffer | string>;
  };

  if (typeof app.stats === 'function') {
    const fileStats = await app.stats(tempPath, 'Temp').catch(() => null);
    if (fileStats && typeof fileStats.size === 'number') {
      actualSize = fileStats.size;
    }
  }

  if (typeof app.openFile === 'function') {
    try {
      const file = await app.openFile(tempPath, 'Temp');
      if (actualSize === undefined) actualSize = file.size;
      const slice = await file.slice(0, 8).arrayBuffer();
      return { headerBytes: new Uint8Array(slice), actualSize };
    } catch {
      // Fallback
    }
  }

  if (typeof app.readFile === 'function') {
    try {
      const content = await app.readFile(tempPath, 'Temp', 'binary');
      const buf = typeof content === 'string' ? new TextEncoder().encode(content).buffer : content;
      const bytes = new Uint8Array(buf);
      if (actualSize === undefined) actualSize = bytes.byteLength;
      return { headerBytes: bytes.slice(0, 8), actualSize };
    } catch {
      // Fallback
    }
  }

  return { actualSize };
}

/**
 * Creates a sanitized, safe filename for local storage preventing path traversal.
 */
export const safeShelfFilename = (filename: string, bookId: number | string): string => {
  const leaf = filename.replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '') || `book-${bookId}`;
  return `${bookId}-${leaf}`;
};
