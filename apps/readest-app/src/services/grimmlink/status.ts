import type { ReadingStatus } from '@/types/book';

export const mapReadStatus = (status: ReadingStatus | undefined, available: string[]): string | null => {
  if (!status) return null;
  return available.find((candidate) => candidate.toLowerCase() === status) ?? null;
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
