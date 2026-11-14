/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import {
  FEED_SINCE_ID,
  MemoryMirrorStore,
  conversationKeyOf,
  feedPartition,
  ohboxRows,
  ohboxView,
  presentsUnread,
  type EntityReader,
  type OhmailEngine,
  type SyncChange,
  resurfacedThreads,
} from "@ohmail/client-engine";
import { liveOhbox, liveReads } from "../../mobile/src/state/live";
import { threadedEngine } from "../../../packages/client-engine/test/fixtures/threaded-demo.js";
import { DEMO_NOW } from "@ohmail/testing/adapter";
import { engineOver, mountSeat, seatRows, settleSeat, unmountSeat } from "./_ohbox-1-seat.js";
import { readSlotSays } from "./ohbox/_finders.js";
import { NOW, VIEW, d, mirrorOf, msg } from "./_ohbox-1-convergence.js";
import messages from "../messages/en.json";

/**
 * ═══ ONE MIRROR, EVERY SURFACE — THE SAME LISTS, THE SAME ORDER, THE SAME NUMBERS ═════════
 *
 * Reported by the account's owner as one screenshot: their desktop app and this app open on the
 * SAME account, side by side, disagreeing. The web drew a "Resurfaced" group the desktop did
 * not; "Earlier" was in a different order on each and held different mail; the rail said
 * one pair of pile counts on one and a count beside a dash on the other. Their words: "we did so
 * many loops on consistency and immediate sync to a snappy app, but this is still inconsistent."
 *
 * Most of that was a stale binary (the desktop release predates the Ohbox's own-sent fix), and a
 * stale binary is not something a test can hold. What a test CAN hold — and what this file is —
 * is the property that makes the answer to the next such report "then it is the build, not the
 * derivation": **given one mirror state, every surface's lists, order and counts are identical,
 * because they are the same derivation and not merely two that agree today.**
 *
 * The two surfaces driven here are the real ones, not models of them:
 *
 *  · the SHELL — `apps/webapp/app/views/OhboxView.tsx`, mounted, and read back out of the DOM.
 *    The desktop bundles this exact file over the vite aliases (`apps/desktop/vite.config.ts`),
 *    so "the shell" here is the browser AND the desktop app;
 *  · the PHONE — `apps/mobile/src/state/live.ts`, the one module the mail screens render from.
 *    It is a separate projection over the same selectors, which makes it the place a second
 *    derivation can actually appear — and twice it had (`liveReads.newCount` counted every
 *    unread row in the stream while the rail counted the fresh side of the line).
 *
 * The mirror below is a reported shape, not a tidy fixture: a resurfaced message that is
 * genuinely READ (theirs was — `last_read_at` five days before the pin), a still-scheduled one,
 * unread arrivals, read mail with real stamps, and a Reads pile that is entirely `\Seen` under a
 * waterline thirteen rows stale.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* The mirror's letters, the clock and the phone's view: `_ohbox-1-convergence.ts`. */
let seq = 0;

/**
 * THE OWNER'S OHBOX, as the server held it at 08:01 on the morning of the report.
 *
 * `pinned` is the "AW: Scam……" row: resurfaced two minutes earlier by an explicit
 * "Resurface now", and READ five days before that — which is the whole point of it being here.
 * Under the read state it stores it is a grey row; under the ruling it is a bold one, on every
 * surface, until Done or a reply releases it.
 */
const OHBOX_ROWS = (): EngineMessage[] => [
  msg({ id: "pinned", date: d(3), unread: false, lastReadAt: d(1), triage: { state: "resurfaced" } }),
  msg({ id: "scheduled", date: d(5), unread: false, lastReadAt: d(4), triage: { state: "bubbled_up" } }),
  msg({ id: "arrival-a", date: d(0), unread: true }),
  msg({ id: "arrival-b", date: d(2), unread: true }),
  msg({ id: "read-recent", date: d(6), unread: false, lastReadAt: d(0) }),
  msg({ id: "read-old", date: d(1), unread: false, lastReadAt: d(5) }),
  msg({ id: "own-sent", date: d(4), unread: false, folder: "Sent" }),
];

