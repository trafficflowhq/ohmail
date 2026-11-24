/** @vitest-environment jsdom */
/**
 * THE BLOCKING NOTICE WEARS ONE SHAPE ON EVERY SURFACE.
 *
 * `tracking-notice.test.tsx` moved "A tracking pixel was blocked." out of the bar above a stream
 * card and into the card's head as a glyph with a two-word caption (`BlockNoticeGloss`). This file
 * holds the reading column to the same shape — the open letter and each letter of its conversation —
 * so one fact is said one way wherever a message is rendered.
 *
 *  1. THE CENSUS. Every file of the app that draws a letter's text through the viewer is a known host,
 *     and every mount passes `onNotice`, and every host wears the report.
 *  2. THE RENDERS. A message with a beacon refused carries, in its head, a real button CALLED by the
 *     caption — and no `.mb-bar-text` anywhere. In the message head the glyph leads the right cluster
 *     (before the ⋯ menu and the stamp). The sentence is printed in full.
 *  3. THE CONTROLS. A message with nothing refused wears no glyph and prints no sentence; German
 *     reads the German caption and sentence.
 *  4. THE HELD SENDER. A letter Screened out loads no picture on open on an auto account; an Ohbox
 *     letter's pictures load.
 *
 * RE-POINTED (share reader-1, the switch's older tests): these cases mounted today's `MessagePane` under a
 * `MessageChromeProvider`; they now mount the reading column the new shell mounts (`_reader-1-letters.tsx`: the
 * frame, the reader with the letter's real body renderer, a fake engine whose mirror holds each letter's body row),
 * each claim as it stood. Where the studio's head says it otherwise, the case follows the studio and says so: the
 * glyph is the kit's chip (`BlockedImages`), and the whole sentence is printed in the chip's card on a press ("the
 * sentence only when asked"), no longer as a tooltip's description or a line of "details". The census reads the
 * files that now draw a letter (`packages/app/src/`: the reading column's `Letter.tsx` and the Screener's held letter,
 * each through the letter part; the part's adapter `reader/body/LetterBody.tsx` is the viewer as the old census's
 * `MessageBody.tsx` was); its Screener half, and the Screener's held card cases, moved as they stood to
 * `block-notice-screener.test.tsx` (their place is not mounted yet). Every address is invented.
 */
import type { EngineMessage } from "@ohmail/wire";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PictureSeam } from "@ohmail/app-logic/reader";
import { imageProxyUrl } from "@ohmail/app-logic/reader/remote-images";
import { letterBody } from "../../../packages/app/src/reader/body/index.js";
import readerDe from "../../../packages/app/messages/reader.de.json" with { type: "json" };
import { READER_EN, letter, letterOf, mountLetters } from "./_reader-1-letters.js";

/* The reader stamps in Intl's zone: the case pins it. */
process.env.TZ = "UTC";

/** The body's sentences, in the reader's own catalogue (the words the letter body is handed). */
const COPY = READER_EN.mailBody;
const DE = readerDe.mailBody;

/* ── fixtures: a framed document with a beacon, and one with only words ─────────────────────── */

const SENDER = "images.newsletter.example";
const BEACON = `https://${SENDER}/wf/open?upn=abc`;
const canvas = (inner: string) => `<table width="600"><tr><td><p>hello</p>${inner}</td></tr></table>`;
const PIXEL_ONLY = canvas(`<img src="${BEACON}" width="1" height="1">`);
const ONLY_WORDS = canvas("<p>only words</p>");

function msg(id: string, extra: Partial<EngineMessage> = {}): EngineMessage {
  return {
    ...letter(id, {
      subject: `Subject ${id}`,
      from: { name: "Acme Store", address: "orders@acme.example" },
      // A recipient, so the head renders its recipients line and the "details" press with it.
      to: [{ name: "Lena Marti", address: "lena@atelier.example" }],
      date: "2026-08-01T09:00:00.000Z",
      unread: false,
      ...extra,
    }),
    // The text is the mirror's body row, as the shell hands it.
    body: undefined,
  } as unknown as EngineMessage;
}

/* ── mounting ──────────────────────────────────────────────────────────────────────────────── */

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
});

/**
 * The reading column with `open` open over `conversation` (or the letter alone): every letter's body row answers
 * `ready` with the html given, drawn by the letter's real renderer.
 */
