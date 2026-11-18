import type { HeldReleaseGroupWire, HeldReleaseWire } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import {
  heldReleaseDismissedOf, heldReleaseFingerprintOf, heldReleaseGroups, heldReleaseTotalOf,
  screenerSegments,
} from "../src/selectors.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";
import type { SyncChange } from "../src/types.js";

/** Mirror sequence for the seeded rows below — one counter for the file. */
let mailSeq = 0;

/**
 * "N HELD MESSAGES FROM SENDERS YOU ALREADY DECIDED" — WHAT THE CLIENT MAY SAY ABOUT IT.
 *
 * The set is a SERVER derivation: whether a message is stuck depends on WHO placed it at the gate,
 * and `/sync` carries no such field. So the client's whole job is to hold the door's answer without
 * improving on it — which means three things, each asserted below: the headline number is the
 * server's DISTINCT total and never the sum of the groups; a refresh REPLACES the set rather than
 * merging into it; and a door that cannot answer leaves no row at all rather than a confident zero.
 */

const NOW = new Date("2026-09-12T12:00:00Z");

const group = (o: Partial<HeldReleaseGroupWire> & { ruleId: string; count: number }): HeldReleaseGroupWire => ({
  kind: "sender", match: `${o.ruleId}@shape.test`, destination: "INBOX", ...o,
});

/** A door that answers `heldReleases` from a script and records every press. */
function doorWith(answers: HeldReleaseWire[]): {
  adapter: EngineAdapter; presses: Array<readonly string[] | undefined>;
} {
  const presses: Array<readonly string[] | undefined> = [];
  let i = 0;
  const adapter = {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: null, hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
    heldReleases: async () => answers[Math.min(i++, answers.length - 1)]!,
    releaseHeld: async (ruleIds?: readonly string[]) => {
      presses.push(ruleIds);
      return { released: [], total: 7 };
    },
  } as unknown as EngineAdapter;
  return { adapter, presses };
}

const engineOn = async (adapter: EngineAdapter): Promise<OhmailEngine> => {
  const engine = new OhmailEngine({ adapter, now: () => NOW });
  await engine.start();
  return engine;
};

describe("the held-release offer, client side", () => {
  it("holds the door's groups largest first, and takes the total from the server", async () => {
    const { adapter } = doorWith([{
      groups: [group({ ruleId: "small", count: 2 }), group({ ruleId: "big", count: 9 })],
      // DISTINCT messages: one is claimed by both rules, so the sum (11) is not the number.
      total: 10,
      max: 200,
    }]);
    const engine = await engineOn(adapter);
    await engine.refreshHeldReleases();

    const rows = heldReleaseGroups(engine.read());
    expect(rows.map((r) => [r.id, r.count])).toEqual([["big", 9], ["small", 2]]);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(11);
    expect(heldReleaseTotalOf(engine.read())).toBe(10);
  });

  /** A group that is gone is GONE. A merge would leave a press offering mail nobody holds. */
  it("replaces the set on refresh rather than merging into it", async () => {
    const { adapter } = doorWith([
      { groups: [group({ ruleId: "a", count: 3 }), group({ ruleId: "b", count: 1 })], total: 4, max: 200 },
      { groups: [group({ ruleId: "b", count: 1 })], total: 1, max: 200 },
    ]);
    const engine = await engineOn(adapter);
    await engine.refreshHeldReleases();
    expect(heldReleaseGroups(engine.read()).map((r) => r.id)).toEqual(["a", "b"]);

    await engine.refreshHeldReleases();
    expect(heldReleaseGroups(engine.read()).map((r) => r.id)).toEqual(["b"]);
    expect(heldReleaseTotalOf(engine.read())).toBe(1);
  });

  /** The press reaches the door with what it was given, and the screen is re-read afterwards. */
  it("presses for every group, or for the named ones, and re-reads", async () => {
    const { adapter, presses } = doorWith([
      { groups: [group({ ruleId: "a", count: 3 })], total: 3, max: 200 },
      { groups: [], total: 0, max: 200 },
    ]);
    const engine = await engineOn(adapter);
    await engine.refreshHeldReleases();

    expect(await engine.releaseHeldMail()).toBe(7);
    expect(presses).toEqual([undefined]);
    // The re-read ran: the door's second answer is empty, so nothing is offered any more.
    expect(heldReleaseGroups(engine.read())).toEqual([]);
    expect(heldReleaseTotalOf(engine.read())).toBe(0);

    await engine.releaseHeldMail(["a"]);
    expect(presses).toEqual([undefined, ["a"]]);
  });

  /**
   * A DOOR THAT CANNOT ANSWER SAYS NOTHING, AND NOTHING IS NOT ZERO. An older server, or a build
   * whose adapter has no such call, must leave the mirror empty — the surface then draws no row,
   * rather than telling somebody they have no held mail when nobody has looked.
   */
  it("leaves no row when the door has no such call", async () => {
    const adapter = {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: null, hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ ok: true as const, changes: [] }),
    } as unknown as EngineAdapter;
    const engine = await engineOn(adapter);

    await expect(engine.refreshHeldReleases()).resolves.toBeUndefined();
    expect(heldReleaseGroups(engine.read())).toEqual([]);
    expect(heldReleaseTotalOf(engine.read())).toBe(0);
    expect(await engine.releaseHeldMail()).toBe(0);
  });

  /**
   * "NOT NOW" NAMES THE SET AS READ, then re-reads. The fingerprint comes off the MIRROR — never
   * re-derived — so what is dismissed is exactly what was on screen; a door with no verb, or a
   * mirror with no fingerprint (an older server), is a refusal to press, not a press that lies.
   */
  it("dismisses the set as read, and the re-read hides it everywhere", async () => {
    const dismissals: string[] = [];
    const { adapter } = doorWith([
      { groups: [group({ ruleId: "a", count: 3 })], total: 3, max: 200, fingerprint: "v1-abc", dismissed: false },
      { groups: [group({ ruleId: "a", count: 3 })], total: 3, max: 200, fingerprint: "v1-abc", dismissed: true },
    ]);
    (adapter as { dismissHeldRelease?: (fp: string) => Promise<void> }).dismissHeldRelease =
      async (fp) => { dismissals.push(fp); };
    const engine = await engineOn(adapter);
    await engine.refreshHeldReleases();
    expect(heldReleaseDismissedOf(engine.read())).toBe(false);
    expect(heldReleaseFingerprintOf(engine.read())).toBe("v1-abc");

    await engine.dismissHeldRelease();
    expect(dismissals).toEqual(["v1-abc"]);
    // The re-read ran, and the second answer says dismissed — every surface reads it off the rows.
    expect(heldReleaseDismissedOf(engine.read())).toBe(true);
  });

  it("refuses to dismiss what has no identity — an older server's answer", async () => {
    const dismissals: string[] = [];
    const { adapter } = doorWith([{ groups: [group({ ruleId: "a", count: 3 })], total: 3, max: 200 }]);
    (adapter as { dismissHeldRelease?: (fp: string) => Promise<void> }).dismissHeldRelease =
      async (fp) => { dismissals.push(fp); };
    const engine = await engineOn(adapter);
    await engine.refreshHeldReleases();
    expect(heldReleaseFingerprintOf(engine.read())).toBe("");
    await engine.dismissHeldRelease();
    expect(dismissals).toEqual([]);
  });
});