/**
 * THE SAME MIRROR WITH A CONVERSATION IN IT. `OHBOX_ROWS` is thread-less throughout, so a surface
 * drawing one row per MESSAGE and one drawing one row per CONVERSATION agree on it by accident —
 * the guard below would pass over the whole of FEAT-020. Three pinned members of one thread, and
 * a reply that arrived after the pin, make the two answers different.
 */
const THREADED_PIN = (): EngineMessage[] => [
  msg({ id: "t-1", date: d(9), unread: false, lastReadAt: d(8), threadId: "T", triage: { state: "resurfaced", setAt: d(4) } }),
  msg({ id: "t-2", date: d(8), unread: false, lastReadAt: d(8), threadId: "T", triage: { state: "resurfaced", setAt: d(4) } }),
  msg({ id: "t-reply", date: d(1), unread: true, threadId: "T" }),
  msg({ id: "arrival-a", date: d(0), unread: true }),
];

/* ── the shell, mounted, read back out of the DOM ──────────────────────────────────────── */


interface ShellRow { id: string; unread: boolean; group: string }

/**
 * Mount THE OHBOX's SEAT over the mirror's rows and report what it drew: each row's id, whether it is drawn unread,
 * and which group it sits under (its listbox's name). Nothing here models the list: it is the shipped seat over the
 * mail ground, as every host mounts it (`_ohbox-1-seat.tsx`; today's `OhboxView` mounted through `ohbox/_today`).
 */
async function shellRows(reader: EntityReader): Promise<ShellRow[]> {
  /* THE FILE's WORLD's CLOCK: the seat stands over the ground's partition, whose cutline is read from now (today's
     view was handed its lists cut already); the mirror's letters are of the morning of `NOW`. Only the date is set:
     every timer runs. */
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mountSeat(engineOver(reader).engine, { own: ["own-sent@example.com"] });
  await settleSeat();
  await settleSeat();
  return seatRows().map(({ id, unread, group }) => ({ id, unread, group }));
}

afterEach(() => {
  unmountSeat();
  vi.useRealTimers();
});

beforeEach(() => {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    })) as unknown as (q: string) => MediaQueryList;
  vi.stubGlobal("scrollTo", () => {});
});

/* ── the guards ────────────────────────────────────────────────────────────────────────── */

