/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore,
  type EngineMessage, type Folder, type RuleDTO, type SyncChange,
} from "@ohmail/client-engine";
import { RailNav, ThemeProvider, ToastHost, useToast } from "@ohmail/ui";
import messages from "../messages/en.json";
import { mailboxLabelResolver, type MailboxLabelFact } from "../app/shell/mailbox-label";
import { senderHitOf } from "../app/shell/sender-hit";
import { senderScreening } from "../app/shell/sender-screening";
import { SenderMenu } from "../app/shell/SenderMenu";
import { SubjectRuleSheet } from "../app/shell/SubjectRuleSheet";
import { subjectRuleContext } from "../app/shell/subject-rule";
import { RulesView } from "../app/views/RulesView";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE SCREENER AND THE RULES FIT A PHONE (web 0.25.2 at 375 and 414 with a
 * coarse pointer). Each case loads the stylesheets' OWN phone rules, lifted from their media
 * blocks, so "at phone width" is the cascade's answer and not a class name; the wide control loads
 * none of them. A tap is dispatched where a thumb lands: `pointer-events: none` hands the press to
 * the box under it. Mutations watched red: `sender-hit.ts`'s Screener-row exclusion, the preview's
 * `hm-who` press, `useOverlayFit`'s `full`, the badge's short form and its third, the rules row's
 * stack, and `button kbd` in `touch-keys.css`.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
// jsdom has no `CSS`; `s` looks its row up by `CSS.escape`d id.
(globalThis as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s };

// ── the stylesheets, read as the cascade reads them ───────────────────────────────────────────

const read = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const APP = read("apps/webapp/app/app.css");
const RULES = read("apps/webapp/app/views/rules.css");
const SHEET = read("apps/webapp/app/shell/sender-sheet.css");
const TOUCH = read("apps/webapp/app/shell/touch-keys.css");
const ABAR = read("apps/webapp/app/shell/action-bar.css");

/** Every `@media` block of `css` with its condition and its rules, in file order. */
function mediaBlocks(css: string): Array<{ cond: string; rules: string[] }> {
  const out: Array<{ cond: string; rules: string[] }> = [];
  const re = /@media\s*([^{]+)\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out.push({ cond: m[1]!.trim(), rules: (css.slice(re.lastIndex, i - 1).match(/[^{}]+\{[^{}]*\}/g) ?? []).map((r) => r.trim()) });
    re.lastIndex = i;
  }
  return out;
}
const rulesUnder = (css: string, cond: string): string[] =>
  mediaBlocks(css).filter((b) => b.cond === cond).flatMap((b) => b.rules);
/** The rules outside every at-rule. */
const topRules = (css: string): string[] => {
  let flat = css;
  for (let at = flat.indexOf("@media"); at >= 0; at = flat.indexOf("@media")) {
    let depth = 0;
    let i = flat.indexOf("{", at);
    for (; i < flat.length; i++) {
      if (flat[i] === "{") depth++;
      else if (flat[i] === "}" && --depth === 0) break;
    }
    flat = flat.slice(0, at) + flat.slice(i + 1);
  }
  return (flat.match(/[^{}]+\{[^{}]*\}/g) ?? []).map((r) => r.trim());
};

/** The Screener's phone rules: its narrow blocks (the row CD shape lives in the drawer band since the
 *  width ladder — the band's 300px list wants it too). */
const screenerPhone = (): string[] => [
  ...rulesUnder(APP, "(max-width: 1023.98px)").filter((r) => r.startsWith(".view-screener")),
  ...rulesUnder(APP, "(max-width: 699.98px)").filter((r) => r.startsWith(".view-screener")),
];
/** The touch rule: every `(pointer: coarse)` block of the two files that hold it. */
const touchRules = (): string[] => [
  ...rulesUnder(TOUCH, "(pointer: coarse)"),
  ...rulesUnder(ABAR, "(pointer: coarse)"),
];

let style: HTMLStyleElement | null = null;
function load(rules: string[]): void {
  style?.remove();
  style = document.createElement("style");
  style.textContent = rules.join("\n");
  document.head.appendChild(style);
}

