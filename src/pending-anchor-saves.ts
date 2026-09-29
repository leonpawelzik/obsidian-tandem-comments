/** Flush metadata after the editor's own autosave, without overwriting newer text. */
export class PendingAnchorSaves<File extends object> {
  private pending = new Map<File, { before: string; after: string }>();
  private running = new Map<File, Promise<void>>();
  private changed = new Set<File>();
  private requeued = new Set<File>();
  private deleted = new WeakSet<File>();

  constructor(private process: (file: File, update: (raw: string) => string) => Promise<unknown>) {}

  queue(file: File, before: string, after: string): Promise<void> {
    if (this.deleted.has(file)) return Promise.resolve();
    this.pending.set(file, { before, after });
    // A modification of an older snapshot must not discard this new one.
    this.changed.delete(file);
    this.requeued.add(file);
    return this.flush(file);
  }

  modified(file: File): Promise<void> {
    if (!this.pending.has(file)) return Promise.resolve();
    this.changed.add(file);
    return this.flush(file);
  }

  /** A deleted file object must not be saved by subsequent editor teardown. */
  forget(file: File): void {
    this.deleted.add(file);
    this.pending.delete(file);
    this.changed.delete(file);
    this.requeued.delete(file);
  }
  clear(): void { this.pending.clear(); this.changed.clear(); this.requeued.clear(); }

  private flush(file: File): Promise<void> {
    const running = this.running.get(file);
    if (running) return running;
    // Defer so the running marker exists even for synchronously emitted modify events.
    const job = Promise.resolve().then(async () => {
      do {
        this.requeued.delete(file);
        const discardMismatch = this.changed.delete(file);
        const snapshot = this.pending.get(file);
        if (!snapshot) break;
        await this.process(file, (raw) => {
          if (this.pending.get(file) !== snapshot) return raw;
          if (raw === snapshot.before) {
            this.pending.delete(file);
            return snapshot.after;
          }
          if (raw === snapshot.after || discardMismatch) this.pending.delete(file);
          return raw;
        });
      } while (this.requeued.has(file) || this.changed.has(file));
    }).finally(() => {
      this.running.delete(file);
      // A queue/modify callback can arrive after the loop's last check, while
      // this promise is still registered. Chain the follow-up into its result.
      if (this.requeued.has(file) || this.changed.has(file)) return this.flush(file);
    });
    this.running.set(file, job);
    return job;
  }
}
