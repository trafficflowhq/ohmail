/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * THE DATE ON A LIST ROW SAYS WHICH SATURDAY, AND ONE PRESS ASKS THE WHOLE LIST.
 *
 * A row stamp is relative because that is what a list is scanned by — "Sat", "09:12", "3 Aug".
 * The one question it cannot answer is the obvious one: which Saturday, and at what time. So
 * hovering a date names the exact instant, and PRESSING one flips every date in the list to the
 * exact form at once — not row by row, because a reader comparing dates wants them in the same
 * shape, and not for this list only, because the message open beside it is showing the same mail.
 *
 * The three things asserted here, none of which `MessageRow` can own:
 *
 *   · WHICH TWO FORMS, and which of them is on screen (`rowStamp` in `shell/format.ts`). The title
 *     is always the form that is NOT displayed, so a hover says something new either way.
 *   · THAT THE PRESS REACHES THE WHOLE LIST — a real view, a real shell-held boolean, one press on
 *     ONE row's date, every other row flipped with it.
 *   · THAT THE PRESS IS NOT AN OPEN. The date sits inside the row button; a press on it must flip
 *     the list and leave the cursor exactly where it was.
 *
 * A message with NO `Date:` header has one form and no flip at all — see the last case. That is
 * the production path that keeps `MessageRow`'s unwired branch honest rather than theoretical.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-08T13:00:00.000Z");

/** A desktop width: the row's own press asks, and a tap at phone width opens the reader sheet. */
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  }) as unknown as MediaQueryList;

function msg(id: string, date: string | null): Record<string, unknown> {
  return {
    id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subj-${id}`,
    from: { name: `Sender ${id.toUpperCase()}`, address: `${id}@ex.example` },
    to: [], cc: [],
    date, folder: "INBOX", snippet: `snip-${id}`,
    unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date ?? "2026-08-08T09:00:00.000Z",
  };
}

/** Two rows, dated days apart, so the relative stamps differ from each other and from the exact ones. */
const OLDER = msg("a", "2026-08-01T09:12:00.000Z");
const NEWER = msg("b", "2026-08-08T08:04:00.000Z");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Every row press the view reported — the cursor move a stamp press must NOT cause. */
let selected: string[] = [];

/**
 * The Ohbox, driven the way the shell drives it: the absolute-time flag is held OUTSIDE the view
 * and handed back down, because that is the seam under test. A flag frozen at mount would prove
 * the rows can RENDER two forms and nothing about the press that changes which.
 */
async function render(rows: Record<string, unknown>[]): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const base = {
    demo: false, settled: true, owed: false,
    older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
    resurfacedRows: [], newForYou: rows, previouslySeen: [], replyDone: null,
    threadParticipants: () => [], threadSubject: () => null,
    tags: [], now: NOW,
    onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id], onMarkSeen: () => {},
    bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
    doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
  };
  function Wrapper(): React.ReactElement {
    const [abs, setAbs] = React.useState(false);
    const [sel, setSel] = React.useState<string | null>(null);
    return h(OhboxView as never, {
      ...base,
      absoluteTime: abs,
      onToggleTime: () => setAbs((v) => !v),
      selectedId: sel,
      onSelect: (id: string) => { selected.push(id); setSel(id); },
    } as never);
  }
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: NOW,
    children: h(KeymapProvider as never, { children: h(Wrapper) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

const stampOf = (id: string): HTMLElement =>
  host!.querySelector<HTMLElement>(`.row[data-id="${id}"] .t`)!;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  selected = [];
});

describe("a list row's date names the exact instant on hover", () => {
  it("shows the relative stamp and carries the absolute one as its title", async () => {
    const { displayTime, fullDateTime } = await import("../app/shell/format.js");
    const rel = displayTime(OLDER as never, NOW);
    const abs = fullDateTime(OLDER as never);
    expect(rel, "the fixture's two forms must actually differ").not.toBe(abs);

    await render([OLDER, NEWER]);
    const stamp = stampOf("a");
    expect(stamp.textContent, "the row is not showing the relative stamp").toBe(rel);
    // THE GUARD. Drop `timeTitle` from `rowStamp` (or from the row) and hovering a date says
    // nothing — which is the whole report this answers.
    expect(stamp.getAttribute("title"), "hovering the date does not name the exact instant").toBe(abs);
  });

  it("marks the stamp as pressable ONLY because the list wired a flip", async () => {
    await render([OLDER]);
    const stamp = stampOf("a");
    expect(stamp.hasAttribute("data-stamp"), "the stamp is not a hit target for the row's press").toBe(true);
    expect(stamp.classList.contains("tog"), "the stamp does not wear the pressable styling").toBe(true);
    // The row is a `<button>`: whatever the stamp is, it is not a second control inside one.
    // See `MessageRow.onToggleTime` — the parser would hoist a nested button clean out of the row.
    expect(stamp.tagName).toBe("SPAN");
    expect(host!.querySelector(".row button"), "a control was nested inside the row button").toBeNull();
  });
});

describe("pressing one date flips every date in the list", () => {
  it("flips the pressed row AND its neighbours, and swaps each title to the other form", async () => {
    const { displayTime, fullDateTime } = await import("../app/shell/format.js");
    await render([OLDER, NEWER]);

    await act(async () => { stampOf("a").click(); });

    for (const m of [OLDER, NEWER]) {
      const stamp = stampOf(m.id as string);
      // THE GUARD. Give the flag to each ROW instead of to the shell — or forget to thread
      // `absoluteTime` into a view — and the neighbour stays on the relative form here.
      expect(stamp.textContent, `row ${m.id} did not flip to the exact date`).toBe(
        fullDateTime(m as never),
      );
      expect(stamp.getAttribute("title"), `row ${m.id}'s hover no longer offers the other form`).toBe(
        displayTime(m as never, NOW),
      );
    }

    // …and pressing again puts the whole list back.
    await act(async () => { stampOf("b").click(); });
    expect(stampOf("a").textContent).toBe(displayTime(OLDER as never, NOW));
    expect(stampOf("b").textContent).toBe(displayTime(NEWER as never, NOW));
  });

  it("does NOT move the cursor — the press is a flip, not an open", async () => {
    await render([OLDER, NEWER]);
    await act(async () => { stampOf("a").click(); });
    // THE GUARD. Let the press fall through to the row's own handler (drop the `data-stamp` hit
    // test) and reading the exact date silently opens whatever row it was read on.
    expect(selected, "pressing the date opened the message").toEqual([]);
    expect(host!.querySelector(".row.sel"), "pressing the date selected a row").toBeNull();

    // The rest of the row is untouched: a press anywhere else still opens it.
    await act(async () => { host!.querySelector<HTMLElement>(`.row[data-id="b"] .subj`)!.click(); });
    expect(selected).toEqual(["b"]);
  });
});

