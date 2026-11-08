export interface GrimmLinkSessionPosition {
  progress?: number;
  location?: string;
  currentPage?: number;
  totalPages?: number;
}

export interface GrimmLinkSessionEnvelope {
  bookId: number;
  bookHash: string;
  bookType: string;
  device: string;
  deviceId: string;
  session: Record<string, unknown>;
}

const MIN_DURATION_SECONDS = 10;
const MIN_PROGRESS_DELTA = 0.01;

/** Captures only the reader lifecycle boundary; database/network work stays outside the reader critical path. */
export class GrimmLinkSessionTracker {
  private startedAt: number | null = null;
  private start: GrimmLinkSessionPosition = {};

  startSession(position: GrimmLinkSessionPosition, now = Date.now()): boolean {
    if (this.startedAt != null) return false;
    this.startedAt = now;
    this.start = position;
    return true;
  }

  isActive(): boolean {
    return this.startedAt != null;
  }

  finish(
    position: GrimmLinkSessionPosition,
    link: Omit<GrimmLinkSessionEnvelope, 'session'>,
    now = Date.now(),
  ): GrimmLinkSessionEnvelope | null {
    if (this.startedAt == null) return null;
    const startedAt = this.startedAt;
    this.startedAt = null;
    const durationSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const startProgress = this.start.progress;
    const endProgress = position.progress;
    const progressDelta =
      startProgress != null && endProgress != null ? endProgress - startProgress : undefined;
    if (durationSeconds < MIN_DURATION_SECONDS && Math.abs(progressDelta ?? 0) < MIN_PROGRESS_DELTA)
      return null;
    return {
      ...link,
      session: {
        startTime: new Date(startedAt).toISOString(),
        endTime: new Date(now).toISOString(),
        durationSeconds,
        startProgress,
        endProgress,
        progressDelta,
        startLocation: this.start.location,
        endLocation: position.location,
        startPage: this.start.currentPage,
        endPage: position.currentPage,
        totalPages: position.totalPages,
      },
    };
  }
}
