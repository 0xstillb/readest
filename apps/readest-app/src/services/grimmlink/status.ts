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

export const mergeRemoteReadStatus = (
  local: { readingStatus?: ReadingStatus; readingStatusUpdatedAt?: number },
  remote: { status?: string; updatedAt?: string },
  available: string[],
) => {
  const mapped = mapReadStatus(remote.status as ReadingStatus | undefined, available) as ReadingStatus | null;
  const remoteAt = remote.updatedAt ? Date.parse(remote.updatedAt) : 0;
  if (!mapped || (local.readingStatusUpdatedAt ?? 0) >= remoteAt) return local;
  return { readingStatus: mapped, readingStatusUpdatedAt: remoteAt };
};
