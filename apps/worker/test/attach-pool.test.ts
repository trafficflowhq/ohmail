import { describe, it, expect, vi, afterEach } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  AttachPool, AttachAbortedError, hostKeyOf, type AttachTicket,
} from "../src/attach-pool.js";

/**
 * THE ATTACH POOL'S SCHEDULING, with no database and no IMAP (CLOUD-ROSTER-REATTACH-IS-SERIAL).
 * Every job here is a promise the test resolves by hand, so each claim is about which jobs are
 * running at a moment, never about how long anything took.
 */

interface Held {
  id: string;
  ticket: AttachTicket;
  finish(): void;
  fail(err: unknown): void;
}

function harness(o: { concurrency: number; deadlineMs?: number }) {
  const running = new Map<string, Held>();
  const started: string[] = [];
  const deadlines: string[] = [];
  const faults: unknown[] = [];
  let peak = 0;
  const pool = new AttachPool({
    concurrency: o.concurrency,
    deadlineMs: o.deadlineMs ?? 60_000,
    onDeadline: (j) => { deadlines.push(j.mailboxId); },
    onFault: (err) => { faults.push(err); },
  });
  function add(id: string, host: string): boolean {
    return pool.enqueue({
      mailboxId: id, accountId: `acct-${id}`, hostKey: hostKeyOf(host, id),
      run: (ticket) => new Promise<void>((resolve, reject) => {
        started.push(id);
        running.set(id, {
          id, ticket,
          finish: () => { running.delete(id); resolve(); },
          fail: (err) => { running.delete(id); reject(err); },
        });
        peak = Math.max(peak, running.size);
      }),
    });
  }
  return { pool, add, running, started, deadlines, faults, peak: () => peak };
}

/** Let the pool's microtasks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function fakeAdapter(withForce: boolean): MailboxAdapter & { forced: number; closed: number } {
  const a = {
    forced: 0, closed: 0,
    async close() { a.closed++; },
    ...(withForce ? { forceClose() { a.forced++; } } : {}),
  };
  return a as unknown as MailboxAdapter & { forced: number; closed: number };
}

afterEach(() => { vi.useRealTimers(); });

describe("the attach pool's bound", () => {
  it("runs at most N at once over ten hosts, and exactly N while the queue is longer", async () => {
    const h = harness({ concurrency: 4 });
    for (let i = 0; i < 10; i++) h.add(`m${i}`, `imap${i}.example`);
    await flush();
    expect(h.running.size).toBe(4);
    while (h.running.size > 0) {
      [...h.running.values()][0]!.finish();
      await flush();
      expect(h.running.size).toBeLessThanOrEqual(4);
    }
    expect(h.peak()).toBe(4);
    expect(h.started).toHaveLength(10);
  });

  it("is the serial walk at N=1", async () => {
    const h = harness({ concurrency: 1 });
    for (let i = 0; i < 3; i++) h.add(`m${i}`, `imap${i}.example`);
    await flush();
    while (h.running.size > 0) { [...h.running.values()][0]!.finish(); await flush(); }
    expect(h.peak()).toBe(1);
    expect(h.started).toEqual(["m0", "m1", "m2"]);
  });
});

describe("one attach per provider host", () => {
  it("holds a second mailbox of a busy host and admits the jobs behind it", async () => {
    const h = harness({ concurrency: 4 });
    h.add("s1", "slow.example");
    h.add("s2", "slow.example");
    h.add("f1", "fast1.example");
    h.add("f2", "fast2.example");
    await flush();
    // s2 is skipped, not waited behind: f1 and f2 start beside s1.
    expect([...h.running.keys()].sort()).toEqual(["f1", "f2", "s1"]);
    expect(h.pool.state("s2")).toBe("queued");
    h.running.get("f1")!.finish();
    await flush();
    expect(h.pool.state("s2"), "a free slot does not admit a job of a busy host").toBe("queued");
    h.running.get("s1")!.finish();
    await flush();
    expect(h.pool.state("s2")).toBe("running");
  });

  it("reports how long a job waited for its host, and not how long it has run", async () => {
    vi.useFakeTimers();
    const h = harness({ concurrency: 4 });
    h.add("s1", "slow.example");
    h.add("s2", "slow.example");
    await flush();
    vi.advanceTimersByTime(500);
    h.running.get("s1")!.finish();
    await flush();
    expect(h.pool.queuedMs("s2")).toBe(500);
    vi.advanceTimersByTime(300);
    expect(h.pool.queuedMs("s2")).toBe(500);
    expect(h.pool.queuedMs("s1"), "a settled job has no wait to report").toBe(0);
  });

  it("reads one host however it is spelled, and gives a missing host a key of its own", () => {
    expect(hostKeyOf(" IMAP.Example.COM. ", "a")).toBe(hostKeyOf("imap.example.com", "b"));
    expect(hostKeyOf("", "a")).not.toBe(hostKeyOf("", "b"));
    expect(hostKeyOf(null, "a")).not.toBe(hostKeyOf(undefined, "b"));
  });

  it("never queues one mailbox twice", async () => {
    const h = harness({ concurrency: 2 });
    expect(h.add("m", "a.example")).toBe(true);
    expect(h.add("m", "b.example")).toBe(false);
    await flush();
    expect(h.add("m", "a.example"), "a running mailbox is not queued again").toBe(false);
    h.running.get("m")!.finish();
    await flush();
    expect(h.add("m", "a.example")).toBe(true);
  });
});

describe("the deadline", () => {
  it("force-closes the bound connection and keeps the keys until the job settles", async () => {
    vi.useFakeTimers();
    const h = harness({ concurrency: 4, deadlineMs: 1_000 });
    h.add("s", "slow.example");
    h.add("s2", "slow.example");
    await flush();
    const a = fakeAdapter(true);
    h.running.get("s")!.ticket.bind(a);
    vi.advanceTimersByTime(1_000);
    expect(a.forced).toBe(1);
    expect(h.deadlines).toEqual(["s"]);
    expect(h.running.get("s")!.ticket.aborted).toBe("deadline");
    expect(() => h.running.get("s")!.ticket.checkpoint()).toThrow(AttachAbortedError);
    // Still running until it unwinds: the host is not free for s2 on a timer.
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(h.pool.state("s")).toBe("running");
    expect(h.pool.state("s2")).toBe("queued");
    h.running.get("s")!.finish();
    await flush();
    expect(h.pool.state("s2")).toBe("running");
  });

  it("falls back to close() on an adapter without forceClose, and closes one bound after the fact", async () => {
    vi.useFakeTimers();
    const h = harness({ concurrency: 1, deadlineMs: 500 });
    h.add("m", "a.example");
    await flush();
    vi.advanceTimersByTime(500);
    const late = fakeAdapter(false);
    h.running.get("m")!.ticket.bind(late);
    expect(late.closed).toBe(1);
  });
});

describe("stop, drop and replace", () => {
  it("abortAll drops the queue, aborts the running and settled() waits for them", async () => {
    const h = harness({ concurrency: 1 });
    h.add("a", "a.example");
    h.add("b", "b.example");
    await flush();
    const ad = fakeAdapter(true);
    h.running.get("a")!.ticket.bind(ad);
    h.pool.abortAll();
    expect(ad.forced).toBe(1);
    expect(h.running.get("a")!.ticket.aborted).toBe("stop");
    expect(h.pool.state("b")).toBeNull();
    let done = false;
    const s = h.pool.settled().then(() => { done = true; });
    await flush();
    expect(done, "settled() resolved while an attach was still running").toBe(false);
    h.running.get("a")!.finish();
    await s;
    expect(h.started).toEqual(["a"]);
    expect(h.add("c", "c.example"), "a closed pool takes nothing").toBe(false);
  });

  it("drops and replaces only queued jobs", async () => {
    const h = harness({ concurrency: 1 });
    h.add("a", "a.example");
    h.add("b", "b.example");
    h.add("c", "c.example");
    await flush();
    expect(h.pool.dropQueued((id) => id === "a" || id === "b")).toBe(1);
    expect(h.pool.state("a")).toBe("running");
    expect(h.pool.replaceQueued("a", async () => { /* never */ })).toBe(false);
    let replaced = false;
    expect(h.pool.replaceQueued("c", async () => { replaced = true; })).toBe(true);
    h.running.get("a")!.finish();
    await h.pool.settled();
    expect(replaced).toBe(true);
    expect(h.started).toEqual(["a"]);
  });

  it("reports a rejected job as a fault, to the hook and to settled()", async () => {
    const h = harness({ concurrency: 2 });
    h.add("a", "a.example");
    h.add("b", "b.example");
    await flush();
    const boom = Object.assign(new Error("db down"), { code: "57P01" });
    h.running.get("a")!.fail(boom);
    h.running.get("b")!.finish();
    expect((await h.pool.settled()).fault).toBe(boom);
    expect(h.faults).toEqual([boom]);
  });

  it("throws a lost connection's error at the next checkpoint of the attach that owns it", async () => {
    const h = harness({ concurrency: 1 });
    h.add("a", "a.example");
    await flush();
    const mine = fakeAdapter(true);
    const other = fakeAdapter(true);
    const t = h.running.get("a")!.ticket;
    t.bind(mine);
    const err = new Error("closed");
    h.pool.noteLost("a", other, err);
    expect(() => t.checkpoint(), "another adapter's loss is not this attach's").not.toThrow();
    h.pool.noteLost("a", mine, err);
    expect(() => t.checkpoint()).toThrow(err);
  });
});

