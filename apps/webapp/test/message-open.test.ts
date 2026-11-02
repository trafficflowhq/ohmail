/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter, type EngineMessage, type EngineMutation } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { openTargetFor } from "../app/shell/AppShell";

/**
 * ═══ OPEN IT WHERE IT LIVES (slice gaps the residue and) ═══════════════
 *
 * A report: *"search does not allow a message to be opened, should open the message where it
 * lives"* and, of the other piles, *"messages do not show a collapse or ellipsis function …
 * must be able to be opened similar to the normal ohbox."*
 *
 * The literal first claim is wrong — a `SearchHit` has always been a real `<button>` calling
 * `openMessage` — and that is exactly why this file exists at the seam rather than at the
 * button. `openMessage` set a view and a cursor and then **stopped**, so three of its five
 * destinations dropped the user in a list with no indication which row they had asked for,
 * and the fourth landed them on a reading column their screen width hides.
 *
 * Two levels, deliberately:
 *
 *   1. {@link openTargetFor} — the DECISION, as a pure function. Every arm is an owner
 *      report, including the two the demo world cannot reach through the DOM (the fixture
 *      message set holds only INBOX/Reads/Receipts rows).
 *   2. The shell, driven from the keyboard, for what only exists once it is wired: the
 *      search bindings that did not exist at all, and the reader that could not be opened
 *      on anything but an Ohbox message.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];

function setViewport(mobile: boolean): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile && query.includes("max-width"),
      media: query, onchange: null,
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

async function mountShell(): Promise<void> {
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
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

/** Type into the search box the way a person does — React's own onChange path. */
const typeSearch = async (text: string): Promise<void> => {
  const input = host!.querySelector<HTMLInputElement>(".view-search input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value",
    )!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  input.focus();
  // The archive pass is debounced; the local pass has already painted.
  await act(async () => { vi.advanceTimersByTime(400); });
};

/**
 * A query the FIXTURE world answers with hits in more than one pile.
 *
 * Two characters minimum, because the engine's tokenizer drops shorter tokens — a
 * single-letter query is not a question and the local arm ignores it, so a test typing "a"
 * would measure an empty list and prove nothing about the bindings.
 */
const SEEDS = "the";

const hits = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(".view-search .hit-w")];
const cursorHit = (): HTMLElement | null => host!.querySelector<HTMLElement>(".view-search .hit-w.cur");

/**
 * THE ID OF THE MESSAGE THAT IS OPEN, in whichever pile the shell landed in.
 *
 * The list-shaped piles (Ohbox, Receipts, History, a tag, a folder) mark the open message with
 * `.row.sel`; Reads is a STREAM and marks it by expanding its card. This helper asks both,
 * because "the hit opened where it lives" is a claim about every pile and the assertion should
 * not quietly become a claim about the row-shaped ones.
 *
 * It used to be the `.row.sel` query alone, and it passed for a reason that was not the rule:
 * the second search hit for this query happened to be an Ohbox message. Search now breaks a
 * relevance tie by recency, which reordered two equally-scoring hits and put a Reads message
 * there instead — a real message, opened correctly, in a pile the selector could not see.
 */
function openedMessageId(): string | undefined {
  const row = host!.querySelector<HTMLElement>(".view .row.sel");
  if (row?.dataset.id) return row.dataset.id;
  const open = host!.querySelector<HTMLElement>('.view-reads .scast .sc-x[aria-expanded="true"]');
  return open?.closest<HTMLElement>(".scast")?.dataset.sid;
}

/** A message shaped enough for the routing decision, in `folder`. */
const msg = (id: string, folder: string): EngineMessage =>
  ({ id, folder, from: { address: `${id}@example.test`, name: null } } as unknown as EngineMessage);

