/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  type EngineMessage,
  type Folder,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { ContactPopover } from "../app/shell/ContactPopover";
import { SenderMenu } from "../app/shell/SenderMenu";
import { SubjectRuleSheet } from "../app/shell/SubjectRuleSheet";
import { senderScreening } from "@ohmail/app-logic/press/sender-screening";
import { subjectRuleContext } from "@ohmail/app-logic/press/subject-rule";
import { OVERLAY_EDGE, OVERLAY_GAP } from "../app/shell/overlay-clamp";

/**
 * THE OVERLAYS ARE CLAMPED WHERE A PERSON MEETS THEM.
 *
 * `overlay-clamp.test.ts` holds the geometry as arithmetic; THIS renders the three overlay
 * components and asserts each one actually applies it — measured height in, viewport-bound
 * `max-height` and an inner scroll out. The repository's recurring failure is *built, tested,
 * unreachable*: a clamp that exists as a pure function and is wired to nothing would pass every
 * geometry test while the sheet keeps clipping in production. Unwire `useOverlayClamp` from any
 * of the three roots — restore `style={{ left: state.x, top: state.y }}` — and its case here
 * goes red.
 *
 * jsdom lays nothing out, so the measured height is planted on the element (`scrollHeight` is a
 * plain getter override) and the re-measure is driven by a window resize — the same listener a
 * real viewport change hits. The CSS halves (VWR-8, VWR-12) are asserted at the stylesheet, the
 * way `screener-row-actions-overlay.test.ts` does and for the same reason: jsdom cannot see a
 * wrapped line, but the rule that permits wrapping is a fact of the source.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let seq = 0;

function msg(id: string, from: string, subject: string, folder: Folder = "INBOX"): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject,
    from: { name: null, address: from },
    to: [],
    cc: [],
    date: "2026-08-01T09:00:00.000Z",
    folder,
    snippet: "s",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-01T09:00:00.000Z",
  };
}

async function mirror(list: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(list.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return store;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      React.createElement(NextIntlClientProvider, { locale: "en", messages, children: node }),
    );
  });
  return host;
}

/**
 * Plant the natural height jsdom will not compute, then drive the clamp's own resize listener.
 * `scrollHeight` is what `useOverlayClamp` reads as "what the sheet wants to be".
 */
async function planted(el: Element, naturalHeight: number, viewport: { w: number; h: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: naturalHeight });
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: 252 });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport.w });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.h });
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
  });
}

/** the measured geometry: a 583px sheet whose anchor sits at 630/654 in a 900px viewport. */
const LOW_ANCHOR = { x: 600, y: 662, anchorTop: 630, anchorBottom: 654 };

describe("SenderMenu is viewport-clamped", () => {
  const render = async (anchor: Record<string, number> = LOW_ANCHOR) => {
    const store = await mirror([msg("a", "one@x.example", "Subject a")]);
    const sender = senderScreening(store, "a")!;
    const onChoose = vi.fn();
    const el = await mount(
      React.createElement(SenderMenu, {
        state: { messageId: "a", x: 0, y: 0, ...anchor },
        sender,
        onChoose,
        onOpenDetail: () => {},
        onClose: () => {},
      }),
    );
    return { el, onChoose };
  };

  it("flips above a low anchor once its measured height cannot fit below", async () => {
    const { el } = await render();
    const sheet = el.querySelector<HTMLElement>(".senderm")!;
    await planted(sheet, 583, { w: 1440, h: 900 });

    // The flip: bottom edge on the anchor's top, whole sheet on-screen. With the clamp
    // unwired the style stays `top: 662px` and the sheet's lower half is past the viewport.
    expect(sheet.style.top).toBe(`${630 - OVERLAY_GAP - 583}px`);
    const maxHeight = Number.parseFloat(sheet.style.maxHeight);
    expect(maxHeight).toBeGreaterThanOrEqual(583);
    expect(maxHeight).toBeLessThanOrEqual(900 - 2 * OVERLAY_EDGE);
    // The cap's escape valve: a capped sheet scrolls inside instead of clipping.
    expect(sheet.style.overflowY).toBe("auto");
  });

  it("stands whole, slid up over its anchor, when neither side of the anchor holds it", async () => {
    // A mid-viewport anchor on a phone: 583px of sheet fits on neither side of 400/424 in 844,
    // and the viewport holds it with 241px to spare. It keeps its height — no inner scroll —
    // and slides up from the anchor by the pixels it lacked below.
    const { el } = await render({ x: 80, y: 432, anchorTop: 400, anchorBottom: 424 });
    const sheet = el.querySelector<HTMLElement>(".senderm")!;
    await planted(sheet, 583, { w: 390, h: 844 });
    const maxHeight = Number.parseFloat(sheet.style.maxHeight);
    const top = Number.parseFloat(sheet.style.top);
    expect(maxHeight).toBeGreaterThanOrEqual(583);
    expect(top).toBe(844 - OVERLAY_EDGE - 583);
    expect(top).toBeGreaterThanOrEqual(OVERLAY_EDGE);
    // And the measured 252px width is clamped for real — not `placePicker`'s 240px guess.
    expect(Number.parseFloat(sheet.style.left) + 252).toBeLessThanOrEqual(390 - OVERLAY_EDGE);
  });

  it("scrolls inside only when it is taller than the viewport itself", async () => {
    const { el } = await render({ x: 80, y: 432, anchorTop: 400, anchorBottom: 424 });
    const sheet = el.querySelector<HTMLElement>(".senderm")!;
    await planted(sheet, 900, { w: 390, h: 844 });
    const maxHeight = Number.parseFloat(sheet.style.maxHeight);
    expect(Number.parseFloat(sheet.style.top)).toBe(OVERLAY_EDGE);
    expect(maxHeight).toBe(844 - 2 * OVERLAY_EDGE);
    expect(sheet.style.overflowY).toBe("auto");
  });

  it("destinations are keyboard-operable: Enter on a focused option commits it", async () => {
    const { el, onChoose } = await render();
    const option = [...el.querySelectorAll("li[role=option]")]
      .find((n) => (n.textContent ?? "").includes("News"))!;
    expect(option.getAttribute("tabindex")).toBe("0");
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledWith("reads", "sender", true, true);
  });
});

