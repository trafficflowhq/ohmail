import { describe, expect, it } from "vitest";
import {
  OhmailEngine,
  MutationRejectedError,
  screenerSegments,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * GAP "when I select one as ohbox, it does not seem to work", and then it does.
 *
 * Reported twice and never, until this file, held down by a test.
 *
 * ## THE MECHANISM
 *
 * `dispatch` turns an empty `changes` echo into `await this.syncOnce()`, and `syncOnce`
 * COALESCES onto whatever drain is already running. A drain that was issued BEFORE the
 * mutation's POST committed cannot carry that mutation's `change_log` rows — it read the log
 * at a seq below them. The engine awaits it anyway, concludes the write landed, deletes the
 * optimistic overlay and returns `confirmed`. The mail snaps back to the Screener until the
 * next 8 s poll.
 *
 * Which means it depends entirely on whether a poll happens to be in flight when the user
 * clicks. That is the whole of "it does not seem to work, then it does".
 *
 * ## WHAT THE HARNESS MODELS, AND WHY IT IS NOT A CONTRIVANCE
 *
 * {@link stalledSyncAdapter} does two things the real wire does and the FixturesAdapter does
 * not:
 *
 *  1. `sync` READS THE LOG WHEN THE REQUEST IS ISSUED and only then stalls in transit. That is
 *     what a server does — the response is a snapshot taken at arrival, so a request issued
 *     before a commit cannot see it however long the response takes to come back. Holding the
 *     read instead of the response would model a server that time-travels, and would hide the
 *     defect.
 *  2. `mutate` COMMITS and answers `{changes: []}`. That is the real contract for six of the
 *     eight mutation kinds — `screener_decide`, `triage_set`, `mark_seen`, `tag_assign`,
 *     `rule_delete` and `mail_send` all answer with no echo body (`http-adapter.ts`), because
 *     `X-Sync-Seq` can only carry one seq and these routes emit rows at several. The
 *     FixturesAdapter echoes its changes, which is precisely why the demo never showed this.
 */

/** Let every pending microtask AND the macrotask queue run. */
const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

interface Stalled {
  adapter: EngineAdapter;
  /** How many `sync` requests have been ISSUED (i.e. have read the log). */
  syncCount: () => number;
  /** How many `mutate` requests have been issued. */
  mutateCount: () => number;
  /** Stall the NEXT sync's response in transit. Returns a release for it. */
  stallNextSync: () => () => void;
}

function stalledSyncAdapter(inner: FixturesAdapter, opts: { echo?: boolean } = {}): Stalled {
  let syncCount = 0;
  let mutateCount = 0;
  let stall: { release: () => void; gate: Promise<void> } | null = null;

  const adapter: EngineAdapter = {
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: () => inner.fetchBody(),
    async sync(params: SyncParams): Promise<SyncResponse> {
      syncCount++;
      // THE READ HAPPENS NOW — the snapshot is taken at request time (see the note above).
      const resp = await inner.sync(params);
      const held = stall;
      if (held) {
        stall = null;
        await held.gate; // ...and only the RESPONSE is stalled in transit.
      }
      return resp;
    },
    async mutate(m, o): Promise<MutationOutcome> {
      mutateCount++;
      // The server COMMITS. `inner.mutate` appends the rows to the change log at fresh seqs.
      const out = await inner.mutate(m, o);
      // ...and answers with no echo body, like the six real no-echo routes.
      return opts.echo ? out : { changes: [], seq: out.seq };
    },
  };

  return {
    adapter,
    syncCount: () => syncCount,
    mutateCount: () => mutateCount,
    stallNextSync: () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      stall = { release, gate };
      return release;
    },
  };
}

async function startedEngine(adapter: EngineAdapter): Promise<OhmailEngine> {
  const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
  await engine.start();
  return engine;
}

const waitingIds = (engine: OhmailEngine): string[] =>
  screenerSegments(engine.read(), DEMO_NOW).waiting.map((s) => s.id);