describe("one mirror, two surfaces — the same lists in the same order", () => {
  it("the phone's Ohbox groups are the shell's, id for id, position for position", async () => {
    const reader = await mirrorOf(OHBOX_ROWS());
    const shell = ohboxView(reader);
    const phone = liveOhbox(reader, VIEW);

    // Not `toContain`, not set equality: ORDER is half of what was reported, so the
    // comparison is positional. A phone that re-sorted "Earlier" by date — which is what the
    // stale desktop build was doing — fails here even though it holds the same rows.
    /* MOVED DELIBERATELY (FEAT-020): the Resurfaced block is one row per CONVERSATION on both
       surfaces now, so the phone's list is compared to the ENGINE'S ROWS. `shell.resurfaced` is
       still the per-message pin and is asserted beside it — the two answer different questions
       and a surface reading the wrong one is what this file exists to catch. */
    expect(phone.resurfaced.map((m) => m.id))
      .toEqual(resurfacedThreads(reader).map((r) => r.openTarget.id));
    expect(shell.resurfaced.map((m) => m.id)).toEqual(["pinned"]);
    expect(phone.fresh.map((m) => m.id)).toEqual(shell.newForYou.map((m) => m.id));
    expect(phone.seen.map((m) => m.id)).toEqual(shell.previouslySeen.map((m) => m.id));
  });

  /**
   * CONTROL (g) — the phone and the shell draw ONE row for one conversation, from one derivation.
   *
   * MUTATION WATCHED: have `liveOhbox` map `box.resurfaced` again and the phone draws two rows
   * where the shell draws one; key the view's fold by message id and the shell draws two where
   * the phone draws one. Either way the surfaces disagree about how many conversations are back,
   * which is the class of defect this file exists for.
   */
  it("a threaded pin is ONE row on both surfaces, opening the same message", async () => {
    const reader = await mirrorOf(THREADED_PIN());
    const rows = resurfacedThreads(reader);
    expect(rows).toHaveLength(1);

    const phone = liveOhbox(reader, VIEW);
    const drawn = await shellRows(reader);
    const shellPinned = drawn.filter((r) => r.group === "Resurfaced").map((r) => r.id);

    /* `t-reply`, not `t-1`: the row opens on its NEWEST member, and `d(1)` is four weeks after
       `d(9)`. That is the feature — the conversation came back and somebody wrote in it, so the
       thing to read is what they wrote, not the message that was pinned. */
    expect(phone.resurfaced.map((m) => m.id)).toEqual(["t-reply"]);
    expect(shellPinned).toEqual(["t-reply"]);
    // And the reply that arrived after the pin is in NO other group on either surface — the row
    // it belongs to is where it is.
    expect(phone.fresh.map((m) => m.id)).toEqual(["arrival-a"]);
    expect(drawn.filter((r) => r.group === "New").map((r) => r.id)).toEqual(["arrival-a"]);
    // The badge is the same number on both: one unread reply since the pin went up.
    expect(rows[0]!.newSince.map((m) => m.id)).toEqual(["t-reply"]);
    expect(phone.resurfaced[0]!.newSince).toBe(1);
  });

  it("and the SHELL renders exactly those groups, in that order", async () => {
    const reader = await mirrorOf(OHBOX_ROWS());
    const shell = ohboxView(reader);
    const drawn = await shellRows(reader);

    expect(drawn.filter((r) => r.group === "Resurfaced").map((r) => r.id))
      .toEqual(resurfacedThreads(reader).map((r) => r.openTarget.id));
    expect(drawn.filter((r) => r.group === "New").map((r) => r.id))
      .toEqual(shell.newForYou.map((m) => m.id));
    expect(drawn.filter((r) => r.group === "Earlier").map((r) => r.id))
      .toEqual(shell.previouslySeen.map((m) => m.id));
  });

  it("a parked row is in NO Ohbox group on either surface — the scheduled resurface included", async () => {
    const reader = await mirrorOf(OHBOX_ROWS());
    const phone = liveOhbox(reader, VIEW);
    const drawn = await shellRows(reader);
    const everywhere = [
      ...phone.resurfaced, ...phone.fresh, ...phone.seen,
    ].map((m) => m.id).concat(drawn.map((r) => r.id));
    expect(everywhere).not.toContain("scheduled");
  });
});

/**
 * THE OHBOX WITH CONVERSATIONS IN IT (owner 2026-09-28). `OHBOX_ROWS` is thread-less, so a phone
 * drawing one row per MESSAGE agrees with a shell drawing one per conversation by accident. Here a
 * waiting conversation whose NEWEST member is the account's own reply (so its row stands at the
 * reply's instant, above `solo-mid`, and opens on the unread member), an answered one (all read,
 * faced by the own reply) and three plain rows make the two answers differ.
 */
const THREADED_OHBOX = (): EngineMessage[] => [
  msg({ id: "solo-new", date: d(0), unread: true }),
  msg({ id: "c-own", date: d(1), unread: false, folder: "Sent", threadId: "C" }),
  msg({ id: "solo-mid", date: d(2), unread: true }),
  msg({ id: "c-unread", date: d(3), unread: true, threadId: "C" }),
  msg({ id: "d-own", date: d(4), unread: false, folder: "Sent", threadId: "D" }),
  msg({ id: "d-read-2", date: d(5), unread: false, lastReadAt: d(1), threadId: "D" }),
  msg({ id: "c-read", date: d(6), unread: false, lastReadAt: d(3), threadId: "C" }),
  msg({ id: "d-read-1", date: d(7), unread: false, lastReadAt: d(1), threadId: "D" }),
  msg({ id: "solo-read", date: d(8), unread: false, lastReadAt: d(2) }),
];

