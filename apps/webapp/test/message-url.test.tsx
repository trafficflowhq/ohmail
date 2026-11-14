/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { canonicalHash, normalizedHash, parseHash } from "../app/shell/routing";

/**
 * THE OPEN MESSAGE LIVES IN THE URL — `#/<view>/m/<id>`.
 *
 * A reload used to boot to the bare view: the URL knew the place and not the reading, so the
 * message on screen was gone, Back left the view instead of leaving the reading, and there was
 * no link that could hand somebody the exact message. The router carries the id now (the same
 * segment discipline the screener/triage/settings paths keep), and the shell mirrors it both
 * ways — the bar claims what is on screen, and what the bar claims is restored onto the screen.
 *
 * THE READ-STATE CLAIMS ARE DELIBERATE AND SAY SO: a reload is a leave-and-revisit. The
 * departure's own `pagehide` commit is the correct spender of the pending read (the waterline
 * rule), and the RESTORE arms nothing — it sets the selection, never calls the view's `open`,
 * so nothing is marked read by arriving. A restored unread message re-arms the way any
 * on-screen message does: the dwell, or an explicit open.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
/* jsdom implements NO scrolling at all, and the stream views scroll for two different reasons —
 * a selected row into view on every cursor move, and the scroller itself when the cursor lands
 * outside the mounted window. Both throw, and a throw inside a view lands in its error boundary,
 * so the assertion after it reads the fallback card instead of the stream: "the pill is missing"
 * where the truth is "the whole view is gone". Stubbed to no-ops, the same way every other webapp
 * test that drives a stream does it. */
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.scrollTo ??= function scrollTo() {};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

/** Unmount WITHOUT touching the hash — a reload keeps the URL, which is the whole point. */
async function unmountKeepHash(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
};

async function mountShell(): Promise<void> {
  await unmountKeepHash();
  setViewport();
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
  await settle();
}

/** A hash move the way Back reaches the page: the fragment changes and `hashchange` fires. */
async function goHash(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settle();
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settle();
};

afterEach(async () => {
  await unmountKeepHash();
  window.location.hash = "";
  vi.restoreAllMocks();
});

describe("the route carries the open message", () => {
  it("parses and round-trips the m/<id> tail on every message view, segments intact", () => {
    expect(parseHash("#/ohbox/m/abc")).toMatchObject({ view: "ohbox", messageId: "abc" });
    expect(parseHash("#/reads/m/x1")).toMatchObject({ view: "reads", messageId: "x1" });
    expect(parseHash("#/triage/aside/m/x2")).toMatchObject({ view: "triage", triagePile: "aside", messageId: "x2" });
    expect(parseHash("#/tag/pottery/m/x3")).toMatchObject({ view: "tag", tagId: "pottery", messageId: "x3" });
    for (const hash of ["#/ohbox/m/abc", "#/reads/m/x1", "#/triage/aside/m/x2", "#/tag/pottery/m/x3"]) {
      expect(canonicalHash(parseHash(hash)), hash).toBe(hash);
      expect(normalizedHash(hash), `${hash} is already canonical`).toBeNull();
    }
  });

  it("a message-less view sheds the tail — settings, compose, drafts and the sender queue", () => {
    // The Screener's rows are senders; a message id names nothing its list can locate.
    expect(parseHash("#/settings/m/x").messageId).toBeNull();
    expect(parseHash("#/screener/m/x").messageId).toBeNull();
    expect(parseHash("#/drafts/m/x").messageId).toBeNull();
    expect(normalizedHash("#/screener/m/x")).toBe("#/screener");
    expect(normalizedHash("#/drafts/m/x")).toBe("#/drafts");
  });
});

