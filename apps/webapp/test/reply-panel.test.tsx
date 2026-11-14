/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { settleEditor } from "./_first-paint.js";

/**
 * ═══ THE DOCKED REPLY PANEL: FIXED CHROME, ONE BODY SCROLLER, A GRIP, THREE WAYS OUT ═══════
 *
 * The panel redesign this file guards, each half against the defect it replaces:
 *
 *  1. THE CHROME NEVER SCROLLS AWAY. The dock used to be a `max-height: 45vh; overflow-y: auto`
 *     strip that scrolled the WHOLE panel — two attachments were enough to put the formatting
 *     toolbar and Send below a fold inside the editor being typed in. The panel is a flex
 *     column now: every piece of chrome is a `flex: none` direct child, the editor takes the
 *     slack, and the ONE scroll region is the editor's own surface. Guarded structurally (the
 *     chrome is OUTSIDE the scroller, as direct children of the panel) and at the source (the
 *     dock declares no overflow and no height cap of its own).
 *
 *  2. NOTHING LEAVES THE VIEWPORT. `.reply` bounds its own height against the viewport
 *     (`max-height: calc(100dvh - …)`) and the drag clamp enforces the same bound in JS, so
 *     Send/Cancel and the toolbar cannot be pushed off-screen by content OR by a drag. jsdom
 *     runs no layout, so the bound is asserted where it lives: the declaration and the clamp.
 *
 *  3. THE HEIGHT IS THE USER'S. A grip on the panel's top edge — pointer drag and keyboard
 *     arrows — sets the height within [floor, viewport − margin], and the chosen height
 *     survives closing and reopening the editor within the session.
 *
 *  4. REPLY IS A TOGGLE. Cancel has always closed the editor; `r` and the pill's Reply now
 *     close the editor they opened. Each close leaves no dock, no editor and no route change
 *     behind — the reply-cancel suite owns the Cancel path in depth; the toggle paths are here.
 *
 *  5. THE OPENED AUDIENCE IS ONE ALIGNED STACK. From leads it in the same `.c-field` grammar
 *     as To/Cc/Bcc (one label gutter — it used to trail the stack as a caption at its own
 *     indent), and toggling Cc/Bcc on adds rows WITHOUT displacing the From row — the
 *     "From disappears when Cc/Bcc turn on" report. The Bcc helper sentence is deleted.
 *
 * Driven through the whole shell in demo mode where behaviour is the question (the open, the
 * close and the toggle live in `AppShell`), and through the stylesheet's source where the
 * cascade is (the list-title-size idiom — jsdom drops `clamp()`/`dvh` values from computed
 * style, so the declaration text is the honest assertion).
 */

/*
 * RE-POINTED (the older tests' sorting, share write-1). Today's docked panel leaves with today's shell: the reply is
 * Write's, in the open letter of the new shell (the reader's slot, the kit's Composer), found by role and name: the
 * sheet "Reply to <sender>" or "Forward", its text the textbox "Reply body" / "Forward body", its people the
 * comboboxes "To", "Cc", "Bcc" and the chooser "From …". The letter is opened at the Ohbox (`j`), History not being
 * mounted (the same reply). The panel's own stylesheet and structure (its `.reply` rules, the chrome as its direct
 * children) and its height grip (a look the studio's composer does not draw) retire with it, each by its row, held
 * by the kit's Composer and Write's reply. `r` or Reply pressed again no longer closes an open reply (the census's
 * row): those two cases retire, held by the reply that closes on Escape and keeps its words
 * (`inline-reply.test.ts`, "the draft > survives closing and reopening the editor"). Expectations as they stood.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** The repo root from either working directory — the root run is what CI does. */
function fromRootOrApp(relFromRoot: string): string {
  try {
    readFileSync(resolve(process.cwd(), relFromRoot), "utf8");
    return relFromRoot;
  } catch {
    return `../../${relFromRoot}`;
  }
}