async function mountPane(
  open: EngineMessage,
  opts: { conversation?: EngineMessage[]; html?: string; locale?: "en" | "de"; remoteImages?: PictureSeam } = {},
): Promise<HTMLElement> {
  cleanup();
  const letters = opts.conversation ?? [open];
  const html = opts.html ?? PIXEL_ONLY;
  mountLetters({
    letters,
    open: open.id,
    lang: opts.locale ?? "en",
    parts: { body: letterBody, ...(opts.remoteImages ? { pictures: opts.remoteImages } : {}) },
    bodies: Object.fromEntries(letters.map((m) => [m.id, { state: "ready", text: m.snippet, html }])),
  });
  await new Promise((r) => setTimeout(r, 0));
  return document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]') ?? document.body;
}

/** The glyph in a letter's head, with what a reader is told about it on a press. */
function glyphIn(head: Element | null, caption: string) {
  const trigger = head ? within(head as HTMLElement).queryByRole("button", { name: caption }) : null;
  if (!trigger) return null;
  return { trigger, name: trigger.getAttribute("aria-label"), words: trigger.textContent };
}
/** The sentence the glyph's card prints in full, with the card open (pressed once). */
function sentenceOf(glyph: { trigger: HTMLElement }, caption: string): string | null {
  fireEvent.click(glyph.trigger);
  const card = screen.queryByRole("dialog", { name: caption });
  const said = card ? (within(card).queryByRole("note")?.textContent ?? null) : null;
  fireEvent.keyDown(card ?? document.body, { key: "Escape" });
  return said;
}
/** A letter's head: its sender line, its tools and its recipients. */
const headOf = (id: string): HTMLElement | null => letterOf(id)?.querySelector<HTMLElement>("header") ?? null;
/** The head's right cluster, in order: the glyph, the letter's menu, the stamp. */
const cluster = (head: Element): Element[] => [...(head.querySelector("button[aria-haspopup='menu']")?.parentElement?.children ?? [])];
/** Where a part stands in the cluster: the glyph's box, the menu ("Message"), the stamp (its time). */
const at = (head: Element, part: "notice" | "menu" | "stamp"): number =>
  cluster(head).findIndex((el) =>
    part === "notice" ? el.querySelector(".oh-blocked") !== null
      : part === "menu" ? el.getAttribute("aria-label") === "Message"
        : el.querySelector("time") !== null);
/** The "details" press under the recipients. */
const detailsOf = (id: string): HTMLButtonElement | null =>
  within(headOf(id)!).queryByRole("button", { name: READER_EN.message.detailsAriaDate }) as HTMLButtonElement | null;

/* ── 1. the census ────────────────────────────────────────────────────────────────────────── */

const APP = resolve(process.cwd(), "packages/app/src");
/** The viewer as the app mounts it: the letter part's renderer (the old census's `MessageBody.tsx`). */
const VIEWER = "reader/body/LetterBody.tsx";
/** Every product surface that draws a letter through the viewer (the letter part a shell hands). */
const HOSTS = [
  "reader/Letter.tsx",
  "reader/entry.tsx",
  "screener/held/HeldLetter.tsx",
].sort();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** A mount of the viewer: `<MessageBody … />`, or the letter part a shell hands, drawn as `<Body … />`. */
const MOUNT = /<(?:MessageBody(?:View)?|Body)\b[\s\S]*?\/>/g;
/** A file draws the viewer: it mounts `MessageBody`, or the letter part (`parts.body`, `letters.body`). */
const DRAWS = /<MessageBody(?:View)?\b|=\s*(?:parts|letters)\.body\b/;

describe("the census: every host that mounts the viewer passes onNotice", () => {
  it("every file under app/ that mounts <MessageBody> is a known host", () => {
    const mounting = walk(APP)
      .filter((p) => relative(APP, p) !== VIEWER)
      .filter((p) => DRAWS.test(readFileSync(p, "utf8")))
      .map((p) => relative(APP, p))
      .sort();
    expect(mounting, "a surface mounts the viewer and is not in HOSTS — add it here and hold it below").toEqual(HOSTS);
  });

  it("every mount on every host passes onNotice", () => {
    const missing: string[] = [];
    for (const rel of HOSTS) {
      const src = readFileSync(join(APP, rel), "utf8");
      const mounts = (src.match(MOUNT) ?? []).filter((tag) => /^<(?:MessageBody|Body)\b/.test(tag));
      expect(mounts.length, `${rel}: no <MessageBody …/> mount parsed — the census regex lost the host`).toBeGreaterThan(0);
      for (const tag of mounts) if (!/\bonNotice=/.test(tag)) missing.push(rel);
    }
    expect(missing, "host(s) still leaving the sentence to the bar").toEqual([]);
  });

  it("every host wears the report somewhere in its own chrome", () => {
    // The Screener's held letter's half stands in `block-notice-screener.test.tsx`, waiting for its mount.
    for (const rel of HOSTS.filter((h) => h.startsWith("reader/"))) {
      const src = readFileSync(join(APP, rel), "utf8");
      // The reading column hands it to its head (`notice={notice}`), or limits it to HTML previews. The kit draws it (`BlockedImages`).
      expect(/BlockedImages|notice=\{(?:html \? )?notice(?: : null)?\}/.test(src), `${rel} takes the report and renders nothing with it`).toBe(true);
    }
  });
});

