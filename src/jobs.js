// In-memory, single-process job state. Records contain only progress and sanitized
// results: never request bodies, credentials, credential hashes, or browser state.
export const JOB_TTL_MS = 10 * 60 * 1000;
export const MAX_JOB_RESULTS = 10;
export const MAX_JOB_KEYS = 32;
export const isJobId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export class JobRegistry {
  constructor(now = Date.now, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.now = now; this.jobs = new Map(); this.keys = new Map();
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.timer = null; this.closed = false;
  }
  scheduleExpiry() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.closed) return;
    const expiresAt = Math.min(...this.keys.values());
    if (!Number.isFinite(expiresAt)) return; // Running jobs have no expiry timer.
    this.timer = this.setTimer(() => {
      this.timer = null; this.prune(); this.scheduleExpiry();
    }, Math.max(1, expiresAt - this.now()));
    // One bounded timer per registry, never keeping the process alive by itself.
    this.timer?.unref?.();
  }
  close() {
    this.closed = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
  prune() {
    for (const [id, expiresAt] of this.keys) if (expiresAt <= this.now()) { this.keys.delete(id); this.jobs.delete(id); }
  }
  find(id) { this.prune(); return this.jobs.get(id); }
  seen(id) { this.prune(); return this.keys.has(id); }
  hasCapacity() { this.prune(); return this.keys.size < MAX_JOB_KEYS; }
  create(id) {
    this.prune();
    if (this.keys.has(id) || this.keys.size >= MAX_JOB_KEYS) throw new Error('Job registry capacity or duplicate');
    while (this.jobs.size >= MAX_JOB_RESULTS) {
      const expired = [...this.jobs].find(([, job]) => job.status !== 'running');
      if (!expired) throw new Error('Job registry full');
      // Keep its lightweight key tombstone to prevent a duplicate browser run.
      this.jobs.delete(expired[0]);
    }
    const startedMs = this.now();
    const job = { jobId: id, status: 'running', phase: 'accepted', startedAt: new Date(startedMs).toISOString(), startedMs };
    this.jobs.set(id, job); this.keys.set(id, Infinity);
    return job;
  }
  finish(job) {
    job.finishedMs = this.now(); job.finishedAt = new Date(job.finishedMs).toISOString();
    this.keys.set(job.jobId, job.finishedMs + JOB_TTL_MS);
    this.scheduleExpiry();
  }
  metadata(job) {
    return { jobId: job.jobId, ...(isJobId(job.requestId) ? { requestId: job.requestId } : {}), status: job.status, phase: job.phase, startedAt: job.startedAt,
      elapsedMs: Math.max(0, (job.finishedMs ?? this.now()) - job.startedMs), ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}) };
  }
}
