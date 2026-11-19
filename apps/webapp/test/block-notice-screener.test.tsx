/** @vitest-environment jsdom */
/**
 * THE BLOCKING NOTICE ON THE SCREENER's HELD CARD: the Screener's cases of `block-notice-surfaces.test.tsx`, MOVED here
 * as they stood (share reader-1, the switch's older tests): their place, the Screener, is not mounted by the new shell
 * yet, and the reading pane's cases of that file are re-pointed over the new reader. Each case waits for the Screener's
 * mount (`mount-screener`) by its row. The header of the file they came from, for what they hold:
 *
 *  2. THE RENDERS. On each host a message with a beacon refused carries, in its META LINE, a real
 *     button CALLED by the caption and DESCRIBED by the whole sentence — and no `.mb-bar-text`
 *     anywhere. In the Screener card's line it stands right before the time.
 *  3. THE CONTROLS. A message with nothing refused wears no glyph.
 *  4. THE HELD SENDER. A letter in the Screener loads no picture on open on an auto account; the held card keeps Show
 *     images.
 *
 * Mutation-proven at authoring time (each reddens the case named and no other):
 *   · drop `onNotice={setNotice}` from `HeldMail`'s mount              → census + the Screener render
 *   · move the Screener glyph after the time                           → the Screener order case
 *
 * The census's Screener half stands here too: the file's census reads, for the reading column, that the surface that
 * draws a letter through the letter part wears the report in its own chrome; the same reading of the Screener's held
 * letter (`packages/app/src/screener/held/HeldLetter.tsx`, which hands its body `onNotice={() => undefined}` today)
 * waits here for the Screener's mount.
 */
import type { EngineMessage, MessageBodyWire } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { COPY } from "../../../packages/letter-body/src/MessageBody";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../app/shell/locale";
import { imageProxyUrl, useRemoteImages, type RemoteImagesChrome } from "../app/shell/remote-images";
import { settleFirstPaint } from "./_first-paint.js";
import { withBodyDoor } from "./_body-door.js";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// See `sync-liveness-shell.test.ts` for why React is published as a global (the Screener mount).
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

type Catalogue = Record<string, Record<string, string>>;
const DE = de as unknown as Catalogue;
const DE_MERGED = fillFrom(en as never, de as never) as never;

/* ── fixtures: a framed document with a beacon, and one with only words ─────────────────────── */

const SENDER = "images.newsletter.example";
const BEACON = `https://${SENDER}/wf/open?upn=abc`;
const canvas = (inner: string) => `<table width="600"><tr><td><p>hello</p>${inner}</td></tr></table>`;
const PIXEL_ONLY = canvas(`<img src="${BEACON}" width="1" height="1">`);
const ONLY_WORDS = canvas("<p>only words</p>");

const NOW = new Date("2026-08-02T12:00:00.000Z");

function msg(id: string, extra: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: "Acme Store", address: "orders@acme.example" },
    // A recipient, so the header renders its recipients block and the "details" press with it.
    to: [{ name: "Lena Marti", address: "lena@atelier.example" }], cc: [],
    date: "2026-08-01T09:00:00.000Z", folder: "INBOX", snippet: `snippet ${id}`, unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
    ...extra,
  } as unknown as EngineMessage;
}

/* ── mounting ──────────────────────────────────────────────────────────────────────────────── */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

afterEach(async () => {
  await unmount();
  setActiveCatalog(DEFAULT_LOCALE, null);
});
/**
 * The Screener through the real engine and the real state hook (`screener-cloud.test.ts`'s
 * recipe): three held messages, every body hydrated from an adapter whose `fetchBody` answers the
 * beacon document, then the view — so a held card's `MessageBody` frames html the way a live
 * account's does.
 */
