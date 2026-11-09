export interface GrimmLinkProxyPayload {
  serverUrl: string;
  endpoint: string;
  method: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface GrimmLinkCapabilities {
  capabilities: string[];
}

export interface GrimmLinkConnectionResult {
  success: boolean;
  message?: string;
  capabilities?: string[];
  errorCategory?: import('./GrimmLinkRequestError').GrimmLinkErrorCategory;
}

export interface GrimmLinkBookLink {
  bookHash: string;
  bookId: number;
  bookFileId?: number;
  format?: string;
}

/** Adapter v2 session state returned by `POST /auth/session`. */
export interface GrimmLinkSession {
  authenticated: boolean;
  username?: string;
  userId?: number;
  expiresAt?: string;
}

/**
 * Adapter v2 progress write.  The adapter derives every native locator from
 * the reader's own position: a CFI for EPUB and a 1-indexed page for
 * fixed-layout formats.
 */
export type GrimmLinkProgressUpdate = {
  bookHash: string;
  operationId: string;
  source: 'readest';
  device: { id?: string; name?: string };
  updatedAt: string;
  fraction: number;
  position: {
    format: string;
    cfi?: string;
    href?: string;
    page?: number;
    totalPages?: number;
  };
};

export interface GrimmLinkProgress {
  bookId?: number;
  bookFileId?: number;
  bookHash?: string;
  progress?: string;
  location?: string;
  /** Reader-native locators as reported by Adapter v2. */
  cfi?: string;
  xpointer?: string;
  href?: string;
  /** Optional display labels supported by newer Grimmory responses. */
  chapter?: string;
  chapterTitle?: string;
  sectionLabel?: string;
  percentage?: number;
  currentPage?: number;
  totalPages?: number;
  device?: string;
  device_id?: string;
  updatedAt?: string;
}

export type GrimmLinkShelfType = 'regular' | 'magic';
/** Shelf membership is download-only: Readest never removes books from Grimmory. */
export type GrimmLinkShelfCleanupPolicy = 'keep_local' | 'remove_managed_copy';
export type GrimmLinkShelfDownloadPolicy = 'off' | 'wifi_only' | 'always';

export interface GrimmLinkShelf {
  id: number;
  name: string;
  type: GrimmLinkShelfType;
}

export interface GrimmLinkShelfBook {
  bookId: number;
  bookHash: string;
  filename: string;
  format: string;
  size?: number;
  title?: string;
  author?: string;
}