/**
 * ── ONE SENDER, ONE LIST ──────────────────────────────────────────────────────────────────
 *
 * The queue is derived by FOLDER and the release screen by the server's rules, so a sender whose
 * mail is at the gate behind a rule they already wrote appeared in BOTH: "first-time waiting" on
 * one half of the screen and "already decided" on the other, at the same moment. Three senders on
 * one live account were in that state. The queue keeps FOLDER as its rendering rule and subtracts
 * the door's set — nothing is recomputed, so what it drops is what a press would release.
 */
describe("a sender the door calls decided leaves the waiting queue", () => {
  const screenerMail = (id: string, from: string): SyncChange => ({
    type: "message", op: "create", id, seq: ++mailSeq, updatedAt: NOW.toISOString(),
    entity: {
      id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
      subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
      date: NOW.toISOString(), folder: "ohmail/Screener" as const, snippet: "s", unread: true,
      hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none" as const, updatedAt: NOW.toISOString(),
    },
  });

  const waitingOf = (engine: OhmailEngine): string[] =>
    screenerSegments(engine.read(), NOW).waiting.map((s) => s.from.address.toLowerCase()).sort();

  it("subtracts the sender group and the domain group, and nobody else", async () => {
    const { adapter } = doorWith([{
      groups: [
        { ruleId: "r-spam", kind: "sender", match: "Spammed@Ex.Test ", destination: "ohmail/Quarantine", count: 1 },
        { ruleId: "r-dom", kind: "domain", match: "paper.test", destination: "ohmail/News", count: 2 },
      ],
      total: 3,
      max: 200,
    }]);
    const engine = await engineOn(adapter);
    await engine.store.applyChanges([
      screenerMail("m-spam", "spammed@ex.test"),
      screenerMail("m-dom", "bills@paper.test"),
      screenerMail("m-new", "stranger@ex.test"),
    ]);

    // BEFORE the door answers: the queue says what the folder says, and that is honest — an
    // unanswered door is not evidence that anybody has decided anything.
    expect(waitingOf(engine)).toEqual(["bills@paper.test", "spammed@ex.test", "stranger@ex.test"]);

    await engine.refreshHeldReleases();

    // AFTER: each decided sender is in exactly ONE list, and the stranger is untouched.
    expect(waitingOf(engine), "a sender the door calls decided is still in the queue")
      .toEqual(["stranger@ex.test"]);
    expect(heldReleaseGroups(engine.read()).map((g) => g.id).sort()).toEqual(["r-dom", "r-spam"]);
  });

  /** An empty door subtracts nothing — the arm that keeps the queue from emptying on silence. */
  it("subtracts nothing when the door offers no groups", async () => {
    const { adapter } = doorWith([{ groups: [], total: 0, max: 200 }]);
    const engine = await engineOn(adapter);
    await engine.store.applyChanges([screenerMail("m-only", "stranger@ex.test")]);
    await engine.refreshHeldReleases();
    expect(waitingOf(engine)).toEqual(["stranger@ex.test"]);
  });
});
