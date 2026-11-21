/** @vitest-environment jsdom */
import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine, rulesShown,
  type EngineAdapter, type QueuedRuleWrite, type SyncChange,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import messages from "../messages/en.json";
import { within } from "@testing-library/react";
import { MailGround, mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import { displayRuleMatch } from "@ohmail/app-logic/text/idn";
import { fakeMail } from "../../../packages/app/test/reader/support/mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../packages/app/test/support/fake-window.js";
import { MailFrame } from "../app/shell/browser-mail";
import { mailbox } from "./fixtures/live-walk-shell";
import { queuedSentence, queuedWaitOf } from "@ohmail/app-logic/press/queued-sentence";
import { queuedRuleKey } from "@ohmail/app-logic/press/sender-screening";

/**
 * A REVOKE THE SERVER REFUSED IS NOT "BACK ONLINE". The server answered a revoke 500;
 * the browser was online and was told "Revoke queued — it'll go through when you're back online",
 * and the Rules page read "No rules match" while the server kept the rule filing. A failure the server
 * answered stays on the pane with the rule shown still active; "back online" is said only offline.
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
const rule = (id: string, match: string): RuleDTO => ({
  id, kind: "sender", match, destination: "ohmail/News", priority: 0, provenance: "promoted",
  enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-10-13T04:01:00.000Z", updatedAt: "2026-10-13T04:01:00.000Z",
} as RuleDTO);
type Answer = { status: "queued" | "confirmed" | "rolled_back"; serverFailed?: true };

let host: HTMLDivElement;
let root: Root | null = null;
const setOnline = (on: boolean): void => {
  Object.defineProperty(window.navigator, "onLine", { value: on, configurable: true });
};

let listed: RuleDTO[];

async function open(
  items: RuleDTO[],
  answer: Answer,
  queued: readonly QueuedRuleWrite[] = [],
  onRevoke?: (id: string) => void,
): Promise<void> {
  listed = items;
  const { WebRulesPane } = await import("../app/(product)/mailbox/WebRulesPane");
  const settings = mailSettings({ ...NO_PANE_PARTS, rules: WebRulesPane });
  const mail = fakeMail([], [], {}, Object.fromEntries(items.map((rule) => [`rule:${rule.id}`, rule])));
  const engine = Object.assign(mail.engine, {
    queuedRuleWrites: () => queued,
    waitingOnOrganizer: () => [],
    appliedRuleRequests: () => [],
    unsettledRulePresses: () => [],
    mutate: async (mutation: Parameters<typeof mail.engine.mutate>[0]) => {
      if (mutation.kind === "rule_delete") onRevoke?.(mutation.ruleId);
      return answer;
    },
  });
  const { host: recorded } = fakeHost({
    engine, service: "managed", scope: "rules-test", above: MailGround,
    address: fakeAddress("#/settings/rules"), places: { settings },
    mailboxes: async () => [mailbox({ organizerRole: "organizer" })],
  });
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-10-13T05:00:00.000Z"),
      children: h(ThemeProvider, { children: h(ToastHost, { children: h(MailFrame, { host: recorded }) }) }),
    }));
  });
  await within(host).findByRole("list", { name: messages.settings.rules }, { timeout: 5000 });
}

const buttonIn = (el: HTMLElement, name: string | RegExp) =>
  within(el).getByRole<HTMLButtonElement>("button", { name });
const press = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const rowName = (rule: RuleDTO) => R.what.sender.replace("{match}", displayRuleMatch(rule.match));

function rowOf(id: string) {
  const rule = listed.find((candidate) => candidate.id === id)!;
  return within(host).queryByRole("group", { name: rowName(rule) });
}
async function revoke(id: string): Promise<string> {
  await press(buttonIn(rowOf(id)!, R.revoke));
  await press(buttonIn(within(host).getByRole("dialog", { name: R.revokeConfirm }), R.revokeConfirm));
  return host.textContent ?? "";
}

beforeEach(() => {
  setOnline(true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host.remove();
  root = null;
  setOnline(true);
});

describe("what a queued revoke says", () => {
  it("the server's failure: the rule is still in place, never 'back online'", async () => {
    await open([rule("a", "b@r34n.example")], { status: "queued", serverFailed: true });
    const text = await revoke("a");
    expect(text).toContain(R.toastRevokeFailing);
    expect(text).not.toContain(R.toastRevokeQueued);
    expect(text).not.toContain(R.toastRevoked);
  });

  it("offline: queued until back online (the sentence's one true place)", async () => {
    setOnline(false);
    await open([rule("a", "b@r34n.example")], { status: "queued" });
    const text = await revoke("a");
    expect(text).toContain(R.toastRevokeQueued);
  });

  it("online and unanswered: not arrived yet, not 'back online'", async () => {
    await open([rule("a", "b@r34n.example")], { status: "queued" });
    const text = await revoke("a");
    expect(text).toContain(R.toastRevokeUnsent);
    expect(text).not.toContain(R.toastRevokeQueued);
  });

  it("a retarget the server refused says so too", async () => {
    await open([rule("a", "b@r34n.example")], { status: "queued", serverFailed: true });
    await press(buttonIn(rowOf("a")!, /^Files into /));
    await press(within(host).getByRole("menuitemradio", { name: "Ohbox" }));
    expect(host.textContent).toContain(R.toastRetargetFailing);
  });

  it("the deciding function, every arm", () => {
    expect(queuedSentence({ wait: "retry", failed: true }, true)).toBe("failing");
    expect(queuedSentence({ wait: "retry" }, true)).toBe("queued");
    expect(queuedSentence({ wait: "retry" }, false)).toBe("unsent");
    expect(queuedSentence({ wait: "organizer" }, false)).toBe("organizer");
  });
});

describe("the Screener and the sheets take the same three waits", () => {
  it("one server failure among the queued makes the set a failure; offline alone says queued", () => {
    const q = (serverFailed?: true) => ({ status: "queued", ...(serverFailed ? { serverFailed } : {}) });
    expect(queuedWaitOf([q(), q(true), { status: "confirmed" }], false)).toBe("failing");
    expect(queuedWaitOf([q(), q(true)], true)).toBe("failing");
    expect(queuedWaitOf([q(), { status: "confirmed" }], true)).toBe("queued");
    expect(queuedWaitOf([q()], false)).toBe("unsent");
    // A failure on a verb that did not queue is not this set's wait.
    expect(queuedWaitOf([q(), { status: "rolled_back", serverFailed: true }], false)).toBe("unsent");
  });

  it("each wait has its own sentence key", () => {
    expect(queuedRuleKey("failing")).toBe("toastRuleFailing");
    expect(queuedRuleKey("queued")).toBe("toastRuleQueued");
    expect(queuedRuleKey("unsent")).toBe("toastRuleUnsent");
  });
});

describe("a rule with a queued revoke is shown as it runs", () => {
  const queuedOf = (serverFailed: boolean): QueuedRuleWrite[] =>
    [{ id: "o-1", verb: "revoke", ruleId: "a", rule: rule("a", "b@r34n.example"), serverFailed }];

  it("the search finds it, it says the revoke failed, and its controls wait", async () => {
    await open([rule("a", "b@r34n.example"), rule("z", "c@else.example")], { status: "confirmed" }, queuedOf(true));
    const search = within(host).getByRole<HTMLInputElement>("searchbox", { name: R.searchLabel });
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(search, "r34n");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).not.toContain(R.noMatch);
    const row = rowOf("a")!;
    expect(row.textContent).toContain(R.queuedRevokeFailing);
    expect(buttonIn(row, R.revoke)!.disabled).toBe(true);
    expect(buttonIn(row, /^Files into /)!.disabled).toBe(true);
  });

  it("an unsent revoke says it has not been sent", async () => {
    await open([rule("a", "b@r34n.example")], { status: "confirmed" }, queuedOf(false));
    expect(rowOf("a")!.textContent).toContain(R.queuedRevokeUnsent);
  });

  it("the bulk revoke leaves a rule whose revoke is still queued out of its count and its presses", async () => {
    const pressed: string[] = [];
    await open([rule("a", "b@r34n.example"), rule("b", "c@one.example"), rule("c", "d@two.example")], { status: "confirmed" }, queuedOf(true), (id) => { pressed.push(id); });
    await press(buttonIn(host, /^Revoke all 2 matching/));
    const dialog = within(host).getByRole("dialog", { name: "Revoke 2 rules" });
    await press(buttonIn(dialog, "Revoke 2 rules"));
    expect(pressed.sort()).toEqual(["b", "c"]);
  });

  it("nothing queued: no line, controls live (the control)", async () => {
    await open([rule("a", "b@r34n.example")], { status: "confirmed" });
    const row = rowOf("a")!;
    expect(within(row).queryByText((text) => text === R.queuedRevokeFailing || text === R.queuedRevokeUnsent)).toBeNull();
    expect(buttonIn(row, R.revoke)!.disabled).toBe(false);
  });
});

describe("the shell reads the rules as the server runs them", () => {
  it("a revoke the server refused leaves the rule in the shell's rules list", async () => {
    const inner = new FixturesAdapter();
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      sync: (p) => inner.sync(p),
      async mutate() { throw new MutationRejectedError("internal error", { status: 500, code: "internal", retryable: true }); },
    };
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter, store });
    await engine.start();
    await store.applyChanges([{
      type: "rule", op: "create", id: "a", seq: 10_000, updatedAt: "2026-10-13T04:01:00.000Z", entity: rule("a", "b@r34n.example"),
    }] as SyncChange[]);
    await engine.mutate({ kind: "rule_delete", ruleId: "a" });

    const queued = engine.queuedRuleWrites();
    const shown = rulesShown(engine.read(), {
      readerOnly: false, queued, applied: engine.appliedRuleRequests(), now: new Date("2026-10-13T05:00:00.000Z"),
    });
    await open(shown.rules, { status: "confirmed" }, queued);
    const list = within(host).getByRole("list", { name: messages.settings.rules });
    const ids = within(list).getAllByRole("listitem").map((row) =>
      shown.rules.find((rule) => within(row).queryByRole("group", { name: rowName(rule) }))?.id,
    );
    expect(ids, "the shell's list hid a rule the server still runs").toEqual(["a"]);
    expect(rowOf("a")!.textContent).toContain(R.queuedRevokeFailing);
    expect(buttonIn(rowOf("a")!, R.revoke)!.disabled).toBe(true);
  });
});
