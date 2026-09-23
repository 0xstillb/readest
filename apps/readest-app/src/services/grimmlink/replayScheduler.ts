import { GrimmLinkOutbox } from './outbox';
import { recordGrimmLinkPerformance } from './einkDiagnostics';

/**
 * Serializes replay requests for one connection. Calls made while a replay is
 * active collapse into one trailing replay, so lifecycle, online, and manual
 * sync events cannot race the durable outbox.
 */
export class GrimmLinkReplayScheduler {
  private running: Promise<void> | null = null;
  private trailing = false;
  private delayedTimer: ReturnType<typeof setTimeout> | null = null;
  private delayedWaiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];

  constructor(private readonly outbox: GrimmLinkOutbox) {}

  requestReplay(delayMs = 0): Promise<void> {
    recordGrimmLinkPerformance('replayRequested');
    if (this.running) {
      this.trailing = true;
      return this.running;
    }
    if (delayMs > 0) {
      const promise = new Promise<void>((resolve, reject) => {
        this.delayedWaiters.push({ resolve, reject });
      });
      if (!this.delayedTimer) {
        this.delayedTimer = setTimeout(() => {
          this.delayedTimer = null;
          const waiters = this.delayedWaiters.splice(0);
          this.startReplay().then(
            () => waiters.forEach(({ resolve }) => resolve()),
            (error) => waiters.forEach(({ reject }) => reject(error)),
          );
        }, delayMs);
      }
      return promise;
    }
    if (this.delayedTimer) {
      clearTimeout(this.delayedTimer);
      this.delayedTimer = null;
      const waiters = this.delayedWaiters.splice(0);
      const run = this.startReplay();
      run.then(
        () => waiters.forEach(({ resolve }) => resolve()),
        (error) => waiters.forEach(({ reject }) => reject(error)),
      );
      return run;
    }
    return this.startReplay();
  }

  private startReplay(): Promise<void> {
    const run = (async () => {
      do {
        this.trailing = false;
        recordGrimmLinkPerformance('replayExecuted');
        await this.outbox.replay();
      } while (this.trailing);
    })();
    const scheduled = run.finally(() => {
      if (this.running === scheduled) this.running = null;
    });
    this.running = scheduled;
    return scheduled;
  }

  flushNow(): Promise<void> {
    return this.requestReplay();
  }
}
