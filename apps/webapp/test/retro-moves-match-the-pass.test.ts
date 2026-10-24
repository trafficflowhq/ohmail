/**
 * A RULE'S BACKLOG IS MOVED BY THE SERVER'S PASS, NEVER BY THE PRESS (THE-CLIENTS-FIFTY).
 *
 * The sheet used to dispatch up to fifty `move`s itself under a rule that also asked the pass for
 * the past mail, choosing them with `retroPassWouldMove` — which sees three of the pass's seven
 * clauses. So mail the person had replied to, or placed themselves from another mail app, moved at
 * the press while the footer said the pass leaves it alone. The press now moves none of it: the
 * rule carries `applyRetro` and the pass moves exactly its own set. A press with NO rule is the
 * person's own instruction and still moves the visible mail, narrowed by the predicate, newest
 * fifty. The fixture is `test/support/retro-candidates.ts`, shared with the phone's twin.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  pressForecast,
  refileWouldMove,
  retroPassWouldMove,
  type EngineMessage,
  type Folder,
  type MessageStateDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import { movesAtLanding, planScreeningChange, senderScreening } from "../app/shell/sender-screening";
import {
  RETRO_DESTINATION,
  RETRO_FIXTURE,
  RETRO_MOVES,
  RETRO_PRESS_MOVES,
  RETRO_ORDER_FIXTURE,
  RETRO_ORDER_MOVES,
  RETRO_SENDER,
  REFILE_COUNTED,
  REFILE_FIXTURE,
  REFILE_FROM,
  REFILE_TO,
  type RetroFixtureRow,
} from "../../../test/support/retro-candidates.js";

let seq = 0;

function row(r: RetroFixtureRow): EngineMessage {
  const triage: MessageStateDTO | null = r.triage === null
    ? null
    : {
      messageId: r.id,
      state: r.triage as MessageStateDTO["state"],
      bubbleUpAt: null,
      setAt: r.date,
      updatedAt: r.date,
    };
  return {
    id: r.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: r.why,
    from: { name: RETRO_SENDER.name, address: RETRO_SENDER.address },
    to: [],
    cc: [],
    date: r.date,
    folder: r.folder as Folder,
    snippet: r.why,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage,
    labels: [],
    remoteContent: "none",
    updatedAt: r.date,
    ...(r.placeDecided ? { placeDecided: true as const } : {}),
  };
}

async function mirror(rows: readonly RetroFixtureRow[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows.map((r): SyncChange => ({
    type: "message", op: "create", id: r.id, seq: ++seq, updatedAt: r.date, entity: row(r),
  })));
  return store;
}

/** The plan this press makes over the fixture: a rule with the past-mail answer, or a bare move. */
async function planOf(rows: readonly RetroFixtureRow[], makeRule: boolean) {
  const store = await mirror(rows);
  const s = senderScreening(store, rows[0]!.id, RETRO_SENDER.address);
  expect(s, "the fixture's sender did not read out of the mirror").not.toBeNull();
  return planScreeningChange(s!, "reads", "sender", makeRule, true);
}

/** The ids a press moves itself, in the order the one door emits them (no forecast: every candidate). */
const movedBy = (plan: Awaited<ReturnType<typeof planOf>>): string[] =>
  movesAtLanding(plan, null).map((m) => m.messageId);

