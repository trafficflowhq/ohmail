/** @vitest-environment jsdom */
import type { EngineMessage, RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, consentPartition, rulesInPlay, type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { SenderMenu } from "../app/components/sender-menu/SenderMenu";
import { ruleMatchOf, senderScreening, type ScreeningScope } from "@ohmail/app-logic/press/sender-screening";

/**
 * WHERE A SENDER'S MAIL GOES IS THEIR RULE, NOT WHERE THEIR LETTERS SIT. Tester round 24: two of
 * B's letters in News by B's rule and one left in Screened by an older, revoked rule. The sheet
 * marked no destination and named no rule, so nothing on it said B's mail files into News. The
 * mark and "Their rules" read the rule; the Now line keeps saying where the letters are.
 *
 * (The reader-only install's two planner cases moved to `sender-sheet-reads-the-rule-plan.test.ts`: they render no
 * sheet.)
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
  return within(host).getByRole("dialog", { name: en.screening.aria.replace("{sender}", ADDR) });
}

const marked = (el: HTMLElement): string[] =>
  within(el).queryAllByRole("option", { selected: true }).map((n) => n.getAttribute("data-dest") ?? "");
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
    expect(within(el).getByRole("option", { name: /^News/, selected: true }).querySelector(".ck"), "no ✓ on the rule's place").not.toBeNull();
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
