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

export interface GrimmLinkProgress {
  bookId?: number;
  bookFileId?: number;
  progress?: string;
  location?: string;
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
