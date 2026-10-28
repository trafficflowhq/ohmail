/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, consentPartition, heldRuleId, pressRules, rulesInPlay, type EngineMessage, type RuleDTO, type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { SenderMenu } from "../app/shell/SenderMenu";
import { planScreeningChange, ruleMatchOf, senderScreening, type ScreeningScope } from "../app/shell/sender-screening";

/**
 * WHERE A SENDER'S MAIL GOES IS THEIR RULE, NOT WHERE THEIR LETTERS SIT. Tester round 24: two of
 * B's letters in News by B's rule and one left in Screened by an older, revoked rule. The sheet
 * marked no destination and named no rule, so nothing on it said B's mail files into News. The
 * mark and "Their rules" read the rule; the Now line keeps saying where the letters are.
 */
const NOW = new Date("2026-09-28T07:00:00.000Z");
const ADDR = "bea@example.invalid";
let seq = 0;

function msg(id: string, folder: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `letter ${id}`, from: { name: "Bea", address: ADDR }, to: [], cc: [],
    date: "2026-09-27T12:00:00.000Z", folder, snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-27T12:00:00.000Z",
  } as EngineMessage;
}

function rule(id: string, destination: string, o: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id, kind: "sender", match: ADDR, destination, priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-28T06:25:41.000Z", updatedAt: "2026-09-28T06:25:41.000Z", ...o,
  } as RuleDTO;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

async function render(messages: EngineMessage[], rules: RuleDTO[]): Promise<HTMLElement> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[]);
  const placeOf = consentPartition(store, { now: NOW }).placeOf;
  const sender = senderScreening(store, messages[0]!.id, undefined, placeOf)!;
  const rulesFor = (scope: ScreeningScope) => rulesInPlay({
    reader: store, placeOf, subject: sender.scopes[scope].messages, scope, match: ruleMatchOf(sender, scope),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en,
      children: React.createElement(SenderMenu, {
        state: { messageId: messages[0]!.id, x: 0, y: 0 }, sender, onChoose: () => {}, onOpenDetail: () => {},
        rulesFor, onClose: () => {},
      }),
    }));
  });
  return host;
}

const marked = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('[role="option"][aria-selected="true"]')].map((n) => n.getAttribute("data-dest") ?? "");
const ruleLines = (el: HTMLElement): string[] =>
  [...el.querySelectorAll(".sm-rules .sm-rule-line")].map((n) => n.textContent ?? "");

describe("the sender sheet reads the sender's rule", () => {
  it("mail split by an older rule: News is marked and the News rule is named", async () => {
    const el = await render(
      [msg("f2", "ohmail/News"), msg("f5", "ohmail/News"), msg("old", "ohmail/Screened")],
      [rule("r-news", "ohmail/News")],
    );
    expect(el.querySelector(".sm-now")?.textContent, "the Now line stopped saying where the letters are")
      .toBe("3 messages — News 2 · Screened out 1");
    expect(marked(el), "the sheet does not mark where their rule files their mail").toEqual(["reads"]);
    expect(el.querySelector('[data-dest="reads"] .ck'), "no ✓ on the rule's place").not.toBeNull();
    expect(ruleLines(el), "the sheet does not name the rule").toEqual(["All their mail → News2"]);
  });

  it("a rule nothing follows yet is still the mark and the line", async () => {
    const el = await render(
      [msg("a", "ohmail/Screened"), msg("b", "ohmail/Screened")],
      [rule("r-news", "ohmail/News")],
    );
    expect(marked(el)).toEqual(["reads"]);
    expect(ruleLines(el)).toEqual(["All their mail → News0"]);
  });

  it("a domain rule is the address's decision too", async () => {
    const el = await render(
      [msg("a", "ohmail/Receipts")],
      [rule("r-dom", "ohmail/News", { kind: "domain", match: "example.invalid" })],
    );
    expect(marked(el)).toEqual(["reads"]);
  });

  it("a sender nothing decides keeps the mark where the lists show their mail", async () => {
    const el = await render([msg("a", "ohmail/Receipts"), msg("b", "ohmail/Receipts")], []);
    expect(marked(el), "an undecided sender's one place stopped being marked").toEqual(["receipts"]);
  });

  it("all their mail where their rule puts it: the mark, and no line to add", async () => {
    const el = await render(
      [msg("a", "ohmail/News"), msg("b", "ohmail/News")],
      [rule("r-news", "ohmail/News")],
    );
    expect(marked(el)).toEqual(["reads"]);
    expect(el.querySelector(".sm-rules"), "a single rule that places everything says nothing new").toBeNull();
  });
});

describe("on a reader-only install the sheet plans over the organizer's copy", () => {
  it("a stale row of this device says the Ohbox, the organizer files News: the Ohbox press rewrites the rule", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const copy = { mailboxId: "mb", rules: [rule("profile:mb:0", "ohmail/News")], asOf: NOW.toISOString(), from: { kind: "local", name: "Host", since: null }, updatedAt: NOW.toISOString(), applied: [] };
    await store.applyChanges([
      { type: "message", op: "create", id: "a", seq: ++seq, updatedAt: NOW.toISOString(), entity: msg("a", "ohmail/News") },
      { type: "rule", op: "create", id: "local-1", seq: ++seq, updatedAt: NOW.toISOString(), entity: rule("local-1", "INBOX") },
      { type: "mailbox_profile", op: "create", id: "mb", seq: ++seq, updatedAt: NOW.toISOString(), entity: copy },
    ] as SyncChange[]);
    const placeOf = consentPartition(store, { now: NOW }).placeOf;
    const stale = planScreeningChange(senderScreening(store, "a", undefined, placeOf)!, "ohbox", "sender", true, false);
    expect(stale.ruleState, "over the device's own row").toBe("already");
    const over = pressRules(store, { travels: true, queued: [], applied: [], unsettled: [], now: NOW });
    const plan = planScreeningChange(senderScreening(store, "a", undefined, placeOf, over)!, "ohbox", "sender", true, false);
    expect(plan.ruleState).toBe("retargeted");
    expect(plan.ruleMutations).toEqual([{ kind: "rule_update", ruleId: "local-1", destination: "INBOX", applyRetro: false }]);
  });

  it("a Move back to the copy's place while a press to the Ohbox waits on the organizer retargets after it", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const copy = { mailboxId: "mb", rules: [rule("profile:mb:0", "ohmail/News")], asOf: NOW.toISOString(), from: { kind: "local", name: "Host", since: null }, updatedAt: NOW.toISOString(), applied: [] };
    await store.applyChanges([
      { type: "message", op: "create", id: "a", seq: ++seq, updatedAt: NOW.toISOString(), entity: msg("a", "INBOX") },
      { type: "mailbox_profile", op: "create", id: "mb", seq: ++seq, updatedAt: NOW.toISOString(), entity: copy },
    ] as SyncChange[]);
    const key = { kind: "sender", match: ADDR, subjectContains: null, bodyContains: null };
    const move = (unsettled: Parameters<typeof pressRules>[1]["unsettled"]) => planScreeningChange(senderScreening(store, "a", undefined, undefined,
      pressRules(store, { travels: true, queued: [], applied: [], unsettled, now: NOW }))!, "reads", "sender", true, false);
    expect(move([]).ruleState, "the copy alone").toBe("already");
    const plan = move([{ kind: "rule.update", key, destination: "INBOX" }]);
    expect(plan.ruleMutations).toEqual([{ kind: "rule_update", ruleId: heldRuleId(key), destination: "ohmail/News", applyRetro: false }]);
  });
});