describe("a mutation must be reconciled by a drain that started AFTER it committed", () => {
  it("A · no drain in flight: the decision holds after reconcile (the control)", async () => {
    const h = stalledSyncAdapter(new FixturesAdapter());
    const engine = await startedEngine(h.adapter);
    expect(waitingIds(engine)).toEqual(["lena", "paperbird", "jackpot"]);

    const res = await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes", read: true });

    expect(res.status).toBe("confirmed");
    expect(waitingIds(engine)).toEqual(["paperbird", "jackpot"]);
  });

  it("B · a poll drain already in flight: the decision must NOT vanish", async () => {
    const h = stalledSyncAdapter(new FixturesAdapter());
    const engine = await startedEngine(h.adapter);
    expect(waitingIds(engine)).toEqual(["lena", "paperbird", "jackpot"]);

    // The 8 s poll fires and its response stalls in transit. Its READ is already done — it
    // holds a snapshot of the log from BEFORE the click.
    const release = h.stallNextSync();
    const poll = engine.syncOnce();
    await tick();

    // The user clicks Ohbox. The POST commits; the response carries no echo.
    const mutation = engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes", read: true });
    await tick();

    // The stale poll response finally lands.
    release();
    const res = await mutation;
    await poll;

    // The engine said the write landed...
    expect(res.status).toBe("confirmed");
    // ...so the decision must be on screen. Before the fix it was not: the overlay was
    // deleted against a drain that could not have carried the decision, and lena came back.
    expect(waitingIds(engine)).toEqual(["paperbird", "jackpot"]);
  });

  it("B · and the write really HAD landed — the client, not the server, was lying", async () => {
    // The other half of the report: "and then it does". This proves the server
    // committed all along, so the defect is a client-side reconcile against a stale drain and
    // never a lost write. It passes before the fix too — deliberately: it is what rules OUT
    // the reading that the mutation failed.
    const h = stalledSyncAdapter(new FixturesAdapter());
    const engine = await startedEngine(h.adapter);

    const release = h.stallNextSync();
    const poll = engine.syncOnce();
    await tick();
    const mutation = engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes", read: true });
    await tick();
    release();
    await mutation;
    await poll;

    // The next poll — up to 8 s later for the reporter — brings it back.
    await engine.syncOnce();
    expect(waitingIds(engine)).toEqual(["paperbird", "jackpot"]);
  });

  it("B · the same for a move, which is the same dispatch path", async () => {
    const h = stalledSyncAdapter(new FixturesAdapter());
    const engine = await startedEngine(h.adapter);
    expect(engine.read().get<EngineMessage>("message", "giulia")?.folder).toBe("INBOX");

    const release = h.stallNextSync();
    const poll = engine.syncOnce();
    await tick();
    const mutation = engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/Receipts" });
    await tick();
    release();
    const res = await mutation;
    await poll;

    expect(res.status).toBe("confirmed");
    expect(engine.read().get<EngineMessage>("message", "giulia")?.folder).toBe("ohmail/Receipts");
  });
});

describe("the cost of the fix", () => {
  it("no drain in flight ⇒ exactly ONE drain, and no extra round trip", async () => {
    // The common case must be untouched: the fix may not turn one drain into two, or the
    // click would pay a round trip it does not pay today.
    const h = stalledSyncAdapter(new FixturesAdapter());
    const engine = await startedEngine(h.adapter);
    const before = h.syncCount(); // the bootstrap drain

    await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes", read: true });

    expect(h.syncCount()).toBe(before + 1);
  });

  it("N mutations inside ONE in-flight window share ONE follow-up drain", async () => {
    // The request-rate bound. Three clicks during one stalled poll must not mean three extra
    // drains, or a burst of triage keystrokes would multiply the sync traffic.
    const h = stalledSyncAdapter(new FixturesAdapter());
    const engine = await startedEngine(h.adapter);
    const before = h.syncCount();

    const release = h.stallNextSync();
    const poll = engine.syncOnce(); // +1
    await tick();

    const a = engine.mutate({ kind: "triage_set", messageId: "cinderlock", state: "reply_later" });
    const b = engine.mutate({ kind: "triage_set", messageId: "petra", state: "set_aside" });
    const c = engine.mutate({ kind: "triage_set", messageId: "giulia", state: "none" });
    await tick();

    release();
    await Promise.all([a, b, c]);
    await poll;

    // bootstrap + the poll + ONE shared follow-up. Not one per mutation.
    expect(h.syncCount()).toBe(before + 2);
  });

  it("a mutation that DOES echo changes never syncs at all — with or without a drain in flight", async () => {
    // The blast-radius guard. `feed_mark_seen` and `rule_update` return real changes and take
    // the `applyChanges` branch, which must not acquire a sync of any kind.
    const h = stalledSyncAdapter(new FixturesAdapter(), { echo: true });
    const engine = await startedEngine(h.adapter);
    const before = h.syncCount();

    const release = h.stallNextSync();
    const poll = engine.syncOnce(); // +1
    await tick();

    const res = await engine.mutate({ kind: "feed_mark_seen" });
    expect(res.status).toBe("confirmed");
    // Resolved WITHOUT waiting for the stalled poll — the echo branch does not touch sync.
    expect(h.syncCount()).toBe(before + 1);

    release();
    await poll;
    expect(h.syncCount()).toBe(before + 1);
  });
});