/** A viewport: its width and whether the primary pointer is coarse. Answers `matchMedia`. */
let vp = { width: 414, coarse: true };
function matches(query: string): boolean {
  return query.split(",").some((part) => {
    const conds = [...part.matchAll(/\(([a-z-]+)\s*:\s*([^)]+)\)/g)];
    return conds.length > 0 && conds.every(([, f, v]) => {
      const n = Number.parseFloat(v!);
      if (f === "max-width") return vp.width <= n;
      if (f === "min-width") return vp.width >= n;
      if (f === "pointer") return (v!.trim() === "coarse") === vp.coarse;
      if (f === "hover") return (v!.trim() === "none") === vp.coarse;
      return false;
    });
  });
}

// ── the Screener, mounted over the real state hook, inside the stage's hit test ───────────────

const NOW = new Date("2026-09-27T12:00:00.000Z");
let seq = 0;
function held(id: string, mailboxId = "mb-a", name: string | null = "Fixture Stranger"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId, threadId: null, messageIdHeader: null,
    subject: `ohmail-e2e phone subject ${id}`, from: { name, address: `stranger-${id}@stranger.example` }, to: [], cc: [],
    date: "2026-09-27T09:00:00.000Z", folder: "ohmail/Screener" as Folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-27T09:00:00.000Z",
  };
}

async function engineWith(mail: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(mail.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
}

/** Two mailboxes on one domain with no display names — account A's shape in the evidence. */
const MB_A: MailboxLabelFact = { id: "mb-a", address: "casey@acme.example", displayName: null };
const MB_B: MailboxLabelFact = { id: "mb-b", address: "ops@acme.example", displayName: null };

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Every sender the stage's hit test opened the sheet for, and every `full` the view asked. */
let sheetFor: string[] = [];
let fullCalls: boolean[] = [];

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

async function render(node: React.ReactElement): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: node }) }),
    }));
  });
  await flush();
  await settleFirstPaint();
  return host;
}

async function mountScreener(mail: EngineMessage[], facts: MailboxLabelFact[] | null = [MB_A, MB_B]): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const engine = await engineWith(mail);
  const labels = mailboxLabelResolver(facts);
  function Probe(): React.ReactElement {
    const toast = useToast();
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, v, toast);
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    const [full, setFull] = React.useState(false);
    const onFull = React.useCallback((f: boolean) => { fullCalls.push(f); setFull(f); }, []);
    return h(ScreenerView, {
      owed: false, state, segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full, onFull, mailboxLabelOf: labels,
    } as never);
  }
  /* The stage's capture-phase hit test, wired as `shell-verbs.ts` wires it: a sender hit opens the
     sheet INSTEAD of the row's own press. */
  const onClickCapture = (e: React.MouseEvent): void => {
    if (e.shiftKey) return;
    const hit = senderHitOf(e.target as Element);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    sheetFor.push(hit.id);
  };
  await render(h("main", { className: "stage", onClickCapture }, h(KeymapProvider, { children: h(Probe) })));
}

const section = (): HTMLElement => host!.querySelector<HTMLElement>("section.view-screener")!;
const readCol = (): HTMLElement => host!.querySelector<HTMLElement>(".view-screener .scn-read")!;
const rowOf = (id: string): HTMLElement => {
  const row = host!.querySelector<HTMLElement>(`.view-screener .row[data-id="${id}"]`);
  if (!row) throw new Error(`no row ${id}`);
  return row;
};
/** Where a thumb on `el` lands: the nearest box that takes pointer events. */
function landing(el: Element): HTMLElement {
  let n: Element | null = el;
  while (n && getComputedStyle(n).pointerEvents === "none") n = n.parentElement;
  return n as HTMLElement;
}
async function tap(el: Element): Promise<void> {
  const at = landing(el);
  await act(async () => { at.click(); });
  await flush();
}
/** Drawn: neither the element nor an ancestor computes to `display: none`. */
const drawn = (el: Element): boolean => {
  for (let n: Element | null = el; n; n = n.parentElement) if (getComputedStyle(n).display === "none") return false;
  return true;
};
/** The delivered-to chip on a row: the badge that carries the "Delivered to" sentence. */
const chipOf = (row: HTMLElement): HTMLElement | null =>
  [...row.querySelectorAll<HTMLElement>(".badge[title]")].find((b) => b.title.startsWith("Delivered to ")) ?? null;

