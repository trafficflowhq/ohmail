import { describe, it, expect, beforeEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { readEngineAsOneText } from "../../../test/support/engine-unit.js";
import {
  armFirstPageGate, awaitFirstPage, FIRST_PAGE_GRACE_MS, noteFirstPageServed, resetFirstPageGate,
} from "../src/first-page-gate.js";
import { encodeFrame, PROTOCOL_VERSION } from "../src/frame.js";
import { serveOverStdio } from "../src/host.js";

/**
 * ═══ THE BOOT DRAIN YIELDS TO THE READER'S FIRST PAGE ════════════════════════════════════════
 *
 * `store-lanes.ts` shares the one connection by weight, and the weight cannot preempt inside a
 * TRANSACTION — one admission for the whole body. Measured on a large mirror: a read
 * alone 180 ms, beside loose ingest statements 561 ms, beside one 4 000 ms ingest transaction
 * 4 178 ms. So on a cold start the boot drain sat in front of the first list row, ten runs of ten.
 *
 * The ordering is what this file holds, on both sides: the drain waits, and it never waits for
 * ever. Each case was watched RED against a mutation of the line that decides.
 */
beforeEach(() => resetFirstPageGate());

/** A promise's state without awaiting it — "did the drain go?" is the whole question here. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  return (await Promise.race([p, Promise.resolve(marker)])) !== marker;
}

describe("the gate the boot drain waits on", () => {
  it("holds the drain while no page has been served", async () => {
    armFirstPageGate();
    const waiting = awaitFirstPage(10_000);

    // Microtasks drain here; nothing has served a page, so the drain must still be waiting.
    expect(await settled(waiting)).toBe(false);

    noteFirstPageServed();
    await expect(waiting).resolves.toBe("served");
  });

  it("lets the drain go when the grace runs out and nobody asked", async () => {
    armFirstPageGate();
    await expect(awaitFirstPage(5)).resolves.toBe("timed-out");
  });

  /**
   * THE GRACE RUNS FROM THE DOOR, NOT FROM THE WAIT. Otherwise a slow store open is paid twice —
   * once opening, then again waiting — and the bound would no longer bound the start.
   */
  it("counts the grace from when the door opened", async () => {
    const t0 = 10_000;
    armFirstPageGate(t0);
    // The drain reaches the gate 1 490 ms later: 10 ms of the 1 500 ms grace is left, so this
    // resolves on its own. With the grace counted from the WAIT it would sit here for 1.5 s.
    // On a fake clock: open one tick short of what is left, gone at it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = Date.now();
      const waiting = awaitFirstPage(FIRST_PAGE_GRACE_MS, t0 + FIRST_PAGE_GRACE_MS - 10);
      await vi.advanceTimersByTimeAsync(9);
      expect(await settled(waiting), "the drain went before what was left of the grace").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await settled(waiting), "the drain sat past what was left of the grace").toBe(true);
      await expect(waiting).resolves.toBe("timed-out");
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait at all once the grace is already spent", async () => {
    armFirstPageGate(10_000);
    await expect(awaitFirstPage(FIRST_PAGE_GRACE_MS, 20_000)).resolves.toBe("timed-out");
  });

  /**
   * AN UNARMED GATE GETS THE WHOLE BOUND, NOT NONE OF IT. A build with no door never arms, and the
   * failure to arm must become neither a drain that waits for ever nor one that never waits.
   */
  it("gives an unarmed gate the full grace", async () => {
    const waiting = awaitFirstPage(10_000);
    expect(await settled(waiting)).toBe(false);
    noteFirstPageServed();
    await expect(waiting).resolves.toBe("served");
  });

  /* AN UNARMED GATE PAYS ONCE PER PROCESS. The phone's door never arms it, and every one of its
     drains waited the whole grace: a Move took the next cycle plus 1.5 s to reach the wire. */
  it("a second unarmed wait after the grace does not wait again", async () => {
    const first = awaitFirstPage(20, 10_000);
    expect(await settled(first), "the first unarmed wait did not wait").toBe(false);
    await expect(first).resolves.toBe("timed-out");
    const second = awaitFirstPage(20, 10_000 + 20);
    expect(await settled(second), "the second drain waited the grace again").toBe(true);
  });

  it("an unarmed gate on the default clock waits only what is left", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    try {
      const first = awaitFirstPage(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toBe("timed-out");
      const second = awaitFirstPage(1_000);
      expect(await settled(second), "the second drain waited the grace again").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds one start only — a later drain never waits again", async () => {
    armFirstPageGate();
    noteFirstPageServed();
    await expect(awaitFirstPage(10_000)).resolves.toBe("already");
  });

  it("is idempotent, so a second page cannot resolve a settled wait", async () => {
    armFirstPageGate();
    const waiting = awaitFirstPage(10_000);
    noteFirstPageServed();
    noteFirstPageServed();
    await expect(waiting).resolves.toBe("served");
  });
});