async function mountScreener(
  html: string, remoteImages?: RemoteImagesChrome | (() => RemoteImagesChrome | undefined),
): Promise<HTMLDivElement> {
  await unmount();
  const held = [
    msg("m1", { from: { name: null, address: "lena@atelier.example" }, folder: "ohmail/Screener" } as Partial<EngineMessage>),
    msg("m2", { from: { name: null, address: "lena@atelier.example" }, folder: "ohmail/Screener" } as Partial<EngineMessage>),
    msg("m3", { from: { name: null, address: "win@jackpot.example" }, folder: "ohmail/Screener" } as Partial<EngineMessage>),
  ];
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(
    held.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
  );
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async (): Promise<MessageBodyWire> => ({
        text: "FULL BODY", html, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    } as never,
  });
  await engine.start();
  for (const m of held) await engine.hydrateBody(m.id);

  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { useKeyBindings } = await import("@ohmail/app-logic/keys/keymap");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    useKeyBindings([{ chord: "?", group: "app", label: "Keyboard shortcuts", run: () => {} }], "global");
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText());
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    // A hook is the shell's own chrome, called here as `AppShell` calls it.
    const chrome = typeof remoteImages === "function" ? remoteImages() : remoteImages;
    return h(ScreenerView, {
      owed: false,
      state, segment: "waiting", selection: sel as never,
      onSelect: (seg: string, id: string | null) => setSel((m) => ({ ...m, [seg]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {}, remoteImages: chrome,
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, { storageKey: null, children: withBodyDoor(engine, h(KeymapProvider, { children: h(Probe) })) }),
      }),
    );
  });
  await settle();
  await settleFirstPaint();
  return host;
}

/** The glyph inside a meta line, with what a reader is told about it. */
function glyphIn(line: Element | null) {
  const trigger = line?.querySelector<HTMLButtonElement>(".mb-notice .gloss-t") ?? null;
  if (!trigger) return null;
  const describedBy = trigger.getAttribute("aria-describedby");
  const tooltip = describedBy ? document.querySelector<HTMLElement>(`[id="${describedBy}"]`) : null;
  return {
    trigger,
    name: trigger.querySelector(".gloss-cap")?.textContent ?? "",
    description: tooltip?.textContent ?? null,
    tooltipRole: tooltip?.getAttribute("role") ?? null,
    tooltipHidden: tooltip?.hidden ?? null,
  };
}

/** First-class index of a child by its FIRST class name, or -1. */
const at = (parent: Element, cls: string): number =>
  [...parent.children].findIndex((el) => el.classList.contains(cls));

/* ── 1. the census: the Screener's half ──────────────────────────────────────────────────────── */

const APP_SRC = resolve(process.cwd(), "packages/app/src");

describe("the census: every host that mounts the viewer passes onNotice", () => {
  it("every host wears the report somewhere in its own chrome: the Screener's held letter", () => {
    for (const rel of ["screener/held/HeldLetter.tsx"]) {
      const src = readFileSync(resolve(APP_SRC, rel), "utf8");
      // The reading column hands it to its head (`notice={notice}`); the kit draws it (`BlockedImages`).
      expect(/BlockedImages|notice=\{notice\}/.test(src), `${rel} takes the report and renders nothing with it`).toBe(true);
    }
  });
});


describe("the Screener's held card", () => {
  it("wears the glyph in its head line, right before the time — and no bar", async () => {
    const el = await mountScreener(PIXEL_ONLY);
    const cards = [...el.querySelectorAll(".view-screener .hmail")];
    expect(cards.length, "the premise: the selected sender's held mail is on screen").toBeGreaterThan(0);
    for (const card of cards) {
      const line = card.querySelector(".hm-line")!;
      const g = glyphIn(line);
      expect(g, "the held card's line carries no notice glyph").not.toBeNull();
      expect(g!.name).toBe(COPY.pixelCaption);
      expect(g!.description).toBe(COPY.pixelOnly);
      expect(g!.tooltipRole).toBe("tooltip");
      // The glyph leads into the time: it is the time's immediate predecessor in the line.
      expect(at(line, "mb-notice"), "the notice is not right before the time").toBe(at(line, "t") - 1);
      // Only the dark toggle's slot may follow the time: in a dark theme "Original" stands right of
      // the date (DESIGN-FOLD-WIDTHS); in this light theme the slot is empty.
      const afterTime = [...line.children].slice(at(line, "t") + 1);
      expect(afterTime.every((e) => e.classList.contains("hm-adapt")), "the time lost its corner").toBe(true);
      expect(card.querySelector(".mb-bar-text"), "the sentence is still said as a bar").toBeNull();
    }
  });

  it("a held message with nothing refused wears no glyph", async () => {
    const el = await mountScreener(ONLY_WORDS);
    const cards = [...el.querySelectorAll(".view-screener .hmail")];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(glyphIn(card.querySelector(".hm-line"))).toBeNull();
  });
});

