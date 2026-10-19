import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";

/**
 * BOUNDED-PARALLEL MAILBOX ATTACHES (CLOUD-ROSTER-REATTACH-IS-SERIAL).
 *
 * A roster pass used to await one attach after another, so one provider's slow dial (107 s on
 * 2026-10-09) held every mailbox behind it unconnected, and held the one serial queue with it. This
 * pool runs them beside each other under three keys, each held from start until the job settles:
 * one of `concurrency` global slots, the provider host (no provider sees a burst from us), and the
 * mailbox (never two attaches of one mailbox). Admission is first-in-first-out, skipping a job
 * whose host is busy, so a slow host never blocks the jobs behind it.
 *
 * Scheduling only: no database, no IMAP. The attach itself decides what a deadline or a stop means
 * for its row; the pool only says that one happened and closes the connection under it.
 */

/** Why an attach was told to stop: its own deadline, or the process going down. */
export type AttachAbort = "deadline" | "stop";

/** Thrown at an attach's checkpoint once it has been aborted. */
export class AttachAbortedError extends Error {
  readonly code = "ATTACH_ABORTED";
  constructor(readonly why: AttachAbort) {
    super(`attach aborted (${why})`);
    this.name = "AttachAbortedError";
  }
}

/**
 * What a deadline-aborted attach is quarantined with. `ETIMEDOUT` so the row's `error_code` reads
 * `timeout`, the code a provider that stops answering already gets.
 */
export class AttachDeadlineError extends Error {
  readonly code = "ETIMEDOUT";
  constructor(readonly deadlineMs: number) {
    super(`attach did not finish within ${deadlineMs} ms`);
    this.name = "AttachDeadlineError";
  }
}

/** One attach's handle on its own fate. */
export interface AttachTicket {
  readonly aborted: AttachAbort | null;
  /** Set once the connection this attach dialled was reported lost ({@link AttachPool.noteLost}). */
  readonly lost: { err: unknown } | null;
  /** Throws {@link AttachAbortedError} once aborted, or the error a lost connection recorded. */
  checkpoint(): void;
  /** The connection this attach dialled: what a deadline or a stop force-closes. */
  bind(adapter: MailboxAdapter): void;
  /**
   * `step`, or {@link AttachAbortedError} as soon as this attach is aborted. For a step a close
   * may not end: imapflow's `connect()` stays pending when it is closed mid-handshake.
   */
  abortable<T>(step: Promise<T>): Promise<T>;
}

export interface AttachJob {
  mailboxId: string;
  accountId: string;
  hostKey: string;
  run(ticket: AttachTicket): Promise<void>;
}

export interface AttachPoolOpts {
  concurrency: number;
  deadlineMs: number;
  onDeadline(job: { mailboxId: string; accountId: string }): void;
  /** A job that REJECTED: the attach rethrows only a shared database fault. */
  onFault(err: unknown): void;
}

/**
 * The key one IMAP host is admitted under. Case, surrounding space and a trailing dot do not make a
 * second host; a missing host gets a key of its own, so it never serializes unrelated mailboxes.
 * The key stays in memory and is never logged.
 */
export function hostKeyOf(host: string | null | undefined, mailboxId: string): string {
  const h = (host ?? "").trim().toLowerCase().replace(/\.+$/, "");
  return h === "" ? `mailbox:${mailboxId}` : `host:${h}`;
}

/** End a connection without waiting on whatever command it is stuck in. */
function shut(adapter: MailboxAdapter): void {
  try {
    if (adapter.forceClose) adapter.forceClose();
    else void adapter.close().catch(() => { /* going away regardless */ });
  } catch { /* going away regardless */ }
}

class Ticket implements AttachTicket {
  aborted: AttachAbort | null = null;
  lost: { err: unknown } | null = null;
  adapter: MailboxAdapter | null = null;
  private rejectAborted!: (err: Error) => void;
  private readonly abortedSignal = new Promise<never>((_, reject) => { this.rejectAborted = reject; });

  constructor() {
    this.abortedSignal.catch(() => { /* observed through `abortable` */ });
  }

  abortable<T>(step: Promise<T>): Promise<T> {
    step.catch(() => { /* abandoned once aborted */ });
    if (this.aborted !== null) return Promise.reject(new AttachAbortedError(this.aborted));
    return Promise.race([step, this.abortedSignal]);
  }

  checkpoint(): void {
    if (this.aborted !== null) throw new AttachAbortedError(this.aborted);
    if (this.lost !== null) throw this.lost.err;
  }

  bind(adapter: MailboxAdapter): void {
    this.adapter = adapter;
    if (this.aborted !== null) shut(adapter);
  }

  abort(why: AttachAbort): void {
    if (this.aborted !== null) return;
    this.aborted = why;
    if (this.adapter) shut(this.adapter);
    this.rejectAborted(new AttachAbortedError(why));
  }
}