// ── THE DOOR'S HALF, driven through the real `serveOverStdio` ─────────────────────────────────

/** One request frame in, the door's answer awaited, and every line it logged. */
async function ask(url: string): Promise<Array<[string, Record<string, unknown>]>> {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const lines: Array<[string, Record<string, unknown>]> = [];
  const host = serveOverStdio({
    input, output,
    log: (event, detail) => { lines.push([event, detail]); },
    handle: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  });
  input.write(encodeFrame({
    v: PROTOCOL_VERSION, t: "req", id: 1, method: "GET", url, h: [],
  }));
  input.end();
  await host.finished();
  host.stop();
  return lines;
}

describe("the door releases the gate", () => {
  it("on the bootstrap page", async () => {
    armFirstPageGate();
    const waiting = awaitFirstPage(10_000);
    await ask("http://sidecar/sync/snapshot");
    await expect(waiting).resolves.toBe("served");
  });

  /* THE CONTROL, and the reason the match is on the route rather than on "any request": the delta
     reader runs on every poll for the life of the process, so a gate released by it would be a
     gate released by something that is not the reader's first page at all. */
  it("and on nothing else", async () => {
    armFirstPageGate();
    const waiting = awaitFirstPage(10_000);
    await ask("http://sidecar/sync?since=0");
    expect(await settled(waiting)).toBe(false);
    noteFirstPageServed();
    await waiting;
  });
});

// ── THE WIRING, read as source ───────────────────────────────────────────────────────────────
//
// The drain lives inside a world a unit test cannot assemble — a connection, a roster, a
// classifier — so the ORDER of these two calls is asserted where it is written. A gate that is
// awaited AFTER the drain, or not at all, is the whole defect this lane exists about, and it
// would leave every case above green.

describe("the drain is wired to the gate", () => {
  const src = readEngineAsOneText();

  /* The wait has one spelling, `yieldToFirstPage`, which the poll's drain and the launch's call. */
  it("awaits the first page BEFORE it drains", () => {
    const helper = src.indexOf("const yieldToFirstPage = ");
    expect(src.slice(helper, helper + 200), "the helper does not wait for the gate").toContain("await awaitFirstPage(");
    const gate = src.indexOf("await yieldToFirstPage(");
    const drain = src.indexOf("await drainPass(");
    expect(gate, "the drain does not wait for the first page at all").toBeGreaterThan(-1);
    expect(drain, "the drain call could not be found").toBeGreaterThan(-1);
    expect(gate).toBeLessThan(drain);
  });

  it("and a forced drain does not wait — somebody is at the screen", () => {
    const gate = src.indexOf("await yieldToFirstPage(");
    // The guard immediately in front of the wait, not merely somewhere in the file.
    expect(src.slice(Math.max(0, gate - 40), gate)).toContain("opts.force !== true");
  });

  it("says which arm released it, in two lines a rig can tell apart", () => {
    expect(src).toContain('log("first_page_before_drain"');
    expect(src).toContain('log("first_page_grace_expired"');
  });
});

/**
 * ═══ WHAT THE BOOTSTRAP COST, ON A SHIPPED BUILD ═════════════════════════════════════════════
 *
 * The cold-start path logged nothing: a `snapshot` grep over a whole run's engine log read zero,
 * so page count, page size and the server's time per page were unreadable outside a rig.
 */
describe("the door says what each bootstrap page cost", () => {
  it("one line per page, with its size and its time", async () => {
    const lines = await ask("http://sidecar/sync/snapshot");
    const pages = lines.filter(([event]) => event === "snapshot_page");
    expect(pages).toHaveLength(1);
    expect(pages[0]![1]).toHaveProperty("bytes");
    expect(pages[0]![1]).toHaveProperty("pageMs");
    expect(typeof pages[0]![1].bytes).toBe("number");
  });

  /* The delta reader runs on every poll for the life of the process; a line per `/sync` would
     bury the twenty that matter under thousands that do not. */
  it("and nothing for the delta reader beside it", async () => {
    const lines = await ask("http://sidecar/sync?since=0");
    expect(lines.filter(([event]) => event === "snapshot_page")).toHaveLength(0);
  });
});