/* ── 4. a sender not let in: its pictures wait for a press, on an account that loads them on open ──── */

const PICTURED = canvas(`<img src="https://${SENDER}/hero.png" width="600" height="200">`);
const NO_PICTURES: ReadonlyMap<string, string> = new Map();

/** An account that loads pictures on open, through the proxy on this origin; each Show images press lands in `pressed`. */
function autoChrome(pressed: string[] = []): RemoteImagesChrome {
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
  it("the Screener's held cards name no proxied picture and offer Show images, which asks for that letter", async () => {
    const pressed: string[] = [];
    const el = await mountScreener(PICTURED, autoChrome(pressed));
    const card = el.querySelector<HTMLElement>(".view-screener .hmail[data-sid]");
    expect(card, "the premise: a held letter is on screen").not.toBeNull();
    expect(proxiedIn(el), "a held sender's picture was asked for on open").toEqual([]);
    const show = [...card!.querySelectorAll("button")].find((b) => b.textContent === COPY.show);
    expect(show, "the held card offers no Show images").toBeTruthy();
    await act(async () => { show!.click(); });
    expect(pressed).toEqual([card!.dataset.sid]);
  });

  it("on a door that fetches its own pictures, a held card's Show images loads them into the card", async () => {
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const recorded: string[] = [];
    const fetched: string[] = [];
    const proxies = new Map<string, (url: string) => string>();
    const el = await mountScreener(PICTURED, function useDesktopChrome() {
      const real = useRemoteImages({
        onFailed: () => {}, mode: "auto", loadPixels: false,
        wire: {
          fetch: async (id, url) => { fetched.push(`${id} ${url}`); await new Promise((r) => setTimeout(r, 0)); return PNG; },
          record: async (id) => { recorded.push(id); },
        },
      });
      // The desktop's `tauri://localhost` window (macOS, Linux): no proxy source a frame could name.
      const tauri = (id: string) => {
        if (!proxies.has(id)) proxies.set(id, (url) => imageProxyUrl("", "tauri://localhost", id, url));
        return proxies.get(id)!;
      };
      return React.useMemo(() => real && { ...real, proxyFor: tauri }, [real]);
    });
    const sid = el.querySelector<HTMLElement>(".view-screener .hmail[data-sid]")?.dataset.sid;
    const card = () => el.querySelector<HTMLElement>(`.view-screener .hmail[data-sid="${sid}"]`)!;
    expect(sid, "the premise: a held letter is on screen").toBeTruthy();
    const show = [...card().querySelectorAll("button")].find((b) => b.textContent === COPY.show);
    expect(show, "the held card offers no Show images").toBeTruthy();
    expect(fetched, "a held sender's picture was fetched on open").toEqual([]);
    await act(async () => { show!.click(); });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
      await settle();
    }
    expect(recorded).toEqual([sid]);
    expect(fetched).toEqual([`${sid} https://${SENDER}/hero.png`]);
    const drawn = [...new DOMParser().parseFromString(card().querySelector("iframe")?.getAttribute("srcdoc") ?? "", "text/html")
      .querySelectorAll("img")].filter((img) => img.getAttribute("src") === PNG);
    expect(drawn.length, "the fetched picture never reached the card").toBe(1);
  });
});
