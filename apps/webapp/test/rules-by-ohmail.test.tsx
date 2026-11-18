/** @vitest-environment jsdom */
import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { SettingsView } from "../app/views/SettingsView";
import { splitByDecider } from "../app/views/RulesView";

/**
 * SETTINGS → RULES SAYS WHICH RULES OHMAIL WROTE. The act on suggestions' rules were listed
 * "from a Screener decision", a person's words. They carry `byOhmail` now and are drawn in their
 * own group, "Decided for you by ohmail", with the same Change and Revoke — through the real pane.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

const R = messages.rules;
const rule = (id: string, match: string, over: Partial<RuleDTO> = {}): RuleDTO => ({
  id, kind: "sender", match, destination: "ohmail/Screened", priority: 0, provenance: "promoted",
  enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z", ...over,
});

let host: HTMLDivElement;
let root: Root | null = null;
let revoked: string[];

async function open(rules: RuleDTO[]): Promise<void> {
  const view = h(SettingsView, {
    notifications: null, tags: [], tagCounts: {},
    rules: {
      items: rules,
      onRevoke: async (id: string) => { revoked.push(id); return { status: "confirmed" as const }; },
      onRetarget: async () => ({ status: "confirmed" as const }),
      pastMail: () => null,
    },
  });
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-09-27T12:00:00.000Z"),
      children: h(ThemeProvider, { children: h(ToastHost, { children: view }) }),
    }));
  });
  const nav = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Rules")!;
  await act(async () => { nav.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

const lists = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.rules-view [role="list"]')];
const rowsIn = (list: HTMLElement): HTMLElement[] => [...list.querySelectorAll<HTMLElement>("[data-rule-id]")];

beforeEach(() => {
  revoked = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host.remove();
  root = null;
});

describe("the act's rules in their own group", () => {
  it("draws them under their own label, each saying where it came from", async () => {
    await open([
      rule("p1", "friend@press.example", { destination: "INBOX" }),
      rule("a1", "news@act.example", { byOhmail: true }),
      rule("p2", "shop@press.example"),
      rule("a2", "promo@act.example", { byOhmail: true }),
    ]);
    const [yours, ohmail] = lists();
    expect(lists()).toHaveLength(2);
    expect(host.textContent).toContain(R.groupByOhmail);
    expect(ohmail!.getAttribute("aria-label")).toBe(R.groupByOhmail);
    expect(rowsIn(yours!).map((r) => r.dataset.ruleId)).toEqual(["p1", "p2"]);
    expect(rowsIn(ohmail!).map((r) => r.dataset.ruleId), "the act's rules are listed as a person's").toEqual(["a1", "a2"]);
    for (const r of rowsIn(ohmail!)) {
      expect(r.textContent).toContain(R.origin.byOhmail);
      expect(r.textContent).not.toContain(R.origin.promoted);
      expect(r.getAttribute("aria-setsize")).toBe("2");
    }
    for (const r of rowsIn(yours!)) expect(r.textContent).toContain(R.origin.promoted);
    expect(rowsIn(ohmail!).map((r) => r.getAttribute("aria-posinset"))).toEqual(["1", "2"]);
  });

  it("with the same undo", async () => {
    await open([rule("p1", "friend@press.example"), rule("a1", "news@act.example", { byOhmail: true })]);
    const row = host.querySelector<HTMLElement>('[data-rule-id="a1"]')!;
    const revoke = [...row.querySelectorAll("button")].find((b) => b.textContent?.trim() === R.revoke)!;
    await act(async () => { revoke.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const confirm = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === R.revokeConfirm)!;
    await act(async () => { confirm.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(revoked).toEqual(["a1"]);
  });

  it("CONTROL: with no rule of ohmail's there is one list and no label", async () => {
    await open([rule("p1", "friend@press.example"), rule("p2", "shop@press.example", { byOhmail: false })]);
    expect(lists()).toHaveLength(1);
    expect(host.textContent).not.toContain(R.groupByOhmail);
  });

  it("a rule from a server that sends no mark is a person's", () => {
    const { yours, ohmail } = splitByDecider([rule("x", "a@b.example"), rule("y", "c@d.example", { byOhmail: true })]);
    expect(yours.map((r) => r.id)).toEqual(["x"]);
    expect(ohmail.map((r) => r.id)).toEqual(["y"]);
  });
});
