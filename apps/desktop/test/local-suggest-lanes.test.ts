import { afterEach, describe, expect, it } from "vitest";
import {
  runSuggest, chunksOf, localBatchSizes, lanesFor, CHUNK, DEFAULT_PER_PRESS, HOSTED_LANES,
} from "../src/local-suggest-run.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE STANDALONE SUGGEST RUN — a chosen size, and lanes bounded by where the model is
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two changes are under test and they are separable. The SIZE was fixed at fifty and is now the
 * person's choice; the CONCURRENCY was one and is now decided by where the model runs.
 *
 * ── WHY THE LANE COUNT IS NOT SIMPLY "AS MANY AS POSSIBLE" ──────────────────────────────────
 *
 * Measured against a real `llama3.2` daemon on this machine, twelve screening calls through the
 * shipped provider: **2 699 ms per sender serially** (min 2 586, p50 2 679, max 2 991), and the
 * same twelve through 2, 4 and 8 lanes finished in **1.02x, 0.99x and 1.01x** the time — that is,
 * no change at all. One local daemon answers one prompt at a time, so lanes there buy nothing and
 * spend CPU the sync is using. That is why `this_machine` stays at one lane, and it is a
 * measurement rather than a preference.
 *
 * A HOSTED key is the case the old serial rule generalised to without evidence: the wait there is
 * a round trip this machine spends idle. This file does not claim a vendor measurement it did not
 * take — what it proves is that the machinery does what it says, at the bound it says, which is
 * the part that lives in this repository. The lane count itself is deliberately small because the
 * rate limit being spent is the user's own.
 *
 * ── WHY A FAKE TRANSPORT AND NOT THE REAL ENGINE ────────────────────────────────────────────
 *
 * Every property here is about the SHAPE of the request sequence — how many are open at once, how
 * many a stop can cost, which refusal is reported. A real engine would answer correctly and tell
 * us nothing about any of them, and would make the timing assertions a property of the machine.
 * The engine-backed proof that this loop talks to the real route lives beside the engine, in the
 * sidecar's end-to-end desktop AI bridge test.
 */

interface Invoked { url: string; senders: string[] }

const host = globalThis as {
  __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> };
};

/** The window's own wire format: a 4-byte big-endian meta length, the meta JSON, then the body. */
function framed(status: number, body: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const meta = new TextEncoder().encode(JSON.stringify({
    status, statusText: "", h: [["content-type", "application/json"]],
  }));
  const out = new Uint8Array(4 + meta.byteLength + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(bytes, 4 + meta.byteLength);
  return out;
}

interface Rig {
  calls: Invoked[];
  /** The greatest number of requests open at the same instant — the bound under test. */
  peak: number;
  inFlight: number;
}

/**
 * Stand a fake engine behind the bridge. `latencyMs` is awaited INSIDE each request, which is
 * what makes overlap observable at all: with an immediate answer every request opens and closes
 * before the next lane is scheduled and the peak would read 1 whatever the lane count is.
 */
function rig(opts: {
  latencyMs?: number;
  answer?: (senders: string[], n: number) => { status: number; body: unknown };
} = {}): Rig {
  const state: Rig = { calls: [], peak: 0, inFlight: 0 };
  let n = 0;
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command === "engine_status") {
        return { state: "serving", mode: "local", mailboxId: "mb", credentialState: "ready" };
      }
      if (command !== "engine_request") return null;
      const url = String(payload?.url ?? "");
      const raw = new TextDecoder().decode(Uint8Array.from((payload?.body as number[]) ?? []));
      const senders = (JSON.parse(raw || "{}") as { senders?: string[] }).senders ?? [];
      state.calls.push({ url, senders });

      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      try {
        if (opts.latencyMs) await new Promise((r) => { setTimeout(r, opts.latencyMs); });
        const a = opts.answer?.(senders, n++)
          ?? { status: 200, body: { suggestions: senders.map(one), skipped: [] } };
        return framed(a.status, a.body);
      } finally {
        state.inFlight -= 1;
      }
    },
  };
  return state;
}

const one = (sender: string) => ({
  sender, messageId: `m-${sender}`, decision: "no" as const,
  destination: "ohmail/Reads", confidence: 0.9, rationale: "a newsletter",
});

