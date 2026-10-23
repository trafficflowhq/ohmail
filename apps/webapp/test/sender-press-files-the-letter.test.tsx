/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, mutationEffects,
  type EngineMessage, type EngineMutation, type Folder, type RuleDTO, type SyncChange,
} from "@ohmail/client-engine";
import { ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import { COMMIT_MS, UNDO_MS } from "../app/shell/screener-state";
import en from "../messages/en.json";

/**
 * A LETTER FILED FROM THE SENDER SHEET NEVER RETURNS TO THE OHBOX (RULE-FILED-MESSAGE-SNAPS-BACK-
 * TO-OHBOX). A person opened a just-arrived sign-in notice, pressed Receipts on its sender's sheet
 * with the rule on, and the letter jumped back into New when the routing window closed: the press
 * moved nothing itself, only the window's overlay showed it filed, and the rule write files no mail.
 * The press now files the letter it was made on as an ordinary `move` at the press, with its inverse
 * in Undo, on every rule state and either switch position. The shell is the shipped one over a real
 * engine whose adapter answers like the server: a rule write echoes the rule row only, a move echoes
 * the letter at its new folder.
 */
const ME = "walker@example.invalid";
const SENDER = "notice@host.example";
const RECEIPTS = "ohmail/Receipts" as Folder;
let seq = 0;

function letter(id: string, date: string, unread: boolean, from = SENDER): EngineMessage {
  return {
    id, accountId: "acct_local_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Login notice ${id}`, from: { name: "Host", address: from }, to: [{ name: null, address: ME }], cc: [],
    date, folder: "INBOX" as Folder, snippet: "a new sign-in", unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: true, category: "security_alert", no_ai: true, no_forward: true, no_kb: true, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  } as unknown as EngineMessage;
}

function ruleOf(id: string, destination: string, provenance: string, match = SENDER): RuleDTO {
  return {
    id, kind: "sender", match, destination, priority: 0, provenance, enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 1, lastHitAt: null, demotions: 0 },
    createdAt: ISO, updatedAt: ISO, retro: { requestedAt: null, doneAt: null },
  } as unknown as RuleDTO;
}

interface Rig {
  engine: OhmailEngine;
  wire: EngineMutation[];
  /** The next /sync pages: the server's own changes, as the walk writes them. */
  pages: SyncChange[][];
}

async function rig(rules: RuleDTO[], extra: EngineMessage[] = [], seed: Partial<EngineMessage> = {}): Promise<Rig> {
  const store = new MemoryMirrorStore();
  await store.load();
  const rows = [{ ...letter("seed", "2026-08-04T08:55:00.000Z", true), ...seed }, letter("older", "2026-08-01T08:00:00.000Z", false), ...extra];
  await store.applyChanges([
    ...rows.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: ISO, entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: ISO, entity: r })),
  ] as unknown as SyncChange[]);
  const wire: EngineMutation[] = [];
  const pages: SyncChange[][] = [];
  const engine = new OhmailEngine({
    store,
    adapter: {
      sync: async () => {
        const page = pages.shift() ?? [];
        return {
          changes: { creates: [], updates: page, moves: [], deletes: [] },
          cursor: String(seq), hasMore: false, serverTime: ISO,
        };
      },
      mutate: async (m: EngineMutation) => {
        wire.push(m);
        // An older server: the rule write echoes the rule row, re-armed for its walk, and files nothing.
        const changes = mutationEffects(store, m, { now: () => new Date(ISO), uuid: () => `srv-${++seq}` }).map((e) => ({
          type: e.type, op: "update", id: e.id, seq: ++seq, updatedAt: ISO,
          entity: e.type === "rule" && (m as { applyRetro?: boolean }).applyRetro === true
            ? { ...(e.entity as RuleDTO), retro: { requestedAt: ISO, doneAt: null } } : e.entity,
        }));
        return { changes, seq: null, ...(m.kind === "rule_create" ? { entityId: changes[0]?.id } : {}) };
      },
      fetchBody: async () => null,
    },
  } as never);
  return { engine, wire, pages };
}

/** The ids the Ohbox draws in New, and in the whole Ohbox. */
const inNew = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(`[aria-label="${en.ohbox.newForYou}"] .row[data-id]`)].map((n) => n.dataset.id!);
const inOhbox = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".row[data-id]")].map((n) => n.dataset.id!);
const folderOf = (r: Rig, id = "seed"): string | undefined => r.engine.read().get<EngineMessage>("message", id)?.folder;
const moves = (r: Rig) => r.wire.filter((m): m is Extract<EngineMutation, { kind: "move" }> => m.kind === "move");
const ruleWrites = (r: Rig) => r.wire.filter((m) => m.kind.startsWith("rule_"));
const UNDO = "Undo";
const toasts = (): string[] =>
  [...document.querySelectorAll("[class*=toast]")].map((n) => (n.textContent ?? "").trim()).filter(Boolean);