describe("one conversation, one row — on the shell and on the phone alike", () => {
  /**
   * MUTATIONS WATCHED: `ohboxView`'s filing put back to per message (C drops below `solo-mid` on
   * both surfaces), the fold keyed by section, and the phone's Earlier mapped per message again.
   */
  it("the phone's rows are the shell's rendered rows: key, group and open target, position for position", async () => {
    const reader = await mirrorOf(THREADED_OHBOX());
    await shellRows(reader);
    const keyOf = (id: string): string => {
      const m = reader.get<EngineMessage>("message", id);
      return m ? conversationKeyOf(m) : `unknown:${id}`;
    };
    const shell: string[] = [];
    for (const row of seatRows()) shell.push(`${keyOf(row.id)} ${row.group} ${row.id}`);
    const phone = liveOhbox(reader, VIEW);
    const phoneRows = [
      ...phone.resurfaced.map((m) => `${m.rowKey} Resurfaced ${m.id}`),
      ...phone.fresh.map((m) => `${m.rowKey} New ${m.id}`),
      ...phone.seen.map((m) => `${m.rowKey} Earlier ${m.id}`),
    ];
    expect(shell).toEqual([
      "msg:solo-new New solo-new",
      "C New c-unread",
      "msg:solo-mid New solo-mid",
      "D Earlier d-read-2",
      "msg:solo-read Earlier solo-read",
    ]);
    expect(phoneRows).toEqual(shell);
    const keys = [...phone.resurfaced, ...phone.fresh, ...phone.seen].map((m) => m.rowKey);
    expect(new Set(keys).size, "a phone row key repeats").toBe(keys.length);
    // Messages stay the unit of the count: nine messages on five rows.
    expect(phone.total).toBe(THREADED_OHBOX().length);
  });
});

describe("a resurfaced message reads UNREAD on every surface (owner ruling, 2026-08-31)", () => {
  it("the pinned row is drawn unread although the mirror says it was read", async () => {
    const rows = OHBOX_ROWS();
    const pinned = rows.find((m) => m.id === "pinned")!;
    // The premise: the STORED state is read. Without it this test proves nothing — it would be
    // asserting that an unread message draws unread.
    expect(pinned.unread).toBe(false);
    expect(presentsUnread(pinned)).toBe(true);

    const reader = await mirrorOf(rows);
    const drawn = await shellRows(reader);
    const phone = liveOhbox(reader, VIEW);

    expect(drawn.find((r) => r.id === "pinned")?.unread).toBe(true);
    expect(phone.resurfaced.find((m) => m.id === "pinned")?.unread).toBe(true);
  });

  it("every OTHER row keeps its genuine read state on both surfaces — the rule is not 'bold everything'", async () => {
    const reader = await mirrorOf(OHBOX_ROWS());
    const drawn = await shellRows(reader);
    const phone = liveOhbox(reader, VIEW);
    const phoneById = new Map([...phone.resurfaced, ...phone.fresh, ...phone.seen].map((m) => [m.id, m.unread]));

    for (const row of drawn) {
      const engineRow = OHBOX_ROWS().find((m) => m.id === row.id)!;
      expect(row.unread, `${row.id}: the shell disagrees with the shared derivation`)
        .toBe(presentsUnread(engineRow));
      expect(phoneById.get(row.id), `${row.id}: the phone disagrees with the shell`).toBe(row.unread);
    }
    // …and the read rows really are read, so the loop above is not vacuously true.
    expect(drawn.find((r) => r.id === "read-recent")?.unread).toBe(false);
    expect(drawn.find((r) => r.id === "own-sent")?.unread).toBe(false);
  });

  it("releasing the pin hands the row back its own read state — no second write decides it", async () => {
    // Done, a reply settling and every deliberate read all do ONE thing to this row: clear
    // `resurfaced`. Nothing re-stamps read state on the way out, so what the reader sees next is
    // what the mailbox says — which is what makes the transition impossible to flip-flop.
    const released = OHBOX_ROWS().map((m) => (m.id === "pinned" ? { ...m, triage: null } : m));
    const reader = await mirrorOf(released);
    const drawn = await shellRows(reader);
    const phone = liveOhbox(reader, VIEW);

    expect(drawn.find((r) => r.id === "pinned")?.unread).toBe(false);
    expect(drawn.find((r) => r.id === "pinned")?.group).toBe("Earlier");
    expect([...phone.seen].find((m) => m.id === "pinned")?.unread).toBe(false);
  });
});

