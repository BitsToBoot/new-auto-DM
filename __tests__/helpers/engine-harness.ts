/**
 * Shared harness for delivery-engine integration tests. The test file wires
 * these fakes in with vi.mock; this module holds their state and behavior.
 */
import type { FakePrisma } from "./fake-prisma";

export interface QueuedJob {
  name: string;
  data: any;
  opts: { jobId?: string; delay?: number; priority?: number };
  enqueuedAt: number;
}

export class FakeQueue {
  jobs = new Map<string, QueuedJob>();
  private seq = 0;

  async add(name: string, data: any, opts: QueuedJob["opts"] = {}) {
    const id = opts.jobId ?? `auto-${++this.seq}`;
    if (this.jobs.has(id)) return { id }; // BullMQ: duplicate jobId is a no-op
    this.jobs.set(id, { name, data, opts, enqueuedAt: Date.now() });
    return { id };
  }

  async addBulk(jobs: { name: string; data: any; opts?: QueuedJob["opts"] }[]) {
    for (const job of jobs) await this.add(job.name, job.data, job.opts);
  }

  /** Simulates Redis losing all queued work (restart without persistence). */
  wipe() {
    this.jobs.clear();
  }

  dueJobs(now = Date.now()) {
    return [...this.jobs.entries()].filter(
      ([, job]) => job.enqueuedAt + (job.opts.delay ?? 0) <= now
    );
  }
}

/** Per-account throughput limiter mirroring reserveDMSlot semantics. */
export class FakeRateLimiter {
  limit = Number.POSITIVE_INFINITY;
  windowMs = 60 * 60 * 1000;
  counts = new Map<string, number>();

  reserve(accountId: string) {
    const current = this.counts.get(accountId) ?? 0;
    if (current >= this.limit) {
      return {
        allowed: false,
        currentCount: current,
        remainingDMs: 0,
        shouldRequeue: true,
        requeueDelayMs: this.windowMs,
        shouldSkip: false,
        reserved: false,
      };
    }
    this.counts.set(accountId, current + 1);
    return {
      allowed: true,
      currentCount: current + 1,
      remainingDMs: this.limit - current - 1,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: false,
      reserved: true,
    };
  }

  release(accountId: string) {
    const current = this.counts.get(accountId) ?? 0;
    this.counts.set(accountId, Math.max(0, current - 1));
    return Math.max(0, current - 1);
  }

  resetWindow() {
    this.counts.clear();
  }
}

/** Monthly usage reservations mirroring reserveWorkspaceDMSend semantics. */
export class FakeUsage {
  limit = Number.POSITIVE_INFINITY;
  used = new Map<string, number>();
  readonly periodStart = new Date("2026-11-01T00:00:00.000Z");

  reserve(workspaceId: string) {
    const current = this.used.get(workspaceId) ?? 0;
    if (current >= this.limit) {
      return { allowed: false, reserved: false, remaining: 0, limit: this.limit, periodStart: this.periodStart };
    }
    this.used.set(workspaceId, current + 1);
    return {
      allowed: true,
      reserved: true,
      remaining: this.limit - current - 1,
      limit: this.limit,
      periodStart: this.periodStart,
    };
  }

  release(workspaceId: string) {
    const current = this.used.get(workspaceId) ?? 0;
    this.used.set(workspaceId, Math.max(0, current - 1));
    return { count: current > 0 ? 1 : 0 };
  }

  count(workspaceId: string) {
    return this.used.get(workspaceId) ?? 0;
  }
}

export interface SentMessage {
  instagramAccountId: string;
  commentId: string;
  message: string;
}

/**
 * Records every Meta send and checks the core safety invariant at the moment
 * of sending: the DeliveryJob for this comment must already be durably
 * SENDING. Any send without that state is a violation.
 */
export class FakeMeta {
  sent: SentMessage[] = [];
  violations: string[] = [];
  nextErrors: unknown[] = [];
  mediaPublishedAt = new Map<string, Date | Error>();

  constructor(private db: FakePrisma) {}

  async sendPrivateReply(_token: string, instagramAccountId: string, commentId: string, message: string) {
    const sending = this.db.tables.deliveryJob.filter(
      (job) => job.triggerId === commentId && job.status === "SENDING"
    );
    if (sending.length !== 1) {
      this.violations.push(
        `send for comment ${commentId} without exactly one SENDING DeliveryJob (found ${sending.length})`
      );
    }
    this.sent.push({ instagramAccountId, commentId, message });
    const error = this.nextErrors.shift();
    if (error) throw error;
    return { recipient_id: "r", message_id: `mid_${this.sent.length}` };
  }

  async getMediaPublishedAt(_token: string, mediaId: string) {
    const value = this.mediaPublishedAt.get(mediaId);
    if (value instanceof Error) throw value;
    if (!value) throw new Error(`no publish time configured for ${mediaId}`);
    return value;
  }

  reset() {
    this.sent = [];
    this.violations = [];
    this.nextErrors = [];
    this.mediaPublishedAt.clear();
  }
}
