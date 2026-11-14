/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, landingOfMoves, pressForecast,
  type EngineMessage, type Folder, type RuleDTO, type SyncChange,
} from "@ohmail/client-engine";
import { movesAtLanding, planScreeningChange, senderScreening } from "@ohmail/app-logic/press/sender-screening";

/**
 * A PRESS MOVES ONLY WHAT THE LIST WILL SHOW AT THE PLACE (SCREENING-VISIBLE-MOVES-IGNORE-TERM-RULES).
 * The plan carries no `move`; its moves leave by `movesAtLanding`, over the press's own forecast,
 * so a row a rule of theirs keeps elsewhere is not moved into a place the list never shows it in.
 * The bulk bar asks the same door over one partition for the whole selection (`landingOfMoves`).
 */

const NOW = new Date("2026-09-24T08:00:00.000Z");
const ADDR = "lena@atelier.example";
let seq = 0;

function msg(id: string, folder: Folder, subject: string, from = ADDR): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-20T09:00:00.000Z", folder, snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}
function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    subjectContains: null, bodyContains: null, ...o,
  };
}
async function mirror(ms: EngineMessage[], rs: RuleDTO[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...ms.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rs.map((r): SyncChange => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ]);
  return store;
}

/* A bare decision into the Ohbox and a subject screen-out: the alert is shown on the shelf. */
const RULES = [rule({ id: "1-bare", destination: "INBOX" }), rule({ id: "9-deny", destination: "ohmail/Screened", subjectContains: "alert" })];
const ROWS = [msg("m-alert", "ohmail/Screened", "Weekly alert 12"), msg("m-other", "ohmail/News", "Lunch")];

describe("a no-rule press moves the rows its forecast lands at the place", () => {
  it("a move-only press into the Ohbox leaves the row the subject rule keeps on the shelf", async () => {
    const store = await mirror(ROWS, RULES);
    const s = senderScreening(store, "m-other")!;
    const plan = planScreeningChange(s, "ohbox", "sender", false, true);
    expect(plan.mutations.some((m) => (m.kind as string) === "move"), "the plan carries no move").toBe(false);
    const forecast = pressForecast({
      reader: store, options: { now: NOW }, subject: s.scopes.sender.messages, scope: "sender", match: ADDR,
      wanted: "INBOX", makeRule: false, applyRetro: true, now: NOW,
    });
    expect(forecast.keep.landing).toEqual(["m-other"]);
    expect(movesAtLanding(plan, forecast).map((m) => m.messageId)).toEqual(["m-other"]);
  });

  it("the demo's arm, with no forecast, moves every candidate (the control)", async () => {
    const store = await mirror(ROWS, RULES);
    const plan = planScreeningChange(senderScreening(store, "m-other")!, "ohbox", "sender", false, true);
    expect(movesAtLanding(plan, null).map((m) => m.messageId).sort()).toEqual(["m-alert", "m-other"]);
  });

  it("a rule press moves nothing itself, whatever its forecast lands", async () => {
    const store = await mirror(ROWS, RULES);
    const plan = planScreeningChange(senderScreening(store, "m-other")!, "ohbox", "sender", true, true);
    expect(movesAtLanding(plan, { keep: { landing: ["m-alert", "m-other"] }, remove: { landing: [] } })).toEqual([]);
  });

  it("the bulk bar's one partition answers for every sender it covers", async () => {
    // An undecided stranger's letter moved into the INBOX is shown in the Screener, so it is not
    // landed either; the decided sender's other letter is, as the single press's forecast says.
    const other = msg("x-news", "ohmail/News", "Hello", "someone@else.example");
    const store = await mirror([...ROWS, other], RULES);
    expect(landingOfMoves(store, { now: NOW }, [...ROWS, other], "INBOX").sort()).toEqual(["m-other"]);
    const known = await mirror([...ROWS, other], [...RULES, rule({ id: "x", match: "someone@else.example", destination: "INBOX" })]);
    expect(landingOfMoves(known, { now: NOW }, [...ROWS, other], "INBOX").sort()).toEqual(["m-other", "x-news"]);
  });
});
