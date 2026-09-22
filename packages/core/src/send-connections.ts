import { IMAP_READ_DEADLINE_MS } from "./adapters/imap-bounds.js";
import type { OutboundMessage, SendAdapter } from "./send.js";

/**
 * A connected send adapter that can say whether its connection is still there. `ImapAdapter`
 * answers from imapflow's own `usable` flag; a double without the method is never kept.
 */
export type WarmSendAdapter = SendAdapter & { isLive?(): boolean };

/** The idle clock, injectable so a test drives it without waiting out the deadline. */
export interface KeepTimers {
  set(fn: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

interface Kept {
  readonly mailboxId: string;
  readonly real: SendAdapter & { isLive(): boolean };
  leases: number;
  idle: unknown;
}

/**
 * THE SEND PATH REUSES A LIVE CONNECTION AND DIALS ONLY WHEN NONE EXISTS. Every press of Send
 * dialled, handshook, LOGINed and LISTed a fresh IMAP connection for one APPEND — on some
 * providers the largest and most variable phase of the send. A connection a press releases is
 * kept for at most the adapter's own read deadline (no new number), a dial in flight is shared
 * by a second press, a kept connection that died is dropped and re-dialled, and nothing here
 * outlives that ceiling: the idle timer closes it, `closeAll` closes it at host shutdown.
 */
export class SendConnections {
  private readonly kept = new Map<string, Kept>();
  private readonly dialling = new Map<string, Promise<SendAdapter>>();
  private readonly idleMs: number;
  private readonly timers: KeepTimers;

  constructor(opts: { idleMs?: number; timers?: KeepTimers } = {}) {
    this.idleMs = opts.idleMs ?? IMAP_READ_DEADLINE_MS;
    this.timers = opts.timers ?? {
      set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
      clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    };
  }

  /**
   * The one door. A live kept connection is leased; a dial in flight is awaited and its result
   * leased; otherwise `dial` runs once and its connection is kept. A result without `isLive` —
   * every hand-written double — is handed back as it is and never kept.
   */
  async open(mailboxId: string, dial: () => Promise<WarmSendAdapter>): Promise<SendAdapter> {
    const entry = this.kept.get(mailboxId);
    if (entry !== undefined) {
      if (entry.real.isLive()) return this.lease(entry);
      // Died while idle: the next press re-dials rather than failing on a socket that is gone.
      this.drop(entry);
      entry.real.forceClose?.();
    }
    const pending = this.dialling.get(mailboxId);
    if (pending !== undefined) return pending.then(() => this.open(mailboxId, dial));
    const dialled = (async (): Promise<SendAdapter> => {
      const real = await dial();
      if (typeof real.isLive !== "function") return real;
      const fresh: Kept = { mailboxId, real: real as Kept["real"], leases: 0, idle: null };
      this.kept.set(mailboxId, fresh);
      return this.lease(fresh);
    })();
    this.dialling.set(mailboxId, dialled);
    try { return await dialled; } finally { this.dialling.delete(mailboxId); }
  }

  /** How many connections are kept right now (tests and vitals). */
  size(): number { return this.kept.size; }

  /** Close every kept connection now — the host is going down. */
  async closeAll(): Promise<void> {
    const all = [...this.kept.values()];
    for (const entry of all) this.drop(entry);
    await Promise.all(all.map((e) => e.real.close().catch(() => { /* already gone */ })));
  }

  private lease(entry: Kept): SendAdapter {
    entry.leases += 1;
    if (entry.idle !== null) { this.timers.clear(entry.idle); entry.idle = null; }
    // ONE release per lease: the send path closes in a `finally` and a follower may close again.
    let released = false;
    return {
      send: (msg: OutboundMessage) => entry.real.send(msg),
      messageInSent: (id: string) => entry.real.messageInSent(id),
      close: async () => {
        if (released) return;
        released = true;
        await this.release(entry);
      },
      forceClose: () => {
        if (!released) { released = true; entry.leases = Math.max(0, entry.leases - 1); }
        this.drop(entry);
        entry.real.forceClose?.();
      },
    };
  }

  private async release(entry: Kept): Promise<void> {
    entry.leases = Math.max(0, entry.leases - 1);
    if (entry.leases > 0) return;
    if (this.kept.get(entry.mailboxId) !== entry || !entry.real.isLive()) {
      this.drop(entry);
      await entry.real.close().catch(() => { /* already gone */ });
      return;
    }
    entry.idle = this.timers.set(() => {
      entry.idle = null;
      if (this.kept.get(entry.mailboxId) !== entry || entry.leases > 0) return;
      this.kept.delete(entry.mailboxId);
      void entry.real.close().catch(() => { /* already gone */ });
    }, this.idleMs);
  }

  private drop(entry: Kept): void {
    if (entry.idle !== null) { this.timers.clear(entry.idle); entry.idle = null; }
    if (this.kept.get(entry.mailboxId) === entry) this.kept.delete(entry.mailboxId);
  }
}
