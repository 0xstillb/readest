const bytes = (data: ArrayBuffer): Uint8Array => new Uint8Array(data);

const beginsWith = (data: Uint8Array, signature: number[]): boolean =>
  signature.every((byte, index) => data[index] === byte);

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