describe("the streams' badge is ONE number", () => {
  /**
   * A reported rail: a Reads count in the browser, nothing on the desktop, and a mail server
   * holding ZERO unread messages in that pile. Both numbers were `fresh.length` over a line that
   * lives only on the device that wrote it — so the browser's thirteen-visits-stale anchor and
   * the desktop's current one gave two answers to one question.
   */
  const readsPile = (): EngineMessage[] =>
    Array.from({ length: 20 }, (_, i) =>
      msg({ id: `r${i}`, date: d(i), unread: false, lastReadAt: d(i), folder: "ohmail/News" }));

  it("an entirely \\Seen pile is 'nothing new' however stale this device's line is", async () => {
    const stale = await mirrorOf(readsPile(), { view: "reads", newestSeenId: "r13" });
    const current = await mirrorOf(readsPile(), { view: "reads", newestSeenId: "r0" });

    // The LINE still differs — it is per-device state and stays that way, because it is what
    // stops the list re-sorting mid-visit (R10-5).
    expect(feedPartition(stale, "reads").fresh).toHaveLength(13);
    expect(feedPartition(current, "reads").fresh).toHaveLength(0);
    // The BADGE does not. Revert `newCount` to `fresh.length` and this is red with 13 vs 0 —
    // which is the screenshot.
    expect(feedPartition(stale, "reads").newCount).toBe(0);
    expect(feedPartition(current, "reads").newCount).toBe(0);
  });

  it("the phone and the shell read the SAME field for it", async () => {
    // Two unread arrivals above an otherwise-read pile: a real "2 new", so the agreement below
    // is not two zeroes agreeing by accident.
    const pile = [
      msg({ id: "n0", date: d(0), unread: true, folder: "ohmail/News" }),
      msg({ id: "n1", date: d(1), unread: true, folder: "ohmail/News" }),
      ...Array.from({ length: 6 }, (_, i) =>
        msg({ id: `r${i}`, date: d(i + 2), unread: false, lastReadAt: d(i + 2), folder: "ohmail/News" })),
      // Old unread mail BELOW the line — deliberately skipped, and not news.
      msg({ id: "skipped", date: d(9), unread: true, folder: "ohmail/News" }),
    ];
    const reader = await mirrorOf(pile, { view: "reads", newestSeenId: "r0" });
    expect(feedPartition(reader, "reads").newCount).toBe(2);
    expect(liveReads(reader, VIEW).newCount).toBe(feedPartition(reader, "reads").newCount);
  });

  it("a first visit names the unread letters present at setup, on the phone as on the shell", async () => {
    const pile = [
      msg({ id: "u0", date: d(0), unread: true, folder: "ohmail/News" }),
      msg({ id: "r0", date: d(1), unread: false, lastReadAt: d(1), folder: "ohmail/News" }),
      msg({ id: "u1", date: d(2), unread: true, folder: "ohmail/News" }),
    ];
    const reader = await mirrorOf(pile);
    // This device's first sync came after all three; no visit has committed a line.
    await reader.putLocal("view_meta", FEED_SINCE_ID, { at: NOW.toISOString() });
    expect(feedPartition(reader, "reads").newCount).toBe(2);
    expect(liveReads(reader, VIEW).newCount).toBe(2);
  });
});


/* ── an answer files the open row (owner defect 2026-09-28) ─────────────────────────────── */

interface LiveRow { ids: string[]; group: string; settling: boolean }

/**
 * THE OHBOX's SEAT mounted ONCE over the engine and left to follow it, as every host mounts it (`_ohbox-1-seat.tsx`;
 * today's `OhboxView` was re-rendered by hand here, through `ohbox/_today`), so the session layer (the slide) sees
 * the live sequence rather than a cold mount of the end state. Giulia's letter is the open one, as the view was handed
 * it, in the demo's world (its fixtures hold no consent: today's view was handed its lists uncut). `render` lets the
 * seat settle after the engine moved; `rows` reads it back by role and name. The kit's row
 * carries no "settling" mark: a row reads `settling` only while the old view's class stood.
 */
async function liveShell(engine: OhmailEngine) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DEMO_NOW);
  /* The threaded demo's engine: its fixtures carry no consent, so the seat stands in the demo's world (`demo`). */
  mountSeat(engine, { first: "#/ohbox/m/giulia", demo: true });
  await settleSeat();
  /* What the engine published reaches the seat by its subscription: a flush, on whichever clock the case runs. */
  const render = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
  };
  const rows = (): LiveRow[] => seatRows().map(({ ids, group }) => ({ ids, group, settling: false }));
  return { render, rows };
}