describe("SubjectRuleSheet is viewport-clamped", () => {
  const render = async () => {
    const store = await mirror([
      msg("alert-1", "info@x.example", "[Alert] disk full"),
      msg("alert-2", "info@x.example", "[Alert] disk fuller"),
      msg("bill-1", "info@x.example", "Invoice 44"),
    ]);
    const ctx = subjectRuleContext(store, "alert-1")!;
    const onConfirm = vi.fn();
    const el = await mount(
      React.createElement(SubjectRuleSheet, {
        state: { messageId: "alert-1", ...LOW_ANCHOR },
        ctx,
        onConfirm,
        onClose: () => {},
      }),
    );
    return { el, onConfirm };
  };

  it("applies the clamp: measured height in, viewport-bound max-height out", async () => {
    const { el } = await render();
    const sheet = el.querySelector<HTMLElement>(".senderm")!;
    // TRI-F1's measurement: ~599px of sheet, 339px of it past a 900px viewport before the fix.
    await planted(sheet, 599, { w: 1440, h: 900 });
    const top = Number.parseFloat(sheet.style.top);
    const maxHeight = Number.parseFloat(sheet.style.maxHeight);
    expect(top).toBeGreaterThanOrEqual(OVERLAY_EDGE);
    expect(top + Math.min(599, maxHeight)).toBeLessThanOrEqual(900 - OVERLAY_EDGE);
    expect(sheet.style.overflowY).toBe("auto");
  });

  it("destinations are keyboard-operable: Space opens the confirm for that destination", async () => {
    const { el } = await render();
    const option = [...el.querySelectorAll("li[role=option]")]
      .find((n) => (n.textContent ?? "").includes("News"))!;
    expect(option.getAttribute("tabindex")).toBe("0");
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(el.querySelector(".sm-confirm")).toBeTruthy();
  });
});

describe("ContactPopover is viewport-clamped", () => {
  it("applies the clamp off a chip pressed at the fold", async () => {
    const el = await mount(
      React.createElement(ContactPopover, {
        state: {
          messageId: "a",
          address: "cy@x.example",
          name: "Cy Cole",
          ...LOW_ANCHOR,
        },
        onClose: () => {},
      }),
    );
    const pop = el.querySelector<HTMLElement>(".cpop")!;
    await planted(pop, 320, { w: 1440, h: 900 });
    const top = Number.parseFloat(pop.style.top);
    // 320px does not fit below the 654 anchor in 900px — the popover flips whole.
    expect(top).toBe(630 - OVERLAY_GAP - 320);
    expect(pop.style.overflowY).toBe("auto");
  });
});

describe("the stylesheet halves (VWR-8, VWR-12) — asserted at the source, jsdom lays nothing out", () => {
  // Root-relative like `screener-row-actions-overlay.test.ts` — the suite runs from the repo
  // root (one root vitest config); under jsdom `import.meta.url` is not a file: URL.
  const bare = readFileSync(
    resolve(process.cwd(), "apps/webapp/app/shell/sender-sheet.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /** Body of the first top-level rule whose selector list is exactly `sel`. */
  const ruleBody = (sel: string): string | null => {
    const re = new RegExp(`(?:^|[}])\\s*${sel}\\s*\\{([^{}]*)\\}`, "m");
    const m = re.exec(bare);
    return m ? m[1] : null;
  };

  it("VWR-8: the scope tile's count wraps — it is the consent, and '1 s…' is not a count", () => {
    const small = ruleBody("\\.sm-scope button small");
    expect(small, "no `.sm-scope button small` rule").not.toBeNull();
    expect(small!, "the count is back to one clipped line").toMatch(/white-space:\s*normal/);
    // The old combined rule must not re-impose nowrap/ellipsis on the small.
    expect(bare).not.toMatch(/\.sm-scope button b,\s*\.sm-scope button small/);
  });

  it("VWR-12: the sheet-level explainer has a box — it no longer prints wall-to-wall", () => {
    const fine = ruleBody("\\.senderm\\s*>\\s*\\.sm-confirm-fine");
    expect(fine, "no `.senderm > .sm-confirm-fine` rule — the subject sheet's explainer is bare again")
      .not.toBeNull();
    // Its inset is the situation line's (`.sm-now`), whichever gutter the panel stands at.
    const now = ruleBody("\\.sm-now");
    const gutter = /padding:\s*0\s+(\d+px)/.exec(now ?? "")?.[1];
    expect(gutter, "no `.sm-now` gutter to inherit").toBeTruthy();
    expect(fine!).toMatch(new RegExp(`margin:\\s*0\\s+${gutter}`));
  });
});