describe("the bar claims the reading, and the reading survives a reload", () => {
  it("selecting a message at split width puts it in the bar; a remount restores it", async () => {
    window.location.hash = "#/ohbox";
    await mountShell();
    await key("j"); // the cursor lands on the first row — at split width the column IS the open

    const selId = host!.querySelector<HTMLElement>(".row.sel[data-id]")?.dataset.id;
    expect(selId, "a selected row").toBeTruthy();
    expect(window.location.hash, "the bar claims the reading").toBe(`#/ohbox/m/${selId}`);

    // THE RELOAD: a fresh mount against the same URL. The selection and the reading column
    // come back without a click — the URL was the claim, the restore honors it.
    await unmountKeepHash();
    await mountShell();
    expect(host!.querySelector<HTMLElement>(".row.sel[data-id]")?.dataset.id, "the restored selection").toBe(selId);
    expect(
      host!.querySelector(".read-col .msg-subject")?.textContent ?? "",
      "the reading column shows the restored message",
    ).not.toBe("");
  });

  it("restoring arms NO read — a reload is a leave-and-revisit, and the waterline already committed", async () => {
    const { FixturesAdapter } = await import("@ohmail/testing/adapter");
    const seen: Array<Record<string, unknown>> = [];
    const real = FixturesAdapter.prototype.mutate;
    vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(function (
      this: unknown, m: unknown, opts: unknown,
    ) {
      seen.push(m as Record<string, unknown>);
      return (real as (this: unknown, m: unknown, o: unknown) => Promise<unknown>).call(this, m, opts);
    } as never);

    window.location.hash = "#/ohbox";
    await mountShell();
    await key("j");
    const selId = host!.querySelector<HTMLElement>(".row.sel[data-id]")!.dataset.id!;
    seen.length = 0;

    await unmountKeepHash();
    await mountShell();
    expect(host!.querySelector<HTMLElement>(".row.sel[data-id]")?.dataset.id).toBe(selId);
    // The restore selected and rendered — and wrote nothing. No mark_seen rides a reload.
    expect(seen.filter((m) => m.kind === "mark_seen")).toEqual([]);
  });

  it("Back walks out of the reading: the route dropping the id closes the selection", async () => {
    window.location.hash = "#/ohbox";
    await mountShell();
    await key("j");
    expect(host!.querySelector(".row.sel[data-id]")).toBeTruthy();

    // Back is a hash move to the entry before the open.
    await goHash("#/ohbox");
    expect(host!.querySelector(".row.sel[data-id]"), "the selection follows the URL out").toBeNull();
  });

  /**
   * THE SAME WALK-OUT, ON A STREAM — where "the reading" is an expanded card, not a selected row.
   *
   * The row case above closes because the selection is shell state. A stream card's expansion is
   * not: `StreamCard` owns the visual open, and the view holds only `expandedId`, which gates the
   * verbs. So the arm that cleared the cursor left the card standing — an open reading the bar no
   * longer claimed, with its verbs still up. The shell now asks the stream to close the card the
   * URL was claiming, through the card's own pill, which is the one definition of close here.
   *
   * Only the CLAIMED card. A second card the reader expanded themselves is scroll posture the bar
   * never claimed, and the twin below holds it open.
   */
  it("Back walks out of a stream reading: the card the URL claimed collapses, and writes nothing", async () => {
    const { FixturesAdapter } = await import("@ohmail/testing/adapter");
    const seen: Array<Record<string, unknown>> = [];
    const real = FixturesAdapter.prototype.mutate;
    vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(function (
      this: unknown, m: unknown, opts: unknown,
    ) {
      seen.push(m as Record<string, unknown>);
      return (real as (this: unknown, m: unknown, o: unknown) => Promise<unknown>).call(this, m, opts);
    } as never);

    window.location.hash = "#/reads";
    await mountShell();

    // Expanded the way a reader expands it — the card's own click, no scroll machinery driven.
    const card = host!.querySelector<HTMLElement>(".view-reads .scast[data-sid]");
    expect(card, "a stream card is mounted").toBeTruthy();
    const id = card!.dataset.sid!;
    await act(async () => { card!.click(); });
    await settle();

    const pill = () =>
      host!.querySelector<HTMLElement>(`.view-reads .scast[data-sid="${CSS.escape(id)}"] .sc-x`);
    // THE ARRANGE IS ASSERTED. Without this the close assertion below passes just as happily over
    // a card that was never open — the vacuous green this test exists to refuse.
    expect(pill()?.getAttribute("aria-expanded"), "the click expanded the card").toBe("true");
    expect(host!.querySelector(".view-reads .sc-actions"), "an expanded card carries its verbs")
      .toBeTruthy();

    // The URL comes to claim that reading; then Back drops the id IN PLACE.
    await goHash(`#/reads/m/${id}`);
    seen.length = 0;
    await goHash("#/reads");

    expect(pill()?.getAttribute("aria-expanded"), "the card follows the URL out").toBe("false");
    expect(host!.querySelector(".view-reads .sc-actions"), "and the verbs go with it").toBeNull();
    // Closing is a state drop: it marks nothing seen and asks for no body.
    expect(seen.filter((m) => m.kind === "mark_seen"), "Back writes no read state").toEqual([]);
  });

  it("a card the reader expanded themselves survives the Back that closes the claimed one", async () => {
    window.location.hash = "#/reads";
    await mountShell();

    const cards = host!.querySelectorAll<HTMLElement>(".view-reads .scast[data-sid]");
    expect(cards.length, "two stream cards to tell apart").toBeGreaterThan(1);
    const claimed = cards[0]!.dataset.sid!;
    const mine = cards[1]!.dataset.sid!;

    await act(async () => { cards[0]!.click(); });
    await settle();
    await act(async () => { cards[1]!.click(); });
    await settle();

    const pill = (id: string) =>
      host!.querySelector<HTMLElement>(`.view-reads .scast[data-sid="${CSS.escape(id)}"] .sc-x`);
    expect(pill(claimed)?.getAttribute("aria-expanded"), "both open before the Back").toBe("true");
    expect(pill(mine)?.getAttribute("aria-expanded")).toBe("true");

    await goHash(`#/reads/m/${claimed}`);
    await goHash("#/reads");

    expect(pill(claimed)?.getAttribute("aria-expanded"), "the claimed card closes").toBe("false");
    expect(
      pill(mine)?.getAttribute("aria-expanded"),
      "the one the reader opened is posture the bar never claimed, and stays",
    ).toBe("true");
    // AND KEEPS ITS VERBS. The bar is a single `expandedId`, so a close that cleared it
    // unconditionally would strip this card's bar while leaving the card open — an expanded
    // reading with no verbs, which is worse than the residue this whole change removes.
    expect(
      host!.querySelector(`.view-reads .scast[data-sid="${CSS.escape(mine)}"] .sc-actions`),
      "closing another card must not take this one's bar with it",
    ).toBeTruthy();
  });

  it("an id this mirror never holds drops out of the bar once the mail state settles — never an error", async () => {
    window.location.hash = "#/ohbox/m/not-in-this-mirror";
    await mountShell();
    // The stale claim is normalized away and the view stands — the fallback for a link from
    // another account's mirror, or a message deleted since the link was made.
    expect(window.location.hash).toBe("#/ohbox");
    expect(host!.querySelector('[role="listbox"]'), "the Ohbox rendered").toBeTruthy();
  });

  it("a deep link on a view with no column of its own opens the reader overlay over that view", async () => {
    // History, a folder, a tag, Trash and Answer Later read a routed letter in their own column
    // (`open-letter-in-the-address.test.tsx`); Search has none, so the overlay is its reading.
    window.location.hash = "#/ohbox";
    await mountShell();
    await key("j");
    const selId = host!.querySelector<HTMLElement>(".row.sel[data-id]")!.dataset.id!;

    await goHash(`#/search/m/${selId}`);
    expect(host!.querySelector(".reader .msg, .reader [class*=\"pm\"]"), "the overlay carries the reading").toBeTruthy();
  });

  it("an outgoing reader is never reflected into the NEXT view's bare route", async () => {
    // A review finding: with the overlay open, navigating to another bare message view had
    // the mirror effect read the closure's not-yet-cleared `readerFor` and push `m/<old>` onto
    // the destination — restoring the old reading over the view the user just chose.
    window.location.hash = "#/ohbox";
    await mountShell();
    await key("j");
    const selId = host!.querySelector<HTMLElement>(".row.sel[data-id]")!.dataset.id!;
    await goHash(`#/search/m/${selId}`);
    expect(host!.querySelector(".reader .msg"), "the overlay is up").toBeTruthy();

    const entriesBefore = window.history.length;
    await goHash("#/reads");
    await settle();
    expect(window.location.hash, "the destination stays bare — the old reading closed with the view").toBe("#/reads");
    expect(host!.querySelector(".reader .msg")).toBeNull();
    // …and with NO junk entry: reflecting the stale reader pushed `m/<old>` before correcting
    // itself, which left Back walking through a route nobody was ever on.
    expect(window.history.length - entriesBefore, "exactly the navigation itself").toBe(1);
  });

  it("restoring a held reading replaces a stale overlay instead of standing under it", async () => {
    // A review finding: Back from an overlay route to a held `#/ohbox/m/<id>` selected the
    // held message but left the overlay showing the old one at a split width.
    window.location.hash = "#/ohbox";
    await mountShell();
    await key("j");
    const heldId = host!.querySelector<HTMLElement>(".row.sel[data-id]")!.dataset.id!;
    await goHash(`#/search/m/${heldId}`);
    expect(host!.querySelector(".reader .msg"), "the overlay is up").toBeTruthy();

    await goHash(`#/ohbox/m/${heldId}`);
    await settle();
    expect(host!.querySelector<HTMLElement>(".row.sel[data-id]")?.dataset.id, "the held selection").toBe(heldId);
    expect(host!.querySelector(".reader .msg"), "no stale overlay over the column").toBeNull();
  });

  /**
   * THE CLOSE THAT ARRIVES INSIDE THE JUMP'S OWN FRAME.
   *
   * A deep link into a stream schedules its work in a `requestAnimationFrame` — the frame exists
   * so a commit can mount the target row first. The controlled close is synchronous. So there is
   * exactly one frame in which a Back can land after the jump was requested and before the jump
   * runs, and in that window the jump's "a new request outranks an earlier close" line cleared the
   * tombstone the close had just written, the landing re-opened the card, and the reader was left
   * with an expanded reading under a bare URL. `[jumpTo]` does not change on a close, so the
   * effect's own cleanup never cancelled the frame.
   *
   * Driven with a HELD frame queue rather than by timing: real `requestAnimationFrame` would make
   * this a stopwatch race, and a test that only sometimes reaches the window is not a guard. The
   * queue is drained to exhaustion afterwards so the stream's landing loop — which is frames all
   * the way down — reaches its `onLanded` and would click the card open if the tombstone were gone.
   */
  it("a Back inside the jump's pending frame wins: the deep link does not re-open the card", async () => {
    window.location.hash = "#/reads";
    await mountShell();

    const card = host!.querySelector<HTMLElement>(".view-reads .scast[data-sid]");
    expect(card, "a stream card is mounted").toBeTruthy();
    const id = card!.dataset.sid!;
    const pill = () =>
      host!.querySelector<HTMLElement>(`.view-reads .scast[data-sid="${CSS.escape(id)}"] .sc-x`);
    expect(pill()?.getAttribute("aria-expanded"), "nothing is open before the deep link").toBe("false");

    /* The frame queue, held. `cancelAnimationFrame` neutralizes by handle so a cleanup that DOES
       run still behaves; the fix must not depend on that cleanup, which is the point. */
    const frames: Array<(() => void) | null> = [];
    const realRaf = window.requestAnimationFrame;
    const realCancel = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      frames.push(() => cb(0))) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((handle: number) => {
      if (handle > 0 && handle <= frames.length) frames[handle - 1] = null;
    }) as typeof window.cancelAnimationFrame;
    const drain = async (): Promise<void> => {
      for (let pass = 0; pass < 500 && frames.some(Boolean); pass++) {
        const batch = frames.slice();
        frames.length = 0;
        await act(async () => { for (const f of batch) f?.(); });
      }
      await settle();
    };

    try {
      // The deep link asks for the card — and its frame is held, not run.
      await goHash(`#/reads/m/${id}`);
      expect(frames.some(Boolean), "the jump scheduled a frame").toBe(true);
      // Back, inside that window. The close is synchronous, so it completes first.
      await goHash("#/reads");
      expect(pill()?.getAttribute("aria-expanded"), "still closed at the moment of the Back")
        .toBe("false");

      await drain();

      expect(
        pill()?.getAttribute("aria-expanded"),
        "the stale jump must not re-open a card the reader has already walked out of",
      ).toBe("false");
      expect(
        host!.querySelector(".view-reads .sc-actions"),
        "and no verb bar comes up under a bare route",
      ).toBeNull();
    } finally {
      window.requestAnimationFrame = realRaf;
      window.cancelAnimationFrame = realCancel;
    }
  });

  /**
   * THE SAME RACE, RUN A SECOND TIME ON THE SAME MESSAGE — where an id comparison goes blind.
   *
   * The tombstone holds an id and keeps holding it, so after one close "was this id closed?"
   * reads the same before and after the NEXT close of it. A reader who walks out of a card,
   * follows a link back to that same message, and presses Back again inside the frame writes
   * the identical id, and the first form of this guard — comparing what the tombstone held at
   * request time against what it holds now — saw no change where the SEQUENCE changed, cleared
   * the tombstone and re-opened the card. Counting closes is what distinguishes them.
   */
  it("a SECOND Back on the same message still wins over its pending jump", async () => {
    window.location.hash = "#/reads";
    await mountShell();

    const card = host!.querySelector<HTMLElement>(".view-reads .scast[data-sid]");
    expect(card, "a stream card is mounted").toBeTruthy();
    const id = card!.dataset.sid!;
    const pill = () =>
      host!.querySelector<HTMLElement>(`.view-reads .scast[data-sid="${CSS.escape(id)}"] .sc-x`);

    const frames: Array<(() => void) | null> = [];
    const realRaf = window.requestAnimationFrame;
    const realCancel = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      frames.push(() => cb(0))) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((handle: number) => {
      if (handle > 0 && handle <= frames.length) frames[handle - 1] = null;
    }) as typeof window.cancelAnimationFrame;
    const drain = async (): Promise<void> => {
      for (let pass = 0; pass < 500 && frames.some(Boolean); pass++) {
        const batch = frames.slice();
        frames.length = 0;
        await act(async () => { for (const f of batch) f?.(); });
      }
      await settle();
    };

    try {
      /* ROUND ONE, on the SAME held queue — deliberately, and not on the real animation clock.
         `settle()` flushes microtasks and a real `requestAnimationFrame` is a timer, so a first
         round run on real frames leaves the jump possibly still pending when the second begins;
         under load that is exactly what happened, and a race in the test is worth nothing
         against a race in the code. Every frame in this case is one this test released. */
      await goHash(`#/reads/m/${id}`);
      await drain();
      expect(
        pill()?.getAttribute("aria-expanded"),
        "round one: the deep link opened the card — the arrange, asserted",
      ).toBe("true");
      await goHash("#/reads");
      expect(pill()?.getAttribute("aria-expanded"), "round one: Back closed it").toBe("false");
      await drain();

      /* THE CONTROL, and without it this case proves the wrong thing. Everything below asserts
         that a card STAYS closed, which an implementation that simply refused every jump for a
         once-closed id would also satisfy — and that implementation is broken in the opposite
         direction: a link to a message you closed earlier would stop opening it, for the rest of
         the session. So: the same deep link again, with no Back racing it, and it must OPEN. */
      await goHash(`#/reads/m/${id}`);
      await drain();
      expect(
        pill()?.getAttribute("aria-expanded"),
        "a message closed earlier still opens when the link is followed again",
      ).toBe("true");
      await goHash("#/reads");
      expect(pill()?.getAttribute("aria-expanded"), "and closes again on Back").toBe("false");
      await drain();

      // ROUND TWO: the same message, the same race, against a tombstone that already holds it.
      await goHash(`#/reads/m/${id}`);
      expect(frames.some(Boolean), "the second jump scheduled a frame").toBe(true);
      await goHash("#/reads");
      await drain();

      expect(
        pill()?.getAttribute("aria-expanded"),
        "a repeat deep link is not a licence to reopen what the second Back closed",
      ).toBe("false");
    } finally {
      window.requestAnimationFrame = realRaf;
      window.cancelAnimationFrame = realCancel;
    }
  });
});
