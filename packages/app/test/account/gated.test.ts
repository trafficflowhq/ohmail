import { describe, expect, it, vi } from "vitest";
import {
  GATED_IDLE,
  gatedAsk,
  gatedStep,
  type GatedEvent,
  type GatedRun,
  type GatedState,
  type GatedStepped,
} from "../../src/account/gated.js";

type Act = "add" | "remove";
type Word = "locked" | "refused";
type State = GatedState<Act, Word>;
type Event = GatedEvent<Act, Word>;

/** Walks the machine: each event in turn, keeping every act it said to send. */
function walk(...events: Event[]): { state: State; runs: GatedRun<Act>[] } {
  let state: State = GATED_IDLE;
  const runs: GatedRun<Act>[] = [];
  for (const event of events) {
    const next: GatedStepped<Act, Word> = gatedStep(state, event);
    state = next.state;
    if (next.run !== null) runs.push(next.run);
  }
  return { state, runs };
}

const press = (act: Act): Event => ({ kind: "try", act });
const ok: Event = { kind: "answered", answer: { ok: true } };
const factor: Event = { kind: "answered", answer: { ok: false, word: "factor" } };
const signIn: Event = { kind: "answered", answer: { ok: false, word: "sign_in" } };
const verified: Event = { kind: "verified" };
const cancelled: Event = { kind: "cancelled" };
const discarded: Event = { kind: "discarded" };

describe("a gated act, walked", () => {
  it("1. an act the server takes is sent once and is done, with no factor asked", () => {
    const { state, runs } = walk(press("add"), ok);
    expect(runs).toEqual([{ act: "add", afterFactor: false }]);
    expect(state).toEqual({ at: "done", act: "add", nothingRan: false });
  });

  it("2. `factor` on the first try parks the act and asks, and nothing more is sent while it is asked", () => {
    const { state, runs } = walk(press("remove"), factor);
    expect(state).toEqual({ at: "asking", act: "remove", nothingRan: false });
    expect(runs).toEqual([{ act: "remove", afterFactor: false }]);
    // An answer that lands while the factor is asked belongs to no try: it moves nothing and sends nothing.
    expect(walk(press("remove"), factor, ok)).toEqual({ state, runs });
  });

  it("3. the verified factor sends the parked act exactly once more, marked, and its answer ends it", () => {
    const { state, runs } = walk(press("remove"), factor, verified);
    expect(runs).toEqual([
      { act: "remove", afterFactor: false },
      { act: "remove", afterFactor: true },
    ]);
    expect(state).toEqual({ at: "trying", act: "remove", afterFactor: true, nothingRan: false });
    // A second "verified" for the same ceremony sends nothing.
    expect(walk(press("remove"), factor, verified, verified).runs).toHaveLength(2);
    // It starts clean, as every send does: an older ceremony's late factor is no longer what is said.
    expect(walk(press("remove"), discarded, factor).state).toMatchObject({ at: "asking", nothingRan: true });
    expect(walk(press("remove"), discarded, factor, verified).state.nothingRan).toBe(false);
    expect(walk(press("remove"), factor, verified, ok).state).toEqual({
      at: "done",
      act: "remove",
      nothingRan: false,
    });
  });

  it("4. `factor` again after the factor is the sign-in refusal: no second ask, no third send", () => {
    const { state, runs } = walk(press("add"), factor, verified, factor);
    expect(state).toEqual({ at: "refused", act: "add", refusal: { word: "sign_in" }, nothingRan: false });
    expect(runs).toHaveLength(2);
    expect(gatedAsk(state, () => {})).toBeNull();
    expect(walk(press("add"), factor, verified, factor, verified).runs).toHaveLength(2);
  });

  it("5. Cancel drops the parked act: nothing is sent, nothing is said, and a factor after it sends nothing", () => {
    const { state, runs } = walk(press("remove"), factor, cancelled);
    expect(state).toEqual({ at: "idle", nothingRan: false });
    expect(runs).toHaveLength(1);
    expect(walk(press("remove"), factor, cancelled, verified).runs).toHaveLength(1);
  });

  it("6. a factor that landed after Cancel says nothing ran, and sends nothing", () => {
    const { state, runs } = walk(press("remove"), factor, cancelled, discarded);
    expect(state).toEqual({ at: "idle", nothingRan: true });
    expect(runs).toHaveLength(1);
    // Thrown away while the factor is still asked: the parked act goes with it, so the sentence stays true.
    const asked = walk(press("remove"), factor, discarded);
    expect(asked.state).toEqual({ at: "idle", nothingRan: true });
    expect(walk(press("remove"), factor, discarded, verified).runs).toHaveLength(1);
  });

  it("7. `sign_in` on the first try is the refusal as it stands, with no factor asked", () => {
    const { state, runs } = walk(press("add"), signIn);
    expect(state).toEqual({ at: "refused", act: "add", refusal: { word: "sign_in" }, nothingRan: false });
    expect(runs).toHaveLength(1);
    expect(gatedAsk(state, () => {})).toBeNull();
  });

  it("8. every other refusal is said as the door answered it, on the first try and after the factor", () => {
    const locked: Event = { kind: "answered", answer: { ok: false, word: "locked", minutes: 7 } };
    const said: Event = { kind: "answered", answer: { ok: false, word: "said", said: "You are offline." } };
    expect(walk(press("add"), locked).state).toEqual({
      at: "refused",
      act: "add",
      refusal: { word: "locked", minutes: 7 },
      nothingRan: false,
    });
    expect(walk(press("add"), said).state).toEqual({
      at: "refused",
      act: "add",
      refusal: { word: "said", said: "You are offline." },
      nothingRan: false,
    });
    const after = walk(press("add"), factor, verified, locked);
    expect(after.state).toMatchObject({ at: "refused", refusal: { word: "locked", minutes: 7 } });
    expect(after.runs).toHaveLength(2);
  });

  it("9. one act at a time, and the next try starts clean", () => {
    // While one is on its way or asked, a second press is not taken.
    expect(walk(press("add"), press("remove")).runs).toEqual([{ act: "add", afterFactor: false }]);
    expect(walk(press("add"), factor, press("remove")).state).toMatchObject({ at: "asking", act: "add" });
    // The next try clears what the last one left: its refusal, and "nothing ran".
    const next = walk(press("add"), factor, cancelled, discarded, press("remove"));
    expect(next.state).toEqual({ at: "trying", act: "remove", afterFactor: false, nothingRan: false });
    expect(walk(press("add"), signIn, press("add")).state).toMatchObject({
      at: "trying",
      afterFactor: false,
    });
    expect(walk(press("add"), ok, press("remove")).runs).toHaveLength(2);
  });
});