describe("rowStamp — the two forms, and when there is only one", () => {
  it("names the other form whichever one is displayed", async () => {
    const { displayTime, fullDateTime, rowStamp } = await import("../app/shell/format.js");
    const rel = displayTime(OLDER as never, NOW);
    const abs = fullDateTime(OLDER as never);
    const toggle = () => {};

    // THREE forms, not two: `timeSpoken` is the ABSOLUTE one either way round, because a row's
    // own label replaces everything inside it and a spoken "Sat" cannot say which Saturday.
    const resting = rowStamp(OLDER as never, NOW, false, toggle);
    expect(resting).toEqual({ time: rel, timeTitle: abs, timeSpoken: abs, onToggleTime: toggle });

    const flipped = rowStamp(OLDER as never, NOW, true, toggle);
    expect(flipped).toEqual({ time: abs, timeTitle: rel, timeSpoken: abs, onToggleTime: toggle });
  });

  it("a message with no Date: header gets no title and NO flip — one form is not a choice", async () => {
    const { rowStamp } = await import("../app/shell/format.js");
    // Spam and scripts routinely omit the header; `fullDateTime` answers "" because there is no
    // instant to name. Offering to reveal an exact date that does not exist is the dead
    // affordance this product removes wherever it finds one.
    const stamp = rowStamp(msg("c", null) as never, NOW, false, () => {});
    expect(stamp.timeTitle, "an undated row offered an exact instant it does not have").toBeUndefined();
    expect(stamp.onToggleTime, "an undated row's date is pressable").toBeUndefined();
  });

  it("an undated row renders no stamp element at all, flip wired or not", async () => {
    await render([msg("c", null)]);
    expect(host!.querySelector(`.row[data-id="c"] .t`), "an undated row rendered an empty stamp").toBeNull();
  });
});
