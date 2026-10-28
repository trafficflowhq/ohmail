/* @reads: apps/mobile/src/state/live.ts apps/mobile/src/state/world.tsx */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  routingSubject,
  type EngineMutation,
  type RoutingIntent,
} from "@ohmail/client-engine";
import {
  closeRoutingSession,
  flushRouting,
  holdRouting,
  openRoutingSession,
  routingPlaces,
  subscribeRoutingPlaces,
  type RoutingJournal,
} from "../src/state/held-routing";
import { undoRouting } from "../src/state/held-routing";

/**
 * THE PHONE'S MOVE IS TWO HALVES, and the window it holds the second in is the ENGINE'S — one
 * definition, so the phone and the desktop make one promise about one press. What is the phone's
 * own is the plan and the dispatch, because only this surface knows its ladder; everything below
 * is read at that seam: what is sent, when, and what never is.
 */

const RULE: EngineMutation = { kind: "rule_update", ruleId: "r1", destination: "ohmail/News" };

function intent(over: Partial<RoutingIntent> = {}): RoutingIntent {
  return {
    v: 1, id: "p1", seedId: "m1", address: "a@b.test", scope: "sender",
    dest: "reads", messageIds: ["m1"], from: "INBOX", at: 1_000, ...over,
  };
}

/** The mirror's client-local half, in memory — the kill test drives the real store. */
function memoryJournal(): RoutingJournal {
  const rows = new Map<string, unknown>();
  return {
    get: <T,>(type: string, id: string) => rows.get(`${type}:${id}`) as T | undefined,
    commitLocal: async (puts, deletes) => {
      for (const p of puts) rows.set(`${p.type}:${p.id}`, p.entity);
      for (const d of deletes) rows.delete(`${d.type}:${d.id}`);
    },
  };
}

function session(plan: readonly EngineMutation[] = [RULE]) {
  const sent: EngineMutation[][] = [];
  const planned: string[] = [];
  openRoutingSession({
    windowMs: 8000,
    journal: memoryJournal(),
    plan: (i) => { planned.push(i.id); return plan; },
    dispatch: async (m) => { sent.push([...m]); },
  });
  return { sent, planned };
}

afterEach(() => { closeRoutingSession(); });

describe("the phone's routing window", () => {
  it("a press holds the rules, shows the mail where it was filed, and sends nothing", async () => {
    const s = session();
    expect(await holdRouting(intent())).toEqual({ held: true, superseded: false, sent: false });
    expect(s.sent, "a rule went out inside the undo window").toEqual([]);
    expect(s.planned, "the press planned the routing it is supposed to be holding").toEqual([]);
    expect(routingPlaces().get("m1"), "the held row is not shown where it was filed")
      .toBe("ohmail/News");
  });

  it("Undo cancels the rules and the row goes back to being where it is", async () => {
    const s = session();
    await holdRouting(intent());
    expect(undoRouting(routingSubject({ scope: "sender", address: "a@b.test" }))).toBe(true);
    expect(s.sent, "Undo left the rules on the wire").toEqual([]);
    expect(routingPlaces().size, "the overlay outlived the press it was showing").toBe(0);
  });

  it("nothing held is not an undo — and with no session open, nothing is held", async () => {
    const s = session();
    await holdRouting(intent());
    expect(undoRouting("sender:someone-else@b.test")).toBe(false);
    closeRoutingSession();
    expect(undoRouting(routingSubject({ scope: "sender", address: "a@b.test" }))).toBe(false);
    /* Closing the session COMMITS what was open — leaving is not asking for it back. */
    expect(s.sent).toEqual([[RULE]]);
  });

  it("a press with no session open sends its rules at once and offers no undo", async () => {
    expect(await holdRouting(intent())).toEqual({ held: false, superseded: false, sent: false });
  });

  it("backgrounding commits the window, and the plan is built THERE", async () => {
    const s = session();
    await holdRouting(intent());
    expect(s.planned).toEqual([]);
    flushRouting();
    expect(s.planned, "the routing was not re-planned at the commit").toEqual(["p1"]);
    expect(s.sent).toEqual([[RULE]]);
  });

  it("a re-plan that finds the rules already pointing there sends an empty plan", async () => {
    /* The phone's ladder is idempotent by construction: once those rules point at the
       destination they no longer hold the sender at the place the press was made from. */
    const s = session([]);
    await holdRouting(intent());
    flushRouting();
    expect(s.sent).toEqual([[]]);
  });

  it("a second press about one sender supersedes the first — one rule, the later one", async () => {
    const s = session();
    await holdRouting(intent());
    await holdRouting(intent({ id: "p2", dest: "receipts", messageIds: ["m2"] }));
    expect(routingPlaces().get("m2")).toBe("ohmail/Receipts");
    expect(routingPlaces().has("m1"), "the superseded press kept showing its row").toBe(false);
    flushRouting();
    expect(s.planned, "the superseded press was planned beside its replacement").toEqual(["p2"]);
  });

  it("the places store publishes a NEW map per change, so the projection re-derives", async () => {
    session();
    const seen: number[] = [];
    const off = subscribeRoutingPlaces(() => seen.push(routingPlaces().size));
    await holdRouting(intent());
    const first = routingPlaces();
    await holdRouting(intent({ id: "p3", address: "c@d.test", messageIds: ["m3"] }));
    expect(routingPlaces()).not.toBe(first);
    expect(seen.length, "the store did not publish").toBeGreaterThan(1);
    off();
  });
});

