/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import type { MailboxFacts } from "../app/shell/mail-state";
import {
  REPLY_PANEL_MIN_PX,
  REPLY_PANEL_VIEWPORT_MARGIN_PX,
  clampReplyHeight,
} from "../app/shell/InlineReply";

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
 * cascade is (jsdom drops `clamp()`/`dvh` values from computed
 * style, so the declaration text is the honest assertion).
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/* ══ the stylesheets, at the source ══════════════════════════════════════════════════════ */

/** The repo root from either working directory — the root run is what CI does. */
function fromRootOrApp(relFromRoot: string): string {
  try {
    readFileSync(resolve(process.cwd(), relFromRoot), "utf8");
    return relFromRoot;
  } catch {
    return `../../${relFromRoot}`;
  }
}
/** Comments stripped first — a commented-out declaration is not a declaration. */
const bare = (relFromRoot: string): string =>
  readFileSync(resolve(process.cwd(), fromRootOrApp(relFromRoot)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const APP_CSS = bare("apps/webapp/app/app.css");
const READER_CSS = bare("packages/ui/src/composites/reader.css");

/** Body of the first rule whose selector list is exactly `sel` (regex-escaped by the caller). */
const ruleBody = (css: string, sel: string): string | null => {
  const re = new RegExp(`(?:^|[};])\\s*${sel}\\s*\\{([^{}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[1] : null;
};

describe("the panel wears the design system's floating layer (structural CSS)", () => {
  const reply = ruleBody(APP_CSS, "\\.reply");

  it("rounded, tokened, lifted — never a square box of literal colors", () => {
    expect(reply, "no `.reply` rule in app.css").not.toBeNull();
    expect(reply!).toMatch(/border-radius:\s*var\(--r-overlay\)/);
    expect(reply!).not.toMatch(/border-radius:\s*0/);
    expect(reply!).toMatch(/background:\s*var\(--float\)/);
    expect(reply!).toMatch(/var\(--lift-3\)/);
    // Tokens only. A literal color here holds in exactly one theme.
    expect(reply!, "a literal color crept into the panel — it cannot hold in both themes")
      .not.toMatch(/#[0-9a-f]{3}|rgba?\(|oklch\(/i);
  });

  it("is a viewport-bounded flex column — chrome can never be pushed off-screen", () => {
    expect(reply!).toMatch(/display:\s*flex/);
    expect(reply!).toMatch(/flex-direction:\s*column/);
    // The hard bound: taller than the viewport is chrome nobody can reach. `vh` fallback
    // first, `dvh` over it — both must be present.
    expect(reply!, "the panel lost its viewport height bound").toMatch(/max-height:\s*calc\(100vh/);
    expect(reply!).toMatch(/max-height:\s*calc\(100dvh/);
    // The resting posture backs off on a short window instead of overrunning it.
    expect(reply!).toMatch(/min-height:\s*clamp\(/);
  });

  it("chrome is `flex: none`; the editor alone takes the slack and may shrink", () => {
    const chrome = ruleBody(APP_CSS, "\\.reply\\s*>\\s*\\*");
    expect(chrome, "no `.reply > *` rule — chrome rows can be crushed by flex").not.toBeNull();
    expect(chrome!).toMatch(/flex:\s*none/);
    const editor = ruleBody(APP_CSS, "\\.reply\\s*>\\s*\\.reply-editor");
    expect(editor, "no `.reply > .reply-editor` rule — nothing takes the slack").not.toBeNull();
    expect(editor!).toMatch(/flex:\s*1 1 auto/);
    expect(editor!, "the editor lost its visibility floor").toMatch(/min-height:\s*\d+px/);
  });

  it("the ONE scroll region is the editor surface; the dock declares no scroll of its own", () => {
    const surface = ruleBody(APP_CSS, "\\.reply-editor \\.rte-surface");
    expect(surface, "no `.reply-editor .rte-surface` rule").not.toBeNull();
    expect(surface!).toMatch(/overflow-y:\s*auto/);
    // `min-height: 0` is what lets the surface shrink under its content instead of pushing
    // the chrome out of the panel.
    expect(surface!).toMatch(/min-height:\s*0/);
    // The dock was the old scroller, and a dock that scrolls again is the chrome-scrolls-away
    // defect returning wholesale (see also action-bar.test.ts).
    const dock = /\.read-col \.reply-dock \{[^}]*\}/.exec(READER_CSS)?.[0] ?? "";
    expect(dock, "no sticky dock rule in reader.css").toContain("position: sticky");
    expect(dock, "the dock scrolls the whole panel again").not.toContain("overflow");
    expect(dock, "the dock caps the panel again — the bound belongs to `.reply`").not.toContain("max-height");
  });

  it("the attachment LIST is bounded inside the chrome — many files scroll in their strip", () => {
    const list = ruleBody(APP_CSS, "\\.reply \\.compose-attach-list");
    expect(list, "no `.reply .compose-attach-list` bound — files can eat the panel").not.toBeNull();
    expect(list!).toMatch(/max-height:\s*\d+px/);
    expect(list!).toMatch(/overflow-y:\s*auto/);
  });

  it("the grip is a real handle: resize cursor, drag not hijacked by touch scroll", () => {
    const grip = ruleBody(APP_CSS, "\\.reply-grip");
    expect(grip, "no `.reply-grip` rule").not.toBeNull();
    expect(grip!).toMatch(/cursor:\s*row-resize/);
    expect(grip!).toMatch(/touch-action:\s*none/);
  });
});

describe("the drag clamp — every path to a height goes through the same bounds", () => {
  it("floors, ceilings against the viewport, and never inverts on a tiny window", () => {
    expect(clampReplyHeight(10_000, 768)).toBe(768 - REPLY_PANEL_VIEWPORT_MARGIN_PX);
    expect(clampReplyHeight(50, 768)).toBe(REPLY_PANEL_MIN_PX);
    expect(clampReplyHeight(400, 768)).toBe(400);
    // A window shorter than floor+margin: the floor wins and the bound never goes negative.
    expect(clampReplyHeight(500, 200)).toBe(REPLY_PANEL_MIN_PX);
  });
});

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

/** The whole client on the fixture world; optional mailbox facts for the From flows. */
async function mountShell(facts?: MailboxFacts[]): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
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
            children: h(AppShell, { demo: true, ...(facts ? { mailboxFacts: async () => facts } : {}) }),
          }),
        }),
      }),
    );
  });
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  await key("j");
  await waitFor(() => openSubject() !== "", "the Ohbox never opened a message");
}

async function waitFor(ready: () => boolean, why: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (ready()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  throw new Error(why);
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);

const openSubject = (): string =>
  q(".reader .msg .msg-subject")?.textContent ?? q(".read-col .msg .msg-subject")?.textContent ?? "";

const replySurface = (): HTMLElement | null =>
  [...host!.querySelectorAll<HTMLElement>(".reader .msg, .read-col .msg")]
    .flatMap((m) => [...m.querySelectorAll<HTMLElement>(".rte-surface")])[0] ?? null;

async function openReply(): Promise<void> {
  await key("r");
  await waitFor(() => replySurface() !== null, "`r` opened no reply editor");
}

/** A close is only a close when it strands nothing — asserted after every path out. */
function expectClosedClean(how: string): void {
  expect(replySurface(), `${how} left the editor open`).toBeNull();
  expect(q(".reply-dock"), `${how} left the dock behind`).toBeNull();
  expect(q(".reply"), `${how} left the panel behind`).toBeNull();
  // The view is unchanged; the open message rides the hash by design (`message-url.test.tsx`).
  expect(window.location.hash, `${how} changed the route`).toMatch(/^#\/ohbox(\/m\/|$)/);
}

/** The pill's own label, shorn of the keycap the bar renders beside it. The answer verbs carry
 *  their word in a span beside an icon face (DESIGN-026 §2.1), so the span counts as label text. */
const labelWithoutKeycap = (b: HTMLButtonElement): string =>
  [...b.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE
    || (n instanceof HTMLElement && /^abar-(reply|fwd)-lab$/.test(n.className)))
    .map((n) => n.textContent).join("").trim();

const pillReply = (): HTMLButtonElement => {
  const btn = [...host!.querySelectorAll<HTMLButtonElement>(".read-col .msg-actions button")]
    .find((b) => labelWithoutKeycap(b) === "Reply");
  expect(btn, "no Reply button on the pill").toBeDefined();
  return btn!;
};

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

describe("the chrome stays outside the scroll region — with attachments present", () => {
  /**
   * ══ THE CENTRAL STRUCTURAL GUARD ═══════════════════════════════════════════════════════
   *
   * Mutation: wrap `<ComposeAttach>` (or the actions row) in an extra div inside
   * `InlineReply` — the flex contract breaks silently in a browser (the wrapper is the flex
   * item, not the strip) and the direct-child assertions here go red. Nesting any chrome into
   * the editor's own tree trips the `closest(".rte-surface")` half.
   */
  it("toolbar, attachments, actions and grip are pinned panel children, never scroller content", async () => {
    // A synchronous FileReader — only that bytes are carried matters; restored in finally.
    const RealFileReader = (globalThis as { FileReader?: unknown }).FileReader;
    class FakeFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error: unknown = null;
      readAsDataURL(): void {
        this.result = "data:text/plain;base64,QUJDREU=";
        this.onload?.();
      }
    }
    (globalThis as unknown as { FileReader: unknown }).FileReader = FakeFileReader;
    try {
      await mountShell();
      await openReply();

      const input = q<HTMLInputElement>(".reply .compose-attach input[type='file']");
      expect(input, "the reply editor rendered no attach control").not.toBeNull();
      const file = new File([new Uint8Array([1, 2, 3])], "plan.txt", { type: "text/plain" });
      Object.defineProperty(input!, "files", {
        configurable: true, value: { 0: file, length: 1, item: () => file },
      });
      await act(async () => { input!.dispatchEvent(new Event("change", { bubbles: true })); });
      await waitFor(
        () => q(".reply .compose-attach-item") !== null,
        "the picked file never appeared in the strip",
      );

      const panel = q<HTMLElement>(".reply")!;
      // Every piece of chrome exists, sits OUTSIDE the one scroll region, and is a DIRECT
      // child of the flex column (the editor is the sole flexible one among them).
      for (const sel of [".reply-grip", ".compose-attach", ".reply-actions"]) {
        const piece = panel.querySelector<HTMLElement>(sel);
        expect(piece, `${sel} is not in the panel`).not.toBeNull();
        expect(piece!.closest(".rte-surface"), `${sel} is INSIDE the scroll region`).toBeNull();
        expect(piece!.closest(".rte-body"), `${sel} is inside the editor's body wrapper`).toBeNull();
        expect(piece!.parentElement, `${sel} is not a direct child of the panel — the flex chrome contract broke`).toBe(panel);
      }
      // The toolbar is chrome too: inside the editor frame but a SIBLING of the body wrapper
      // the surface scrolls in — never content that can scroll away under it.
      const bar = panel.querySelector<HTMLElement>(".rte-bar");
      expect(bar, "no formatting toolbar in the panel").not.toBeNull();
      expect(bar!.closest(".rte-surface")).toBeNull();
      expect(bar!.closest(".rte-body"), "the toolbar rode into the scrolling body").toBeNull();
      expect(bar!.parentElement?.classList.contains("rte"), "the toolbar left the editor frame").toBe(true);
      // …and the editor frame itself is the panel's direct flexible child.
      const editor = panel.querySelector<HTMLElement>(".reply-editor");
      expect(editor!.parentElement).toBe(panel);
      // The surface (the one scroller) lives inside the body wrapper, below the toolbar.
      expect(panel.querySelector(".rte-body .rte-surface"), "the surface left the body chain").not.toBeNull();
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = RealFileReader;
    }
  });
});