/**
 * Past `SETTLE_MS` (280, `packages/app-logic/src/ohbox/slide.ts`): the slide's timer fires. On the wall's clock: the
 * seat over the demo's engine re-files the row only when the engine's answer has travelled (under a faked clock it
 * never does), so the case no longer fakes its timers after the boot; only the date stands still.
 */
async function slidePast(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
}

describe("an answer files the open row — the shell (web and desktop) and the phone", () => {
  // Faked AFTER the engine boots, inside each case: the slide timer is the view's own.
  afterEach(() => { vi.useRealTimers(); });
  it("open H, reply to one person, confirm: ONE row for the conversation, under Earlier", async () => {
    const { engine } = await threadedEngine();
    const onT = (r: LiveRow) => r.ids.some((id) => engine.read().get<EngineMessage>("message", id)?.threadId === "T");
    const shell = await liveShell(engine);

    engine.holdOpenRow("giulia");
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false, via: "glance" });
    await shell.render();
    expect(shell.rows().filter(onT).map((r) => r.group), "the premise: H held in New").toContain("New");

    const res = await engine.mutate({ kind: "mail_send", inReplyTo: "giulia", body: "TOPPPENS!" });
    expect(res.status).toBe("confirmed");
    await shell.render();
    await slidePast();
    await shell.render();

    const drawn = shell.rows().filter(onT);
    expect(drawn.map((r) => r.group), `rows on T: ${JSON.stringify(drawn)}`).toEqual(["Earlier"]);
    expect(drawn[0]!.ids).toContain("giulia");
    expect(drawn[0]!.ids.some((id) => engine.read().get<EngineMessage>("message", id)?.local === true),
      "the Sent copy rides the same row").toBe(true);

    // The phone reads the same rows from the same hold: one per conversation, T under Earlier.
    const phone = liveOhbox(engine.read(), VIEW, engine.openRowHeld());
    const rows = ohboxRows(engine.read(), engine.openRowHeld());
    expect(phone.fresh.map((m) => m.rowKey)).toEqual(rows.new.map((r) => r.key));
    expect(phone.seen.map((m) => m.rowKey)).toEqual(rows.earlier.map((r) => r.key));
    expect(phone.fresh.flatMap((m) => m.memberIds ?? [])).not.toContain("giulia");
    expect(phone.seen.filter((m) => m.rowKey === "T")).toHaveLength(1);
  });

  it("CONTROL: a plain compose leaves the held row where it is, and a single row stays single", async () => {
    const { engine } = await threadedEngine();
    const shell = await liveShell(engine);
    engine.holdOpenRow("giulia");
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false, via: "glance" });
    await shell.render();
    await engine.mutate({
      kind: "mail_send", inReplyTo: null, to: [{ name: "Z", address: "z@example.test" }], subject: "Hello", body: "new",
    });
    await shell.render();
    await slidePast();
    await shell.render();
    const rows = shell.rows();
    expect(rows.find((r) => r.ids.includes("giulia"))?.group, "a compose is not an answer").toBe("New");
    const ben = rows.find((r) => r.ids.includes("ben"));
    expect(ben, "the threadless unread row").toMatchObject({ ids: ["ben"], group: "New", settling: false });
  });
});