describe("the follow-up drain must not invent a failure or swallow one", () => {
  it("the OLDER drain failing is not this mutation's failure", async () => {
    // A mutation that committed must not be reported `rolled_back` because a poll that was
    // already in flight — and has nothing to do with it — happened to fail.
    const inner = new FixturesAdapter();
    let failNextSync = false;
    let syncCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      async sync(params) {
        syncCount++;
        const resp = await inner.sync(params);
        if (failNextSync) {
          failNextSync = false;
          await gate;
          throw new Error("poll drain died in transit");
        }
        return resp;
      },
      async mutate(m, o) {
        const out = await inner.mutate(m, o);
        return { changes: [], seq: out.seq };
      },
    };

    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();

    failNextSync = true;
    const poll = engine.syncOnce().catch(() => { /* the poller swallows its own */ });
    await tick();

    const mutation = engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes", read: true });
    await tick();
    release();

    const res = await mutation;
    await poll;

    expect(res.status).toBe("confirmed");
    expect(waitingIds(engine)).toEqual(["paperbird", "jackpot"]);
    expect(syncCount).toBeGreaterThanOrEqual(3); // bootstrap + the failed poll + the follow-up
  });

  it("the mutation's OWN drain failing reports confirmed — the WRITE landed", async () => {
    /**
     * This assertion was inverted during the slice, so the reasoning is written down rather
     * than left as a diff nobody can reconstruct.
     *
     * It first asserted `rolled_back`, on the rule that a rolled-back mutation must not report
     * success. That rule is right and is not what this is. `adapter.mutate` RESOLVED: the
     * server answered 2xx and committed. The reconciliation drain is a SEPARATE request whose
     * failure says nothing about whether the write was accepted — so `rolled_back` here is a
     * false statement about a mutation that succeeded, and `confirmed` is a true one.
     *
     * It is also the dangerous one. `useMailSend.absorb` releases the send lock on every status
     * except `queued`, and runs `settle` only on `confirmed` — so a delivered mail reported
     * `rolled_back` keeps its draft, unlocks, and the next press mints a fresh
     * Idempotency-Key and delivers it AGAIN (the "No silent AI actions" invariant).
     *
     * The guard that actually protects the original rule is the next test: a server REJECTION
     * must still roll back. That one was added, not weakened.
     */
    const inner = new FixturesAdapter();
    let armed = false;
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      async sync(params) {
        if (armed) throw new Error("the follow-up drain failed");
        return inner.sync(params);
      },
      async mutate(m, o) {
        const out = await inner.mutate(m, o);
        return { changes: [], seq: out.seq };
      },
    };

    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();
    armed = true;

    const res = await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes", read: true });
    expect(res.status).toBe("confirmed");
    expect(res.error).toBeUndefined();
    expect(engine.pendingMutations()).toHaveLength(0);
  });

  it("a SEND whose drain fails reports confirmed — the anti-double-delivery guard", async () => {
    // The same case as above, on the one mutation where a false `rolled_back` costs money and
    // credibility: the recipient already has the mail.
    const inner = new FixturesAdapter();
    let armed = false;
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      async sync(params) {
        if (armed) throw new Error("the follow-up drain failed");
        return inner.sync(params);
      },
      async mutate(m, o) {
        const out = await inner.mutate(m, o);
        return { changes: [], seq: out.seq };
      },
    };

    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();
    armed = true;

    const res = await engine.mutate({ kind: "mail_send", inReplyTo: "giulia", body: "Gerne — Donnerstag?" });
    expect(res.status).toBe("confirmed");
    expect(engine.pendingMutations()).toHaveLength(0);
  });

  it("a SERVER rejection still rolls back — swallowing the drain did not widen to the POST", async () => {
    // THE anti-weakening guard. The only thing that means "the mutation failed" is the server
    // refusing it, and that must still roll the overlay back and say so. A 403 that reported
    // `confirmed` is the defect this repo already learned once, from a rules toast.
    const inner = new FixturesAdapter();
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      sync: (p) => inner.sync(p),
      mutate: async () => {
        throw new MutationRejectedError("forbidden", { status: 403, code: "forbidden", retryable: false });
      },
    };

    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();

    const res = await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes", read: true });
    expect(res.status).toBe("rolled_back");
    expect(res.error).toBeInstanceOf(MutationRejectedError);
    expect(res.error?.code).toBe("forbidden");
    // ...and the decision is OFF the screen again: lena is back in the Screener.
    expect(waitingIds(engine)).toEqual(["lena", "paperbird", "jackpot"]);
  });

  it("a RETRYABLE server rejection still queues and keeps the overlay", async () => {
    // The other half of the untouched `catch`: user-always-wins survives the change.
    const inner = new FixturesAdapter();
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      sync: (p) => inner.sync(p),
      mutate: async () => {
        throw new MutationRejectedError("socket closed", { code: "network", retryable: true });
      },
    };

    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();

    const res = await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes", read: true });
    expect(res.status).toBe("queued");
    expect(engine.pendingMutations()).toHaveLength(1);
    // The intent stands on screen while it waits.
    expect(waitingIds(engine)).toEqual(["paperbird", "jackpot"]);
  });
});

