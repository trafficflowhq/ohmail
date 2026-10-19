/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine, MemoryMirrorStore } from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import type { ScreenerState } from "../app/shell/screener-state.js";
import type { JunkWindowControl } from "../app/shell/junk-window.js";
import type { JunkItemWire } from "../app/api-client.js";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { fillFrom } from "../app/shell/locale.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE LIVE JUNK WINDOW'S RENDERING (FOLDERS-SPEC.md §16.2) — the ScreenerView half.
 *
 * The junk-window guards this file owns, each watched red under a mutation before landing:
 *
 *  · FLAG-OFF PARITY (§16.7): without the `junk` prop the third segment is the pre-window
 *    segment — the "Spam" label over the mirror pile. Rename unconditionally and this reddens.
 *  · A FAILED WINDOW IS NEVER AN EMPTY LIST: `phase: "failed"` renders the failed sentence and
 *    a human retry; substituting the empty state (the defect the spec's table names) reddens
 *    on both assertions at once.
 *  · THE ORIGIN MARKER (the prototype's owed in product): every row says who filed it —
 *    the recorded verdict, or the provider's own filter.
 *  · The DEGRADE is stated: a mailbox with no native \Junk is named, not errored.
 *  · The RETENTION sentence renders digit-free (its catalogue pin lives in
 *    `deleted-claims.test.ts`; here it must actually be on screen).
 *  · The RESCUE dispatches through the control, once, from its one button.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-08-24T12:00:00.000Z");
let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function emptyEngine(): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
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
      fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
}

function item(over: Partial<JunkItemWire> & { uid: number }): JunkItemWire {
  return {
    mailboxId: "mb1",
    uidValidity: "7",
    subject: `junk ${over.uid}`,
    from: { name: null, address: `s${over.uid}@example.invalid` },
    date: new Date(Date.UTC(2026, 7, 1) + over.uid * 60_000).toISOString(),
    messageIdHeader: `<mid-${over.uid}@x>`,
    seen: false,
    origin: "provider",
    ...over,
  };
}

/** A fake control — every fact and dispatch the view is allowed to touch. */
function control(over: Partial<JunkWindowControl> = {}): JunkWindowControl {
  return {
    supported: true,
    phase: "ready",
    items: [],
    // `visible` is what the view renders; with no query it IS the loaded window.
    visible: over.items ?? [],
    mailboxes: [{ id: "mb1", address: "a@example.invalid", window: "ok" }],
    nextCursor: null,
    olderLoading: false,
    reload: vi.fn(),
    loadOlder: vi.fn(),
    bodyFor: () => ({ phase: "ready", text: "Buy now." }),
    openBody: vi.fn(),
    rescue: vi.fn(),
    rescuing: () => false,
    dismissRescue: vi.fn(),
    search: {
      query: "", setQuery: vi.fn(), phase: "idle", hits: [], localCount: 0, mailboxes: [], truncated: false, searchServer: vi.fn(),
    },
    sweep: { phase: "none", preview: null, requesting: false, request: vi.fn(), dismiss: vi.fn() },
    held: null,
    ...over,
  };
}

/** What `onFull` was pressed with — the mobile open-preview gesture's witness. */
let fullPresses: boolean[] = [];

/** The live media-query stub: `resizeTo` flips the answer AND notifies subscribers, like a
 *  real rotation — the body-open effect is SUBSCRIBED to the breakpoint, and a stub that
 *  never fires would leave that reactivity untestable. */
let viewportMobile = false;
const mqListeners = new Set<() => void>();
function setViewport(mobile: boolean): void {
  viewportMobile = mobile;
  mqListeners.clear();
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((query: string) => {
    const mq = {
      get matches() { return viewportMobile && query.includes("max-width"); },
      media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener(_: string, cb: () => void) { mqListeners.add(cb); },
      removeEventListener(_: string, cb: () => void) { mqListeners.delete(cb); },
      dispatchEvent() { return false; },
    };
    return mq;
  }) as never;
}
async function resizeTo(mobile: boolean): Promise<void> {
  viewportMobile = mobile;
  await act(async () => { for (const cb of [...mqListeners]) cb(); });
}

async function mount(
  junk: JunkWindowControl | undefined, opts: { full?: boolean; locale?: "en" | "de" } = {},
): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const engine = await emptyEngine();

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state: ScreenerState = useScreenerState(engine, v, (() => {}) as never);
    return h(ScreenerView, {
      owed: false,
      state,
      segment: "spam", settled: true,
      selection: { waiting: null, screened: null, spam: null } as never,
      onSelect: () => {}, hydrateBody: () => {},
      full: opts.full ?? false,
      onFull: (f: boolean) => { fullPresses.push(f); },
      junk,
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: opts.locale ?? "en",
        messages: (opts.locale === "de" ? fillFrom(messages as never, de as never) : messages) as never,
        timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(KeymapProvider, { children: h(Probe) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
  await settleFirstPaint();
}

const tabs = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"], .scn-seg button')]
    .map((b) => (b.textContent ?? "").trim());
const click = async (el: Element | null): Promise<void> => {
  expect(el, "expected a control to click").not.toBeNull();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const buttonByText = (needle: string): HTMLButtonElement | null =>
  [...host!.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => (b.textContent ?? "").includes(needle)) ?? null;

beforeEach(() => {
  fullPresses = [];
  setViewport(false);
  globalThis.fetch = (async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

describe("flag-off parity (§16.7)", () => {
  it("without the junk control the third segment is still SPAM over the mirror pile", async () => {
    await mount(undefined);
    expect(tabs().join(" ")).toContain("Spam");
    expect(tabs().join(" ")).not.toContain("Junk");
    // The pre-window empty state, once — the same claim `screener-empty-once` pins.
    expect(host!.querySelectorAll(".empty")).toHaveLength(1);
    expect(host!.textContent).toContain("No spam held.");
  });
});

describe("the live window", () => {
  it("renames the segment to Junk and renders each row with its ORIGIN marker", async () => {
    await mount(control({
      items: [item({ uid: 2, origin: "verdict" }), item({ uid: 1, origin: "provider" })],
    }));
    expect(tabs().join(" ")).toContain("Junk");
    expect(tabs().join(" ")).not.toContain("Spam");
    const rows = [...host!.querySelectorAll<HTMLElement>(".row")];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.textContent).join(" ")).toContain("your verdict");
    expect(rows.map((r) => r.textContent).join(" ")).toContain("filed by your mail server");
    // The retention sentence is ON SCREEN, and carries no number to promise.
    const retention = host!.querySelector(".scn-junk-retention");
    expect(retention).not.toBeNull();
    expect(retention!.textContent).toContain("on its own schedule");
    expect(retention!.textContent).not.toMatch(/\d/);
  });

  it("LOADING is a stated state — no rows, and no claim of emptiness", async () => {
    await mount(control({ phase: "loading" }));
    expect(host!.textContent).toContain("Reading your mail server's Junk folder");
    expect(host!.textContent).not.toContain("Junk is empty.");
  });

  it("FAILED renders the failed sentence and a human retry — NEVER the empty state", async () => {
    const junk = control({ phase: "failed" });
    await mount(junk);
    expect(host!.textContent).toContain("Junk couldn't be read just now");
    expect(host!.textContent).not.toContain("Junk is empty.");
    await click(buttonByText("Try again"));
    expect(junk.reload).toHaveBeenCalledTimes(1);
  });

  it("in German the window is the Spam-Ordner, and the English word Junk is nowhere on it", async () => {
    await mount(control({ items: [] }), { locale: "de" });
    expect(tabs()).toContain(de.screener.segJunk);
    expect(host!.textContent).toContain(de.screener.empty.junk.title);
    expect(host!.querySelector<HTMLInputElement>('input[type="search"]')?.placeholder).toBe(de.screener.junkSearchPlaceholder);
    const said = [host!.textContent ?? "", ...[...host!.querySelectorAll("[aria-label], [placeholder]")]
      .flatMap((el) => [el.getAttribute("aria-label") ?? "", el.getAttribute("placeholder") ?? ""])];
    expect(said.filter((s) => /\bJunk\b/.test(s))).toEqual([]);
  });

  it("an empty READY window says Junk is empty — an answer, not a fallback", async () => {
    await mount(control({ items: [] }));
    expect(host!.textContent).toContain("Junk is empty.");
  });

  it("a mailbox with no native \\Junk is NAMED, beside whatever did load", async () => {
    await mount(control({
      items: [item({ uid: 3 })],
      mailboxes: [
        { id: "mb1", address: "a@example.invalid", window: "ok" },
        { id: "mb2", address: "b@example.invalid", window: "no_junk_folder" },
      ],
    }));
    expect(host!.textContent).toContain("b@example.invalid has no Junk folder of its own");
    expect(host!.querySelectorAll(".row")).toHaveLength(1);
  });

  it("Show older appears exactly while there is an older page, and dispatches loadOlder", async () => {
    const junk = control({ items: [item({ uid: 9 })], nextCursor: "abc" });
    await mount(junk);
    await click(buttonByText("Show older"));
    expect(junk.loadOlder).toHaveBeenCalledTimes(1);
    await mount(control({ items: [item({ uid: 9 })], nextCursor: null }));
    expect(buttonByText("Show older")).toBeNull();
  });
});

describe("the honest empty claim and the mobile gestures (UI review round)", () => {
  it("ZERO items beside an UNREACHABLE mailbox is NOT 'Junk is empty'", async () => {
    await mount(control({
      items: [],
      mailboxes: [
        { id: "mb1", address: "a@example.invalid", window: "ok" },
        { id: "mb2", address: "b@example.invalid", window: "unreachable" },
      ],
    }));
    expect(host!.textContent).not.toContain("Junk is empty.");
    expect(host!.textContent).toContain("b@example.invalid couldn't be read just now.");
  });

  it("on a NARROW viewport a row tap opens the full preview — the read column is hidden until it does", async () => {
    setViewport(true);
    await mount(control({ items: [item({ uid: 5 })] }));
    const row = host!.querySelector<HTMLElement>(".row")!;
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(fullPresses).toContain(true);
  });

  it("on a NARROW viewport no body is fetched until the preview is OPEN — body-on-open, §16.2", async () => {
    setViewport(true);
    // NOTHING has been opened, so the session cache answers IDLE — the default fake's
    // always-ready answer would render a full body and hide the face under test.
    const closed = control({ items: [item({ uid: 5 })], bodyFor: () => ({ phase: "idle" }) });
    await mount(closed);
    expect(closed.openBody).not.toHaveBeenCalled();
    // …and the hidden, mounted preview shows NO waiting face: `idle` is not `loading` (and
    // not "snippet", whose may-yet-arrive arm also runs the stall countdown) — no timer runs
    // against a request that does not exist (review round). "Loading the full message…" is
    // `HeldMail`'s waiting note.
    expect(host!.textContent).not.toContain("Loading the full message");
    const open = control({ items: [item({ uid: 5 })] });
    await mount(open, { full: true });
    expect(open.openBody).toHaveBeenCalledWith(expect.objectContaining({ uid: 5 }));
  });

  it("WIDENING the viewport reveals the read column AND fetches the selection's body", async () => {
    // Entering Junk narrow, then rotating/widening: CSS reveals `.scn-read` without any other
    // dependency of the body-open effect changing — the breakpoint is SUBSCRIBED, so the
    // reveal itself triggers the fetch (review round).
    setViewport(true);
    const junk = control({ items: [item({ uid: 5 })] });
    await mount(junk);
    expect(junk.openBody).not.toHaveBeenCalled();
    await resizeTo(false);
    expect(junk.openBody).toHaveBeenCalledWith(expect.objectContaining({ uid: 5 }));
  });
});

describe("the preview and the rescue", () => {
  it("the selected row opens its body (session-cached fetch) and renders it as text", async () => {
    const junk = control({ items: [item({ uid: 5 })] });
    await mount(junk);
    // The selection fell to the first row; the effect asked for its body once.
    expect(junk.openBody).toHaveBeenCalledWith(expect.objectContaining({ uid: 5 }));
    expect(host!.textContent).toContain("Buy now.");
  });

  it("Not junk dispatches the rescue for the SELECTED row, with the honest note beside it", async () => {
    const junk = control({ items: [item({ uid: 5 }), item({ uid: 4 })] });
    await mount(junk);
    expect(host!.textContent).toContain("a first-time sender waits in the Screener");
    await click(buttonByText("Not junk"));
    expect(junk.rescue).toHaveBeenCalledTimes(1);
    expect(junk.rescue).toHaveBeenCalledWith(expect.objectContaining({ uid: 5 }));
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE §16.2 EXTRAS (2026-08-27): the second verb, the search box and its states, the sweep offer.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const typeInto = async (el: HTMLInputElement | null, value: string): Promise<void> => {
  if (!el) throw new Error("no search field on screen");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("the second verb — Not junk, always allow", () => {
  it("is a SECOND button on the selected row, and dispatches the rescue WITH the allow flag", async () => {
    const junk = control({ items: [item({ uid: 5 }), item({ uid: 4 })] });
    await mount(junk);
    expect(host!.textContent).toContain("their spam rule is switched off");
    await click(buttonByText("Not junk, always allow"));
    expect(junk.rescue).toHaveBeenCalledTimes(1);
    expect(junk.rescue).toHaveBeenCalledWith(expect.objectContaining({ uid: 5 }), { allow: true });
    // The plain verb is still there and still plain.
    await click(buttonByText("Not junk"));
    expect(junk.rescue).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 5 }));
  });
});

describe("the search-append's rendering", () => {
  it("the field hands every keystroke to the control", async () => {
    const junk = control({ items: [item({ uid: 5 })] });
    await mount(junk);
    await typeInto(host!.querySelector<HTMLInputElement>(".scn-junk-search input"), "acme");
    expect(junk.search.setQuery).toHaveBeenCalledWith("acme");
  });

  it("SEARCHING is a stated state, and the appended hits sit under their own caption", async () => {
    const local = item({ uid: 5, subject: "acme invoice" });
    const hit = item({ uid: 1, subject: "older acme" });
    const searching = control({
      items: [local], visible: [local],
      search: { query: "acme", setQuery: vi.fn(), phase: "searching", hits: [], localCount: 1, mailboxes: [], truncated: false, searchServer: vi.fn() },
    });
    await mount(searching);
    expect(host!.textContent).toContain("Searching your mail server's Junk folder for “acme”…");
    expect(host!.textContent).not.toContain("Found on your mail server");
    await act(async () => { root!.unmount(); });

    const done = control({
      items: [local], visible: [local, hit],
      search: {
        query: "acme", setQuery: vi.fn(), phase: "done", hits: [hit], localCount: 1,
        mailboxes: [
          { id: "mb1", address: "a@example.invalid", window: "ok" },
          { id: "mb2", address: "b@example.invalid", window: "unreachable" },
        ],
        truncated: true, searchServer: vi.fn(),
      },
    });
    await mount(done);
    const text = host!.textContent ?? "";
    expect(text).toContain("Found on your mail server");
    expect(text).toContain("older acme");
    expect(text).toContain("b@example.invalid couldn't be searched in time.");
    expect(text).toContain("Showing the newest matches");
    // "Show older" is the WINDOW's pagination, not the search's — hidden while a query is typed.
    expect(buttonByText("Show older")).toBeNull();
  });

  it("NOTHING FOUND says so plainly; a FAILED search offers the retry; local matches offer the server", async () => {
    const none = control({
      items: [item({ uid: 5 })], visible: [],
      search: { query: "zzz", setQuery: vi.fn(), phase: "done", hits: [], localCount: 0, mailboxes: [], truncated: false, searchServer: vi.fn() },
    });
    await mount(none);
    expect(host!.textContent).toContain("Nothing in Junk matches “zzz”.");
    // Not the window's empty state — the window is not empty, the SEARCH is.
    expect(host!.textContent).not.toContain("Junk is empty");
    await act(async () => { root!.unmount(); });

    const failed = control({
      items: [item({ uid: 5 })], visible: [],
      search: { query: "zzz", setQuery: vi.fn(), phase: "failed", hits: [], localCount: 0, mailboxes: [], truncated: false, searchServer: vi.fn() },
    });
    await mount(failed);
    expect(host!.textContent).toContain("Junk couldn't be searched just now.");
    await click(buttonByText("Search again"));
    expect(failed.search.searchServer).toHaveBeenCalledTimes(1);
    await act(async () => { root!.unmount(); });

    const local = item({ uid: 5, subject: "acme" });
    const kept = control({
      items: [local], visible: [local],
      search: { query: "acme", setQuery: vi.fn(), phase: "local", hits: [], localCount: 1, mailboxes: [], truncated: false, searchServer: vi.fn() },
    });
    await mount(kept);
    await click(buttonByText("Also search your mail server's Junk folder"));
    expect(kept.search.searchServer).toHaveBeenCalledTimes(1);
  });
});

describe("the one-time sweep offer", () => {
  const preview = (movable: number, over: Partial<JunkWindowControl["sweep"]["preview"] & object> = {}) => ({
    mailboxes: [{ id: "mb1", address: "a@example.invalid", candidates: movable, hasJunkFolder: true, pending: false }],
    movable, pending: false, ...over,
  });

  it("offers the pile with its NUMBER, asks once more, then records the press; Dismiss dismisses", async () => {
    const junk = control({ sweep: { phase: "offer", preview: preview(3), requesting: false, request: vi.fn(), dismiss: vi.fn() } });
    await mount(junk);
    expect(host!.textContent).toContain("3 messages from earlier spam verdicts still sit in ohmail/Quarantine.");
    expect(junk.sweep.request).not.toHaveBeenCalled();
    await click(buttonByText("Move to Junk"));
    // The first press only opens the confirm — nothing is recorded yet.
    expect(junk.sweep.request).not.toHaveBeenCalled();
    await click(buttonByText("Move 3 messages"));
    expect(junk.sweep.request).toHaveBeenCalledTimes(1);
    await act(async () => { root!.unmount(); });

    const again = control({ sweep: { phase: "offer", preview: preview(1), requesting: false, request: vi.fn(), dismiss: vi.fn() } });
    await mount(again);
    expect(host!.textContent).toContain("1 message from earlier spam verdicts");
    await click(buttonByText("Dismiss"));
    expect(again.sweep.dismiss).toHaveBeenCalledTimes(1);
  });

  it("QUEUED and DONE are read back, a stranded mailbox is named, and no offer renders on a guess", async () => {
    const pending = control({ sweep: { phase: "pending", preview: preview(2, { pending: true }), requesting: false, request: vi.fn(), dismiss: vi.fn() } });
    await mount(pending);
    expect(host!.textContent).toContain("Queued");
    expect(buttonByText("Move to Junk")).toBeNull();
    await act(async () => { root!.unmount(); });

    const done = control({ sweep: { phase: "done", preview: preview(0), requesting: false, request: vi.fn(), dismiss: vi.fn() } });
    await mount(done);
    expect(host!.textContent).toContain("Done — ohmail/Quarantine is empty.");
    await act(async () => { root!.unmount(); });

    const stranded = control({
      sweep: {
        phase: "offer", requesting: false, request: vi.fn(), dismiss: vi.fn(),
        preview: {
          mailboxes: [
            { id: "mb1", address: "a@example.invalid", candidates: 2, hasJunkFolder: true, pending: false },
            { id: "mb2", address: "b@example.invalid", candidates: 4, hasJunkFolder: false, pending: false },
          ],
          movable: 2, pending: false,
        },
      },
    });
    await mount(stranded);
    expect(host!.textContent).toContain("2 messages from earlier spam verdicts");
    expect(host!.textContent).toContain("b@example.invalid has no Junk folder — its 4 messages stay where they are.");
    await act(async () => { root!.unmount(); });

    const unknown = control({ sweep: { phase: "unknown", preview: null, requesting: false, request: vi.fn(), dismiss: vi.fn() } });
    await mount(unknown);
    expect(host!.querySelector(".scn-junk-sweep")).toBeNull();
  });
});

describe("the sweep offer — a STRANDED pile (client review round 1)", () => {
  it("names what stays and offers NOTHING to press — never 'Done', never 'Move to Junk'", async () => {
    const junk = control({
      sweep: {
        phase: "stranded", requesting: false, request: vi.fn(), dismiss: vi.fn(),
        preview: {
          mailboxes: [{ id: "mb2", address: "b@example.invalid", candidates: 4, hasJunkFolder: false, pending: false }],
          movable: 0, pending: false,
        },
      },
    });
    await mount(junk);
    expect(host!.textContent).toContain("b@example.invalid has no Junk folder — its 4 messages stay where they are.");
    expect(host!.textContent).not.toContain("Done — ohmail/Quarantine is empty.");
    expect(buttonByText("Move to Junk")).toBeNull();
  });
});
