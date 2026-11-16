/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";

/**
 * WHERE A LIVE ARRIVAL ENTERS "NEW FOR YOU".
 *
 * The reported defect: a message arriving by sync after mount landed at the BOTTOM of "New for
 * you". The selector (`ohboxView`) hands the group down newest-first, but the view's session
 * placement APPENDED any id it was not already holding, so only the ids present at mount were
 * ever in date order — every genuinely new arrival filed below mail that had been sitting on
 * screen since the mount, for the whole session.
 *
 * The rule now is a STABLE MERGE (`reconcile` in `OhboxView.tsx`): a fresh id inserts at the
 * position the selector's own order dictates relative to the kept rows — before the first kept
 * row the selector ranks older — and the kept rows never reorder among themselves. Three
 * consequences, each pinned here:
 *
 *   · genuinely new mail enters at the TOP, above everything already on screen;
 *   · an OLD unread arriving late — a mirror backfill, or old mail marked unread here or on
 *     another client — files below genuinely newer rows, never above them;
 *   · the rows the reader is looking at keep their order among themselves; an insertion is an
 *     insertion, not a re-sort.
 *
 * An explicit mark-unread here files exactly like one from another client (as reported; it
 * used to lead New for the session, and the pressing surface disagreed with every other);
 * `ohbox-mark-unread.test.tsx` pins it, and here its interplay with arrivals in the same render
 * and on a later sync.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Desktop split width — the reading column exists and the mobile-only paths stay away. */
