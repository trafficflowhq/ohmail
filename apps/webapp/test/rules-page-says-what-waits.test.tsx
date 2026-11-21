/** @vitest-environment jsdom */
import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import type { WaitingOnOrganizerView } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { within } from "@testing-library/react";
import { MailGround, mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import { displayRuleMatch } from "@ohmail/app-logic/text/idn";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../packages/app/test/support/fake-window.js";
import { fakeMail } from "../../../packages/app/test/reader/support/mail.js";
import { MailFrame } from "../app/shell/browser-mail";
import { mailbox } from "./fixtures/live-walk-shell";

/**
 * THE RULES PAGE SAYS THE STATE THE ORGANIZER WILL ACT ON, through the real pane: a removal or a
 * change that waits on the install organizing the mailbox, its refusal, a rule removed here and
 * still asked there, an address rule lifted over its domain's (or outranked by it again), twins
 * as one row, and the settings bound (gap rows NO-STANDING-LIST-OF-WHAT-WAITS-ON-THE-ORGANIZER,
 * LB2-RULE-DELETE-204-HIDES-PENDING, RULES-PAGE-HIDES-A-LIFTED-PRIORITY, PROFILE-EXPORT-BOUND-SAYS-NOTHING).
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
const rule = (id: string, kind: "sender" | "domain", match: string, over: Partial<RuleDTO> = {}): RuleDTO => ({
  id, kind, match, destination: "ohmail/News", priority: 0, provenance: "manual",
  enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z", ...over,
});

let host: HTMLDivElement;
let root: Root | null = null;

let retargets: Array<[string, string, boolean | "walk"]>;
let shownRules: RuleDTO[];
let words: typeof messages | typeof de;

async function open(
  rules: RuleDTO[], waiting: WaitingOnOrganizerView[] = [], lang: "en" | "de" = "en",
): Promise<void> {
  shownRules = rules;
  words = lang === "de" ? de : messages;
  const { WebRulesPane } = await import("../app/(product)/mailbox/WebRulesPane");
  const settings = mailSettings({ ...NO_PANE_PARTS, rules: WebRulesPane });
  const mail = fakeMail([], [], {}, Object.fromEntries(rules.map((rule) => [`rule:${rule.id}`, rule])));
  const engine = Object.assign(mail.engine, {
    waitingOnOrganizer: () => waiting,
    queuedRuleWrites: () => [],
    appliedRuleRequests: () => [],
    unsettledRulePresses: () => [],
    mutate: async (mutation: Parameters<typeof mail.engine.mutate>[0]) => {
      if (mutation.kind === "rule_update") {
        retargets.push([mutation.ruleId, mutation.destination, mutation.applyRetro ? "walk" : mutation.refile === true]);
      }
      return { status: "confirmed" as const };
    },
  });
  const { host: rulesHost } = fakeHost({
    engine, scope: "rules-test", service: "managed", above: MailGround,
    address: fakeAddress("#/settings/rules"), places: { settings },
    mailboxes: async () => [mailbox({ id: "mb-other", address: "other@shop.test", organizerRole: "organizer" })],
  });
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: lang, messages: words, timeZone: "UTC", now: new Date("2026-10-02T12:00:00.000Z"),
      children: h(ThemeProvider, { children: h(ToastHost, { children: h(MailFrame, { host: rulesHost }) }) }),
    }));
  });
  await within(host).findByRole("list", { name: words.settings.rules }, { timeout: 5000 });
}

const ruleRows = () => within(within(host).getByRole("list", { name: words.settings.rules })).getAllByRole("listitem");

function rowOf(id: string): HTMLElement {
  const rule = shownRules.find((candidate) => candidate.id === id)!;
  const name = words.rules.what[rule.kind as "sender" | "domain"].replace("{match}", displayRuleMatch(rule.match));
  return within(host).getByRole("group", { name: name.replace(/\s+/g, " ").trim() });
}

const waitingGroup = () => within(host).queryByRole("heading", { name: words.rules.waitingGroup })
  ?.closest<HTMLElement>(".oh-settingssheet") ?? null;

const rankNote = (row: HTMLElement) => within(row).queryByText((text) =>
  [words.rules.outranks, words.rules.outranked].some((message) => text.startsWith(message.split("{")[0]!)),
);
const press = async (el: Element | undefined) => {
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};

beforeEach(() => {
  retargets = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host.remove();
  root = null;
});

const KEY = (match: string) => ({ kind: "sender", match, subjectContains: null, bodyContains: null });
const waits = (over: Partial<WaitingOnOrganizerView>): WaitingOnOrganizerView => ({
  requestId: "req-1", kind: "rule.delete", state: "sent", holder: { name: "Laptop" }, mailboxId: "mb-other",
  decidedAt: "2026-10-02T09:00:00.000Z", refusedReason: null, target: { rule: KEY("ann@shop.example") },
  ruleId: "a", messageId: null, slow: false, ...over,
});

describe("what waits on the organizer is said on the page", () => {
  it("a removal the organizer has not carried out keeps its row and says who it waits on", async () => {
    await open([rule("a", "sender", "ann@shop.example")], [waits({})]);
    expect(rowOf("a").textContent).toContain("Removal waits on Laptop");
  });

  it("a change that waits says where to, and an unnamed organizer is still said", async () => {
    await open([rule("a", "sender", "ann@shop.example")], [waits({ kind: "rule.update", holder: { name: null }, target: { rule: KEY("ann@shop.example"), destination: "ohmail/Receipts" } })]);
    expect(rowOf("a").textContent).toMatch(/Change to Receipts waits on the organizer/);
  });

  it("a refusal says why: the organizer no longer has the rule", async () => {
    await open([rule("a", "sender", "ann@shop.example")], [waits({ state: "refused", refusedReason: "no_such_rule" })]);
    expect(rowOf("a").textContent).toContain(R.refusedGone.replace("{holder}", "Laptop"));
  });

  it("a rule removed here and still asked there is listed at the top, naming the mailbox", async () => {
    await open([rule("b", "sender", "bob@shop.example")], [waits({ ruleId: null, target: { rule: KEY("ann@shop.example") } })]);
    const group = waitingGroup()!;
    expect(group, "no waiting group").toBeTruthy();
    expect(group.textContent).toContain("Mail from ann@shop.example");
    expect(group.textContent).toContain("Removed here; waits on Laptop for other@shop.test");
    // Outside the window's index space: at phone width the page is the window's scroller, and a
    // slot claimed here was measured as a row and re-measured for ever (measured on the rig).
    expect(group.querySelectorAll("[data-index]")).toHaveLength(0);
  });

  it("a request names its rule by key: a padded spelling, read before the mirror held the row, reaches it", async () => {
    await open([rule("a", "sender", "ann@shop.example")], [waits({ ruleId: null, target: { rule: KEY("  Ann@Shop.example") } })]);
    expect(rowOf("a").textContent).toContain("Removal waits on Laptop");
    expect(waitingGroup()).toBeNull();
  });

  it("CONTROL: with nothing waiting no row says so and there is no group", async () => {
    await open([rule("a", "sender", "ann@shop.example")], []);
    expect(waitingGroup()).toBeNull();
    expect(rowOf("a").textContent).not.toContain("waits on");
  });

  it("German says it in its own words", async () => {
    await open([rule("a", "sender", "ann@shop.example")], [waits({})], "de");
    expect(rowOf("a").textContent).toContain("Aufhebung wartet auf Laptop");
  });
});

describe("an address rule against its domain's", () => {
  it("lifted above the domain's rule, it says it decides before it", async () => {
    await open([
      rule("d", "domain", "shop.example", { priority: 4, destination: "ohmail/Receipts" }),
      rule("a", "sender", "ann@shop.example", { priority: 4, destination: "INBOX" }),
    ]);
    expect(rowOf("a").textContent).toContain("Decides before the rule for anyone at shop.example (Receipts)");
  });

  it("outranked again by a later change of the domain's rule, it says so and offers the way back", async () => {
    await open([
      rule("d", "domain", "shop.example", { priority: 9, destination: "ohmail/Receipts" }),
      rule("a", "sender", "ann@shop.example", { priority: 4, destination: "INBOX" }),
    ]);
    expect(rowOf("a").textContent).toContain("The rule for anyone at shop.example (Receipts) decides this sender now");
    await press(within(rowOf("a")).getByRole("button", { name: R.liftAction }));
    expect(retargets).toEqual([["a", "INBOX", false]]);
  });

  it("CONTROL: a priority-0 address rule over a priority-0 domain rule says nothing; no domain rule, nothing", async () => {
    await open([
      rule("d", "domain", "shop.example", { destination: "ohmail/Receipts" }),
      rule("a", "sender", "ann@shop.example", { destination: "INBOX" }),
      rule("c", "sender", "cat@else.example", { priority: 3 }),
    ]);
    expect(rankNote(rowOf("a"))).toBeNull();
    expect(rankNote(rowOf("c"))).toBeNull();
  });
});

describe("twins and the settings bound", () => {
  it("two rows under one key are one row, the one the router runs, with the copy counted", async () => {
    await open([rule("p", "sender", "ann@shop.example"), rule("q", "sender", "  Ann@Shop.example ", { priority: 2 })]);
    expect(ruleRows()).toHaveLength(1);
    expect(rowOf("q").textContent).toContain("1 more copy of this rule, removed with it");
  });

  it("a paused twin that outranks the running one is not the row: the running rule is, and the paused one is named", async () => {
    // The router never runs a paused rule, so the page shows the one it runs (REVIEW-026 H3).
    await open([
      rule("a1", "sender", "Ann@Shop.example", { destination: "ohmail/Receipts", priority: 5, enabled: false }),
      rule("b2", "sender", "ann@shop.example"),
    ]);
    expect(ruleRows()).toHaveLength(1);
    const row = rowOf("b2").textContent ?? "";
    expect(row).toContain("Also for this sender: files into Receipts, paused. Revoke removes that rule too.");
    expect(row).not.toContain("more copy");
  });

  it("twins filing elsewhere are named with their places, in English and in German", async () => {
    const twins = [rule("p", "sender", "ann@shop.example"), rule("q", "sender", "ANN@shop.example", { destination: "ohmail/Receipts" })];
    await open(twins);
    const en = ruleRows()[0]!.textContent ?? "";
    expect(en).toMatch(/Also for this sender: files into (News|Receipts)\. Revoke removes that rule too\./);
    await open(twins, [], "de");
    const de = ruleRows()[0]!.textContent ?? "";
    expect(de).toMatch(/Außerdem für diesen Absender: sortiert in \S+\. Aufheben entfernt diese Regel mit\./);
  });

  it("past the bound the page says how many stay on this computer, and not before", async () => {
    const many = Array.from({ length: 5001 }, (_, i) => rule(`r${i}`, "sender", `s${i}@x.example`));
    await open(many);
    expect(host.textContent).toContain("Your other computers receive your newest 5,000" + " rules; 1 older one stays on this one.");
    await open(many.slice(0, 5000));
    expect(host.textContent).not.toContain("Your other computers receive");
  });
});