describe("the grip sets the panel's height, within bounds, and it sticks for the session", () => {
  it("drags with the pointer, steps with the keyboard, clamps both, and survives reopen", async () => {
    await mountShell();
    await openReply();

    const grip = q<HTMLElement>(".reply .reply-grip");
    expect(grip, "the panel has no resize grip").not.toBeNull();
    expect(grip!.getAttribute("role")).toBe("separator");
    expect(grip!.getAttribute("aria-orientation")).toBe("horizontal");
    expect(grip!.tabIndex, "the grip is not keyboard-reachable").toBe(0);

    const panel = q<HTMLElement>(".reply")!;
    expect(panel.style.height, "a height was set before anybody dragged").toBe("");

    // Drag UP 360px. jsdom renders every box 0 tall, so the start height is 0 and the drag
    // lands exactly at its delta — which is what makes the arithmetic assertable here.
    await act(async () => {
      grip!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 600 }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientY: 240 }));
    });
    expect(panel.style.height, "the drag set no height").toBe("360px");

    // The drag ends on pointerup; a later move must not keep resizing.
    await act(async () => { window.dispatchEvent(new MouseEvent("pointerup", {})); });
    await act(async () => { window.dispatchEvent(new MouseEvent("pointermove", { clientY: 100 })); });
    expect(panel.style.height, "the panel kept resizing after the pointer was released").toBe("360px");

    // The keyboard has the same control: arrows nudge from the set height.
    await act(async () => {
      grip!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    });
    expect(panel.style.height).toBe("384px");

    // CLAMPED — a drag cannot take the panel past the viewport bound (jsdom: 768 − margin),
    // nor under the floor. Mutation: drop the clamp in `setPanelHeight` → both go red.
    await act(async () => {
      grip!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 5000 }));
    });
    await act(async () => { window.dispatchEvent(new MouseEvent("pointermove", { clientY: 0 })); });
    await act(async () => { window.dispatchEvent(new MouseEvent("pointerup", {})); });
    expect(panel.style.height).toBe(`${window.innerHeight - REPLY_PANEL_VIEWPORT_MARGIN_PX}px`);
    await act(async () => {
      grip!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 0 }));
    });
    await act(async () => { window.dispatchEvent(new MouseEvent("pointermove", { clientY: 5000 })); });
    await act(async () => { window.dispatchEvent(new MouseEvent("pointerup", {})); });
    expect(panel.style.height).toBe(`${REPLY_PANEL_MIN_PX}px`);

    // The height survives closing and reopening the editor — a session posture, not a per-open one.
    await key("Escape");
    expectClosedClean("Escape");
    await openReply();
    expect(
      q<HTMLElement>(".reply")!.style.height,
      "the dragged height did not survive reopening the editor",
    ).toBe(`${REPLY_PANEL_MIN_PX}px`);
  });
});