describe("a step that ignores the close", () => {
  /** What an abortable step settled as: its value, the abort's reason, or another error. */
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then((v) => `value:${String(v)}`, (e: unknown) => (e instanceof AttachAbortedError ? e.why : "other"));

  it("is settled by the deadline: a dial imapflow never ends still lets the job unwind", async () => {
    vi.useFakeTimers();
    const h = harness({ concurrency: 4, deadlineMs: 1_000 });
    h.add("s", "slow.example");
    await flush();
    const t = h.running.get("s")!.ticket;
    let settled = "pending";
    void outcome(t.abortable(new Promise<never>(() => { /* a dial closed mid-handshake */ })))
      .then((o) => { settled = o; });
    await flush();
    expect(settled).toBe("pending");
    vi.advanceTimersByTime(1_000);
    await flush();
    expect(settled).toBe("deadline");
  });

  it("is settled by a stop, and a step started after the abort is refused at once", async () => {
    const h = harness({ concurrency: 1 });
    h.add("a", "a.example");
    await flush();
    const t = h.running.get("a")!.ticket;
    const hung = outcome(t.abortable(new Promise<never>(() => { /* never */ })));
    h.pool.abortAll();
    expect(await hung).toBe("stop");
    expect(await outcome(t.abortable(Promise.resolve(1)))).toBe("stop");
  });

  it("passes a step's own value and error through while nothing aborted it", async () => {
    const h = harness({ concurrency: 1 });
    h.add("a", "a.example");
    await flush();
    const t = h.running.get("a")!.ticket;
    expect(await outcome(t.abortable(Promise.resolve(7)))).toBe("value:7");
    expect(await outcome(t.abortable(Promise.reject(new Error("refused"))))).toBe("other");
  });
});