describe("a rule's past mail is the pass's to move, and the press moves none of it", () => {
  it("names the same destination the fixture does", () => {
    // Anti-vacuity: the whole comparison is about one destination, and a fixture built for a
    // different one would make every exclusion below trivially true.
    expect(RETRO_DESTINATION).toBe("ohmail/News");
  });

  it("a rule press dispatches no move of its own, and asks the pass for the past mail", async () => {
    const plan = await planOf(RETRO_FIXTURE, true);
    expect(movedBy(plan), "the press moved backlog the pass alone can judge").toEqual([]);
    expect(plan.mutations.some((m) => m.kind === "rule_create" && m.applyRetro === true),
      "the positive control: the rule carries the past-mail answer to the pass").toBe(true);
    // The sheet's count still names the mail in scope, which is what it says before the click.
    expect(plan.matched).toBe(RETRO_MOVES.length);
  });

  it("a bare move — the person's own instruction — moves exactly the predicate's rows", async () => {
    const moved = new Set(movedBy(await planOf(RETRO_FIXTURE, false)));
    expect([...moved].sort()).toEqual([...RETRO_PRESS_MOVES].sort());
    for (const r of RETRO_FIXTURE) {
      expect(
        moved.has(r.id),
        `${r.id} (${r.folder}, triage ${r.triage ?? "none"}) — ${r.why}`,
      ).toBe(retroPassWouldMove(row(r), RETRO_DESTINATION));
    }
    expect(moved.size).toBeGreaterThan(0);
    expect(moved.size).toBeLessThan(RETRO_FIXTURE.length);
  });

  /* RULE-FILED-MESSAGE-SNAPS-BACK-TO-OHBOX: the letter pressed on is the press's own to file, and
     it is the only one; the forecast lands the walk's own set, a decided row in neither half. */
  it("over the forecast, a rule press moves the letter it was made on and nothing else", async () => {
    const store = await mirror(RETRO_FIXTURE);
    for (const applyRetro of [true, false]) {
      const s = senderScreening(store, "r-inbox", RETRO_SENDER.address)!;
      const plan = planScreeningChange(s, "reads", "sender", true, applyRetro);
      const forecast = pressForecast({
        reader: store, options: { now: new Date("2026-08-21T09:00:00.000Z") }, subject: s.scopes.sender.messages,
        scope: "sender", match: RETRO_SENDER.address, wanted: RETRO_DESTINATION as Folder, makeRule: true,
        applyRetro, now: new Date("2026-08-21T09:00:00.000Z"), seedId: "r-inbox",
      });
      expect(movesAtLanding(plan, forecast).map((m) => m.messageId), `switch ${applyRetro}`).toEqual(["r-inbox"]);
      expect(forecast.keep.moves.map((m) => m.messageId), "the decided row is not the walk's").not.toContain("r-decided");
      expect(forecast.keep.landing).not.toContain("r-decided");
      expect(plan.matched).toBe(RETRO_MOVES.length);
    }
    // The control: the same press seeded on the decided row moves it — the person's hand is on it.
    const s = senderScreening(store, "r-decided", RETRO_SENDER.address)!;
    const forecast = pressForecast({
      reader: store, options: { now: new Date("2026-08-21T09:00:00.000Z") }, subject: s.scopes.sender.messages,
      scope: "sender", match: RETRO_SENDER.address, wanted: RETRO_DESTINATION as Folder, makeRule: true,
      applyRetro: true, now: new Date("2026-08-21T09:00:00.000Z"), seedId: "r-decided",
    });
    expect(forecast.keep.seedMove?.messageId).toBe("r-decided");
    expect(forecast.keep.landing).toContain("r-decided");
  });

  it("keeps the NEWEST fifty when fifty-one are eligible for a bare move", async () => {
    const ids = movedBy(await planOf(RETRO_ORDER_FIXTURE, false));
    expect(ids).toHaveLength(50);
    expect([...ids].sort()).toEqual([...RETRO_ORDER_MOVES].sort());
  });
});

describe("a Rules-page Change counts the rule's own pile", () => {
  it("refileWouldMove answers exactly the rows the client can count", () => {
    for (const r of REFILE_FIXTURE) {
      const m = row({ id: r.id, folder: r.folder, triage: r.triage, date: "2026-08-20T09:00:00.000Z", why: r.why,
        ...(r.decided ? { placeDecided: true } : {}) });
      expect(refileWouldMove(m, REFILE_FROM, REFILE_TO), `${r.id} — ${r.why}`).toBe(REFILE_COUNTED.includes(r.id));
    }
  });
});
