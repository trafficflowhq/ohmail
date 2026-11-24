/** @vitest-environment jsdom */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { cursorRow, ohboxRow, ohboxRows, openLetter, openSubject, readingColumn } from "./ohbox/_finders.js";

/**
 * ═══ THE READER OPENS ON A MESSAGE, NOT ON A PILE: the Ohbox's cases of `message-open.test.ts` ═══
 *
 * Moved out of `message-open.test.ts` (whose other cases are Search's, and its routing decision's, which today's shell
 * exports) and re-pointed over the new shell's door, `MailShell` of `_mail-shell.tsx`, as every browser entry mounts
 * it: the frame over the mail ground, the seated Ohbox's list and its reading column. Their expectations are
 * today's, untouched; what finds a part is the seated Ohbox's finders (`ohbox/_finders.ts`):
 *
 *   · the reading sheet (`.reader`): at 390 wide the open letter's region, the one column there (the frame draws
 *     the reading column in place of the list); beside the list, a SECOND drawing of the open letter, which is what a
 *     sheet raised over a column already showing it would be;
 *   · the letter's subject (`.msg-subject`): the open letter's head; a row's subject: its own line on the row;
 *   · the control that offered the sheet (`.msg-open`): a press in the reading column named "Open reading mode".
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
/* The frame's report animates its way in and out (the kit's motion): jsdom has no Web Animations. */
Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;

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
  /* The frame reads a phone's width off the window's own width, not only the media query. */
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: mobile ? 390 : 1024 });
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountShell(): Promise<void> {
  await unmount();
  const { MailShell: AppShell } = await import("./_mail-shell.js");
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
  await vi.waitFor(() => expect(ohboxRows(host!).length).toBeGreaterThan(0));
}

/** A key, then the hash change it may make: jsdom says one in a task of its own, which this file's fake clock holds. */
const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
  await act(async () => { vi.advanceTimersByTime(1); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
};

/** The open letter's region where one column shows it (today's reading sheet, `.reader`). */
const reader = (): HTMLElement | null => openLetter(document);
/** A second drawing of the open letter beside the column that shows it: what a sheet raised over it would be. */
const raisedOver = (): Element | null => document.querySelectorAll('[role="region"][aria-label="Open message"]')[1] ?? null;
/** A row's subject, as its own line draws it (today's `.subj`). */
const rowSubjectOf = (row: HTMLElement | null): string => row?.querySelector<HTMLElement>(".oh-row-subject")?.textContent ?? "";
/** A press in the reading column that offers the reading sheet (today's `.msg-open`, "Open reading mode"). */
const offersTheSheet = (): HTMLButtonElement | null =>
  [...(readingColumn(document)?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === messages.message.openReader) ?? null;

beforeEach(() => {
  vi.useFakeTimers();
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
  setViewport(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
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
    const cursor = cursorRow(host!)!.dataset.id!;
    await key("Enter");

    expect(
      raisedOver(),
      "a sheet opened over a reading column that is already showing this message",
    ).toBeNull();

    // …and "opened" still means something: the column IS showing the row under the cursor.
    // Without this the assertion above would hold for a build that opened nothing at all.
    // (Selector updated by the viewer redesign — the subject lives in the header's
    // `.msg-subject` line now, not a 24px `h2`. The assertion is untouched, here and in the
    // two reader-path reads below.)
    const paneSubject = openSubject(document);
    const rowSubject = rowSubjectOf(ohboxRow(host!, cursor));
    expect(rowSubject).not.toBe("");
    expect(paneSubject).toContain(rowSubject.trim().slice(0, 12));

    // And no control offers the sheet from here. `ReadingPane` renders `.msg-open` when it
    // is given `onEnterReader`, and the split column was the one caller that passed it —
    // at exactly the widths where the sheet duplicates the pane the button sits in.
    expect(
      offersTheSheet(),
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
    const cursor = cursorRow(host!)!.dataset.id!;
    await key("Enter");

    expect(reader(), "no reader opened").toBeTruthy();
    const subject = openSubject(document);
    const rowSubject = rowSubjectOf(ohboxRow(host!, cursor));
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
    const target = ohboxRows(host!)[2]!;
    const wanted = target.dataset.id!;
    const rowSubject = rowSubjectOf(target);
    await act(async () => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => { vi.advanceTimersByTime(1); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });

    expect(reader(), "no reader opened").toBeTruthy();
    const subject = openSubject(document);
    expect(rowSubject).not.toBe("");
    expect(subject, `the reader is not showing ${wanted}`).toContain(rowSubject.trim().slice(0, 12));
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
    const opened = cursorRow(host!)!.dataset.id!;
    await key("Enter");
    expect(reader()).toBeTruthy();

    sent = [];
    await key("a");
    expect(
      sent.filter((m) => m.kind === "triage_set"),
      "`a` did not act on the message in the reader",
    ).toEqual([expect.objectContaining({ messageId: opened, state: "reply_later" })]);
  });
});