describe("the reader's read slot is the conversation's on the shell and on the phone alike", () => {
  /**
   * One mirror, three surfaces: the shell's reading column (the shipped OhboxView), the reader sheet
   * over it (the same `conversationReadSet` the shell hands its pane) and the phone (`read-slot.ts`
   * over `liveMessage`). Thread T, a2 opened (read). Mutations: the shell's face back to the opened
   * message's flag, the phone's set back to `m.unread` alone, either side's resurfaced filter
   * dropped — each red here.
   */
  async function threadEngine(rows: EngineMessage[]) {
    const { OhmailEngine } = await import("@ohmail/client-engine");
    const creates: SyncChange[] = rows.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m }) as SyncChange);
    for (const m of rows) {
      if (!m.triage) continue;
      creates.push({ type: "message_state", op: "create", id: `st:${m.id}`, seq: ++seq, updatedAt: m.updatedAt,
        entity: { messageId: m.id, state: (m.triage as { state: string }).state, bubbleUpAt: null, setAt: m.updatedAt, updatedAt: m.updatedAt } } as SyncChange);
    }
    let page: SyncChange[] | null = creates;
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => {
          const c = page ?? [];
          page = null;
          return { changes: { creates: c, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString() };
        },
        mutate: async () => ({ ok: true, changes: [] }),
      } as never,
      store: new MemoryMirrorStore(),
      storePolicy: { mode: "full" },
    });
    await engine.start();
    return engine;
  }
  async function surfaces(engine: { read(): EntityReader }) {
    const { conversationReadSet } = await import("@ohmail/app-logic/reading/conversation-on-screen");
    const { conversationUnreadIds } = await import("../../mobile/src/ui/read-slot.js");
    const { liveMessage } = await import("../../mobile/src/state/live.js");
    /* THE OHBOX's SEAT over the engine, a2 open in its reading column, in the demo's world (these letters carry no
       consent: today's view was handed its lists uncut); today's `OhboxView` was mounted through `ohbox/_today`. */
    const readSetFor = (id: string) => conversationReadSet(engine.read(), engine.read(), id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mountSeat(engine as OhmailEngine, { first: "#/ohbox/m/a2", demo: true });
    await settleSeat();
    const render = async (): Promise<void> => {
      for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    };
    return {
      render,
      /* The reading column's read slot, by its name (`readSlotSays`), and a row drawn unread (`data-unread`). */
      columnFace: (): string | null => readSlotSays(document) || null,
      columnBold: (): boolean => seatRows().some((r) => r.unread),
      sheetSet: (): string[] => readSetFor("a2"),
      phoneSet: (): string[] => conversationUnreadIds(liveMessage(engine as never, "a2", VIEW)!),
      phoneBold: (): boolean => [...liveOhbox(engine.read(), VIEW).fresh, ...liveOhbox(engine.read(), VIEW).seen].some((m) => m.unread),
    };
  }

  it("all three faces say Mark read over the same set, then Mark unread with the row unbold", async () => {
    const engine = await threadEngine([
      msg({ id: "a1", date: d(2), unread: true, threadId: "T" }),
      msg({ id: "a2", date: d(1), unread: false, threadId: "T" }),
    ]);
    const s = await surfaces(engine);
    await s.render();
    expect(s.columnFace(), "the column's face").toBe(messages.ohbox.actionMarkRead);
    expect(s.sheetSet(), "the sheet's set").toEqual(["a1"]);
    expect(s.phoneSet(), "the phone's set, whose face is Mark as read").toEqual(["a1"]);
    expect(s.columnBold() && s.phoneBold(), "the premise: the row is bold on both").toBe(true);

    await (engine as unknown as { mutate(m: unknown): Promise<unknown> }).mutate({ kind: "mark_seen", messageIds: ["a1"], unread: false });
    await s.render();
    expect(s.columnFace()).toBe(messages.ohbox.actionMarkUnread);
    expect(s.sheetSet()).toEqual([]);
    expect(s.phoneSet(), "nothing left: the phone's face is Mark unread").toEqual([]);
    expect(s.columnBold() || s.phoneBold(), "unbold on both").toBe(false);
  });

  it("a resurfaced unread sibling is in no surface's set: its pin is its row's to release", async () => {
    const engine = await threadEngine([
      msg({ id: "a1", date: d(3), unread: true, threadId: "T", triage: { state: "resurfaced" } }),
      msg({ id: "b1", date: d(2), unread: true, threadId: "T" }),
      msg({ id: "a2", date: d(1), unread: false, threadId: "T" }),
    ]);
    const s = await surfaces(engine);
    await s.render();
    expect(s.sheetSet()).toEqual(["b1"]);
    expect(s.phoneSet()).toEqual(["b1"]);
    expect(s.columnFace()).toBe(messages.ohbox.actionMarkRead);
    await (engine as unknown as { mutate(m: unknown): Promise<unknown> }).mutate({ kind: "mark_seen", messageIds: ["b1"], unread: false });
    await s.render();
    expect(s.columnFace(), "only the pinned sibling is unread: the column says Mark unread").toBe(messages.ohbox.actionMarkUnread);
    expect(s.sheetSet()).toEqual([]);
    expect(s.phoneSet()).toEqual([]);
  });
});
