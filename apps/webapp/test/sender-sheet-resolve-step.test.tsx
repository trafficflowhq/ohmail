/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  FOLDER_OF_VIEW,
  MemoryMirrorStore,
  consentPartition,
  pressForecast,
  rulesInPlay,
  type EngineMessage,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { SenderMenu } from "../app/shell/SenderMenu";
import {
  planScreeningChange, ruleMatchOf, screeningPath, senderScreening, withResolution,
  type ScreeningDest, type ScreeningScope,
} from "@ohmail/app-logic/press/sender-screening";
import { shellSliceOf } from "./source-anchor";

/**
 * THE SHEET NAMES THE RULE THAT DISAGREES, AND THE PRESS WINS BY DEFAULT. A subject rule for the
 * pressed address filing elsewhere turns the press into a step: the rule is listed with the rows it
 * keeps, "All their mail" is chosen, Enter commits it, ↑/↓ changes the answer, and Escape goes back
 * to the list before it closes the sheet. No rule in the way: no step, the press commits.
 */
const NOW = new Date("2026-09-25T13:00:00.000Z");
const ADDR = "alerts@kestrel.example";
let seq = 0;

function msg(id: string, o: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "Invoice ready", from: { name: "Kestrel", address: ADDR }, to: [], cc: [],
    date: "2026-09-24T12:00:00.000Z", folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-24T12:00:00.000Z", ...o,
  } as EngineMessage;
}

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T08:00:00.000Z", updatedAt: "2026-08-01T08:00:00.000Z", ...o,
  } as RuleDTO;
}

async function mirror(messages: EngineMessage[], rules: RuleDTO[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[]);
  return store;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

async function render(messages: EngineMessage[], rules: RuleDTO[], locale: "en" | "de" = "en") {
  const store = await mirror(messages, rules);
  const options = { now: NOW };
  const placeOf = consentPartition(store, options).placeOf;
  const sender = senderScreening(store, messages[0]!.id, undefined, placeOf)!;
  const onChoose = vi.fn();
  const backRef: { current: (() => boolean) | null } = { current: null };
  const forecastFor = (dest: ScreeningDest, scope: ScreeningScope, makeRule: boolean, applyRetro: boolean) =>
    pressForecast({
      reader: store, options, subject: sender.scopes[scope].messages, scope, match: ruleMatchOf(sender, scope),
      wanted: FOLDER_OF_VIEW[dest], makeRule, applyRetro, now: NOW,
    });
  const rulesFor = (scope: ScreeningScope) => rulesInPlay({
    reader: store, placeOf, subject: sender.scopes[scope].messages, scope, match: ruleMatchOf(sender, scope),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de,
      children: React.createElement(SenderMenu, {
        state: { messageId: messages[0]!.id, x: 0, y: 0 }, sender, onChoose, onOpenDetail: () => {},
        forecastFor, rulesFor, backRef, onClose: () => {},
      }),
    }));
  });
  return { el: host, onChoose, backRef, sender };
}

