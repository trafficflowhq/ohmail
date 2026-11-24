/** @vitest-environment jsdom */
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { canonicalHash, normalizedHash, parseHash } from "../app/shell/routing";
import { openSubject } from "./ohbox/_finders.js";

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
  await settle();
}

/** A hash move the way Back reaches the page: the fragment changes and `hashchange` fires. */
async function goHash(hash: string, width?: number): Promise<void> {
  await act(async () => {
    if (width !== undefined) {
      vi.stubGlobal("innerWidth", width);
      window.dispatchEvent(new Event("resize"));
    }
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
  vi.unstubAllGlobals();
});

const readingSheet = () => screen.queryByRole("dialog", { name: messages.frame.landmark.reading });
const newsStream = () => screen.getByRole("region", { name: messages.news.stream.label });
const newsCards = () => [...newsStream().querySelectorAll<HTMLElement>("[data-stream-item]")];
const newsCard = (id: string) => newsCards().find((card) => card.dataset.streamItem === id)!;
const newsClip = (id: string) => within(newsCard(id)).getByRole("button", { name: /^(Expand|Collapse)$/ });
const newsActions = () => within(newsStream()).queryByRole("toolbar", { name: messages.reader.panel });

/** Give the stream's link landing real dimensions in jsdom. */
function layOutNews(): void {
  const scroller = newsStream().querySelector<HTMLElement>("[data-reading-scroll]")!;
  const cards = newsCards();
  Object.defineProperties(scroller, {
    clientHeight: { value: 600 },
    scrollHeight: { value: cards.length * 300 },
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  cards.forEach((card, index) => {
    card.getBoundingClientRect = () => new DOMRect(0, index * 300 - scroller.scrollTop, 600, 300);
  });
  scroller.scrollTo = ((options: ScrollToOptions) => {
    scroller.scrollTop = options.top ?? 0;
    scroller.dispatchEvent(new Event("scroll"));
  }) as typeof scroller.scrollTo;
}

async function expandNews(id: string): Promise<void> {
  await act(async () => { newsClip(id).click(); });
  await settle();
}

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

    const selId = host!.querySelector<HTMLElement>("[role=option][data-open][data-id]")?.dataset.id;
    expect(selId, "a selected row").toBeTruthy();
    expect(window.location.hash, "the bar claims the reading").toBe(`#/ohbox/m/${selId}`);

    // THE RELOAD: a fresh mount against the same URL. The selection and the reading column
    // come back without a click — the URL was the claim, the restore honors it.
    await unmountKeepHash();
    await mountShell();
    expect(host!.querySelector<HTMLElement>("[role=option][data-open][data-id]")?.dataset.id, "the restored selection").toBe(selId);
    /* The reading column, by its section and the open letter's region: its heading is the letter's subject. */
    expect(
      openSubject(host!),
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
    const selId = host!.querySelector<HTMLElement>("[role=option][data-open][data-id]")!.dataset.id!;
    seen.length = 0;

    await unmountKeepHash();
    await mountShell();
    expect(host!.querySelector<HTMLElement>("[role=option][data-open][data-id]")?.dataset.id).toBe(selId);
    // The restore selected and rendered — and wrote nothing. No mark_seen rides a reload.
    expect(seen.filter((m) => m.kind === "mark_seen")).toEqual([]);
  });

  it("Back walks out of the reading: the route dropping the id closes the selection", async () => {
    window.location.hash = "#/ohbox";
    await mountShell();
    await key("j");
    expect(host!.querySelector("[role=option][data-open][data-id]")).toBeTruthy();

    // Back is a hash move to the entry before the open.
    await goHash("#/ohbox");
    expect(host!.querySelector("[role=option][data-open][data-id]"), "the selection follows the URL out").toBeNull();
  });

  it("a card the reader expanded themselves survives the Back that closes the claimed one", async () => {
    window.location.hash = "#/reads";
    await mountShell();

    const cards = newsCards();
    expect(cards.length, "two stream cards to tell apart").toBeGreaterThan(1);
    const claimed = cards[0]!.dataset.streamItem!;
    const mine = cards[1]!.dataset.streamItem!;

    layOutNews();
    await expandNews(mine);
    expect(newsActions(), "the manually expanded card starts with its verbs").toBeTruthy();
    await goHash(`#/reads/m/${claimed}`);

    await waitFor(() => expect(newsClip(claimed).getAttribute("aria-expanded"), "the link expands its card").toBe("true"));
    expect(newsClip(mine).getAttribute("aria-expanded")).toBe("true");

    await goHash("#/reads");

    expect(newsClip(claimed).getAttribute("aria-expanded"), "the claimed card closes").toBe("false");
    expect(
      newsClip(mine).getAttribute("aria-expanded"),
      "the one the reader opened is posture the bar never claimed, and stays",
    ).toBe("true");
    // AND KEEPS ITS VERBS. The bar is a single `expandedId`, so a close that cleared it
    // unconditionally would strip this card's bar while leaving the card open — an expanded
    // reading with no verbs, which is worse than the residue this whole change removes.
    expect(
      newsActions(),
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
    // On a narrow window Search opens a routed letter over its results.
    window.location.hash = "#/ohbox";
    await mountShell();
    await key("j");
    const selId = host!.querySelector<HTMLElement>("[role=option][data-open][data-id]")!.dataset.id!;

    await goHash(`#/search/m/${selId}`, 390);
    const sheet = readingSheet();
    expect(sheet, "the overlay carries the reading").toBeTruthy();
    expect(within(sheet!).getByRole("region", { name: messages.reader.pane })).toBeTruthy();
    expect(window.location.hash).toBe(`#/search/m/${selId}`);
  });

  it("an outgoing reader is never reflected into the NEXT view's bare route", async () => {
    // A review finding: with the overlay open, navigating to another bare message view had
    // the mirror effect read the closure's not-yet-cleared `readerFor` and push `m/<old>` onto
    // the destination — restoring the old reading over the view the user just chose.
    window.location.hash = "#/ohbox";
    await mountShell();
    await key("j");
    const selId = host!.querySelector<HTMLElement>("[role=option][data-open][data-id]")!.dataset.id!;
    await goHash(`#/search/m/${selId}`, 390);
    expect(readingSheet(), "the overlay is up").toBeTruthy();

    const entriesBefore = window.history.length;
    await goHash("#/reads");
    await settle();
    expect(window.location.hash, "the destination stays bare — the old reading closed with the view").toBe("#/reads");
    expect(readingSheet()).toBeNull();
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
    const heldId = host!.querySelector<HTMLElement>("[role=option][data-open][data-id]")!.dataset.id!;
    const heldSubject = openSubject(host!);
    await key("j");
    const other = host!.querySelector<HTMLElement>("[role=option][data-open][data-id]")!.dataset.id!;
    expect(other).not.toBe(heldId);
    await goHash(`#/search/m/${other}`, 390);
    expect(readingSheet(), "the overlay is up").toBeTruthy();

    await goHash(`#/ohbox/m/${heldId}`, 1280);
    await settle();
    expect(host!.querySelector<HTMLElement>("[role=option][data-open][data-id]")?.dataset.id, "the held selection").toBe(heldId);
    expect(openSubject(host!)).toBe(heldSubject);
    expect(readingSheet(), "no stale overlay over the column").toBeNull();
  });
});
