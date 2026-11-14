import { describe, expect, it } from "vitest";
import {
  OhmailEngine,
  triagePiles,
  type EngineAdapter,
  type MessageStateDTO,
  type MutationOutcome,
  type SyncChange,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * TRIAGE PILE PARITY THROUGH A TRANSITION — the badge and the pile are ONE number.
 *
 * ## THE DEFECT (a drag-park read "Parked 6" on the rail while the pile listed 1)
 *
 * The live server keys the `message_state` entity by the `message_states` ROW's uuid —
 * `TriageService.setState` emits `entityId: row.id` — while the optimistic overlay keyed its
 * effect by MESSAGE id. Two spellings of one fact, so through any transition the two never met:
 *
 *  · parking a message already in another pile left the settled row standing — the message
 *    counted in BOTH piles until the drain;
 *  · `state:"none"` tombstoned an id the mirror does not hold, so an un-park deleted nothing
 *    optimistically — the row stood in its pile for the whole round trip;
 *  · a drain landing the settled row while the overlay still stood counted the SAME message
 *    twice in ONE pile.
 *
 * Every count consumer renders `triagePiles`, so the rail badge inflated by exactly these
 * mechanisms and re-derived correct on reload (the overlay dies with the tab).
 *
 * ## THE HARNESS MODELS THE LIVE WIRE, NOT THE DEMO
 *
 * The FixturesAdapter keys `message_state` by message id — which is precisely why the demo
 * never showed this. This wrapper re-keys every `message_state` change in a sync page to
 * `state-row:<messageId>` (a stable per-message uuid, exactly the live upsert's shape) and
 * answers mutations with `changes: []` like the six no-echo routes. `mutate` can hold its
 * RESPONSE in transit after the server committed, which is the in-flight window every
 * assertion below runs inside.
 */

const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

interface LiveShaped {
  adapter: EngineAdapter;
  /** Hold every mutate RESPONSE in transit until released. */
  holdMutations: () => () => void;
}

function liveShapedAdapter(inner: FixturesAdapter): LiveShaped {
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;

  const rekey = (c: SyncChange): SyncChange => {
    if (c.type !== "message_state") return c;
    const messageId = (c.entity as MessageStateDTO | null)?.messageId ?? c.id;
    return { ...c, id: `state-row:${messageId}` };
  };

  const adapter: EngineAdapter = {
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: () => inner.fetchBody(),
    async sync(params: SyncParams): Promise<SyncResponse> {
      const resp = await inner.sync(params);
      return {
        ...resp,
        changes: {
          creates: resp.changes.creates.map(rekey),
          updates: resp.changes.updates.map(rekey),
          moves: resp.changes.moves.map(rekey),
          deletes: resp.changes.deletes.map(rekey),
        },
      };
    },
    async mutate(m, o): Promise<MutationOutcome> {
      // The server COMMITS (the fixture log gains the rows at fresh seqs)…
      const out = await inner.mutate(m, o);
      // …and the response may be held in transit, with no echo body — the live shape.
      if (gate) await gate;
      return { changes: [], seq: out.seq };
    },
  };

  return {
    adapter,
    holdMutations: () => {
      gate = new Promise<void>((r) => { release = r; });
      return () => { gate = null; release?.(); };
    },
  };
}

async function liveEngine(): Promise<{ engine: OhmailEngine; h: LiveShaped }> {
  const h = liveShapedAdapter(new FixturesAdapter());
  const engine = new OhmailEngine({ adapter: h.adapter, now: () => DEMO_NOW });
  await engine.start();
  return { engine, h };
}

/**
 * The MESSAGE-BACKED pile members. The demo world also seeds fixture-only `triage_item`
 * orphans (no `messageId`); they ride no wire and cannot double, so they are held out of
 * every count here — the duplication under test is message-backed by construction.
 */
const pileIds = (engine: OhmailEngine) => {
  const p = triagePiles(engine.read());
  const ids = (entries: Array<{ messageId?: string }>) =>
    entries.map((e) => e.messageId).filter((x): x is string => x != null);
  return { replyLater: ids(p.replyLater), setAside: ids(p.setAside) };
};

describe("TRI-F5 — the optimistic pile count equals the settled pile through the transition", () => {
  it("parking a message OUT of another pile moves it, in flight and settled — never both piles", async () => {
    const { engine, h } = await liveEngine();
    // The seed, under the server's own record ids: nadja and jonas wait in Answer Later. The
    // message has to START in a pile for this to be a pile-to-pile move at all, which is why it
    // is one of these two and not any Ohbox row.
    expect(pileIds(engine)).toEqual({ replyLater: ["nadja", "jonas"], setAside: [] });

    const release = h.holdMutations();
    const p = engine.mutate({ kind: "triage_set", messageId: "nadja", state: "set_aside" });
    await tick();

    // IN FLIGHT: one message, one pile. The un-fixed overlay left the settled reply_later row
    // standing beside its own set_aside effect — nadja in two piles, the badge counting both.
    expect(pileIds(engine)).toEqual({ replyLater: ["jonas"], setAside: ["nadja"] });

    release();
    await p;
    // SETTLED: the drain delivered the same fact under the server's id; nothing doubled.
    expect(pileIds(engine)).toEqual({ replyLater: ["jonas"], setAside: ["nadja"] });
  });

  it("state:'none' takes the message out of its pile AT PRESS TIME, not a round trip later", async () => {
    const { engine, h } = await liveEngine();

    const release = h.holdMutations();
    const p = engine.mutate({ kind: "triage_set", messageId: "nadja", state: "none" });
    await tick();

    // IN FLIGHT: the un-park is visible now. The un-fixed tombstone deleted an id the mirror
    // does not hold, so the row stood in the pile for the whole round trip.
    expect(pileIds(engine).replyLater).toEqual(["jonas"]);

    release();
    await p;
    expect(pileIds(engine).replyLater).toEqual(["jonas"]);
  });

  it("a drain landing the settled row UNDER the standing overlay counts the message once", async () => {
    const { engine, h } = await liveEngine();
    // cinderlock has no settled state row, so the overlay's honest key is the message id and
    // the drain's row arrives under a DIFFERENT id — the one interleaving no id fix can close.
    const release = h.holdMutations();
    const p = engine.mutate({ kind: "triage_set", messageId: "cinderlock", state: "set_aside" });
    await tick();
    expect(pileIds(engine).setAside).toEqual(["cinderlock"]);

    // The poll drain delivers the committed row while the mutation's response is still in
    // transit — the exact window a badge was measured inflated in.
    await engine.syncOnce();
    expect(pileIds(engine).setAside).toEqual(["cinderlock"]);

    release();
    await p;
    expect(pileIds(engine).setAside).toEqual(["cinderlock"]);
  });

  it("re-filing (move) spends the resurface against the SERVER'S record id too", async () => {
    const { engine, h } = await liveEngine();
    // Pin giulia, let it settle: the mirror now holds `state-row:giulia` = resurfaced.
    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "resurfaced" });

    const release = h.holdMutations();
    const p = engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/News" });
    await tick();
    // IN FLIGHT: the spend must land on the settled record — a `none` written beside it would
    // leave the resurfaced row standing (the same two-spellings defect, one verb over).
    const states = engine.read().entries<MessageStateDTO>("message_state")
      .filter((e) => (e.entity.messageId ?? e.id) === "giulia");
    expect(states).toHaveLength(1);
    expect(states[0]!.entity.state).toBe("none");

    release();
    await p;
  });
});
