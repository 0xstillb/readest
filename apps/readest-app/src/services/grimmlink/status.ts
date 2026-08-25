import type { ReadingStatus } from '@/types/book';

export const mapReadStatus = (status: ReadingStatus | undefined, available: string[]): string | null => {
  if (!status) return null;
  // Grimmory calls a completed book READ, while Readest calls it finished.
  // Match the server's advertised enum value rather than sending Readest's
  // display name verbatim.
  const accepted = {
    unread: ['UNREAD'],
    reading: ['READING'],
    finished: ['READ', 'FINISHED'],
    abandoned: ['ABANDONED', 'WONT_READ'],
  }[status];
  return available.find((candidate) => accepted.includes(candidate.trim().toUpperCase())) ?? null;
};

/** Convert Grimmory's wire enum back to Readest's local status names. */
export const fromGrimmoryReadStatus = (status: string | undefined): ReadingStatus | null => {
  const normalized = status?.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === 'UNREAD') return 'unread';
  if (normalized === 'READING' || normalized === 'RE_READING') return 'reading';
  if (normalized === 'READ' || normalized === 'FINISHED') return 'finished';
  if (normalized === 'ABANDONED' || normalized === 'WONT_READ' || normalized === 'PAUSED' || normalized === 'ON_HOLD') return 'abandoned';
  return null;
};

export const mergeRemoteReadStatus = (
  local: { readingStatus?: ReadingStatus; readingStatusUpdatedAt?: number },
  remote: { status?: string; updatedAt?: string },
  available: string[],
) => {
  // `available` confirms that this server supports reading status sync; the
  // remote value itself uses Grimmory's enum rather than Readest's names.
  if (!available.length) return local;
  const mapped = fromGrimmoryReadStatus(remote.status);
  const remoteAt = remote.updatedAt ? Date.parse(remote.updatedAt) : 0;
  if (!mapped || (local.readingStatusUpdatedAt ?? 0) >= remoteAt) return local;
  return { readingStatus: mapped, readingStatusUpdatedAt: remoteAt };
};