/* ══ through the whole shell ═════════════════════════════════════════════════════════════ */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
  // The frame's report leaves through `animate`; jsdom has none.
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** The two fixture mailboxes, for the flows that need a From control on screen. */
const fact = (over: Partial<MailboxFacts>): MailboxFacts => ({
  id: "mb1", address: "one@example.test", status: "connected",
  errorCode: null, disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: null, initialImportCompletedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z", ...over,
});
const TWO_CONNECTED: MailboxFacts[] = [
  fact({ id: "lichtgrat", address: "mila@lichtgrat.example", createdAt: "2025-03-02T00:00:00.000Z" }),
  fact({ id: "milabrunner", address: "hello@milabrunner.example", createdAt: "2024-01-05T00:00:00.000Z" }),
];

const OPEN = '[role="region"][aria-label="Open message"]';

/** The whole client on the fixture world; optional mailbox facts for the From flows. The newest letter opened by `j`. */
async function mountShell(facts?: MailboxFacts[]): Promise<void> {
  await unmount();
  const { MailShell } = await import("./_mail-shell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, {
            children: h(MailShell, { demo: true, ...(facts ? { mailboxFacts: async () => facts } : {}) }),
          }),
        }),
      }),
    );
  });
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  await waitFor(() => host!.querySelector('section[aria-label="Messages"] [role=option][data-id]') !== null, "the Ohbox grew no rows");
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
  });
  await waitFor(() => openSubject() !== "", "the Ohbox never opened a message");
}

/** Bounded by real time, not a tick count: the editor's cold lazy import outlasts any count under load. */
async function waitFor(ready: () => boolean, why: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(why);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);

/** The open letter's subject (today's `.msg-subject`): the open message's heading. */
const openSubject = (): string => q(`${OPEN} h2`)?.textContent ?? "";

/** The reply or forward standing in the open letter (today's `.reply`, the panel): Write's sheet, by its name. */
const panel = (): HTMLElement | null =>
  q<HTMLElement>(`${OPEN} section[aria-label="Forward"], ${OPEN} section[aria-label^="Reply to "]`);
/** Its text (today's `.rte-surface` inside the open message). */
const replySurface = (): HTMLElement | null =>
  panel()?.querySelector<HTMLElement>('[role="textbox"][aria-label="Reply body"], [role="textbox"][aria-label="Forward body"]') ?? null;

async function openReply(): Promise<void> {
  await key("r");
  await waitFor(() => replySurface() !== null, "`r` opened no reply editor");
  await settleEditor();
}