/** Mount, open the just-arrived letter (the hold and the glance read), and press on its sender's sheet. */
async function press(r: Rig, o: { dest?: string; retroOff?: boolean; domain?: boolean } = {}): Promise<void> {
  await mountShell([mailbox({ id: "mb_1", address: ME, organizerRole: "organizer", lastSyncAt: ISO } as never)], { engine: r.engine });
  await tick(50);
  // Opened the way a person opens it: the click holds it in New and reads it.
  const row = document.querySelector<HTMLElement>('.row[data-id="seed"]');
  await act(async () => { row!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await tick(3000);
  expect(r.engine.openRowHeld(), "premise: the opened letter is held").toBe("seed");
  expect(inNew(), "premise: the opened letter is in New").toContain("seed");
  const av = document.querySelector<HTMLElement>('.row[data-id="seed"] .av');
  await act(async () => { av!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await tick(50);
  if (o.domain) {
    await act(async () => { document.querySelectorAll<HTMLElement>("#sender-sheet .sm-scope [role=radio]")[1]!.click(); });
    await tick(10);
  }
  if (o.retroOff) {
    await act(async () => { document.querySelector<HTMLElement>("#sender-sheet .sm-retro")!.click(); });
    await tick(10);
  }
  const option = document.querySelector<HTMLElement>(`#sender-sheet [data-dest="${o.dest ?? "receipts"}"]`);
  expect(option, "the sheet offers the place").toBeTruthy();
  await act(async () => { option!.click(); });
  await tick(20);
}

beforeEach(() => { installShellEnv(); process.env.NEXT_PUBLIC_API_BASE = ""; seq = 0; });
afterEach(async () => { await teardownShellEnv(); process.env.NEXT_PUBLIC_API_BASE = "/api"; });

describe("the sender sheet's rule press files the letter it was made on", () => {
  it("A: a retarget press moves the letter at the press; it is never in the Ohbox again, and the hold ends", async () => {
    const r = await rig([ruleOf("r-allow", "INBOX", "promoted")]);
    await press(r);
    expect(moves(r).map((m) => [m.messageId, m.folder]), "the press moved the letter").toEqual([["seed", RECEIPTS]]);
    expect(moves(r)[0]!.pressRule, "the press rewrites the route: its move is no override of it").toBe(true);
    expect(ruleWrites(r), "the rule waits for the window").toEqual([]);
    expect(r.engine.openRowHeld(), "the move named the held row").toBeNull();
    expect(inOhbox(), "at the press").not.toContain("seed");

    await tick(UNDO_MS + 1000);
    expect(ruleWrites(r).map((m) => m.kind)).toEqual(["rule_update"]);
    expect(inOhbox(), "after the window and the PATCH answer").not.toContain("seed");
    expect(folderOf(r)).toBe(RECEIPTS);

    await act(async () => { await r.engine.syncOnce(); });
    await tick(20);
    expect(inOhbox(), "after the next /sync").not.toContain("seed");
    expect(moves(r), "no backlog row moved").toHaveLength(1);
  });

  it("A: Undo inside the window puts the letter back in New and sends no rule", async () => {
    const r = await rig([ruleOf("r-allow", "INBOX", "promoted")]);
    await press(r);
    const undo = [...document.querySelectorAll<HTMLElement>(".toast-act")].find((b) => b.textContent?.trim() === UNDO);
    expect(undo, "the press offered Undo").toBeTruthy();
    await act(async () => { undo!.click(); });
    await tick(UNDO_MS + 1000);
    expect(folderOf(r)).toBe("INBOX");
    // Taking the press back is no correction of the route: the inverse is marked as the press's.
    expect(moves(r).map((m) => [m.messageId, m.folder, m.pressRule])).toEqual([["seed", RECEIPTS, true], ["seed", "INBOX", true]]);
    expect(ruleWrites(r), "Undo left the rule to be written").toEqual([]);
    expect(inNew()).toContain("seed");
  });

  it("B: a Receipts rule already stands and the lift left the letter in INBOX: the press moves it, with Undo", async () => {
    const r = await rig([ruleOf("r-rec", RECEIPTS, "manual")]);
    await press(r, { retroOff: true });
    expect(moves(r).map((m) => m.messageId)).toEqual(["seed"]);
    expect(inOhbox()).not.toContain("seed");
    expect(toasts().some((t) => t.includes("is already in")), toasts().join(" | ")).toBe(false);
    expect([...document.querySelectorAll(".toast-act")].some((b) => b.textContent?.trim() === UNDO),
      "the press offered no Undo").toBe(true);
    await tick(UNDO_MS + 1000);
    expect(ruleWrites(r), "a standing rule with the switch off writes nothing").toEqual([]);
    expect(folderOf(r)).toBe(RECEIPTS);
    expect(inOhbox()).not.toContain("seed");
  });

  it("D: with the past-mail switch off the letter lands and the rest of their mail stays", async () => {
    const r = await rig([ruleOf("r-allow", "INBOX", "promoted")]);
    await press(r, { retroOff: true });
    expect(moves(r).map((m) => m.messageId)).toEqual(["seed"]);
    await tick(UNDO_MS + 1000);
    expect(ruleWrites(r).map((m) => [m.kind, (m as { applyRetro?: boolean }).applyRetro])).toEqual([["rule_update", false]]);
    expect(folderOf(r)).toBe(RECEIPTS);
    expect(folderOf(r, "older")).toBe("INBOX");
    expect(inOhbox()).not.toContain("seed");
    expect(inOhbox(), "the rest stays where it is").toContain("older");
  });

  it("the rest of the landing stays at the place until the walk files it, then a skipped row returns with its cause", async () => {
    const r = await rig([ruleOf("r-allow", "INBOX", "promoted")], [letter("other", "2026-08-02T08:00:00.000Z", false)]);
    await press(r);
    expect(moves(r).map((m) => m.messageId), "only the letter pressed on moved").toEqual(["seed"]);
    expect(inOhbox(), "at the press").not.toEqual(expect.arrayContaining(["older"]));
    expect(inOhbox()).not.toContain("other");
    await tick(UNDO_MS + 1000);
    expect(ruleWrites(r).map((m) => m.kind)).toEqual(["rule_update"]);
    for (const id of ["seed", "older", "other"]) expect(inOhbox(), `${id} after the window and the PATCH answer`).not.toContain(id);
    await act(async () => { await r.engine.syncOnce(); });
    await tick(20);
    for (const id of ["older", "other"]) expect(inOhbox(), `${id} after the next /sync`).not.toContain(id);

    // The walk files one, and skips the other (a reason the wire does not carry), then stamps done.
    const filed = r.engine.read().get<EngineMessage>("message", "other")!;
    r.pages.push([{ type: "message", op: "update", id: "other", seq: ++seq, updatedAt: ISO, entity: { ...filed, folder: RECEIPTS } } as SyncChange]);
    await act(async () => { await r.engine.syncOnce(); });
    await tick(20);
    expect(folderOf(r, "other")).toBe(RECEIPTS);
    expect(inOhbox()).not.toContain("other");
    expect(inOhbox(), "the walk has not said it is done").not.toContain("older");
    const rule = r.engine.read().get<RuleDTO>("rule", "r-allow")!;
    r.pages.push([{ type: "rule", op: "update", id: "r-allow", seq: ++seq, updatedAt: ISO,
      entity: { ...rule, retro: { requestedAt: ISO, doneAt: ISO } } } as SyncChange]);
    await act(async () => { await r.engine.syncOnce(); });
    await tick(20);
    expect(inOhbox(), "the walk is done: the row it skipped is shown where it is").toContain("older");
    // The read-back names what stayed, once the walk reads done (the toast host shows one at a time).
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) { for (const t of toasts()) seen.add(t); await tick(500); }
    expect([...seen].some((t) => t.includes(" still in ")), [...seen].join(" | ")).toBe(true);
  });

  /* THE GATE PATH: the answer the gate admitted stands in the Ohbox (decided) while a newer letter
     of theirs waits, so the press is the Screener's decide. The decide files its own bag; the
     letter pressed on moves once the decision stands, and only while it is where it was pressed. */
  const atTheGate = () => rig([], [{ ...letter("held", "2026-08-05T08:00:00.000Z", true), folder: "ohmail/Screener" as Folder }], { placeDecided: true });

  it("the gate path: the letter pressed on is filed once the decision stands", async () => {
    const r = await atTheGate();
    await press(r);
    expect(moves(r), "nothing moves before the decision is sent").toEqual([]);
    await tick(COMMIT_MS + 1000);
    expect(r.wire.map((m) => m.kind), "the decision first, then the letter pressed on").toEqual(["screener_decide", "move"]);
    expect(moves(r)).toEqual([{ kind: "move", messageId: "seed", folder: RECEIPTS, from: "INBOX", pressRule: true }]);
    await act(async () => { await r.engine.syncOnce(); });
    await tick(20);
    expect(folderOf(r)).toBe(RECEIPTS);
    expect(inOhbox(), "after the next /sync").not.toContain("seed");
  });

  it("the gate path: Undo inside the window sends neither the decision nor the move", async () => {
    const r = await atTheGate();
    await press(r);
    const undo = [...document.querySelectorAll<HTMLElement>(".toast-act")].find((b) => b.textContent?.trim() === UNDO);
    expect(undo, "the decision offered Undo").toBeTruthy();
    await act(async () => { undo!.click(); });
    await tick(COMMIT_MS + 1000);
    expect(r.wire).toEqual([]);
    expect(folderOf(r)).toBe("INBOX");
  });

  it("a domain-scope press moves exactly the letter pressed on", async () => {
    const r = await rig([{ ...ruleOf("r-dom", "INBOX", "promoted", "host.example"), kind: "domain" } as RuleDTO]);
    await press(r, { domain: true });
    await tick(UNDO_MS + 1000);
    expect(ruleWrites(r).map((m) => [m.kind, (m as { ruleId?: string }).ruleId])).toEqual([["rule_update", "r-dom"]]);
    expect(moves(r).map((m) => [m.messageId, m.folder, m.pressRule])).toEqual([["seed", RECEIPTS, true]]);
    expect(inOhbox()).not.toContain("seed");
  });
});
