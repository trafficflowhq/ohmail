/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import type { EngineMutation } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { dispatchMarkAllRead, MARK_SEEN_CHUNK } from "../app/shell/read-all";
import { MarkAllRead } from "../app/components/MarkAllRead";

/**
 * MARK ALL READ: the two guards the ruling names.
 *
 *  1. CHUNKED at ≤ MARK_SEEN_CHUNK ids, one mutation (one Idempotency-Key) per chunk. `PATCH
 *     /messages` 413s above 200, so a "mark all" over a big pile MUST NOT be one mutation.
 *  2. The affordance is ABSENT at unread === 0 — a control that could be pressed against an
 *     already-read list is one that lies about what it does.
 */

describe("dispatchMarkAllRead — chunked at the route's cap", () => {
  it("splits more ids than the batch cap into ceil(n/cap) mark_seen mutations, each within the cap and unread:false", () => {
    const seen: EngineMutation[] = [];
    const n = 2 * MARK_SEEN_CHUNK + 37; // 437
    const ids = Array.from({ length: n }, (_, i) => `id-${i}`);

    const chunks = dispatchMarkAllRead((m) => seen.push(m), ids);

    expect(chunks).toBe(Math.ceil(n / MARK_SEEN_CHUNK)); // 3
    expect(seen).toHaveLength(3);
    // RED-FIRST: replace the loop with a single `mutate({..., messageIds: ids, ...})` and this
    // fails — one 437-id mutation would 413 on the wire.
    for (const m of seen) {
      expect(m.kind).toBe("mark_seen");
      const mm = m as Extract<EngineMutation, { kind: "mark_seen" }>;
      expect(mm.unread).toBe(false);
      expect(mm.messageIds.length).toBeLessThanOrEqual(MARK_SEEN_CHUNK);
    }
    // Every id is covered exactly once, order preserved.
    const flat = seen.flatMap((m) => (m as Extract<EngineMutation, { kind: "mark_seen" }>).messageIds);
    expect(flat).toEqual(ids);
  });

  it("dispatches nothing for an empty selection", () => {
    const seen: EngineMutation[] = [];
    expect(dispatchMarkAllRead((m) => seen.push(m), [])).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("a selection at exactly the cap is one chunk", () => {
    const seen: EngineMutation[] = [];
    const ids = Array.from({ length: MARK_SEEN_CHUNK }, (_, i) => `id-${i}`);
    expect(dispatchMarkAllRead((m) => seen.push(m), ids)).toBe(1);
  });
});

describe("MarkAllRead — absent exactly when there is nothing to clear", () => {
  const act = (React as unknown as { act: (cb: () => void) => void }).act;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let roots: Root[] = [];
  afterEach(() => { act(() => { for (const r of roots) r.unmount(); }); roots = []; });

  const mount = (unreadCount: number, onClick: () => void, freshCount?: number): HTMLElement => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => {
      root.render(
        React.createElement(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC",
          children: React.createElement(MarkAllRead, { unreadCount, freshCount, onMarkAllRead: onClick }),
        }),
      );
    });
    return host;
  };

  it("renders nothing at unreadCount === 0 (and no fresh count)", () => {
    const host = mount(0, () => {});
    expect(host.querySelector("button.mark-all-read")).toBeNull();
  });

  it("renders nothing when both counts are zero — an explicit zero is not a count", () => {
    const host = mount(0, () => {}, 0);
    expect(host.querySelector("button.mark-all-read")).toBeNull();
  });

  it("renders a pressable button when unread > 0", () => {
    const onClick = vi.fn();
    const host = mount(5, onClick);
    const btn = host.querySelector("button.mark-all-read") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    act(() => { btn!.click(); });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders for a standing FRESH count with zero unread — the streams' waterline count must be clearable", () => {
    // Mail read in another IMAP client: nothing unread, but the waterline still counts it as
    // new. A view saying "2 new" with no way to clear it is the live defect this exists for.
    const onClick = vi.fn();
    const host = mount(0, onClick, 2);
    const btn = host.querySelector("button.mark-all-read") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    // The aria states what the press acts on — the new count, since nothing is unread — and
    // names WHICH count that is: the waterline, in the same words the header uses. "2 new"
    // alone is also this app's phrasing for two unread, which is the confusion being ended.
    expect(btn!.getAttribute("aria-label"))
      .toBe("Mark all 2 messages new since you were here as read");
    act(() => { btn!.click(); });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("with both counts, the aria speaks to the unread — the stronger statement", () => {
    const host = mount(3, () => {}, 5);
    const btn = host.querySelector("button.mark-all-read");
    expect(btn!.getAttribute("aria-label")).toBe("Mark all 3 unread messages read");
  });

  it("one unread or one new message is named in the singular, in English and German", () => {
    expect(mount(1, () => {}).querySelector("button")!.getAttribute("aria-label"))
      .toBe("Mark the 1 unread message read");
    expect(mount(0, () => {}, 1).querySelector("button")!.getAttribute("aria-label"))
      .toBe("Mark the 1 message new since you were here as read");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => {
      root.render(React.createElement(NextIntlClientProvider, {
        locale: "de", messages: de, timeZone: "UTC",
        children: React.createElement(MarkAllRead, { unreadCount: 1, onMarkAllRead: () => {} }),
      }));
    });
    expect(host.querySelector("button")!.getAttribute("aria-label"))
      .toBe("Die 1 ungelesene Nachricht als gelesen markieren");
  });
});

describe("a count of one is said in the singular", () => {
  it("the first run's History row and a Screener card's caption, in English and German", () => {
    const enT = createTranslator({ locale: "en", messages });
    const deT = createTranslator({ locale: "de", messages: de });
    expect(enT("onboarding.doneHistory", { count: 1 })).toBe("1 message listed under History");
    expect(enT("onboarding.doneHistory", { count: 12 })).toBe("12 messages listed under History");
    expect(deT("onboarding.doneHistory", { count: 1 })).toBe("1 Nachricht unter Historie gelistet");
    expect(enT("screener.heldCaption", { count: 1, time: "9:00" })).toBe("1 held message — shown · first contact 9:00");
    expect(deT("screener.heldCaption", { count: 1, time: "9:00" }))
      .toBe("1 zurückgehaltene Nachricht — gezeigt · erster Kontakt 9:00");
    expect(enT("screener.heldCaption", { count: 12, time: "9:00" })).toBe("12 held messages — all shown · first contact 9:00");
  });
});