const press = async (node: Element | null | undefined) => {
  expect(node, "the control this test drives does not exist").toBeTruthy();
  await act(async () => { node!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const key = async (node: Element | null | undefined, k: string) => {
  expect(node).toBeTruthy();
  await act(async () => { node!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
};
const ohbox = (el: HTMLElement) => el.querySelector('[data-dest="ohbox"]');

const owner = () => [
  [msg("plain"), msg("mon", { subject: "[Monitor] disk at 91%", folder: "ohmail/News" })],
  [rule({ id: "bare", destination: "INBOX", createdAt: "2026-07-01T08:00:00.000Z" }),
    rule({ id: "term", destination: "ohmail/News", subjectContains: "[Monitor]" })],
] as const;

describe("the sheet lists the rules in play", () => {
  it("both rules, each with the rows it places, under Their rules", async () => {
    const [m, r] = owner();
    const { el } = await render([...m], [...r]);
    const lines = [...el.querySelectorAll(".sm-rules .sm-rule-line")].map((n) => n.textContent);
    expect(el.querySelector(".sm-rules-head")?.textContent).toBe("Their rules");
    // The router's order, the winner first: a term outranks the bare rule it narrows.
    expect(lines).toEqual(["Subject contains »[Monitor]« → News1", "All their mail → Ohbox1"]);
    expect(el.querySelector(".sm-now")?.textContent).toBe("2 messages — Ohbox 1 · News 1");
  });

  it("a single bare rule says nothing new", async () => {
    const { el } = await render([msg("plain")], [rule({ id: "bare", destination: "INBOX" })]);
    expect(el.querySelector(".sm-rules")).toBeNull();
  });
});

describe("the resolve step", () => {
  it("pressing the Ohbox over their subject rule asks, with All chosen, and Enter commits it", async () => {
    const [m, r] = owner();
    const { el, onChoose } = await render([...m], [...r]);
    await press(ohbox(el));
    expect(onChoose, "the press committed over a rule that disagrees").not.toHaveBeenCalled();
    const step = el.querySelector(".sm-resolve");
    expect(step?.querySelector("p")?.textContent).toBe("Ohbox — one of your rules says otherwise");
    const tiles = [...el.querySelectorAll('.sm-choices [role="radio"]')];
    expect(tiles.map((n) => n.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(tiles[0]!.textContent).toContain("All their mail → Ohbox");
    expect(tiles[0]!.textContent).toContain("2 messages");
    expect(tiles[1]!.textContent).toContain("Keep the split");
    expect(document.activeElement, "focus is on the chosen tile").toBe(tiles[0]);
    await key(el.querySelector(".sm-choices"), "Enter");
    expect(onChoose).toHaveBeenCalledTimes(1);
    const [dest, scope, , , answer] = onChoose.mock.calls[0]!;
    expect([dest, scope, answer.resolution, answer.shown.map((x: RuleDTO) => x.id)]).toEqual(["ohbox", "sender", "remove", ["term"]]);
  });

  it("↓ chooses Keep the split, and it is what commits", async () => {
    const [m, r] = owner();
    const { el, onChoose } = await render([...m], [...r]);
    await press(ohbox(el));
    await key(el.querySelector(".sm-choices"), "ArrowDown");
    expect([...el.querySelectorAll('.sm-choices [role="radio"]')].map((n) => n.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    await press(el.querySelector(".sm-confirm-row .go"));
    expect(onChoose.mock.calls[0]![4].resolution).toBe("keep");
  });

  it("Escape steps back to the list and hands focus back to the destination; a second Escape closes", async () => {
    const [m, r] = owner();
    const { el, backRef } = await render([...m], [...r]);
    await press(ohbox(el));
    let first = false;
    await act(async () => { first = backRef.current!(); await Promise.resolve(); });
    expect(first, "Escape in the step closed the sheet").toBe(true);
    expect(el.querySelector(".sm-resolve")).toBeNull();
    expect(document.activeElement).toBe(ohbox(el));
    let second = true;
    await act(async () => { second = backRef.current!(); });
    expect(second, "Escape on the list must close the sheet").toBe(false);
  });

  it("no rule in the way: no step, the press commits at once", async () => {
    const { el, onChoose } = await render([msg("plain")], [rule({ id: "bare", destination: "ohmail/News" })]);
    await press(ohbox(el));
    expect(el.querySelector(".sm-resolve")).toBeNull();
    expect(onChoose).toHaveBeenCalledWith("ohbox", "sender", true, true);
  });

  it("a higher-priority domain rule: the exception is the default, and says who stays", async () => {
    const wide = rule({ id: "dom", kind: "domain", match: "kestrel.example", destination: "ohmail/Screened", priority: 5 });
    const { el, onChoose } = await render([msg("m1")], [wide]);
    await press(ohbox(el));
    const tiles = [...el.querySelectorAll('.sm-choices [role="radio"]')];
    expect(tiles[0]!.textContent).toContain("Only this address → Ohbox");
    expect(tiles[0]!.textContent).toContain("Everyone else at kestrel.example stays in Screened out");
    await key(el.querySelector(".sm-choices"), "Enter");
    expect(onChoose.mock.calls[0]!.slice(0, 2)).toEqual(["ohbox", "sender"]);
    expect(onChoose.mock.calls[0]![4].resolution).toBe("keep");
  });

  it("the German step at the longest title", async () => {
    const wide = rule({ id: "dom", kind: "domain", match: "kestrel.example", destination: "ohmail/Screened", priority: 5 });
    const { el } = await render([msg("m1")], [wide], "de");
    await press(ohbox(el));
    expect(el.querySelector(".sm-resolve p")?.textContent).toContain("deine Regel für alle bei kestrel.example");
  });
});

describe("no address press past the gate reaches the wire outside the window", () => {
  it("changeScreening hands the window path to the held press before any dispatch", () => {
    const body = shellSliceOf("changeScreening");
    const held = body.indexOf('if (path === "window" && !demo');
    const hold = body.indexOf("holdScreenPress(", held);
    const back = body.indexOf("return;", hold);
    const dispatch = body.indexOf("dispatchScreeningChange(plan");
    expect(held, "the window path is not decided in changeScreening").toBeGreaterThan(0);
    expect(hold, "the window path does not hold the press").toBeGreaterThan(held);
    expect(back, "the held press falls through to a dispatch").toBeGreaterThan(hold);
    expect(dispatch, "the other doors' dispatch is not after the held press").toBeGreaterThan(back);
    expect(body.match(/dispatchScreeningChange\(/g) ?? [], "changeScreening dispatches a plan twice").toHaveLength(1);
  });

  it("the held press dispatches its rules only through the window", () => {
    const body = shellSliceOf("holdScreenPress");
    expect(body).toMatch(/routing\.holdScreen\(/);
    expect(body, "a rule write left the held press directly").not.toMatch(/ruleMutations|dispatchScreeningChange/);
  });
});

describe("which door a sheet press goes through", () => {
  it("an address press past the gate that makes a rule is held; a domain press and a move-only go at once", async () => {
    const store = await mirror([msg("m1")], []);
    const s = senderScreening(store, "m1")!;
    expect(screeningPath(s, "sender", true)).toBe("window");
    expect(screeningPath(s, "domain", true)).toBe("immediate");
    expect(screeningPath(s, "sender", false)).toBe("immediate");
    const held = await mirror([msg("h1", { folder: "ohmail/Screener" })], []);
    expect(screeningPath(senderScreening(held, "h1")!, "sender", true)).toBe("decide");
  });

  it("the step's removals ride a decide ahead of it, and a ladder after it", async () => {
    const store = await mirror([msg("h1", { folder: "ohmail/Screener" })], []);
    const plan = planScreeningChange(senderScreening(store, "h1")!, "ohbox", "sender", true, true);
    const del = { kind: "rule_delete" as const, ruleId: "term" };
    const out = withResolution(plan, [del]);
    expect(out.mutations[0]).toBe(del);
    expect(out.ruleMutations).toEqual([del]);
    expect(out.mutations.filter((m) => m.kind === "screener_decide")).toHaveLength(1);
  });
});