beforeEach(() => {
  sheetFor = [];
  fullCalls = [];
  vp = { width: 414, coarse: true };
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: matches(query), media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    }),
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = (typeof input === "string" ? input : String(input)).replace(/^\/api/, "");
    const body = path.startsWith("/screener")
      ? { items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 50 } }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  style?.remove();
  root = null;
  host = null;
  style = null;
});

// ── R13-04: the row is one target, the sheet is a deliberate press and can be closed ──────────

describe("R13-04 — a thumb on a waiting row opens the letter, never the sender sheet", () => {
  it("a tap on the address or the avatar opens the preview at phone width with a coarse pointer", async () => {
    load(screenerPhone());
    await mountScreener([held("m1")]);
    const addr = rowOf("m1").querySelector(".row-top .addr")!;
    expect(addr, "the premise: the row's middle is the sender's address").not.toBeNull();
    await tap(addr);
    expect(sheetFor, "the address opened the sender sheet").toEqual([]);
    expect(section().className, "the preview is the full-screen layer").toContain("scn-full");
    expect(readCol().textContent).toContain("ohmail-e2e phone subject m1");
  });

  it("the avatar is part of the same target", async () => {
    load(screenerPhone());
    await mountScreener([held("m1")]);
    await tap(rowOf("m1").querySelector(".av")!);
    expect(sheetFor).toEqual([]);
    expect(fullCalls).toContain(true);
  });

  it("the sheet stays reachable from the preview: a press on its sender opens it for that letter", async () => {
    load(screenerPhone());
    await mountScreener([held("m1")]);
    await tap(rowOf("m1"));
    const who = readCol().querySelector<HTMLButtonElement>(".hmail .hm-who");
    expect(who, "the preview offers no sender press").not.toBeNull();
    expect(who!.tagName).toBe("BUTTON");
    expect(who!.getAttribute("aria-label")).toBe("Screening for stranger-m1@stranger.example");
    await act(async () => { who!.click(); });
    expect(sheetFor, "the press reached the stage's hit test as the held letter").toEqual(["m1"]);
  });

  it("wide, with a fine pointer, a click on the address selects the row, and s opens that sender's menu", async () => {
    vp = { width: 1440, coarse: false };
    await mountScreener([held("m1"), held("m2")]);
    const row = rowOf("m2");
    await tap(row.querySelector(".row-top .addr")!);
    expect(sheetFor, "the address opened the sender sheet").toEqual([]);
    expect(fullCalls).not.toContain(true);
    expect(row.getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true }));
    });
    await flush();
    const menu = host!.querySelector("[role=menu]");
    expect(menu?.getAttribute("aria-label")).toBe("Choose where this sender's mail goes");
    expect(menu?.closest(".row-slot")?.querySelector(".row")?.getAttribute("data-id")).toBe("m2");
  });

  it("narrow, with a fine pointer, a click opens the full letter, and s leaves it for that sender's menu", async () => {
    vp = { width: 640, coarse: false };
    load(screenerPhone());
    await mountScreener([held("m1"), held("m2")]);
    await tap(rowOf("m2"));
    expect(section().className, "the click opened the full letter").toContain("scn-full");
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(section().className, "the menu would sit under the full letter").not.toContain("scn-full");
    const menu = host!.querySelector("[role=menu]");
    expect(menu?.getAttribute("aria-label")).toBe("Choose where this sender's mail goes");
    expect(menu?.closest(".row-slot")?.querySelector(".row")?.getAttribute("data-id")).toBe("m2");
  });
});