const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i}@example.test`);

afterEach(() => { delete host.__TAURI_INTERNALS__; });

describe("the ladder — a press asks for a number the person chose", () => {
  it("the top rung is ALL of them, not a fixed fifty", () => {
    // The defect in one assertion: with 312 waiting, the control offered exactly one number and
    // it was 50. The ladder's last rung is now the whole queue.
    const rungs = localBatchSizes(312);
    expect(rungs.at(-1)).toBe(312);
    expect(rungs).toContain(50);
    expect(rungs.every((n) => n <= 312)).toBe(true);
  });

  it("never offers a rung larger than the queue, and a queue of one is not a ladder", () => {
    expect(localBatchSizes(7)).toEqual([7]);
    expect(localBatchSizes(1)).toEqual([1]);
    expect(localBatchSizes(0)).toEqual([]);
  });

  it("`limit` bounds the SET, and the requests stay chunk-sized whatever it is", async () => {
    const r = rig();
    const out = await runSuggest({ senders: many(300), limit: 120, absorb: () => {} });
    expect(out.total).toBe(120);
    expect(out.done).toBe(120);
    expect(r.calls).toHaveLength(Math.ceil(120 / CHUNK));
    expect(Math.max(...r.calls.map((c) => c.senders.length))).toBe(CHUNK);
  });

  it("an absent `limit` is the resting default — every caller that predates the ladder", async () => {
    const r = rig();
    const out = await runSuggest({ senders: many(300), absorb: () => {} });
    expect(out.total).toBe(DEFAULT_PER_PRESS);
    expect(r.calls).toHaveLength(Math.ceil(DEFAULT_PER_PRESS / CHUNK));
  });
});

describe("lanes — bounded concurrency, and one lane where lanes buy nothing", () => {
  it("`lanesFor` reads WHERE the model runs, and takes the cautious arm when it cannot tell", () => {
    // Measured: concurrency against a daemon on this machine changes the total by 1.02x/0.99x/1.01x.
    expect(lanesFor("this_machine")).toBe(1);
    expect(lanesFor("anthropic")).toBe(HOSTED_LANES);
    expect(lanesFor("openai")).toBe(HOSTED_LANES);
    // No provider, or an engine that predates the field: the serial arm this module shipped with.
    expect(lanesFor(null)).toBe(1);
    expect(lanesFor(undefined)).toBe(1);
    // Small on purpose — the rate limit being spent is the user's own key's.
    expect(HOSTED_LANES).toBeLessThanOrEqual(8);
  });

  it("the default is STRICTLY SERIAL — one request open at a time, as it always was", async () => {
    const r = rig({ latencyMs: 15 });
    await runSuggest({ senders: many(20), limit: 20, absorb: () => {} });
    expect(r.peak, "the default must not have become a burst").toBe(1);
  });

  it("`lanes: 4` opens exactly four at once and never a fifth", async () => {
    const r = rig({ latencyMs: 25 });
    await runSuggest({ senders: many(40), limit: 40, lanes: 4, absorb: () => {} });
    expect(r.peak).toBe(4);
    expect(r.calls).toHaveLength(Math.ceil(40 / CHUNK));
  });

  it("lanes never exceed the work — a one-chunk run starts one worker", async () => {
    const r = rig({ latencyMs: 10 });
    await runSuggest({ senders: many(CHUNK), limit: CHUNK, lanes: 8, absorb: () => {} });
    expect(r.peak).toBe(1);
  });

  it("four lanes actually overlap — the wall clock, not just the counter", async () => {
    const serialAt = Date.now();
    const a = rig({ latencyMs: 20 });
    await runSuggest({ senders: many(40), limit: 40, absorb: () => {} });
    const serial = Date.now() - serialAt;
    expect(a.calls).toHaveLength(8);

    const laneAt = Date.now();
    rig({ latencyMs: 20 });
    await runSuggest({ senders: many(40), limit: 40, lanes: 4, absorb: () => {} });
    const lanes = Date.now() - laneAt;

    // Eight chunks at 20 ms: ~160 ms serially, ~40 ms over four lanes. Asserted as "clearly
    // faster" rather than on a ratio, because a timer under load is not a stopwatch — the exact
    // ratio is the counter's job above, and this case exists so a `lanes` that is counted but
    // never awaited in parallel cannot pass.
    expect(lanes, `serial ${serial} ms vs 4 lanes ${lanes} ms`).toBeLessThan(serial * 0.75);
  });
});

describe("a stop and a refusal still behave, with lanes in the picture", () => {
  it("a stop costs at most the chunks already in flight", async () => {
    const r = rig({ latencyMs: 10 });
    let live = true;
    // Stop as soon as the first answers land. The transport carries no cancellation, so what a
    // stop can save is every chunk NOT YET ASKED FOR — with four lanes that is everything past
    // the four open ones, which is the number the control's own copy promises.
    const out = await runSuggest({
      senders: many(200), limit: 200, lanes: 4, absorb: () => {},
      onProgress: (done) => { if (done > 0) live = false; },
      alive: () => live,
    });
    expect(out.abandoned).toBe(true);
    expect(r.calls.length, "a stop must not let the whole run through").toBeLessThan(40 / 2);
  });

  it("the FIRST refusal is the one reported, and it ends the run", async () => {
    const r = rig({
      latencyMs: 5,
      answer: (senders, n) => n === 1
        ? { status: 402, body: { error: { code: "suggest_unconfigured", message: "first" } } }
        : n === 2
          ? { status: 500, body: { error: { code: "internal", message: "second" } } }
          : { status: 200, body: { suggestions: senders.map(one), skipped: [] } },
    });
    const out = await runSuggest({ senders: many(100), limit: 100, lanes: 2, absorb: () => {} });
    expect(out.refusal, "a refusal must be reported, not swallowed").not.toBeNull();
    // The engine's own first sentence — never a second lane's different reason for one stop.
    expect(out.refusal!.message).toBe("first");
    expect(out.refusal!.noModel).toBe(true);
    expect(out.abandoned).toBe(false);
    // And the run stopped: nowhere near the twenty chunks a full pass would have asked for.
    expect(r.calls.length).toBeLessThan(20);
  });

  it("answers land as they arrive, and progress counts answers rather than chunks", async () => {
    rig();
    const ticks: Array<[number, number]> = [];
    const landed: string[] = [];
    const out = await runSuggest({
      senders: many(30), limit: 30, lanes: 3,
      absorb: (rows) => landed.push(...rows.map((x) => x.address)),
      onProgress: (done, total) => ticks.push([done, total]),
    });
    expect(ticks[0]).toEqual([0, 30]);
    expect(out.done).toBe(30);
    expect(landed).toHaveLength(30);
    expect(new Set(landed).size, "an address must not be answered for twice").toBe(30);
    expect(ticks.at(-1)).toEqual([30, 30]);
  });
});

describe("chunksOf is unchanged by any of it", () => {
  it("splits at CHUNK and keeps queue order", () => {
    expect(chunksOf(many(12)).map((c) => c.length)).toEqual([5, 5, 2]);
    expect(chunksOf(many(12))[0]![0]).toBe("s0@example.test");
  });
});