beforeEach(() => {
  setViewport();
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  try { window.sessionStorage.clear(); } catch { /* storage blocked */ }
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await unmount();
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

describe("a forward from the keyboard starts in To, and a send with nobody says so", () => {
  it("⇧F puts the cursor in To; Ctrl+Enter with no recipient sends nothing and says why", async () => {
    await mountShell();
    await key("F", { shiftKey: true });
    const forwardTo = (): HTMLElement | null =>
      panel()?.querySelector<HTMLElement>('[role="combobox"][aria-label="To"]') ?? null;
    await waitFor(() => forwardTo() !== null, "⇧F opened no forward with its recipient rows");
    await waitFor(() => document.activeElement === forwardTo(), "the forward did not put the cursor in To");
    const to = document.activeElement as HTMLElement;
    expect(to.getAttribute("aria-label")).toBe("To");

    // Pressed where the keys are: in To, as a person does (a key on the page itself reaches no field).
    await act(async () => {
      to.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await waitFor(() => (document.body.textContent ?? "").includes(messages.compose.needRecipient),
      "Ctrl+Enter with no recipient said nothing");
    expect(panel(), "the refused send closed the forward").not.toBeNull();
  });
});

describe("the opened audience is one aligned stack, and From survives Cc/Bcc", () => {
  /**
   * Mutation for the disappearance guard: gate `fromRow` on `!open` (or move it back below
   * the stack as the old caption) — "From left the stack when Cc/Bcc opened" goes red.
   */
  it("From leads the stack in the shared row grammar; toggling Cc/Bcc displaces nothing", async () => {
    await mountShell(TWO_CONNECTED);
    await openReply();

    // Open the audience for editing.
    const head = [...(panel()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((b) => b.textContent?.trim() === messages.write.reply.change || b.getAttribute("aria-label") === messages.write.reply.change);
    expect(head, "the reply head is not a control").toBeDefined();
    await act(async () => { head!.click(); });

    /* The opened people, by their names (today's `.reply-rcpt` stack of `.c-field` rows): From's chooser, then the
       To, Cc and Bcc lines. The shared row grammar of today's stylesheet (`.c-field`, the From row a direct child of
       the stack) left with today's panel by its row; the order, the one From and its name are read here. */
    const named = (): { word: string; el: HTMLElement }[] =>
      [...(panel()?.querySelectorAll<HTMLElement>("[aria-label]") ?? [])].flatMap((el) => {
        const name = el.getAttribute("aria-label") ?? "";
        if (el.matches('[role="combobox"], input') && ["To", "Cc", "Bcc"].includes(name)) return [{ word: name, el }];
        if (el.matches("button") && name.startsWith("From ")) return [{ word: "From", el }];
        return [];
      });
    await waitFor(() => named().some((n) => n.word === "To"), "no recipients stack opened");

    const froms = named().filter((n) => n.word === "From");
    expect(froms.length, "no From row in the opened stack").toBeGreaterThan(0);
    const fromSelect = froms[0]!.el;
    expect(fromSelect, "two sendable addresses offered no From selector").not.toBeNull();
    expect(fromSelect.getAttribute("aria-label"), "the From control has no associated label").toMatch(/^From /);
    // …and the caption variant is gone while the stack is open — one From, one place.
    expect(froms.length, "the caption From still renders under the open stack").toBe(1);

    const toLabel = named().find((n) => n.word === "To");
    expect(toLabel, "no To row in the stack").toBeDefined();
    expect(
      fromSelect.compareDocumentPosition(toLabel!.el) & Node.DOCUMENT_POSITION_FOLLOWING,
      "From does not lead the stack",
    ).toBeTruthy();

    // NOW THE REPORT: Cc and Bcc are ALREADY OPEN (2026-08-27 — opening the stack IS the
    // "change recipients" act, so there is no second click), and From stays exactly where it
    // was, leading the full stack.
    expect([...(panel()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === messages.write.more) ?? null,
      "a Cc/Bcc toggle reappeared in the reply stack — the rows must open at once").toBeNull();

    const labels = named().map((n) => n.word);
    expect(labels, "the opened stack: every row present, aligned, in order")
      .toEqual(["From", "To", "Cc", "Bcc"]);
    expect(
      named().find((n) => n.word === "From") ?? null,
      "enabling Cc/Bcc made the From row disappear",
    ).not.toBeNull();
  });

  it("the Bcc helper sentence is gone — from both surfaces and both catalogs", () => {
    for (const rel of [
      "apps/webapp/messages/en.json",
      "apps/webapp/messages/de.json",
      // Both surfaces are Write's now (today's InlineReply.tsx and ComposeView.tsx leave with today's shell): the
      // reply, the letter, the people they both draw, and Write's own catalogue.
      "packages/app/src/write/Reply.tsx",
      "packages/app/src/write/Letter.tsx",
      "packages/app/src/write/head/People.tsx",
      "packages/app/messages/write.en.json",
      "packages/app/messages/write.de.json",
    ]) {
      const src = readFileSync(resolve(process.cwd(), fromRootOrApp(rel)), "utf8");
      expect(src, `${rel} still carries the Bcc helper`).not.toContain("bccHint");
      expect(src).not.toContain("Bcc recipients are hidden");
    }
  });
});
