/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";
import {
  ACCOUNT, ISO, act, installScreeningWeb, mountScreeningWeb, syncScreeningWeb, teardownScreeningWeb, tick,
  warmScreeningWeb,
} from "./fixtures/screening-web";
import { OVERLAY_EDGE } from "../app/screening/overlay-clamp";
import { EDGE as CARD_EDGE } from "../../../packages/ui/src/base/Overlays/menu-place.js";

/**
 * THE OVERLAYS ARE CLAMPED WHERE A PERSON MEETS THEM.
 *
 * `overlay-clamp.test.ts` holds the geometry as arithmetic. This opens the Web reader’s two
 * screening sheets and checks each uses measured height and viewport-bound
 * `max-height` and an inner scroll out. The repository's recurring failure is *built, tested,
 * unreachable*: a clamp that exists as a pure function and is wired to nothing would pass every
 * geometry test while the sheet keeps clipping in production. The sender card uses the shared
 * Menu placement and the subject sheet uses the Web clamp. Remove the Menu’s measured placement
 * and the sender card’s flip and clamp cases fail.
 *
 * jsdom lays nothing out, so the measured height is planted on the element (`scrollHeight` is a
 * plain getter override) and the re-measure is driven by a window resize — the same listener a
 * real viewport change hits. The CSS halves (VWR-8, VWR-12) are asserted at the stylesheet, the
 * way `screener-row-actions-overlay.test.ts` does and for the same reason: jsdom cannot see a
 * wrapped line, but the rule that permits wrapping is a fact of the source.
 */

function msg(id: string, from: string, subject: string): EngineMessage {
  return {
    id,
    accountId: ACCOUNT,
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject,
    from: { name: "Alert sender", address: from },
    to: [],
    cc: [],
    date: "2026-08-01T09:00:00.000Z",
    folder: "INBOX",
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

beforeAll(warmScreeningWeb, 60_000);
afterEach(teardownScreeningWeb);

/**
 * Plant the natural height jsdom will not compute, then drive the clamp's own resize listener.
 * `scrollHeight` is what `useOverlayClamp` reads as "what the sheet wants to be".
 */
async function planted(el: Element, naturalHeight: number, viewport: { w: number; h: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: naturalHeight });
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: 252 });
  if (el.classList.contains("oh-menu")) {
    vi.spyOn(el.parentElement!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, viewport.w, viewport.h));
  }
  vi.stubGlobal("innerWidth", viewport.w);
  vi.stubGlobal("innerHeight", viewport.h);
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
  });
}

/** the measured geometry: a 583px sheet whose anchor sits at 630/654 in a 900px viewport. */
const LOW_ANCHOR = { x: 600, anchorTop: 630, anchorBottom: 654 };

async function mountedSender(letters: readonly EngineMessage[], anchor = LOW_ANCHOR) {
  const first = letters[0]!;
  const sender = first.from.address;
  const ruleWrites: unknown[] = [];
  installScreeningWeb(`#/ohbox/m/${first.id}`, (path, query, method, init) => {
    if (method === "GET" && path === "/api/mailboxes") {
      return Response.json({ items: [{
        id: first.mailboxId, address: ["reader", "example.test"].join("@"), status: "connected",
        createdAt: ISO, lastSyncAt: ISO, initialImportCompletedAt: ISO,
        organizerRole: "organizer", organizerChecked: true, organizeConsentedAt: ISO,
      }] });
    }
    if (method === "GET" && path === "/api/sync" && query.get("types") !== "rule") {
      return syncScreeningWeb(letters.map((message, index) => ({
        type: "message", op: "create", seq: index + 1, id: message.id, updatedAt: ISO,
        entity: message,
      })), letters.length);
    }
    if (method === "POST" && path === "/api/rules") {
      ruleWrites.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: "rule-a", kind: "sender", match: sender, destination: "ohmail/News",
        enabled: true, provenance: "manual", priority: 0, stats: { hits: 0, lastHitAt: null, demotions: 0 },
        createdAt: ISO, updatedAt: ISO, retro: { requestedAt: ISO, doneAt: null, from: null },
      }, { status: 201, headers: { "X-Sync-Seq": String(letters.length + 1) } });
    }
    return undefined;
  });

  const shell = within(await mountScreeningWeb());
  await tick(4000);
  const trigger = shell.getByRole("button", { name: /^Alert sender / });
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(
    new DOMRect(anchor.x, anchor.anchorTop, 180, anchor.anchorBottom - anchor.anchorTop),
  );
  await act(async () => { fireEvent.click(trigger); });
  const sheet = screen.getByRole("dialog", { name: messages.screening.aria.replace("{sender}", sender) });
  return { sheet, ruleWrites };
}