describe("R13-04 — a full-height sender sheet carries a close control of at least 44px", () => {
  async function sheet(natural: number, viewport: { w: number; h: number }, kind: "sender" | "subject" = "sender") {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{ type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: NOW.toISOString(), entity: held("m1") }]);
    const onClose = vi.fn();
    const state = { messageId: "m1", x: 18, y: 10, anchorTop: 400, anchorBottom: 424 };
    await render(kind === "sender"
      ? h(SenderMenu, { state, sender: senderScreening(store, "m1")!, onChoose: () => {}, onOpenDetail: () => {}, onClose })
      : h(SubjectRuleSheet, { state, ctx: subjectRuleContext(store, "m1")!, onConfirm: () => {}, onClose }));
    const el = host!.querySelector<HTMLElement>(".senderm")!;
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: natural });
    Object.defineProperty(el, "offsetWidth", { configurable: true, value: 340 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport.w });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.h });
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    return { el, onClose };
  }

  it("at 375x812 the sheet fills the band, and its close is a named 44px button that closes it", async () => {
    load(topRules(SHEET).filter((r) => r.startsWith(".sm-close")));
    const { el, onClose } = await sheet(900, { w: 375, h: 812 });
    const close = el.querySelector<HTMLButtonElement>(".sm-close");
    expect(close, "a full-height sheet with no way out but an 18px strip").not.toBeNull();
    expect(close!.getAttribute("aria-label")).toBe("Close");
    expect([getComputedStyle(close!).width, getComputedStyle(close!).height]).toEqual(["44px", "44px"]);
    expect(getComputedStyle(close!.parentElement!).position, "it rides the corner while the sheet scrolls").toBe("sticky");
    await act(async () => { close!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the subject-rule sheet, the same shell, carries the same way out", async () => {
    const { el, onClose } = await sheet(900, { w: 375, h: 812 }, "subject");
    const close = el.querySelector<HTMLButtonElement>(".sm-close");
    expect(close, "the sibling sheet has no way out but the strip").not.toBeNull();
    await act(async () => { close!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("control: a sheet with room around it keeps its face — no close control", async () => {
    const { el } = await sheet(583, { w: 1440, h: 900 });
    expect(el.querySelector(".sm-close")).toBeNull();
    expect(el.className).toBe("senderm");
  });
});

// ── R13-07: the subject gets the width ────────────────────────────────────────────────────────

describe("R13-07 — at phone width the subject gets the row, and the chip says which mailbox briefly", () => {
  it("two mailboxes: the chip is the mailbox's short label, never the full address, capped at a third", async () => {
    load(screenerPhone());
    await mountScreener([held("m1", "mb-a")]);
    const chip = chipOf(rowOf("m1"));
    expect(chip, "a two-mailbox account still names the mailbox").not.toBeNull();
    expect(chip!.textContent).toBe("casey");
    expect(chip!.title, "the full label stays in the sentence").toBe("Delivered to casey@acme.example");
    const strip = chip!.closest<HTMLElement>(".badges")!;
    expect(getComputedStyle(strip).maxWidth, "the badge strip may take a third of the row").toBe("33.333%");
    const cs = getComputedStyle(chip!);
    expect([cs.overflow, cs.textOverflow, cs.whiteSpace]).toEqual(["hidden", "ellipsis", "nowrap"]);
  });

  it("control: one mailbox names nothing at phone width", async () => {
    load(screenerPhone());
    await mountScreener([held("m1", "mb-a")], [MB_A]);
    expect(chipOf(rowOf("m1"))).toBeNull();
  });

  it("control: wide, the chip keeps the full label", async () => {
    vp = { width: 1280, coarse: false };
    await mountScreener([held("m1", "mb-a")]);
    expect(chipOf(rowOf("m1"))!.textContent).toBe("casey@acme.example");
  });

  it("the short label tells this account's mailboxes apart", () => {
    const short = (facts: MailboxLabelFact[], id: string) => mailboxLabelResolver(facts)(id, "short");
    const a = (id: string, address: string, displayName: string | null = null) => ({ id, address, displayName });
    expect(short([MB_A, MB_B], "mb-b")).toBe("ops");
    expect(short([a("x", "me@home.example"), a("y", "me@work.example")], "y"), "a shared local part names the domain").toBe("work.example");
    expect(short([a("x", "me@home.example", "Home"), a("y", "me@work.example")], "x"), "a label is its own short form").toBe("Home");
    expect(short([a("x", "me@a.example"), a("y", "me@b.example"), a("z", "you@a.example")], "x"), "both halves shared: the address").toBe("me@a.example");
    expect(short([MB_A], "mb-a"), "one mailbox is still silence").toBeNull();
    expect(mailboxLabelResolver([MB_A, MB_B])("mb-a"), "the long form is unchanged").toBe("casey@acme.example");
  });
});

// ── R13-05: the rule says whose it is ─────────────────────────────────────────────────────────

describe("R13-05 — at phone width a rule row stacks, and its title wraps rather than clips", () => {
  const rule = (i: number, match: string): RuleDTO => ({
    id: `r${i}`, kind: "sender", match, destination: "INBOX", priority: 0, provenance: "promoted", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-26T09:00:00.000Z", updatedAt: "2026-09-26T09:00:00.000Z",
  });
  const mountRules = () => render(h(RulesView, {
    rules: [rule(1, "e2e-stranger-bfeecdac@stranger-fixture.example"), rule(2, "bd1@tq776.example")],
    onRevoke: async () => ({ status: "confirmed" as const }),
    onRetarget: async () => ({ status: "confirmed" as const }),
    pastMail: () => null,
  }));
  const items = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(".rules-item")];

  it("the title takes its own full-width line and wraps anywhere; Change and Revoke sit under it", async () => {
    load([...topRules(RULES), ...rulesUnder(RULES, "(max-width:640px)")]);
    await mountRules();
    expect(items()).toHaveLength(2);
    for (const row of items()) {
      expect(getComputedStyle(row).flexDirection, "the row stacks").toBe("column");
      expect(getComputedStyle(row).height).toBe("auto");
      const what = row.querySelector<HTMLElement>(".what")!;
      expect(what.textContent).toMatch(/^Mail from .+@/);
      expect([getComputedStyle(what).whiteSpace, getComputedStyle(what).overflowWrap]).toEqual(["normal", "anywhere"]);
      expect(row.querySelector(".body")!.nextElementSibling, "the controls follow the title").toBe(row.querySelector(".acts"));
    }
  });

  it("control: wide, the row is the one-line 64px row it was", async () => {
    load(topRules(RULES));
    await mountRules();
    const row = items()[0]!;
    expect(getComputedStyle(row).height).toBe("64px");
    expect(getComputedStyle(row).flexDirection).not.toBe("column");
    expect(getComputedStyle(row.querySelector(".what")!).whiteSpace).toBe("nowrap");
  });
});

// ── R13-06: key hints only where there are keys ───────────────────────────────────────────────

describe("R13-06 — with a coarse pointer the Screener's and the drawer's keycaps are not drawn", () => {
  const rail = () => h(RailNav, {
    composeLabel: "Compose", onCompose: () => {}, mailboxesLabel: "Mailboxes",
    groups: [{ items: [{ id: "ohbox", label: "Ohbox", navKey: "1" }, { id: "search", label: "Search", kbdHint: "/" }] }],
    dock: h("button", { type: "button", className: "ritem dock-cmd" }, "Command", h("span", { className: "cnt" }, h("kbd", null, "⌘K"))),
  } as never);
  async function mountAll(): Promise<HTMLElement[]> {
    await mountScreener([held("m1")]);
    const more = rowOf("m1").parentElement!.querySelector<HTMLButtonElement>(".scn-act-more");
    expect(more, "the row's menu is offered").not.toBeNull();
    await act(async () => { more!.click(); });
    const railHost = document.createElement("div");
    host!.appendChild(railHost);
    const railRoot = createRoot(railHost);
    await act(async () => { railRoot.render(rail()); });
    return [...host!.querySelectorAll<HTMLElement>("kbd")];
  }

  it("the row menu's letters, Compose's c, Search's / and the dock's chord are hidden", async () => {
    load(touchRules());
    const caps = await mountAll();
    const said = caps.map((k) => k.textContent);
    for (const want of ["o", "x", "c", "/", "⌘K"]) expect(said, `the evidence's ${want}`).toContain(want);
    expect(caps.filter(drawn).map((k) => k.textContent), "keycaps drawn on a touch-only screen").toEqual([]);
  });

  it("control: with a fine pointer every one of them is drawn", async () => {
    vp = { width: 1280, coarse: false };
    const caps = await mountAll();
    expect(caps.length).toBeGreaterThanOrEqual(9);
    expect(caps.every(drawn)).toBe(true);
  });
});
