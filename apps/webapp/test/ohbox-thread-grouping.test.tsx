/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * CONVERSATION GROUPING IN THE OHBOX LIST.
 *
 * Five unread replies in one conversation rendered five rows in "New for you" — one row per
 * unread message, by design, with `threadCount` populated only by the demo fixtures. These
 * guards pin the fold the view draws (the engine's `foldOhboxRows`, `ohbox-rows.ts`):
 *
 *   · five unread of one thread render ONE row (mutate the grouping away → five rows, red);
 *   · rows of distinct threads (and threadless rows) are untouched;
 *   · a new unread reply SURFACES its conversation's row to the top of New (the session merge
 *     places the arrival, the fold keys the row at it) with no second row; an OLD member
 *     arriving late merges in below and moves the row nowhere;
 *   · opening the row opens the conversation at its LATEST UNREAD message, with no read-state
 *     dispatch beyond what opening that message already does;
 *   · j/k traverse ROWS (conversations), never a folded member;
 *   · a conversation is ONE row ACROSS sections (owner 2026-09-28) — a thread with unread mail
 *     stands in New with its read history on the same row.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `mobile: true` makes every width query match, so a tap IS the open (the view's own rule). */
function setViewport(mobile = false): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; threadId?: string | null; date?: string; folder?: string }
function msg(m: Row): Record<string, unknown> {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: m.threadId ?? null, messageIdHeader: null,
    subject: `subj-${m.id}`, from: { name: `sender-${m.id}`, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: m.date ?? "2026-08-02T09:00:00.000Z", folder: m.folder ?? "INBOX", snippet: `snip-${m.id}`,
    unread: m.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const marked: Array<{ ids: string[]; unread: boolean }> = [];
const selected: string[] = [];
const opened: string[] = [];

interface Props { newForYou: Row[]; previouslySeen?: Row[] }

function baseProps(props: Props): Record<string, unknown> {
  return {
    demo: false, settled: true,
    older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
    resurfacedRows: [],
    newForYou: props.newForYou.map(msg),
    previouslySeen: (props.previouslySeen ?? []).map(msg),
    replyDone: null,
    // The conversation's stored (server-cleaned) name, as the shell binds it from the mirror.
    threadSubject: (threadId: string) => (threadId === "T" ? "Webshop" : null),
    tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
    onEnterReader: (id: string) => { opened.push(id); }, readerId: null, readSetFor: (id: string) => [id],
    onMarkSeen: (ids: string[], unread: boolean) => { marked.push({ ids, unread }); },
    bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
    doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
  };
}

/**
 * Mounts the view with a LIVE selection: `onSelect` re-renders with the new `selectedId`, the
 * way the shell does — which is what lets a click's select-then-open pair and a j/k walk be
 * exercised at all. Every `onSelect` is also logged.
 *
 * THE WRAPPER IS MODULE-LEVEL, AND THAT IS LOAD-BEARING. It used to be declared inside
 * `render()`, which gave it a fresh function identity per call — a different component TYPE to
 * React — so a second `render()` in one test silently UNMOUNTED and remounted the view, resetting
 * its session order. Every "prop change" was a fresh mount, and a test that believed it was
 * driving the view through a sync delta was actually asserting over the selector's raw order.
 * The props travel through a module variable so the component identity never changes.
 */
let viewProps: Record<string, unknown> = {};
let OhboxViewC: React.ComponentType<never> | null = null;
function Wrapper(): React.ReactElement {
  const [sel, setSel] = React.useState<string | null>(null);
  return h(OhboxViewC as never, {
    ...viewProps,
    selectedId: sel,
    onSelect: (id: string) => { selected.push(id); setSel(id); },
  } as never);
}

async function render(props: Props): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  OhboxViewC = OhboxView as never;
  viewProps = baseProps(props);
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: h(Wrapper) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

/** The data-ids of the rows in the group with this aria-label ("New", "Earlier"). */
function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll(".row[data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

const rowEl = (id: string): HTMLElement =>
  host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`)!;

const click = async (id: string): Promise<void> => {
  await act(async () => {
    rowEl(id).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
};

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null;
  marked.length = 0; selected.length = 0; opened.length = 0;
});

const at = (hour: number): string => `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`;

describe("Ohbox conversation grouping", () => {
  it("five unread of one thread render ONE row — latest unread leads, thread name, member count", async () => {
    setViewport();
    await render({
      newForYou: [5, 4, 3, 2, 1].map((n) => ({ id: `t${n}`, unread: true, threadId: "T", date: at(8 + n) })),
    });

    // One row, not five — the reported five "Webshop" rows. data-id is the LATEST unread (t5).
    expect(idsInGroup("New")).toEqual(["t5"]);

    const row = rowEl("t5");
    // The conversation's stored name (server-cleaned), not any member's raw subject.
    expect(row.textContent).toContain("Webshop");
    expect(row.textContent).not.toContain("subj-t5");
    // The member-count affordance, in the row language the demo threads already use.
    expect(row.textContent).toContain("⤷ 5");
    // The latest message's snippet rides the row.
    expect(row.textContent).toContain("snip-t5");
    // Opened and stamped by one message: no stamp of its own.
    expect(row.dataset.stampId).toBeUndefined();
  });

  it("mixed threads are untouched — distinct threads and threadless rows keep one row each", async () => {
    setViewport();
    await render({
      newForYou: [
        { id: "a", unread: true, threadId: "X", date: at(12) },
        { id: "b", unread: true, threadId: null, date: at(11) },
        { id: "c", unread: true, threadId: "Y", date: at(10) },
      ],
    });
    expect(idsInGroup("New")).toEqual(["a", "b", "c"]);
    // Singletons render exactly as before: own subject, no count badge.
    expect(rowEl("b").textContent).toContain("subj-b");
    expect(rowEl("b").textContent).not.toContain("⤷");
  });

  it("a new unread reply SURFACES its conversation's row to the top — one row, no duplicate", async () => {
    setViewport();
    await render({
      newForYou: [
        { id: "solo", unread: true, threadId: null, date: at(10) },
        { id: "t1", unread: true, threadId: "T", date: at(9) },
      ],
    });
    expect(idsInGroup("New")).toEqual(["solo", "t1"]);

    // The arrival, as the selector would hand it down (newest first). Session placement merges
    // the new reply in at the slot its date earns — the top — and the fold keys the conversation's
    // row at the first member it meets, so the whole row surfaces rather than a second one
    // appearing or the count bumping at the bottom of the list.
    await render({
      newForYou: [
        { id: "t2", unread: true, threadId: "T", date: at(11) },
        { id: "solo", unread: true, threadId: null, date: at(10) },
        { id: "t1", unread: true, threadId: "T", date: at(9) },
      ],
    });

    // Still two rows — the conversation moved to the top, `solo` kept its own slot below, and
    // no duplicate appeared. The row leads with the arrival (t2), its snippet and bumped count.
    expect(idsInGroup("New")).toEqual(["t2", "solo"]);
    expect(rowEl("t2").textContent).toContain("snip-t2");
    expect(rowEl("t2").textContent).toContain("⤷ 2");
  });

  it("an OLD member arriving late merges in BELOW — the conversation's row does not move", async () => {
    // The backfill half of the fold interplay: a late-delivered old member (a mirror backfill)
    // merges below the row's existing members, so the row keeps the highest slot any member
    // holds — the count and snippet update, the row stays put, and nothing jumps the queue.
    setViewport();
    await render({
      newForYou: [
        { id: "solo", unread: true, threadId: null, date: at(10) },
        { id: "t2", unread: true, threadId: "T", date: at(9) },
      ],
    });
    expect(idsInGroup("New")).toEqual(["solo", "t2"]);

    await render({
      newForYou: [
        { id: "solo", unread: true, threadId: null, date: at(10) },
        { id: "t2", unread: true, threadId: "T", date: at(9) },
        { id: "t1", unread: true, threadId: "T", date: at(8) },
      ],
    });
    expect(idsInGroup("New")).toEqual(["solo", "t2"]);
    expect(rowEl("t2").textContent).toContain("⤷ 2");
  });

  it("opening the row opens the conversation at the LATEST UNREAD, with no extra read writes", async () => {
    // Mobile width: a tap IS the open — the shortest path to the open contract.
    setViewport(true);
    await render({
      newForYou: [
        { id: "t3", unread: true, threadId: "T", date: at(11) },
        { id: "t2", unread: true, threadId: "T", date: at(10) },
        { id: "t1", unread: true, threadId: "T", date: at(9) },
      ],
    });
    expect(idsInGroup("New")).toEqual(["t3"]);

    await click("t3");
    // The open names the latest unread member — the reader lands on it, per the thread-open
    // contract — and writes nothing by itself: what turns read is the reader's thread-read rule
    // (the sheet, at this width), and the folded members are never bulk-marked.
    expect(opened).toEqual(["t3"]);
    expect(selected).toContain("t3");
    expect(marked.map((m) => m.ids)).toEqual([]);
  });

  it("j/k traverse conversations — a folded member is never a keyboard stop", async () => {
    setViewport();
    await render({
      newForYou: [
        { id: "a", unread: true, threadId: null, date: at(12) },
        { id: "t2", unread: true, threadId: "T", date: at(11) },
        { id: "t1", unread: true, threadId: "T", date: at(10) },
        { id: "b", unread: true, threadId: null, date: at(9) },
      ],
    });
    expect(idsInGroup("New")).toEqual(["a", "t2", "b"]);

    await key("j"); // → a
    await key("j"); // → the conversation, at its latest unread — never t1
    await key("j"); // → b
    await key("k"); // ← back to the conversation
    expect(selected).toEqual(["a", "t2", "b", "t2"]);
  });

  it("a conversation is ONE row across sections — the read history rides its New row", async () => {
    /* Lists split by message, the shape the selector used to hand down and a session order can
       still hold mid-slide: the fold's first claim gives the conversation to New and the Earlier
       members join that row. Key the fold by section and this reads a second row under Earlier. */
    setViewport();
    await render({
      newForYou: [
        { id: "n2", unread: true, threadId: "T", date: at(12) },
        { id: "n1", unread: true, threadId: "T", date: at(11) },
      ],
      previouslySeen: [
        { id: "p2", unread: false, threadId: "T", date: at(10) },
        { id: "p1", unread: false, threadId: "T", date: at(9) },
      ],
    });
    expect(idsInGroup("New")).toEqual(["n2"]);
    expect(idsInGroup("Earlier")).toEqual([]);
    expect(rowEl("n2").dataset.ids?.split(" ").sort()).toEqual(["n1", "n2", "p1", "p2"]);
    expect(rowEl("n2").textContent).toContain("⤷ 4");
  });

  /** An answered row opens at the letter and is stamped with its newest member, our reply; the stamp dates the latter. */
  it("names the stamped member when it is not the one the row opens", async () => {
    setViewport();
    await render({
      newForYou: [{ id: "n1", unread: true, threadId: "T", date: at(9) }],
      previouslySeen: [{ id: "r2", unread: false, threadId: "T", date: at(12), folder: "Sent" }],
    });
    expect(idsInGroup("New")).toEqual(["n1"]);
    expect(rowEl("n1").dataset.stampId).toBe("r2");
    expect(rowEl("n1").textContent).toContain("snip-r2");
  });

  /**
   * ═══ FOLDING MAY HIDE A MESSAGE BEHIND A ROW. IT MAY NEVER LOSE ONE ══════════════════════
   *
   * Grouping is the one step in this list that renders FEWER rows than it is given messages, so
   * it is the one step that can make mail unreachable — and it would do it silently, because a
   * dropped member costs no error, no gap and no wrong count anywhere on screen. The row simply
   * speaks for four messages while five went in.
   *
   * A live journey went red believing exactly this had happened: a conversation member present
   * in the mirror was not a rendered row. It was not lost — it was folded into a row keyed on
   * the conversation's newest message, which rendered with `⤷ 3`, and opening that row showed
   * all three. That is the design. But "the member is behind the row" and "the member is gone"
   * look identical from outside, so the difference is asserted here as a PARTITION: the members
   * of the groups, concatenated, are exactly the input — every message once, none invented,
   * none dropped — and every group's `openTarget` is one of its own members, so the row a
   * reader clicks always names a message that exists.
   *
   * A property over a shape with every case in it (a long thread, a short one, singletons,
   * threadless rows, interleaved) rather than one hand-picked example, because the failure this
   * is guarding against is a member falling out of a branch nobody thought to write a case for.
   *
   * MUTATION-WATCHED: dropping the `claim.members.push(m)` in `foldOhboxRows` — the one line that
   * puts a non-leading member into its row — turns this red naming the missing ids, while every
   * behavioural test above stays green (they all read the LEADING member). The input is spread
   * over all four sections, so the partition is asked across them.
   */
  it("the fold is a partition — no member is dropped, duplicated or invented", async () => {
    const { foldOhboxRows } = await import("@ohmail/client-engine");
    const rows: Row[] = [
      { id: "a1", unread: true, threadId: "A", date: at(21) },
      { id: "b1", unread: false, threadId: null, date: at(20) },
      { id: "a2", unread: true, threadId: "A", date: at(19) },
      { id: "c1", unread: false, threadId: "C", date: at(18) },
      { id: "a3", unread: false, threadId: "A", date: at(17) },
      { id: "d1", unread: true, threadId: null, date: at(16) },
      { id: "c2", unread: true, threadId: "C", date: at(15) },
      { id: "a4", unread: false, threadId: "A", date: at(14) },
      { id: "e1", unread: false, threadId: "E", date: at(13) },
      { id: "a5", unread: true, threadId: "A", date: at(12) },
    ];
    const input = rows.map(msg) as never[];
    const byFour = (k: number) => input.filter((_, i) => i % 4 === k);
    const folded = foldOhboxRows(
      { resurfaced: byFour(0), new: byFour(1), earlier: byFour(2), older: byFour(3) }, [],
    );
    const groups = [...folded.resurfaced, ...folded.new, ...folded.earlier, ...folded.older];

    // Fewer rows than messages — otherwise this file is guarding nothing.
    expect(groups.length, "nothing folded, so the partition is vacuous").toBeLessThan(rows.length);

    const members = groups.flatMap((g) => g.members.map((m) => m.id));
    expect(
      [...members].sort(),
      `folding changed the message set: ${rows.length} in, ${members.length} out`,
    ).toEqual(rows.map((r) => r.id).sort());
    expect(new Set(members).size, "a message is drawn by two different rows").toBe(rows.length);

    for (const g of groups) {
      expect(
        g.members.map((m) => m.id),
        `the row keyed ${g.key} opens ${g.openTarget.id}, which is not one of its own members`,
      ).toContain(g.openTarget.id);
      expect(g.members.map((m) => m.id)).toContain(g.face.id);
    }
  });
});
