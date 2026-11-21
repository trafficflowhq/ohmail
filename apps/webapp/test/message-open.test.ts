/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { openTargetFor } from "@ohmail/app-logic/search/open-target";
import { openLetter } from "./ohbox/_finders.js";

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
 *
 * The Ohbox's own cases of the second level (↵ at a split width and at 390, a phone's tap, a verb over the open
 * reader) stand in `message-open-ohbox.test.ts`, over the new shell's door.
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
Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];

function setViewport(mobile: boolean): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: mobile ? 390 : 1024 });
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
  const { MailShell } = await import("./_mail-shell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(MailShell, { demo: true }) }),
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
  await act(async () => { vi.advanceTimersByTime(1); });
};

/** Type into the search box the way a person does — React's own onChange path. */
const typeSearch = async (text: string): Promise<void> => {
  const input = host!.querySelector<HTMLInputElement>(`input[aria-label="${messages.search.aria}"]`)!;
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

const hits = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>('[role="listitem"][data-hit]')];
const cursorHit = (): HTMLElement | null =>
  host!.querySelector<HTMLElement>('[role="listitem"][data-hit][aria-current="true"]');

/**
 * THE ID OF THE MESSAGE THAT IS OPEN, in whichever pile the shell landed in.
 *
 * The list-shaped piles mark the open row and the streams mark the open card. This helper asks both,
 * because "the hit opened where it lives" is a claim about every pile and the assertion should
 * not quietly become a claim about the row-shaped ones.
 *
 * It used to be the `:is(.row.sel, [role=option][data-open])` query alone, and it passed for a reason that was not the rule:
 * the second search hit for this query happened to be an Ohbox message. Search now breaks a
 * relevance tie by recency, which reordered two equally-scoring hits and put a Reads message
 * there instead — a real message, opened correctly, in a pile the selector could not see.
 */
function openedMessageId(): string | undefined {
  const streamItem = host!.querySelector<HTMLElement>('[data-stream-item][data-open]');
  if (streamItem) {
    return streamItem.querySelector('.oh-message-more button[aria-expanded="true"]')
      ? streamItem.dataset.streamItem
      : undefined;
  }
  return host!.querySelector<HTMLElement>('[role="option"][data-id][data-open]')?.dataset.id;
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
  setViewport(false);
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
    // Give a stream's scroller a viewport so the chosen card can finish landing in jsdom.
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("oh-sheet-scroll") && this.querySelector("[data-stream-item]") ? 600 : 0;
    });
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
      ohboxHit!.querySelector('[role="button"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await act(async () => { vi.advanceTimersByTime(1); });

    expect(window.location.hash).toContain("ohbox");
    expect(openLetter(document), "the reader did not survive the navigation").toBeTruthy();
    expect(window.location.hash).toContain(`/m/${encodeURIComponent(ohboxHit!.dataset.hit!)}`);
  });
});

it("centers the chosen Ohbox result and marks its arrival until the reader moves on", async () => {
  const centered: Element[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
    options?: boolean | ScrollIntoViewOptions,
  ) {
    if (typeof options === "object" && options.block === "center") centered.push(this);
  });
  await mountShell();
  const at = async (fragment: string) => {
    await act(async () => {
      window.location.hash = fragment;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  };
  await at("#/search");
  await typeSearch(SEEDS);
  const hit = hits().find((row) => row.textContent?.includes("Ohbox"))!;
  const id = hit.dataset.hit!;
  await act(async () => hit.querySelector<HTMLElement>('[role="button"]')!.click());
  await act(async () => { vi.advanceTimersByTime(1); });

  const rows = () => Array.from(host!.querySelectorAll('[role="option"][data-id]'));
  const located = () => rows().filter((row) => row.hasAttribute("data-located")).map((row) => row.getAttribute("data-id"));
  const chosen = rows().find((row) => row.getAttribute("data-id") === id);
  expect(chosen?.hasAttribute("data-open"), "the exact result is selected").toBe(true);
  expect(centered.some((row) => row === chosen), "the exact result was centered").toBe(true);
  expect(located()).toEqual([id]);

  const other = rows().find((row) => row !== chosen)!.getAttribute("data-id")!;
  await at(`#/ohbox/m/${encodeURIComponent(other)}`);
  expect(openedMessageId()).toBe(other);
  expect(located()).toEqual([]);
  await at(`#/ohbox/m/${encodeURIComponent(id)}`);
  expect(openedMessageId()).toBe(id);
  expect(located()).toEqual([]);
});
