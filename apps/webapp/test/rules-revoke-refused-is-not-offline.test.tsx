/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import {
  FixturesAdapter, MemoryMirrorStore, MutationRejectedError, OhmailEngine,
  type EngineAdapter, type QueuedRuleWrite, type RuleDTO, type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SettingsView } from "../app/views/SettingsView";
import { queuedSentence, queuedWaitOf } from "@ohmail/app-logic/press/queued-sentence";
import { queuedRuleKey } from "@ohmail/app-logic/press/sender-screening";
import { useShellDerivations, type ShellDerivationsInput } from "../app/shell/shell-derivations";

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

async function open(items: RuleDTO[], answer: Answer, queued: QueuedRuleWrite[] = []): Promise<void> {
  const view = h(SettingsView, {
    notifications: null, tags: [], tagCounts: {},
    rules: {
      items, queued,
      onRevoke: async () => answer,
      onRetarget: async () => answer,
      pastMail: () => null,
    },
  });
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-10-13T05:00:00.000Z"),
      children: h(ThemeProvider, { children: h(ToastHost, { children: view }) }),
    }));
  });
  const nav = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Rules")!;
  await act(async () => { nav.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
const buttonIn = (el: ParentNode, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const press = async (el: Element | undefined) => {
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const rowOf = (id: string) => host.querySelector<HTMLElement>(`[data-rule-id="${id}"]`);
async function revoke(id: string): Promise<string> {
  await press(buttonIn(rowOf(id)!, R.revoke));
  await press(buttonIn(host, R.revokeConfirm));
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
    await press(buttonIn(rowOf("a")!, R.change));
    await press(buttonIn(host, "Ohbox"));
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
    const search = host.querySelector<HTMLInputElement>(`input[aria-label="${R.searchLabel}"]`)!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(search, "r34n");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).not.toContain(R.noMatch);
    const row = rowOf("a")!;
    expect(row.textContent).toContain(R.queuedRevokeFailing);
    expect(buttonIn(row, R.revoke)!.disabled).toBe(true);
    expect(buttonIn(row, R.change)!.disabled).toBe(true);
  });

  it("an unsent revoke says it has not been sent", async () => {
    await open([rule("a", "b@r34n.example")], { status: "confirmed" }, queuedOf(false));
    expect(rowOf("a")!.textContent).toContain(R.queuedRevokeUnsent);
  });

  it("the bulk revoke leaves a rule whose revoke is still queued out of its count and its presses", async () => {
    const pressed: string[] = [];
    const view = h(SettingsView, {
      notifications: null, tags: [], tagCounts: {},
      rules: {
        items: [rule("a", "b@r34n.example"), rule("b", "c@one.example"), rule("c", "d@two.example")],
        queued: queuedOf(true),
        onRevoke: async (id: string) => { pressed.push(id); return { status: "confirmed" as const }; },
        onRetarget: async () => ({ status: "confirmed" as const }),
        pastMail: () => null,
      },
    });
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-10-13T05:00:00.000Z"),
        children: h(ThemeProvider, { children: h(ToastHost, { children: view }) }),
      }));
    });
    await press([...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Rules"));
    await press(host.querySelector(".rules-bulk") ?? undefined);
    await press(buttonIn(host, "Revoke 2 rules"));
    expect(pressed.sort()).toEqual(["b", "c"]);
  });

  it("nothing queued: no line, controls live (the control)", async () => {
    await open([rule("a", "b@r34n.example")], { status: "confirmed" });
    const row = rowOf("a")!;
    expect(row.querySelector("[data-queued]")).toBeNull();
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

    let seen: string[] | null = null;
    const input = (): ShellDerivationsInput => ({
      engine, reader: engine.read(), derived: 1, demo: false, resolvedDemo: false,
      now: new Date("2026-10-13T05:00:00.000Z"), facts: null, seedOwed: false,
      consent: {
        known: true, standalone: false, dormancyDays: 30, screeningBaselineAt: null, screeningScope: "all_time",
        foldersEnabled: false, folderMailboxesOff: {},
      },
      route: { view: "settings" as ShellDerivationsInput["route"]["view"], folderId: null },
      trashWire: undefined, deleting: { held: new Set() }, restoring: { held: new Set() }, routing: { places: new Map() },
    });
    function Probe(): null {
      seen = useShellDerivations(input()).rules.map((r) => r.id);
      return null;
    }
    await act(async () => { root!.render(h(Probe)); });
    expect(seen, "the shell's list hid a rule the server still runs").toEqual(["a"]);
  });
});
