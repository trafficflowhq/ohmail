/** @vitest-environment jsdom */
/**
 * THE TRACKING NOTICE, WORN AS A GLYPH — the reading stream's card says "A tracking pixel was
 * blocked." in its head, not as a bar above the message.
 *
 * Three things are held here, in the order a person meets them:
 *
 *  1. THE CENSUS. Every sentence in the `mailBody` namespace that says something was blocked has a
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
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { COPY, MessageBody } from "../app/components/MessageBody";
import { CAPTION_KEY, NOTICE_CAPTION, type NoticeKind } from "../app/components/BlockNotice";
import { StreamCardMemo } from "../app/shell/StreamCardMemo";
import type { RemoteImagesChrome } from "../app/shell/remote-images";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../app/shell/locale";

const h = React.createElement;
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
const EN = en as unknown as Catalogue;
const DE = de as unknown as Catalogue;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ── mounting ──────────────────────────────────────────────────────────────────────────────── */

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => { r.unmount(); });
  for (const el of hosts.splice(0)) el.remove();
  setActiveCatalog(DEFAULT_LOCALE, null);
});

function message(id: string, extra: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "a", mailboxId: "mb1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: "Acme Store", address: "orders@acme.example" }, to: [], cc: [],
    date: "2026-08-01T09:00:00.000Z", folder: "INBOX", snippet: "s", unread: false, labels: [],
    ...extra,
  } as unknown as EngineMessage;
}

interface CardOpts {
  html: string;
  amount?: string;
  remoteImages?: RemoteImagesChrome;
  onSelect?: (id: string) => void;
  locale?: "en" | "de";
}

/** One or more stream cards, hydrated, as `ReadsView`/`ReceiptsView` mount them. */
async function mountCards(cards: CardOpts[]): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  const now = new Date("2026-08-02T09:00:00.000Z");
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC", now,
        children: cards.map((c, i) =>
          h(StreamCardMemo, {
            key: `m${i}`,
            m: message(`m${i}`, c.amount ? { amount: c.amount } as Partial<EngineMessage> : {}),
            now, current: false, expanded: false, viewer: true, unread: false,
            bodyText: "body", bodyState: "full" as const, bodyHtml: c.html, bodyLoadedRemote: false,
            remoteImages: c.remoteImages,
            loadingLabel: "…", failedLabel: "!", withheldKey: "withheld", onReask: () => {},
            onSelect: c.onSelect ?? (() => {}), onToggle: () => {},
          })),
      }),
    );
  });
  await settle();
  return host;
}

/** The glyph in a card's meta line, with what a reader is told about it. */
function glyphOf(card: Element) {
  const trigger = card.querySelector<HTMLButtonElement>(".sc-line .sc-notice .gloss-t");
  if (!trigger) return null;
  const describedBy = trigger.getAttribute("aria-describedby");
  const tooltip = describedBy ? card.querySelector<HTMLElement>(`[id="${describedBy}"]`) : null;
  return {
    trigger,
    /* With a caption the Gloss NAMES the trigger by the caption and DESCRIBES it by the sentence;
       the primitive's own suite proves the accname semantics — this reads the wiring. */
    name: trigger.querySelector(".gloss-cap")?.textContent ?? "",
    description: tooltip?.textContent ?? null,
    tooltipRole: tooltip?.getAttribute("role") ?? null,
    tooltipHidden: tooltip?.hidden ?? null,
    open: card.querySelector<HTMLElement>(".gloss-pop")?.hidden === false,
  };
}

/* ── 1. the census ────────────────────────────────────────────────────────────────────────── */