beforeEach(() => {
  vi.useFakeTimers();
  /*
   * jsdom implements no scrolling, so `Element.scrollIntoView` is undefined — and the Reads
   * view calls it when it reveals a message (`ReadsView.tsx`). This file only ever landed in
   * row-shaped piles until search's tie-break reordered two equally-scoring hits and put a
   * Reads message under the cursor, at which point the view threw into its own error boundary
   * and the assertion below read as "the message did not open". It had opened; the environment
   * has no such method. `search-open-exact.test.tsx` stubs the same two for the same reason.
   */
  const proto = Element.prototype as unknown as Record<string, () => void>;
  proto.scrollIntoView = () => {};
  proto.scrollTo = () => {};
  setViewport(false);
  window.location.hash = "#/ohbox";
  sent = [];
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter,
    ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("openTargetFor — the routing decision, every arm", () => {
  const noRow = () => null;

  it("an Ohbox message opens in the split pane on a desktop", () => {
    expect(openTargetFor(msg("a", "INBOX"), false, noRow)).toEqual({
      kind: "ohbox", id: "a", reader: false,
    });
  });

  it("…and in the READER under 700px, where the reading column is display:none", () => {
    // THE GUARD for the fourth thing the ruling found wrong: an Ohbox hit "opened" nothing
    // on the width a phone's journey lives at. Drop the `narrow` arm and this goes
    // red with `reader: false` — the shipped behaviour, which looks like a dead button.
    expect(openTargetFor(msg("a", "INBOX"), true, noRow)).toEqual({
      kind: "ohbox", id: "a", reader: true,
    });
  });

  it("Reads and Receipts open IN PLACE — cursor plus a jump, never the reader", () => {
    // The clamp is those views' contract (the ruling: "collapsed by default, expanding in
    // place, because skimming is the view's contract"). A reader arm here would replace a
    // stream with a sheet and take the waterline's scroll with it.
    expect(openTargetFor(msg("b", "ohmail/News"), true, noRow)).toEqual({
      kind: "stream", view: "reads", id: "b",
    });
    expect(openTargetFor(msg("c", "ohmail/Receipts"), true, noRow)).toEqual({
      kind: "stream", view: "receipts", id: "c",
    });
  });

  it("a held message SELECTS ITS SENDER'S ROW, not merely the segment", () => {
    // The third thing the ruling found: screener hits landed on a queue of strangers with
    // nothing selected. The row id is the SENDER's — for a derived row that is the newest
    // held message from that address, which is almost never the message that was clicked,
    // so a lookup keyed on `m.id` would silently select nothing.
    const rowFor = (m: EngineMessage, segment: string) =>
      segment === "waiting" && m.folder === "ohmail/Screener" ? "row-for-that-sender" : null;
    expect(openTargetFor(msg("d", "ohmail/Screener"), false, rowFor)).toEqual({
      kind: "screener", segment: "waiting", row: "row-for-that-sender", letter: "d",
    });
  });

  it("screened and quarantined mail lands on ITS segment, with the sender selected", () => {
    const rowFor = () => "row";
    expect(openTargetFor(msg("e", "ohmail/Screened"), false, rowFor)).toEqual({
      kind: "screener", segment: "screened", row: "row", letter: "e",
    });
    expect(openTargetFor(msg("f", "ohmail/Quarantine"), false, rowFor)).toEqual({
      kind: "screener", segment: "spam", row: "row", letter: "f",
    });
  });

  it("no row for that sender ⇒ the READER, never a rowless screener queue", () => {
    // THE GUARD for #116's part B. A Screener surface can only show a message THROUGH its sender
    // row, so a hit the queue holds no row for must open the reader in place — the same answer
    // History gives a pile-less hit. Return the old `{ kind: "screener", ..., row: null }` and
    // this goes red: `openMessage` would navigate to a queue the message is not in and flash
    // nothing, which is the vanish this fixes.
    expect(openTargetFor(msg("g", "ohmail/Screener"), false, noRow)).toEqual({
      kind: "reader", id: "g",
    });
  });

  it("a folder no view owns opens the MESSAGE, and never the Screener", () => {
    // The ruling's second finding, and the report corrects it: `Folder` is a closed
    // six-member union and `MessageDTO.folder` is typed to it, so a Sent hit cannot reach
    // this today. The arm exists because the contract says a server may add folders a
    // shipped client has never heard of, and the honest answer to one of those is the
    // message itself — filing the user into the consent gate would be a misroute.
    expect(openTargetFor(msg("h", "Sent" as unknown as string), false, noRow)).toEqual({
      kind: "reader", id: "h",
    });
  });
});

describe("the keyboard opens a search result", () => {
  it("↓ moves a visible cursor through the hits", async () => {
    // THE GUARD. `SearchView` declared ZERO bindings, so with results on screen every key
    // did nothing — in a product whose `?` sheet is generated from a keyboard registry.
    // Delete the ArrowDown binding and this goes red on the second id.
    await mountShell();
    window.location.hash = "#/search";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await typeSearch(SEEDS);

    expect(hits().length, "no results to walk").toBeGreaterThan(1);
    const first = cursorHit()?.dataset.hit ?? null;
    expect(first, "nothing carried the cursor").toBeTruthy();

    await key("ArrowDown");
    expect(cursorHit()?.dataset.hit).toBe(hits()[1]!.dataset.hit);
    await key("ArrowUp");
    expect(cursorHit()?.dataset.hit).toBe(first);
  });

  it("↵ opens the hit under the cursor, in the pile it lives in", async () => {
    // The report, as an assertion: pressing ↵ on a result leaves search and lands
    // on the message. `openMessage` is what routes it; this pins that the KEY reaches it.
    await mountShell();
    window.location.hash = "#/search";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await typeSearch(SEEDS);

    // ↓ FIRST, so `shown[0]` is the wrong answer. Without this step the assertion holds for
    // an implementation that ignores the cursor entirely and always opens the top hit,
    // which would make ↑/↓ decoration.
    await key("ArrowDown");
    const target = cursorHit()!.dataset.hit!;
    expect(target).not.toBe(hits()[0]!.dataset.hit);
    await key("Enter");

    expect(window.location.hash, "still on search").not.toContain("search");
    // THE CURSOR of the pile it landed in, not merely "the row exists somewhere on screen":
    // every Ohbox row is on screen whichever one was opened, so presence alone would hold
    // for an implementation that opened `shown[0]` and ignored ↑/↓ entirely.
    expect(openedMessageId(), `↵ did not open the hit under the cursor`).toBe(target);
  });

  it("↵ with NOTHING found is left to the box, which re-asks the archive", async () => {
    // The composition rule. `SearchBox` fires `onSubmit` from its own keydown; a binding
    // live at the same moment would open a hit AND spend a round trip re-asking for the
    // list it just left. `disabled` when there is no cursor is what keeps them apart —
    // remove the `disabled` line and this goes red by navigating away from search.
    await mountShell();
    window.location.hash = "#/search";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await typeSearch("zzzzzzqqqq");

    expect(hits()).toHaveLength(0);
    await key("Enter");
    expect(window.location.hash).toContain("search");
  });

  it("j and k are NOT rebound here — they keep their pile meaning", async () => {
    // The ruling is explicit that a search-session cursor must not survive navigation. If
    // `j` were bound in this view it would be a second meaning for the most-used key in
    // the product, live only on one surface.
    await mountShell();
    window.location.hash = "#/search";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await typeSearch(SEEDS);

    const before = cursorHit()?.dataset.hit;
    await key("j");
    expect(cursorHit()?.dataset.hit).toBe(before);
  });
});

describe("a remaining case — the reader opens on a message, not on a pile", () => {
  it("↵ AT A SPLIT WIDTH opens in the column — nothing is raised over it", async () => {
    /**
     * A live walk at 1440 found the reading experience rendered TWICE: the message in the
     * split's 752px column AND a 660px sheet over it, with the ghost of that column — and a
     * second action bar — legible behind. `OhboxView.open` called `onEnterReader`
     * unconditionally while `openReply` and `openMessage` had both been asking
     * `readColumnHidden()` since that change.
     *
     * THE GUARD: revert `onEnterReader={enterReader}` in `AppShell` to `setReaderFor` and
     * the first expectation goes red — the sheet is back over a pane already showing the
     * same mail. `beforeEach` runs `setViewport(false)`, so this is the desktop arm.
     */
    await mountShell();
    await key("j");
    const cursor = host!.querySelector<HTMLElement>(".view-ohbox .row.sel")!.dataset.id!;
    await key("Enter");

    expect(
      host!.querySelector(".reader"),
      "a sheet opened over a reading column that is already showing this message",
    ).toBeNull();

    // …and "opened" still means something: the column IS showing the row under the cursor.
    // Without this the assertion above would hold for a build that opened nothing at all.
    // (Selector updated by the viewer redesign — the subject lives in the header's
    // `.msg-subject` line now, not a 24px `h2`. The assertion is untouched, here and in the
    // two reader-path reads below.)
    const paneSubject =
      host!.querySelector<HTMLElement>(".view-ohbox .read-col .msg .msg-subject")?.textContent ?? "";
    const rowSubject =
      host!.querySelector<HTMLElement>(`.view-ohbox .row[data-id="${cursor}"] .subj`)
        ?.textContent ?? "";
    expect(rowSubject).not.toBe("");
    expect(paneSubject).toContain(rowSubject.trim().slice(0, 12));

    // And no control offers the sheet from here. `ReadingPane` renders `.msg-open` when it
    // is given `onEnterReader`, and the split column was the one caller that passed it —
    // at exactly the widths where the sheet duplicates the pane the button sits in.
    expect(
      host!.querySelector(".view-ohbox .read-col .msg-open"),
      "the split pane still offers to open the sheet it duplicates",
    ).toBeNull();
  });

  it("…and at 390px ↵ opens the READER on the row under the cursor", async () => {
    // The path that must survive under 700px `app.css` sets `display:none` on the
    // reading column, so the sheet is what "opened" means. Delete the `readColumnHidden()`
    // arm of `enterReader` — make it open nowhere — and this goes red with no reader.
    //
    // THE GUARD for the staleness the id fixes, kept here. `OhboxView.open` calls
    // `onSelect(id)` and `onEnterReader(id)` in the SAME tick, so a shell reading its own
    // `selectedOhbox` here would render the PREVIOUS row. Close `enterReader` over
    // `selectedOhbox` instead of taking the id and this goes red with the first row's
    // subject.
    setViewport(true);
    await mountShell();
    await key("j");
    const cursor = host!.querySelector<HTMLElement>(".view-ohbox .row.sel")!.dataset.id!;
    await key("Enter");

    const reader = host!.querySelector(".reader");
    expect(reader, "no reader opened").toBeTruthy();
    const subject = host!.querySelector<HTMLElement>(".reader .msg .msg-subject")?.textContent ?? "";
    const rowSubject =
      host!.querySelector<HTMLElement>(`.view-ohbox .row[data-id="${cursor}"] .subj`)
        ?.textContent ?? "";
    expect(rowSubject).not.toBe("");
    expect(subject).toContain(rowSubject.trim().slice(0, 12));
  });

  it("a mobile tap opens the reader on the row that was TAPPED", async () => {
    // THE GUARD for the id travelling. `OhboxView.open` calls `onSelect(id)` and
    // `onEnterReader(id)` in the SAME tick, so a shell that answered with its own
    // `selectedOhbox` would render the PREVIOUSLY selected message — and on a phone the
    // reader is the only thing on screen, so the user simply gets the wrong mail. It has to
    // be a tap on a row that is NOT already the cursor: with the cursor already there the
    // stale value happens to be right, which is why `↵` alone does not catch it.
    setViewport(true);
    await mountShell();
    const target = [...host!.querySelectorAll<HTMLElement>(".view-ohbox .row[data-id]")][2]!;
    const wanted = target.dataset.id!;
    await act(async () => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(host!.querySelector(".reader"), "no reader opened").toBeTruthy();
    const subject = host!.querySelector<HTMLElement>(".reader .msg .msg-subject")?.textContent ?? "";
    const rowSubject = target.querySelector<HTMLElement>(".subj")?.textContent ?? "";
    expect(rowSubject).not.toBe("");
    expect(subject, `the reader is not showing ${wanted}`).toContain(rowSubject.trim().slice(0, 12));
  });

  it("at 390px an Ohbox search hit OPENS — it does not just move a hidden cursor", async () => {
    // Under 700px `app.css` sets `display:none` on the reading column, so the desktop
    // behaviour ("select the row, the pane shows it") is a no-op on a phone: the user
    // taps a result and the app appears to do nothing. Remove the `readerPending` arm and
    // this goes red — and it goes red in the specific way an earlier fix already paid for once, because
    // the route-transition effect closes every overlay on the way.
    setViewport(true);
    await mountShell();
    window.location.hash = "#/search";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await typeSearch(SEEDS);

    // The first Ohbox hit — the routing arm this claim is about.
    const ohboxHit = hits().find((w) => (w.textContent ?? "").includes("Ohbox"));
    expect(ohboxHit, "no Ohbox result to open").toBeTruthy();
    await act(async () => {
      ohboxHit!.querySelector("button")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(window.location.hash).toContain("ohbox");
    expect(host!.querySelector(".reader"), "the reader did not survive the navigation").toBeTruthy();
  });

  it("a message verb acts on the message in the open reader", async () => {
    // Honest about what this does and does not prove: `focused` consults `readerMessage`
    // first, and NO mutation of that line goes red today, because every path that opens the
    // reader also sets the pile cursor to the same message. What this pins is the behaviour
    // a user would notice — a verb pressed over an open message acts on that message —
    // and it would be the first thing to fail if the reader were ever opened over a pile
    // with a cursor of its own. See `focused` in `AppShell.tsx`.
    //
    // AT 390px SINCE that change, because that is now the only width at which the reader opens
    // over the Ohbox at all. The claim under test is unchanged — it was never about the
    // width — and the verbs it exercises are the shell's GLOBAL bindings, which are the
    // same ones at every width.
    setViewport(true);
    await mountShell();
    // THREE presses, and the count matters. The first is the one the shell used to perform on
    // the reader's behalf — its Ohbox selection resolved through `?? allOhbox[0]`, so the top
    // row was "selected" before anybody chose it; with that gone the first `j` lands there. The
    // other two walk to the same third row this test has always used, which is a row the
    // fixture has NOT already queued: on an already-queued message `a` correctly toasts instead
    // of dispatching, and this would then measure the wrong refusal.
    await key("j");
    await key("j");
    await key("j");
    const opened = host!.querySelector<HTMLElement>(".view-ohbox .row.sel")!.dataset.id!;
    await key("Enter");
    expect(host!.querySelector(".reader")).toBeTruthy();

    sent = [];
    await key("a");
    expect(
      sent.filter((m) => m.kind === "triage_set"),
      "`a` did not act on the message in the reader",
    ).toEqual([expect.objectContaining({ messageId: opened, state: "reply_later" })]);
  });
});