function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; threadId?: string; date?: string }
function msg(m: Row): Record<string, unknown> {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: m.threadId ?? null, messageIdHeader: null,
    subject: m.id, from: { name: m.id, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: m.date ?? "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: "s", unread: m.unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const marked: Array<{ ids: string[]; unread: boolean }> = [];

interface Props { newForYou: Row[]; previouslySeen?: Row[]; selectedId?: string | null }

async function render(props: Props): Promise<void> {
  const OhboxView = await (await import("./_today.js")).prepareToday();
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: h(OhboxView as never, {
    owed: false,
      demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      // Always handed down the way `ohboxView` orders the group: date desc.
      newForYou: props.newForYou.map(msg),
      previouslySeen: (props.previouslySeen ?? []).map(msg),
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      selectedId: props.selectedId ?? null, onSelect: () => {}, onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: (ids: string[], unread: boolean) => { marked.push({ ids, unread }); },
      bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
    } as never) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

/** Press a chord the way the registry's dispatcher sees it. */
async function press(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

/** The data-ids of the rows in the group with this aria-label ("New", "Earlier"). */
function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll("[role=option][data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null; marked.length = 0;
});

const at = (hour: number): string => `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`;

describe("where a live arrival enters New for you", () => {
  it("a genuinely newer arrival enters at the TOP, above rows already on screen", async () => {
    /* THE HEADLINE GUARD — the reported defect verbatim. Put the append back in `reconcile`
       (push fresh ids onto the end of `keep` instead of merging) and this goes red with the
       arrival at the bottom: ["b", "c", "a"]. */
    setViewport();
    await render({ newForYou: [{ id: "b", unread: true, date: at(10) }, { id: "c", unread: true, date: at(9) }] });
    expect(idsInGroup("New")).toEqual(["b", "c"]);

    // The sync delta: `a` (newer than everything on screen) arrives; the selector hands the
    // group down newest-first, exactly as `ohboxView`'s `byDateDesc` does.
    await render({
      newForYou: [
        { id: "a", unread: true, date: at(11) },
        { id: "b", unread: true, date: at(10) },
        { id: "c", unread: true, date: at(9) },
      ],
    });
    expect(idsInGroup("New")).toEqual(["a", "b", "c"]);
  });

  it("an OLD unread arriving late files at the bottom — a backfill never jumps newer mail", async () => {
    /* The counter-mutation guard: the cheap "fix" for the defect above is to PREPEND every
       fresh id, which puts a mirror backfill — or old mail marked unread in Outlook, a plain
       re-partition with no promote anywhere — above mail that genuinely just arrived. The
       honest rule is the date slot, and for an old message the date slot is the bottom. */
    setViewport();
    await render({ newForYou: [{ id: "a", unread: true, date: at(11) }, { id: "b", unread: true, date: at(10) }] });

    await render({
      newForYou: [
        { id: "a", unread: true, date: at(11) },
        { id: "b", unread: true, date: at(10) },
        { id: "old", unread: true, date: at(8) },
      ],
    });
    expect(idsInGroup("New")).toEqual(["a", "b", "old"]);
  });

  it("a mid-dated arrival inserts BETWEEN kept rows, which never reorder among themselves", async () => {
    /* The merge is an insertion, not a re-sort: `a` and `b` hold their order, and `m` lands in
       the slot its date earns. Under the append this was ["a", "b", "m"]. */
    setViewport();
    await render({ newForYou: [{ id: "a", unread: true, date: at(11) }, { id: "b", unread: true, date: at(9) }] });

    await render({
      newForYou: [
        { id: "a", unread: true, date: at(11) },
        { id: "m", unread: true, date: at(10) },
        { id: "b", unread: true, date: at(9) },
      ],
    });
    expect(idsInGroup("New")).toEqual(["a", "m", "b"]);
  });

  it("two arrivals in one sync keep the selector's order among themselves", async () => {
    /* One drain can deliver several messages in one re-render. They insert as a block in the
       selector's own order — newest leading — not reversed and not interleaved wrongly. */
    setViewport();
    await render({ newForYou: [{ id: "c", unread: true, date: at(9) }] });

    await render({
      newForYou: [
        { id: "a", unread: true, date: at(11) },
        { id: "b", unread: true, date: at(10) },
        { id: "c", unread: true, date: at(9) },
      ],
    });
    expect(idsInGroup("New")).toEqual(["a", "b", "c"]);
  });

  it("read → slide out → unread from another client: the row re-enters at its date slot", async () => {
    /* The round trip the ruling's parenthetical allows to move rows ("unless they got read /
       unread again"). Reading `a` slides it under "Earlier" and SPENDS its session slot; when
       another client flips it back, it arrives as a plain re-partition — no promote — and the
       merge files it where its date says: above `b`, because `a` is the newer message. Under
       the append it re-entered at the bottom. */
    vi.useFakeTimers();
    try {
      setViewport();
      await render({ newForYou: [{ id: "a", unread: true, date: at(11) }, { id: "b", unread: true, date: at(10) }] });

      // The shell's re-partition on a read, then the slide runs out.
      await render({ newForYou: [{ id: "b", unread: true, date: at(10) }], previouslySeen: [{ id: "a", unread: false, date: at(11) }] });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(idsInGroup("New")).toEqual(["b"]);
      expect(idsInGroup("Earlier")).toEqual(["a"]);

      // Outlook marks it unread: a plain delta, nothing pressed in this app.
      await render({ newForYou: [{ id: "a", unread: true, date: at(11) }, { id: "b", unread: true, date: at(10) }] });
      expect(idsInGroup("New")).toEqual(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a row mid-slide to Earlier anchors no insertion — the arrival files against ranked rows", async () => {
    /* A kept id the selector no longer files under New (a read row holding its slot on the
       slide's 280 ms lease) has NO rank and NO opinion: it is skipped, never treated as older
       or newer. A fresh arrival in the same delta files against the ranked rows around it —
       below the sliding row for the moment, at the top once the slide lands. */
    vi.useFakeTimers();
    try {
      setViewport();
      await render({ newForYou: [{ id: "a", unread: true, date: at(11) }, { id: "b", unread: true, date: at(10) }] });
      expect(idsInGroup("New")).toEqual(["a", "b"]);

      // One delta carries both: `a` was read (slide starts, slot leased) and `f` arrived.
      await render({
        newForYou: [{ id: "f", unread: true, date: at(12) }, { id: "b", unread: true, date: at(10) }],
        previouslySeen: [{ id: "a", unread: false, date: at(11) }],
      });
      expect(idsInGroup("New")).toEqual(["a", "f", "b"]);

      // The slide lands; the selector's answer stands and the arrival leads.
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(idsInGroup("New")).toEqual(["f", "b"]);
      expect(idsInGroup("Earlier")).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an explicit unread and a newer arrival in the SAME render: each files at its arrival place", async () => {
    /* `u` decides that the row is unread, not where it stands: it merges by its date like the
       arrival beside it, so this surface and every surface that received the flip agree. */
    setViewport();
    await render({
      newForYou: [{ id: "n1", unread: true, date: at(10) }],
      previouslySeen: [{ id: "old", unread: false, date: at(8) }],
      selectedId: "old",
    });
    await press("u");
    expect(marked).toEqual([{ ids: ["old"], unread: true }]);

    // The flip and a fresh arrival land in one delta, selector order: f(11), n1(10), old(8).
    await render({
      newForYou: [
        { id: "f", unread: true, date: at(11) },
        { id: "n1", unread: true, date: at(10) },
        { id: "old", unread: true, date: at(8) },
      ],
      previouslySeen: [],
      selectedId: "old",
    });
    expect(idsInGroup("New")).toEqual(["f", "n1", "old"]);
  });

  it("a still-newer message on a LATER sync files above a row marked unread earlier", async () => {
    /* Once placed, the row is a kept row like any other, and new mail is always at the top — the
       owner's rule, and exactly how any inbox treats mail that arrives after a mark-unread. */
    setViewport();
    await render({
      newForYou: [{ id: "n1", unread: true, date: at(10) }],
      previouslySeen: [{ id: "old", unread: false, date: at(8) }],
      selectedId: "old",
    });
    await press("u");
    await render({
      newForYou: [{ id: "n1", unread: true, date: at(10) }, { id: "old", unread: true, date: at(8) }],
      previouslySeen: [],
      selectedId: "old",
    });
    expect(idsInGroup("New")).toEqual(["n1", "old"]);

    // The NEXT sync delivers `f`, newer than everything — it goes above both.
    await render({
      newForYou: [
        { id: "f", unread: true, date: at(11) },
        { id: "n1", unread: true, date: at(10) },
        { id: "old", unread: true, date: at(8) },
      ],
      previouslySeen: [],
      selectedId: "old",
    });
    expect(idsInGroup("New")).toEqual(["f", "n1", "old"]);
  });
});