/* ── 2. the renders ───────────────────────────────────────────────────────────────────────── */

describe("the reading pane", () => {
  it("wears the glyph in its header's right cluster, before the ⋯ menu and the stamp — and no bar", async () => {
    const el = await mountPane(msg("solo"));
    const t = headOf("solo")!;
    expect(t, "the premise: the focused message rendered its header").not.toBeNull();
    const g = glyphIn(t, COPY.pixelCaption);
    expect(g, "the header carries no notice glyph").not.toBeNull();
    expect(g!.name).toBe(COPY.pixelCaption);
    expect(g!.words).toBe("");
    // The full sentence is on hover and in the opened card.
    expect(g!.trigger.getAttribute("title")).toBe(COPY.pixelOnly);
    expect(screen.queryByText(COPY.pixelOnly), "the sentence is stated while closed").toBeNull();
    expect(sentenceOf(g!, COPY.pixelCaption), "the chip's card does not print the sentence").toBe(COPY.pixelOnly);
    // Fact before controls: notice, then the menu, then the stamp (the order conversation.test holds).
    const notice = at(t, "notice");
    const menu = at(t, "menu");
    const stamp = at(t, "stamp");
    expect(notice, "no notice in the cluster").toBeGreaterThanOrEqual(0);
    expect(menu, "no ⋯ menu in the cluster").toBeGreaterThanOrEqual(0);
    expect(stamp, "no stamp in the cluster").toBeGreaterThanOrEqual(0);
    expect(notice, "the notice does not lead the cluster").toBeLessThan(menu);
    expect(menu).toBeLessThan(stamp);
    // The sentence left the bar, and with nothing to load and nothing to adapt the bar is gone.
    expect(el.querySelector(".mb-bar-text"), "the sentence is still said as a bar").toBeNull();
    expect(el.querySelector(".mb-bar"), "a bar with nothing in it is still on the pane").toBeNull();
  });

  it("prints the sentence in full under \"details\", beside the exact date", async () => {
    await mountPane(msg("solo"));
    const more = detailsOf("solo");
    expect(more, "the premise: a recipient renders the details press").not.toBeNull();
    fireEvent.click(more!);
    // The exact date is there in details (its wording is `conversation.test.ts`'s claim).
    expect(within(headOf("solo")!).queryByText("Sat 1 Aug 2026, 09:00", { exact: false }), "the date left the details block").not.toBeNull();
    // The sentence in full: in the studio's head it is the glyph's card, one press away.
    expect(sentenceOf(glyphIn(headOf("solo"), COPY.pixelCaption)!, COPY.pixelCaption), "details does not print the sentence").toBe(COPY.pixelOnly);
  });

  it("a message with nothing refused wears no glyph and prints no sentence", async () => {
    const el = await mountPane(msg("plain"), { html: ONLY_WORDS });
    expect(glyphIn(headOf("plain"), COPY.pixelCaption)).toBeNull();
    expect(headOf("plain")!.querySelector(".oh-blocked"), "a chip of another caption").toBeNull();
    fireEvent.click(detailsOf("plain")!);
    expect(screen.queryByText(COPY.pixelOnly), "a sentence about a block that did not happen").toBeNull();
    expect(el.querySelector(".mb-bar")).toBeNull();
  });

  it("says it in German when the catalogue is German", async () => {
    await mountPane(msg("solo"), { locale: "de" });
    const g = glyphIn(headOf("solo"), DE.pixelCaption)!;
    expect(g.name).toBe(DE.pixelCaption);
    expect(g.words).toBe("");
    expect(g.trigger.getAttribute("title")).toBe(DE.pixelOnly);
    expect(sentenceOf(g, DE.pixelCaption)).toBe(DE.pixelOnly);
  });
});

