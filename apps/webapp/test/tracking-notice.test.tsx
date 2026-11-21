/** @vitest-environment jsdom */
/**
 * THE TRACKING NOTICE, WORN AS A GLYPH — the reading stream's card says "A tracking pixel was
 * blocked." in its head, not as a bar above the message.
 *
 * The census of the captions and the bare viewer's case read only the letter's body, which stays: they
 * moved to `tracking-notice-body.test.tsx`. This suite exercises the mounted stream cards.
 * The cases cover three things:
 *
 *  1. THE CENSUS (now in `tracking-notice-body.test.tsx`). Every sentence in the `mailBody` namespace that says something was blocked has a
 *     caption twin (`NOTICE_CAPTION` in `BlockNotice.tsx`), and every caption it names exists in
 *     both catalogues, is short, and is not a sentence. Red before this slice: no caption keys.
 *  2. THE RENDER. A stream card whose body had a beacon refused carries, in its META LINE, a real
 *     button CALLED by the caption and DESCRIBED by the whole sentence (`aria-describedby` → a
 *     `role="tooltip"` node that is in the DOM while closed) — and no `.mb-bar-text` anywhere in the
 *     card. Ten such cards: ten glyphs, zero boxed lines. The three siblings (pictures, pictures
 *     with a beacon among them, a stylesheet) share the one component and one caption slot.
 *  3. THE SEAMS. A press on the glyph opens its card and does NOT select or expand the message; the
 *     controls the bar still owns ("Show images") keep their place without the box; and the same
 *     viewer mounted BARE — no host meta line to carry the fact; every existing bare test mount —
 *     still says the sentence in the bar exactly as before. (The reading pane, a conversation
 *     panel and the Screener pass `onNotice` too now; `block-notice-surfaces.test.tsx` holds them.)
 *
 * Mutation-proven at authoring time (each reddens the case named and no other):
 *   · delete the `onNotice(...)` call in `MessageBody`'s effect        → 2 (no glyph)
 *   · `barSaysIt = hasBlocked` (ignore the host)                        → "no boxed line" cases
 *   · remove `pixelCaption` from `de.json`                              → census (de parity)
 *   · remove `sheetOne` from `NOTICE_CAPTION`                           → census (lexical sweep)
 *   · remove `e.stopPropagation()` on `.sc-notice` in `StreamCard`      → the press case
 */
import { fireEvent, within } from "@testing-library/react";
import { Frame } from "../../../packages/app/src/frame/index.js";
import { MailGround, mailPlaces } from "../../../packages/app/src/mail/index.js";
import { readerEntry, type ReaderBody } from "../../../packages/app/src/reader/index.js";
import { TextProvider } from "../../../packages/app/src/text/index.js";
import { fakeMail } from "../../../packages/app/test/reader/support/mail.js";
import { issue, receipt } from "../../../packages/app/test/streams/registered-world.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { COPY } from "../../../packages/letter-body/src/MessageBody";

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/* ── fixtures: the frame's document, with a declared canvas so the viewer FRAMES it ─────────── */

const SENDER = "images.newsletter.example";
const PICTURE = (n: number) => `https://${SENDER}/hero-${n}.png`;
const BEACON = `https://${SENDER}/wf/open?upn=abc`;
const SHEET = `https://${SENDER}/style.css`;
const canvas = (inner: string) => `<table width="600"><tr><td><p>hello</p>${inner}</td></tr></table>`;
const PIXEL_ONLY = canvas(`<img src="${BEACON}" width="1" height="1">`);
const TWO_PICTURES = canvas(`<img src="${PICTURE(1)}" width="600" height="200"><img src="${PICTURE(2)}" width="600" height="200">`);
const PICTURES_AND_BEACON = canvas(
  `<img src="${PICTURE(1)}" width="600" height="200"><img src="${PICTURE(2)}" width="600" height="200"><img src="${BEACON}" width="1" height="1">`,
);
/* A remote sheet is recorded from `@import` inside the mail's own `<style>` (`neutraliseCss` hands
   each network reference to `recordSheet`) — a `<link>` in the body never reaches the sanitizer. */
const SHEET_ONLY = canvas(`<style>@import url("${SHEET}");</style>`);