describe("the census: every notice sentence in mailBody has a caption twin", () => {
  const isSentence = (s: string) => /\.$/.test(s.trim());

  it("every mailBody sentence that says something was blocked is in NOTICE_CAPTION", () => {
    // LEXICAL, so a sibling added to the bar tomorrow without a row in the table is red: the rule is
    // "a full sentence in this namespace that names a block is a notice". Captions carry the word
    // too and are not sentences, which is what the period distinguishes.
    const notices = Object.entries(EN.mailBody!)
      .filter(([, v]) => /blocked/i.test(v) && isSentence(v))
      .map(([k]) => k)
      .sort();
    expect(notices.length, "the namespace no longer holds a blocking sentence at all").toBeGreaterThan(0);
    const missing = notices.filter((k) => !(k in NOTICE_CAPTION));
    expect(missing, `mailBody notice sentence(s) with no caption twin: ${missing.join(", ")}`).toEqual([]);
  });

  it("every key the table names exists in both catalogues, and so does every caption", () => {
    for (const locale of ["en", "de"] as const) {
      const ns = (locale === "en" ? EN : DE).mailBody!;
      for (const key of Object.keys(NOTICE_CAPTION)) {
        expect(ns[key], `${locale}.json mailBody.${key} — the table names a sentence the catalogue lacks`).toBeTypeOf("string");
      }
      for (const kind of Object.keys(CAPTION_KEY) as NoticeKind[]) {
        const cap = ns[CAPTION_KEY[kind]];
        expect(cap, `${locale}.json mailBody.${CAPTION_KEY[kind]} is missing`).toBeTypeOf("string");
        expect(cap!.trim().length, `${locale} ${kind} caption is empty`).toBeGreaterThan(0);
        expect(isSentence(cap!), `${locale} ${kind} caption "${cap}" is a sentence, not a caption`).toBe(false);
        expect(cap!.split(/\s+/).length, `${locale} ${kind} caption "${cap}" is longer than two words`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("each caption is shorter than every sentence it headlines, in both languages", () => {
    for (const locale of ["en", "de"] as const) {
      const ns = (locale === "en" ? EN : DE).mailBody!;
      for (const [key, kind] of Object.entries(NOTICE_CAPTION)) {
        const cap = ns[CAPTION_KEY[kind]]!;
        expect(cap.length, `${locale}: caption "${cap}" is not shorter than ${key}`).toBeLessThan(ns[key]!.length);
      }
    }
  });

  it("the component's own table reads the same captions (the parity oracle's new members)", () => {
    for (const kind of Object.keys(CAPTION_KEY) as NoticeKind[]) {
      expect(COPY[CAPTION_KEY[kind]]).toBe(EN.mailBody![CAPTION_KEY[kind]]);
    }
  });
});

/* ── 2. the render ────────────────────────────────────────────────────────────────────────── */

describe("a Reads card with a beacon refused", () => {
  it("carries the glyph in its meta line, called by the caption and described by the sentence — and no bar", async () => {
    const host = await mountCards([{ html: PIXEL_ONLY }]);
    const card = host.querySelector(".scast")!;
    const g = glyphOf(card);
    expect(g, "the card head carries no notice glyph").not.toBeNull();
    expect(g!.name).toBe(COPY.pixelCaption);
    expect(g!.description, "aria-describedby does not resolve to the sentence").toBe(COPY.pixelOnly);
    expect(g!.tooltipRole).toBe("tooltip");
    // In the DOM and describable while CLOSED — the fact is stated before anyone hovers.
    expect(g!.tooltipHidden).toBe(true);
    expect(g!.trigger.getAttribute("aria-expanded")).toBe("false");
    // The bar's sentence is gone from the card, and with nothing to load and nothing to adapt the
    // bar itself is gone: no boxed line.
    expect(card.querySelector(".mb-bar-text"), "the sentence is still said as a bar").toBeNull();
    expect(card.querySelector(".mb-bar"), "a bar with nothing in it is still on the card").toBeNull();
    // The glyph sits BEFORE the time, inside the meta line.
    const line = card.querySelector(".sc-line")!;
    const kids = [...line.children].map((el) => el.className.split(" ")[0]);
    expect(kids.indexOf("sc-notice")).toBe(kids.indexOf("t") - 1);
  });

  it("says it in German when the catalogue is German", async () => {
    setActiveCatalog("de", fillFrom(en as never, de as never) as never);
    const host = await mountCards([{ html: PIXEL_ONLY, locale: "de" }]);
    const g = glyphOf(host.querySelector(".scast")!)!;
    expect(g.name).toBe(DE.mailBody!.pixelCaption);
    expect(g.description).toBe(DE.mailBody!.pixelOnly);
  });
});

describe("the three siblings share one component and one caption slot", () => {
  it("pictures refused → Images blocked / the images sentence", async () => {
    const host = await mountCards([{ html: TWO_PICTURES }]);
    const g = glyphOf(host.querySelector(".scast")!)!;
    expect(g.name).toBe(COPY.imagesCaption);
    expect(g.description).toBe(COPY.blockedMany(2));
  });

  it("pictures with a beacon among them → the beacon leads the caption; the sentence keeps both parts", async () => {
    const host = await mountCards([{ html: PICTURES_AND_BEACON }]);
    const g = glyphOf(host.querySelector(".scast")!)!;
    expect(g.name).toBe(COPY.pixelCaption);
    expect(g.description).toBe(`${COPY.blockedMany(3)} ${COPY.pixelOne}`);
  });

  it("a stylesheet refused → Stylesheet blocked / the stylesheet sentence", async () => {
    const host = await mountCards([{ html: SHEET_ONLY }]);
    const g = glyphOf(host.querySelector(".scast")!)!;
    expect(g.name).toBe(COPY.sheetCaption);
    expect(g.description).toBe(COPY.sheetOne);
  });

  it("a message with nothing refused carries no glyph and no bar", async () => {
    const host = await mountCards([{ html: canvas("<p>only words</p>") }]);
    const card = host.querySelector(".scast")!;
    expect(glyphOf(card)).toBeNull();
    expect(card.querySelector(".mb-bar")).toBeNull();
  });
});

describe("Reads with ten such messages", () => {
  it("shows ten glyphs and zero boxed lines; a Receipts card (with an amount) is the same card", async () => {
    const cards: CardOpts[] = Array.from({ length: 10 }, (_, i) => ({
      html: i % 3 === 0 ? PIXEL_ONLY : i % 3 === 1 ? TWO_PICTURES : PICTURES_AND_BEACON,
      amount: i % 2 === 0 ? "CHF 12.00" : undefined,
    }));
    const host = await mountCards(cards);
    expect(host.querySelectorAll(".scast").length).toBe(10);
    expect(host.querySelectorAll(".sc-line .sc-notice .gloss-t").length, "not every card carries the glyph").toBe(10);
    expect(host.querySelectorAll(".mb-bar-text").length, "a boxed line survived in the stream").toBe(0);
    expect(host.querySelectorAll(".mb-bar").length).toBe(0);
    // The amount and the notice share a line and the time stays last.
    const receipt = host.querySelectorAll(".scast")[0]!;
    expect(receipt.querySelector(".sc-line .amt")).not.toBeNull();
    expect(receipt.querySelector(".sc-line")!.lastElementChild!.classList.contains("t")).toBe(true);
  });
});

/* ── 3. the seams ─────────────────────────────────────────────────────────────────────────── */

describe("the seams", () => {
  it("a press on the glyph opens the sentence and does not select or expand the card", async () => {
    const onSelect = vi.fn();
    const host = await mountCards([{ html: PIXEL_ONLY, onSelect }]);
    const card = host.querySelector(".scast")!;
    const g = glyphOf(card)!;
    await act(async () => { g.trigger.click(); });
    expect(glyphOf(card)!.open, "the press did not open the sentence").toBe(true);
    expect(g.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(onSelect, "asking about the notice selected the card").not.toHaveBeenCalled();
    expect(card.classList.contains("open"), "asking about the notice expanded the card").toBe(false);
  });

  it("\"Show images\" keeps its place above the body, without the box and without the sentence", async () => {
    /**
     * THE WHOLE CHROME, not the five members this case read first — and no cast.
     *
     * `resolvedFor` is called at RENDER by every card, so a partial double threw
     * `resolvedFor is not a function` and the case died before asserting anything. The
     * `as unknown as` is what kept it compiling: the cast, not the double, is why the webapp's
     * own test typecheck could not name the missing members. Typed and uncast, a member added to
     * the interface reddens `tsc` rather than the run.
     */
    const asked: Array<{ messageId: string; urls: string[] }> = [];
    const chrome: RemoteImagesChrome = {
      auto: false,
      loadPixels: false,
      proxyFor: () => (url: string) => `/api/img?u=${encodeURIComponent(url)}`,
      consented: () => false,
      consent: () => {},
      /* A PROXY-DOOR CLIENT HOLDS NOTHING: `proxyFor` is the whole mechanism there, and the map
         is empty everywhere but a pipe-door — the shape this card is actually in. */
      resolvedFor: () => new Map<string, string>(),
      needRemote: (messageId, urls) => { asked.push({ messageId, urls: [...urls] }); },
    };
    const host = await mountCards([{ html: TWO_PICTURES, remoteImages: chrome }]);
    const card = host.querySelector(".scast")!;
    expect(glyphOf(card)!.name).toBe(COPY.imagesCaption);
    const bar = card.querySelector<HTMLElement>(".mb-bar");
    expect(bar, "the button lost its row").not.toBeNull();
    expect(bar!.classList.contains("mb-bar-quiet"), "the controls row is still boxed").toBe(true);
    expect(bar!.getAttribute("role"), "a row of controls is not a live region").toBeNull();
    expect(bar!.querySelector(".mb-bar-text")).toBeNull();
    expect(bar!.querySelector(".mb-bar-icon")).toBeNull();
    const btn = [...bar!.querySelectorAll("button")].find((b) => b.textContent === COPY.show);
    expect(btn, "\"Show images\" is gone").toBeTruthy();
    /* AND NOTHING WAS FETCHED. The reader has not consented, so the viewer blanks the pictures
       and offers the button — asking for the bytes here would be the button pressing itself.
       The recording double is what makes that a reading rather than a stub. */
    expect(asked, "the pictures were fetched before anybody pressed Show images").toEqual([]);
  });

  it("the same viewer mounted bare — no host meta line — still says the sentence in its bar", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    hosts.push(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(h(MessageBody, { messageId: "bare", text: "hello", html: PIXEL_ONLY }));
    });
    await settle();
    const bar = host.querySelector(".mb-bar");
    expect(bar, "the reading pane lost its bar").not.toBeNull();
    expect(bar!.getAttribute("role")).toBe("status");
    expect(bar!.classList.contains("mb-bar-quiet")).toBe(false);
    expect(host.querySelector(".mb-bar-text")?.textContent).toBe(COPY.pixelOnly);
    expect(host.querySelector(".mb-bar-icon")).not.toBeNull();
    expect(host.querySelector(".gloss-t"), "a glyph appeared where no host asked for one").toBeNull();
  });
});
