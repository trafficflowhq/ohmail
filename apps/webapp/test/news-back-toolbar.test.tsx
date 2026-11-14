/** @vitest-environment jsdom */
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

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

afterEach(async () => {
  await unmountKeepHash();
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
  expect(window.location.hash).toBe("#/reads");

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

it("an expanded News card offers Forward without announcing an inactive shortcut", async () => {
  window.location.hash = "#/reads";
  await mountShell();

  const first = newsCards()[0]!;
  await expandNews(first.dataset.streamItem!);
  const forward = within(newsActions()!).getByRole("button", { name: "Forward" });
  const tooltip = forward.title;
  expect(forward.getAttribute("aria-keyshortcuts")).toBeNull();

  await act(async () => {
    forward.focus();
    forward.dispatchEvent(new KeyboardEvent("keydown", { key: "F", shiftKey: true, bubbles: true }));
  });
  expect(screen.queryByRole("textbox", { name: "Forward body" })).toBeNull();

  await act(async () => { forward.click(); });
  expect(await screen.findByRole("textbox", { name: "Forward body" })).toBeTruthy();
  expect(tooltip).toBe("Forward");
});