/**
 * AND THE PRESS GOES THROUGH IT. The cases above drive the window; this one reads the PRESS,
 * because a correct window the verb never opens is the failure this repository keeps shipping —
 * measured here: a mutation that dispatched the rules beside the mail left every case above
 * green. The slice is `move`'s own body, bounded by the next arrow-function declaration, so a
 * rename reads nothing and the length assertion refuses that.
 */
describe("the phone's Move press opens the window rather than sending the rules", () => {
  const LIVE = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "state", "live.ts");

  function moveBody(): string {
    const src = readFileSync(LIVE, "utf8");
    const from = src.indexOf("const move = async (pressed: WorldMail, dest: MoveTarget, members?: readonly string[])");
    expect(from, "`move` is not declared under that name any more").toBeGreaterThan(-1);
    const to = src.indexOf("\n  const deleteMessage", from);
    expect(to, "`move`'s end anchor is gone — the slice would run to the file's end")
      .toBeGreaterThan(from);
    const body = src.slice(from, to);
    expect(body.length, "the slice is too short to be the verb's body").toBeGreaterThan(800);
    return body;
  }

  it("holds the rules and dispatches only the mail", () => {
    const body = moveBody();
    expect(body, "the press does not open a window").toMatch(/holdRouting\(/);
    /* THE MAIL IS DISPATCHED AND THE RULES ARE NOT. Both halves are named, so a press that sent
       everything and a press that sent nothing are each refused. */
    expect(body).toMatch(/const unsent = mail\.filter\(/);
    expect(body).toMatch(/unsent\.map\(\(w\) => inMessageOrder\(w, \(\) => engine\.mutate\(w, \{ key: pressId \}\)/);
    /**
     * THE RULES REACH THE WIRE IN EXACTLY ONE PLACE, and it is the jar-refused branch.
     *
     * A bare "never dispatch the rules" was the first form and it refused correct code: where
     * there is no session to hold the press, the rules go at once and the sentence withholds the
     * undo — the degradation every window in this tree ships. So the count is pinned and its one
     * site is named, which refuses both a second dispatch and a dispatch moved out of that arm.
     */
    const dispatches = body.split("rules.map((w) => engine.mutate(").length - 1;
    expect(dispatches, "the rules are dispatched somewhere other than the refused-jar arm")
      .toBe(1);
    const refused = body.slice(body.indexOf("if (!opened?.held) {"));
    expect(refused.slice(0, refused.indexOf("\n    }")),
      "the one dispatch is not inside the arm that may make it")
      .toContain("rules.map((w) => engine.mutate(");
  });

  it("the window counts from the pill, and a committed press is taken back by its rules' inverse", () => {
    const body = moveBody();
    expect(body, "the Move's offer does not restart its window at the pill").toContain("shown: () => { restartRouting(subject); }");
    /* ONE DECISION: the cancel is asked first, and the committed press's way back only when it did not take. */
    const undo = body.slice(body.indexOf("undo: () => {"));
    // Asked BY PRESS ID: a later press about the sender replaced this one (move-second-press-of-a-sender).
    expect(undo.indexOf("undoRoutingPress(subject, pressId)")).toBeGreaterThan(-1);
    expect(undo.indexOf("cancelled ? null : takeRoutingReversal(pressId)"))
      .toBeGreaterThan(undo.indexOf("undoRoutingPress(subject, pressId)"));
    const src = readFileSync(LIVE, "utf8");
    const sheet = src.slice(src.indexOf("const screenThroughWindow = async"), src.indexOf("const pressSentence = ("));
    expect(sheet, "the sheet press keeps two clocks").toContain("shown: () => { restartRouting(subjectKey); }");
    const world = readFileSync(join(LIVE, "..", "world.tsx"), "utf8");
    // A Move (v1) alone has a way back; a sheet press and a Screener decision have none.
    // The way back reads the same press list as the session's `plan:`.
    expect(world.replace(/\s+/g, " "), "the session is opened with no way back from a committed Move").toContain(
      "reverse: (mutations, intent) => (intent.v === 1 ? routingReversal(() => engine.read(), mutations, "
      + "phonePressRules(engine, phoneRulesTravel(mailboxesNow.current ?? []), new Date())) : null)",
    );
    expect(world.replace(/\s+/g, " ")).toContain(
      "(changed) => noteScreenChanged(intent.id, changed), phonePressRules(engine, phoneRulesTravel(mailboxesNow.current ?? []), new Date()))",
    );
  });

  it("Undo cancels the held rules before it reverses the mail", () => {
    const body = moveBody();
    expect(body).toMatch(/undoRouting\(subject\)/);
    /* AND THE SENTENCE FOLLOWS WHAT THE CANCEL ANSWERED — a late press may not claim no rule
       was made over a rule that was. */
    expect(body).toMatch(/cancelled \? "toastRoutingUndone" : "toastUndone"/);
  });
});