describe("SenderMenu is viewport-clamped", () => {
  it("flips above a low anchor once its measured height cannot fit below", async () => {
    const { sheet } = await mountedSender([msg("a", "one@x.example", "Subject a")]);
    await planted(sheet, 583, { w: 1440, h: 900 });

    const top = Number.parseFloat(sheet.style.top);
    expect(top).toBe(630 - CARD_EDGE - 583);
    expect(top).toBeGreaterThanOrEqual(CARD_EDGE);
    expect(sheet.style.maxHeight).toBe("");
  });

  it("stands whole, slid up over its anchor, when neither side of the anchor holds it", async () => {
    // A mid-viewport anchor on a phone: 583px of sheet fits on neither side of 400/424 in 844,
    // and the viewport holds it with 241px to spare. It keeps its height — no inner scroll —
    // and slides up from the anchor by the pixels it lacked below.
    const { sheet } = await mountedSender([msg("a", "one@x.example", "Subject a")], {
      x: 80, anchorTop: 400, anchorBottom: 424,
    });
    await planted(sheet, 583, { w: 390, h: 844 });
    const top = Number.parseFloat(sheet.style.top);
    expect(sheet.style.maxHeight).toBe("");
    expect(top).toBe(844 - CARD_EDGE - 583);
    expect(top).toBeGreaterThanOrEqual(CARD_EDGE);
    expect(Number.parseFloat(sheet.style.left) + 252).toBeLessThanOrEqual(390 - CARD_EDGE);
  });

  it("scrolls inside only when it is taller than the viewport itself", async () => {
    const { sheet } = await mountedSender([msg("a", "one@x.example", "Subject a")], {
      x: 80, anchorTop: 400, anchorBottom: 424,
    });
    await planted(sheet, 900, { w: 390, h: 844 });
    const maxHeight = Number.parseFloat(sheet.style.maxHeight);
    expect(Number.parseFloat(sheet.style.top)).toBe(CARD_EDGE);
    expect(maxHeight).toBe(844 - 2 * CARD_EDGE);
    const menuCss = readFileSync(resolve("packages/ui/src/base/Overlays/menu.css"), "utf8");
    expect(menuCss).toMatch(/\.oh-menu\s*\{[^}]*overflow:\s*auto;/);
  });

  it("destinations are keyboard-operable: Enter on a focused option commits it", async () => {
    const letter = msg("a", ["one", "x.example"].join("@"), "Subject a");
    const { sheet, ruleWrites } = await mountedSender([letter]);
    const places = within(sheet).getByRole("radiogroup", { name: messages.screening.cardGoesTo });
    const first = within(places).getByRole("radio", { name: "Ohbox" });
    const news = within(places).getByRole("radio", { name: "News" });
    expect(first.getAttribute("tabindex")).toBe("0");
    await act(async () => {
      first.focus();
      fireEvent.keyDown(first, { key: "ArrowRight" });
    });
    expect(document.activeElement).toBe(news);
    expect(news).toBeInstanceOf(HTMLButtonElement);
    expect(ruleWrites).toEqual([]);
    await act(async () => {
      // jsdom does not perform the native button activation that follows an uncancelled Enter.
      if (fireEvent.keyDown(news, { key: "Enter" })) fireEvent.click(news, { detail: 0 });
    });
    await tick(12000);
    expect(ruleWrites).toEqual([{
      kind: "sender", match: letter.from.address, destination: "ohmail/News", applyRetro: true,
    }]);
  });
});

describe("SubjectRuleSheet is viewport-clamped", () => {
  async function renderSubject() {
    const letters = [
      msg("alert-1", "info@x.example", "[Alert] disk full"),
      msg("alert-2", "info@x.example", "[Alert] disk fuller"),
      msg("bill-1", "info@x.example", "Invoice 44"),
    ];
    const { sheet: sender } = await mountedSender(letters);
    await act(async () => {
      fireEvent.click(within(sender).getByRole("menuitem", { name: messages.screening.cardSubject }));
    });
    return screen.getByRole("dialog", {
      name: messages.screening.subjectAria.replace("{who}", letters[0]!.from.address),
    });
  }

  it("applies the clamp: measured height in, viewport-bound max-height out", async () => {
    const sheet = await renderSubject();
    // TRI-F1's measurement: ~599px of sheet, 339px of it past a 900px viewport before the fix.
    await planted(sheet, 599, { w: 1440, h: 900 });
    const top = Number.parseFloat(sheet.style.top);
    const maxHeight = Number.parseFloat(sheet.style.maxHeight);
    expect(top).toBeGreaterThanOrEqual(OVERLAY_EDGE);
    expect(top + Math.min(599, maxHeight)).toBeLessThanOrEqual(900 - OVERLAY_EDGE);
    expect(sheet.style.overflowY).toBe("auto");
  });

  it("destinations are keyboard-operable: Space opens the confirm for that destination", async () => {
    const sheet = await renderSubject();
    const option = within(sheet).getByRole("radio", { name: /^Ohbox(?:\s|$)/ });
    expect(option.getAttribute("tabindex")).toBe("0");
    await act(async () => {
      if (fireEvent.keyDown(option, { key: " " })) fireEvent.click(option, { detail: 0 });
    });
    expect(option.getAttribute("aria-checked")).toBe("true");
    expect(within(sheet).getByRole<HTMLButtonElement>("button", { name: messages.screening.subjectMakeRule }).disabled).toBe(false);
  });
});

/* "ContactPopover is viewport-clamped" retired with today's popover: the reader's contact card is the kit's Menu
   (kind card, `packages/app/src/reader/contact/Contact.tsx`), placed by `placeMenu`, whose own case holds it:
   `packages/ui/test/base/overlays.test.tsx`, "where a menu stands > upwards where it would leave the stage below
   and there is more room above". */

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