describe("three ways out: Cancel, `r` again, Reply on the pill again", () => {
  /**
   * Mutation for the toggle halves: point the `r` binding and the pill's `reply` arm back at
   * `openReply` — both "closes it" assertions go red with the editor still on screen.
   */
  it("`r` toggles the editor it opened, and the state comes back clean", async () => {
    await mountShell();
    expect(q(".reply"), "a panel exists before a reply was opened").toBeNull();
    await openReply();

    await key("r");
    expectClosedClean("`r` again");

    // Clean means REOPENABLE, too — no stuck flag anywhere.
    await openReply();
    expect(replySurface()).not.toBeNull();
    await key("r");
    expectClosedClean("the second `r` toggle");
  });

  it("the pill's Reply toggles the same way, and Cancel still closes", async () => {
    await mountShell();

    await act(async () => { pillReply().click(); });
    await waitFor(() => replySurface() !== null, "the pill's Reply opened no editor");

    await act(async () => { pillReply().click(); });
    expectClosedClean("Reply on the pill again");

    // The third way out is the panel's own Cancel — the close control the panel has always
    // had (reply-cancel.test.tsx owns its depth; presence and effect are pinned here so the
    // trio is one contract in one place).
    await act(async () => { pillReply().click(); });
    await waitFor(() => replySurface() !== null, "the pill's Reply did not reopen the editor");
    const cancel = [...host!.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
      .find((b) => b.textContent === "Cancel");
    expect(cancel, "the panel offers no Cancel").toBeDefined();
    await act(async () => { cancel!.click(); });
    expectClosedClean("Cancel");
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
    const head = q<HTMLButtonElement>(".reply .reply-head-btn");
    expect(head, "the reply head is not a control").not.toBeNull();
    await act(async () => { head!.click(); });

    const stack = q<HTMLElement>(".reply .reply-rcpt");
    expect(stack, "no recipients stack opened").not.toBeNull();

    // From is IN the stack, FIRST, as a `.c-field` row — the same grammar as To/Cc/Bcc, so
    // the four rows share one label gutter (the caption used to sit below at its own indent).
    const fromRow = stack!.querySelector<HTMLElement>(".reply-from-row");
    expect(fromRow, "no From row in the opened stack").not.toBeNull();
    expect(fromRow!.classList.contains("c-field"), "the From row left the shared row grammar").toBe(true);
    expect(fromRow!.parentElement, "the From row is not a row of the stack itself").toBe(stack);
    const fromSelect = fromRow!.querySelector<HTMLSelectElement>("select");
    expect(fromSelect, "two sendable addresses offered no From selector").not.toBeNull();
    const fromLabel = fromRow!.querySelector<HTMLLabelElement>("label");
    expect(fromLabel?.htmlFor, "the From control has no associated label").toBe(fromSelect!.id);
    // …and the caption variant is gone while the stack is open — one From, one place.
    expect(q(".reply .reply-from"), "the caption From still renders under the open stack").toBeNull();

    const toLabel = [...stack!.querySelectorAll<HTMLLabelElement>("label")]
      .find((l) => l.textContent === "To");
    expect(toLabel, "no To row in the stack").toBeDefined();
    expect(
      fromRow!.compareDocumentPosition(toLabel!.closest(".c-field")!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "From does not lead the stack",
    ).toBeTruthy();

    // NOW THE REPORT: Cc and Bcc are ALREADY OPEN (2026-08-27 — opening the stack IS the
    // "change recipients" act, so there is no second click), and From stays exactly where it
    // was, leading the full stack.
    expect(stack!.querySelector(".c-ccbcc-toggle"),
      "a Cc/Bcc toggle reappeared in the reply stack — the rows must open at once").toBeNull();

    const labels = [...stack!.querySelectorAll<HTMLLabelElement>("label")].map((l) => l.textContent);
    expect(labels, "the opened stack: every row present, aligned, in order")
      .toEqual(["From", "To", "Cc", "Bcc"]);
    expect(
      stack!.querySelector(".reply-from-row select"),
      "enabling Cc/Bcc made the From row disappear",
    ).not.toBeNull();
    // Every row wears the same `.c-field` grammar — one gutter, one alignment.
    for (const l of stack!.querySelectorAll("label")) {
      expect(l.closest(".c-field"), `the "${l.textContent}" label sits outside the row grammar`).not.toBeNull();
    }
  });

  it("the Bcc helper sentence is gone — from both surfaces and both catalogs", () => {
    for (const rel of [
      "apps/webapp/messages/en.json",
      "apps/webapp/messages/de.json",
      "apps/webapp/app/shell/InlineReply.tsx",
      "apps/webapp/app/views/ComposeView.tsx",
    ]) {
      const src = readFileSync(resolve(process.cwd(), fromRootOrApp(rel)), "utf8");
      expect(src, `${rel} still carries the Bcc helper`).not.toContain("bccHint");
      expect(src).not.toContain("Bcc recipients are hidden");
    }
  });
});