describe("the property the scheduler depends on, and the kinds that reach this path", () => {
  it("never two concurrent /sync requests, even with mutations chaining follow-ups", async () => {
    // `sync-scheduler.ts` states that a wake, a retry and a mutation's read-your-writes drain
    // "can never stack into two concurrent /sync requests", and `sync-liveness.test.ts` asserts
    // concurrency 1 against one cursor. The chain must not break that claim — it is sequential,
    // not parallel, and `store.applyResponse` writes the cursor from whichever response lands.
    const inner = new FixturesAdapter();
    let concurrent = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Armed only AFTER the bootstrap — otherwise `engine.start()` itself stalls on the gate.
    let stallOnce = false;

    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      async sync(params) {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        try {
          const resp = await inner.sync(params);
          if (stallOnce) { stallOnce = false; await gate; }
          return resp;
        } finally {
          concurrent--;
        }
      },
      async mutate(m, o) {
        const out = await inner.mutate(m, o);
        return { changes: [], seq: out.seq };
      },
    };

    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();
    stallOnce = true;

    const poll = engine.syncOnce();
    await tick();
    const a = engine.mutate({ kind: "triage_set", messageId: "cinderlock", state: "reply_later" });
    const b = engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/Receipts" });
    await tick();
    release();
    await Promise.all([a, b]);
    await poll;

    expect(maxConcurrent, "two /sync requests ran against one cursor").toBe(1);
  });

  /**
   * EVERY KIND REACHES THE EMPTY-CHANGES BRANCH, which is why this defect was never a Screener
   * defect. Six answer `changes: []` unconditionally; `move`, `rule_update` and `feed_mark_seen`
   * degrade to it whenever `X-Sync-Seq` is absent or non-finite (`http-adapter.ts` `noteSeq`).
   * Only `draft_accept` cannot, and only because the HTTP adapter throws
   * `UnsupportedMutationError` for it before any request is made.
   *
   * The table drives the kinds constructible against the demo world. `rule_delete`,
   * `rule_update` and `mail_send` are covered by their own tests above and by there being
   * exactly ONE else-branch for all of them.
   */
  const KINDS: Array<{ name: string; mutation: Parameters<OhmailEngine["mutate"]>[0] }> = [
    { name: "triage_set", mutation: { kind: "triage_set", messageId: "cinderlock", state: "reply_later" } },
    { name: "screener_decide", mutation: { kind: "screener_decide", senderId: "lena", decision: "yes" } },
    { name: "mark_seen", mutation: { kind: "mark_seen", messageIds: ["petra"], unread: false } },
    { name: "tag_assign", mutation: { kind: "tag_assign", messageId: "alpenbahn", tagId: "buch", assigned: true } },
    { name: "move", mutation: { kind: "move", messageId: "giulia", folder: "ohmail/Receipts" } },
    { name: "feed_mark_seen", mutation: { kind: "feed_mark_seen" } },
  ];

  for (const { name, mutation } of KINDS) {
    it(`${name} pulls a follow-up drain when one is already in flight`, async () => {
      const h = stalledSyncAdapter(new FixturesAdapter());
      const engine = await startedEngine(h.adapter);
      const before = h.syncCount();

      const release = h.stallNextSync();
      const poll = engine.syncOnce(); // +1
      await tick();

      const m = engine.mutate(mutation);
      await tick();
      release();
      const res = await m;
      await poll;

      expect(res.status).toBe("confirmed");
      // bootstrap + the stale poll + the follow-up this mutation required.
      expect(h.syncCount()).toBe(before + 2);
    });
  }
});