describe("a conversation's panels", () => {
  const A = msg("a", { threadId: "t1", date: "2026-08-01T09:00:00.000Z" } as Partial<EngineMessage>);
  const B = msg("b", { threadId: "t1", date: "2026-08-01T10:00:00.000Z" } as Partial<EngineMessage>);
  const C = msg("c", { threadId: "t1", date: "2026-08-01T11:00:00.000Z" } as Partial<EngineMessage>);

  it("every panel — the focused one and its siblings — wears the glyph in its header; no panel wears a bar", async () => {
    const el = await mountPane(B, { conversation: [A, B, C] });
    const panels = [...el.querySelectorAll<HTMLElement>("[data-conv-id]")];
    expect(panels.length, "the premise: three panels").toBe(3);
    for (const panel of panels) {
      const g = glyphIn(panel.querySelector("header"), COPY.pixelCaption);
      expect(g, `panel ${panel.getAttribute("data-conv-id")} carries no notice glyph`).not.toBeNull();
      expect(g!.name).toBe(COPY.pixelCaption);
      expect(g!.words).toBe("");
      expect(sentenceOf(g!, COPY.pixelCaption)).toBe(COPY.pixelOnly);
    }
    expect(el.querySelectorAll(".mb-bar-text").length, "a boxed line survived on a panel").toBe(0);
    expect(el.querySelectorAll(".mb-bar").length).toBe(0);
  });

  it("a sibling panel's \"details\" prints the sentence in full", async () => {
    await mountPane(B, { conversation: [A, B, C] });
    const sibling = letterOf("a")!;
    expect(sibling.getAttribute("aria-current"), "the premise: an older sibling panel").toBeNull();
    fireEvent.click(glyphIn(headOf("a"), COPY.pixelCaption)!.trigger);
    const card = screen.getByRole("dialog", { name: COPY.pixelCaption });
    expect(within(card).getByRole("note").textContent).toBe(COPY.pixelOnly);
    // Only the pressed panel opened.
    expect(screen.getAllByRole("dialog", { name: COPY.pixelCaption }).length).toBe(1);
    expect(within(headOf("a")!).getByRole("button", { name: COPY.pixelCaption }).getAttribute("aria-expanded")).toBe("true");
  });
});

/* ── 4. a sender not let in: its pictures wait for a press, on an account that loads them on open ──── */

const PICTURED = canvas(`<img src="https://${SENDER}/hero.png" width="600" height="200">`);
const NO_PICTURES: ReadonlyMap<string, string> = new Map();

/** An account that loads pictures on open, through the proxy on this origin; each Show images press lands in `pressed`. */
function autoChrome(pressed: string[] = []): PictureSeam {
  const proxies = new Map<string, (url: string) => string>();
  return {
    auto: true, loadPixels: false,
    proxyFor: (id) => {
      if (!proxies.has(id)) proxies.set(id, (url) => imageProxyUrl("/api", window.location.origin, id, url));
      return proxies.get(id)!;
    },
    consented: () => false,
    consent: (id) => { pressed.push(id); },
    resolvedFor: () => NO_PICTURES,
    needRemote: () => {},
  };
}

/** Every proxied picture the frames under `el` name, parked or live. */
function proxiedIn(el: Element): string[] {
  return [...el.querySelectorAll("iframe")].flatMap((f) =>
    [...new DOMParser().parseFromString(f.getAttribute("srcdoc") ?? "", "text/html").querySelectorAll("img")]
      .map((img) => img.getAttribute("data-ohmail-src") ?? img.getAttribute("src") ?? "")
      .filter((src) => src.includes("/api/img")));
}

describe("a sender not let in", () => {
  it("the reading pane holds a screened-out letter's pictures; an Ohbox letter's load (control)", async () => {
    const held = await mountPane(msg("p1", { folder: "ohmail/Screened" }), { html: PICTURED, remoteImages: autoChrome() });
    expect(proxiedIn(held), "a screened-out sender's picture was asked for on open").toEqual([]);
    const ohbox = await mountPane(msg("p2"), { html: PICTURED, remoteImages: autoChrome() });
    expect(proxiedIn(ohbox).length, "CONTROL: the Ohbox letter asked for none").toBeGreaterThan(0);
  });
});