type Catalogue = Record<string, Record<string, string>>;
const DE = de as unknown as Catalogue;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ── mounting ──────────────────────────────────────────────────────────────────────────────── */

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const host of hosts.splice(0)) host.remove();
  vi.unstubAllGlobals();
});

interface CardOpts {
  html: string;
  amount?: string;
  subject?: string;
}

async function mountStreamCards(cards: readonly CardOpts[], place: "news" | "receipts", locale: "en" | "de" = "en") {
  const { letterBody } = await vi.importActual<{ letterBody: ReaderBody }>(
    "../../../packages/app/src/reader/body/index.js",
  );
  const make = place === "news" ? issue : receipt;
  const letters = cards.map(({ amount, subject }, i) => make(`notice-${i}`, 20 - i, {
    body: undefined, ...(amount === undefined ? {} : { amount }), ...(subject === undefined ? {} : { subject }),
  }));
  const first = letters[0]!;
  const mail = fakeMail(letters, [], Object.fromEntries(letters.map((message, i) => [
    message.id, { messageId: message.id, state: "ready", text: "hello", html: cards[i]!.html },
  ])), {
    "rule:stream": {
      id: "stream", kind: "sender", match: first.from.address, destination: first.folder,
      priority: 0, provenance: "manual", enabled: true,
    },
  });
  const address = fakeAddress(place === "news" ? "#/reads" : "#/receipts");
  const { host } = fakeHost({
    engine: mail.engine, service: "self", scope: "tracking-notice",
    places: mailPlaces(),
    above: MailGround,
    reader: readerEntry({
      body: letterBody, files: "none", pictures: "none", look: "none",
      sentCopy: "none", reply: "none", invitation: "none",
    }),
    window: fakeWindow("desktop"),
    address,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  hosts.push(container);
  const root = createRoot(container);
  roots.push(root);
  const messages = locale === "en" ? en : de;
  await act(async () => root.render(
    <TextProvider locale={locale} messages={messages} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  ));
  return { region: within(container).getByRole("region", { name: messages[place].stream.label }), address };
}

async function mountNews(html: string, locale: "en" | "de" = "en") {
  const { region, address } = await mountStreamCards([{ html }], "news", locale);
  const card = within(region).getByRole("article").closest<HTMLElement>("[data-stream-item]")!;
  expect(card).not.toBeNull();
  return { card, address };
}

function newsGlyph(card: HTMLElement, caption: string) {
  const trigger = within(card).getByRole("button", { name: caption });
  const describedBy = trigger.getAttribute("aria-describedby");
  const tooltip = describedBy ? document.getElementById(describedBy) : null;
  return { trigger, tooltip };
}

/* ── 2. the render ────────────────────────────────────────────────────────────────────────── */

describe("a Reads card with a beacon refused", () => {
  it("carries the glyph in its meta line, called by the caption and described by the sentence — and no bar", async () => {
    const { card } = await mountNews(PIXEL_ONLY);
    const { trigger, tooltip } = newsGlyph(card, COPY.pixelCaption);
    expect(tooltip?.textContent, "aria-describedby does not resolve to the sentence").toBe(COPY.pixelOnly);
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(card.querySelector(".mb-bar-text"), "the sentence is still said as a bar").toBeNull();
    expect(card.querySelector(".mb-bar"), "a bar with nothing in it is still on the card").toBeNull();
    // The glyph and the time are adjacent in the same metadata line.
    const time = card.querySelector("time")!;
    expect(trigger.parentElement?.nextElementSibling).toBe(time.parentElement);
  });

  it("says it in German when the catalogue is German", async () => {
    const { card } = await mountNews(PIXEL_ONLY, "de");
    const { tooltip } = newsGlyph(card, DE.mailBody!.pixelCaption!);
    expect(tooltip?.textContent).toBe(DE.mailBody!.pixelOnly);
  });
});

describe("the three siblings share one component and one caption slot", () => {
  it("pictures refused → Images blocked / the images sentence", async () => {
    const { card } = await mountNews(TWO_PICTURES);
    const { tooltip } = newsGlyph(card, COPY.imagesCaption);
    expect(tooltip?.textContent).toBe(COPY.blockedMany(2));
  });

  it("pictures with a beacon among them → the beacon leads the caption; the sentence keeps both parts", async () => {
    const { card } = await mountNews(PICTURES_AND_BEACON);
    const { tooltip } = newsGlyph(card, COPY.pixelCaption);
    expect(tooltip?.textContent).toBe(`${COPY.blockedMany(3)} ${COPY.pixelOne}`);
  });

  it("a stylesheet refused → Stylesheet blocked / the stylesheet sentence", async () => {
    const { card } = await mountNews(SHEET_ONLY);
    const { tooltip } = newsGlyph(card, COPY.sheetCaption);
    expect(tooltip?.textContent).toBe(COPY.sheetOne);
  });

  it("a message with nothing refused carries no glyph and no bar", async () => {
    const { card } = await mountNews(canvas("<p>only words</p>"));
    for (const caption of [COPY.pixelCaption, COPY.imagesCaption, COPY.sheetCaption]) {
      expect(within(card).queryByRole("button", { name: caption })).toBeNull();
    }
    expect(card.querySelector("[data-noted]")).toBeNull();
    expect(card.querySelector(".mb-bar")).toBeNull();
  });
});

describe("Reads with ten such messages", () => {
  it("shows ten glyphs and zero boxed lines; a Receipts card (with an amount) is the same card", async () => {
    vi.stubGlobal("innerHeight", 2_600);
    const cards = Array.from({ length: 10 }, (_, i) => ({
      html: i % 3 === 0 ? PIXEL_ONLY : i % 3 === 1 ? TWO_PICTURES : PICTURES_AND_BEACON,
      amount: i % 2 === 0 ? "CHF 12.00" : undefined,
    }));
    const { region } = await mountStreamCards(cards, "news");
    expect(within(region).getAllByRole("article")).toHaveLength(10);
    expect(within(region).getAllByRole("button", { name: new RegExp(`^(${COPY.pixelCaption}|${COPY.imagesCaption})$`) })).toHaveLength(10);
    for (const card of within(region).getAllByRole("article")) {
      const notices = [COPY.pixelCaption, COPY.imagesCaption]
        .flatMap((name) => within(card).queryAllByRole("button", { name }));
      expect(notices, "each card carries one glyph").toHaveLength(1);
      expect(notices[0]!.parentElement?.nextElementSibling).toBe(card.querySelector("time")?.parentElement);
    }
    expect(region.querySelectorAll(".mb-bar, .mb-bar-text")).toHaveLength(0);

    const { region: receipts } = await mountStreamCards([
      { html: PIXEL_ONLY, amount: "CHF 12.00", subject: "" },
      { html: PIXEL_ONLY, amount: "CHF 18.00", subject: "Invoice" },
    ], "receipts");
    const [withoutSubject, invoice] = within(receipts).getAllByRole("article");
    const { trigger } = newsGlyph(withoutSubject!, COPY.pixelCaption);
    const metadata = trigger.parentElement!.parentElement!;
    const amount = within(withoutSubject!).getByText("CHF 12.00");
    const time = metadata.querySelector("time")!;
    expect(metadata.contains(amount)).toBe(true);
    expect(metadata.lastElementChild).toBe(time.parentElement);
    expect(amount.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(invoice!).getByRole("heading", { name: "Invoice" }).parentElement
      ?.contains(within(invoice!).getByText("CHF 18.00"))).toBe(true);
    expect(newsGlyph(invoice!, COPY.pixelCaption).trigger).toBeTruthy();
    expect(receipts.querySelectorAll(".mb-bar, .mb-bar-text")).toHaveLength(0);
  });
});

/* ── 3. the seams ─────────────────────────────────────────────────────────────────────────── */

describe("the seams", () => {
  it("a press on the glyph opens the sentence and does not select or expand the card", async () => {
    const { card, address } = await mountNews(PIXEL_ONLY);
    const { trigger } = newsGlyph(card, COPY.pixelCaption);
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const dialog = within(document.body).getByRole("dialog", { name: COPY.pixelCaption });
    expect(within(dialog).getByRole("note").textContent).toBe(COPY.pixelOnly);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(card.hasAttribute("data-open"), "asking about the notice selected the card").toBe(false);
    expect(address.read()).toBe("#/reads");
    expect(card.hasAttribute("data-expanded"), "asking about the notice expanded the card").toBe(false);
  });

});