describe("what a gated act hands the factor's dialog", () => {
  it("is nothing unless the factor is asked", () => {
    const send = vi.fn();
    for (const events of [[], [press("add")], [press("add"), ok], [press("add"), signIn]] as Event[][])
      expect(gatedAsk(walk(...events).state, send)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("is the dialog's three answers as the machine's three events, with the place's own line", () => {
    const sent: Event[] = [];
    const ask = gatedAsk(
      walk(press("add"), factor).state,
      (event) => sent.push(event),
      "It changes at once.",
    );
    expect(ask?.line).toBe("It changes at once.");
    ask?.onVerified();
    ask?.onCancel();
    ask?.onDiscarded();
    expect(sent).toEqual([verified, cancelled, discarded]);
    expect(gatedAsk(walk(press("add"), factor).state, () => {})).not.toHaveProperty("line");
  });

  it("drives a whole ceremony: asked once, sent twice, done", () => {
    let state: State = GATED_IDLE;
    const runs: GatedRun<Act>[] = [];
    const send = (event: Event): void => {
      const next = gatedStep(state, event);
      state = next.state;
      if (next.run !== null) runs.push(next.run);
    };
    send(press("remove"));
    send(factor);
    const ask = gatedAsk(state, send);
    ask?.onVerified();
    ask?.onVerified();
    send(ok);
    expect(runs).toEqual([
      { act: "remove", afterFactor: false },
      { act: "remove", afterFactor: true },
    ]);
    expect(state.at).toBe("done");
  });
});