interface Entry {
  job: AttachJob;
  /** Resolves when the job settles, or is dropped while queued, with the error it rejected with. */
  done: Promise<unknown>;
  settle(fault: unknown): void;
  ticket?: Ticket;
  timer?: ReturnType<typeof setTimeout>;
  queuedAt: number;
  startedAt?: number;
}

export class AttachPool {
  private readonly queued: Entry[] = [];
  private readonly running = new Map<string, Entry>();
  private readonly busyHosts = new Set<string>();
  private closed = false;

  constructor(private readonly opts: AttachPoolOpts) {}

  /** Queue an attach. False when the mailbox is already queued or running, or the pool is closed. */
  enqueue(job: AttachJob): boolean {
    if (this.closed || this.state(job.mailboxId) !== null) return false;
    let settle!: (fault: unknown) => void;
    const done = new Promise<unknown>((r) => { settle = r; });
    this.queued.push({ job, done, settle, queuedAt: Date.now() });
    this.pump();
    return true;
  }

  /** Give a queued job this pass's row. A running job keeps the row it started with. */
  replaceQueued(mailboxId: string, run: (t: AttachTicket) => Promise<void>): boolean {
    const e = this.queued.find((q) => q.job.mailboxId === mailboxId);
    if (!e) return false;
    e.job = { ...e.job, run };
    return true;
  }

  /** Drop queued jobs (all, or those `pred` names). Running ones are never cancelled here. */
  dropQueued(pred: (mailboxId: string) => boolean = () => true): number {
    let n = 0;
    for (let i = this.queued.length - 1; i >= 0; i--) {
      const e = this.queued[i]!;
      if (!pred(e.job.mailboxId)) continue;
      this.queued.splice(i, 1);
      e.settle(null);
      n++;
    }
    return n;
  }

  state(mailboxId: string): "queued" | "running" | null {
    if (this.running.has(mailboxId)) return "running";
    return this.queued.some((q) => q.job.mailboxId === mailboxId) ? "queued" : null;
  }

  /** How long a running job waited in the queue for its slot and its host, for its start line. */
  queuedMs(mailboxId: string): number {
    const e = this.running.get(mailboxId);
    return e?.startedAt !== undefined ? Math.max(0, e.startedAt - e.queuedAt) : 0;
  }

  /**
   * The connection `adapter` was lost while its attach is still running: that attach throws `err`
   * at its next checkpoint. An adapter no running attach owns is ignored.
   */
  noteLost(mailboxId: string, adapter: MailboxAdapter, err: unknown): void {
    const t = this.running.get(mailboxId)?.ticket;
    if (!t || t.adapter !== adapter || t.lost !== null) return;
    t.lost = { err };
  }

  /** Close the pool: drop the queue and abort every running attach. */
  abortAll(): void {
    this.closed = true;
    this.dropQueued();
    for (const e of this.running.values()) e.ticket?.abort("stop");
  }

  /**
   * Resolves once every named job (default: all) has settled, with the first fault among them.
   * A job enqueued after this call is not waited for.
   */
  async settled(ids?: Iterable<string>): Promise<{ fault: unknown | null }> {
    const want = ids === undefined ? null : new Set(ids);
    const entries = [...this.queued, ...this.running.values()]
      .filter((e) => want === null || want.has(e.job.mailboxId));
    const faults = await Promise.all(entries.map((e) => e.done));
    return { fault: faults.find((f) => f !== null && f !== undefined) ?? null };
  }

  counts(): { queued: number; running: number } {
    return { queued: this.queued.length, running: this.running.size };
  }

  private pump(): void {
    while (!this.closed && this.running.size < this.opts.concurrency) {
      const at = this.queued.findIndex((q) => !this.busyHosts.has(q.job.hostKey));
      if (at < 0) return;
      const e = this.queued.splice(at, 1)[0]!;
      this.start(e);
    }
  }

  private start(e: Entry): void {
    const { job } = e;
    const ticket = new Ticket();
    e.ticket = ticket;
    e.startedAt = Date.now();
    this.running.set(job.mailboxId, e);
    this.busyHosts.add(job.hostKey);
    e.timer = setTimeout(() => {
      if (ticket.aborted !== null) return;
      ticket.abort("deadline");
      this.opts.onDeadline({ mailboxId: job.mailboxId, accountId: job.accountId });
    }, this.opts.deadlineMs);
    // A microtask, so `enqueue` never runs attach code inside the caller's synchronous section.
    void Promise.resolve()
      .then(() => job.run(ticket))
      .then(() => null, (err: unknown) => err ?? new Error("attach rejected"))
      .then((fault) => {
        clearTimeout(e.timer);
        this.running.delete(job.mailboxId);
        this.busyHosts.delete(job.hostKey);
        if (fault !== null) {
          try { this.opts.onFault(fault); } catch { /* the fault is still reported to `settled` */ }
        }
        e.settle(fault);
        this.pump();
      });
  }
}
