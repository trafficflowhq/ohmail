/** @vitest-environment jsdom */
/**
 * THE BLOCKING NOTICE WEARS ONE SHAPE ON EVERY SURFACE.
 *
 * `tracking-notice.test.tsx` moved "A tracking pixel was blocked." out of the bar above a stream
 * card and into the card's head as a glyph with a two-word caption (`BlockNoticeGloss`). This file
 * holds the OTHER three surfaces to the same shape — the reading pane and a conversation panel,
 * which share `MessageHeader`, and the Screener's held card — so one fact is said one way wherever
 * a message is rendered.
 *
 *  1. THE CENSUS. Every file under `app/` that mounts the viewer (`<MessageBody`) is a known host,
 *     and every mount passes `onNotice`. Red before this slice: three of four did not.
 *  2. THE RENDERS. On each host a message with a beacon refused carries, in its META LINE, a real
 *     button CALLED by the caption and DESCRIBED by the whole sentence — and no `.mb-bar-text`
 *     anywhere. In the message header the glyph leads the right cluster (before the ⋯ menu and the
 *     stamp, whose order `conversation.test.ts` holds); in the Screener card's line it stands right
 *     before the time. The header's "details" block prints the sentence in full.
 *  3. THE CONTROLS. A message with nothing refused wears no glyph and prints no sentence; German
 *     reads the German caption and sentence. The bare-mount fallback is `tracking-notice.test.tsx`'s
 *     and is not restated here.
 *  4. THE HELD SENDER. A letter in the Screener, Screened out or Spam loads no picture on open on an
 *     auto account; the held card keeps Show images, and an Ohbox letter's pictures load.
 *
 * Mutation-proven at authoring time (each reddens the case named and no other):
 *   · drop `onNotice={onNotice}` from `MessagePane`'s mount           → census + the pane render
 *   · drop the `<BlockNoticeGloss>` from `MessageHeader`'s cluster     → pane + panel renders
 *   · drop the `.msg-rcpt-notice` row from the details `<dl>`          → the two details cases
 *   · drop `onNotice={setNotice}` from `HeldMail`'s mount              → census + the Screener render
 *   · move the Screener glyph after the time                           → the Screener order case
 *   · move the header glyph after the ⋯ menu                           → the pane order case
 */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineMessage,
  type MessageBodyWire,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { COPY } from "../app/components/MessageBody";
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
 * The reading pane through its chrome, exactly as `conversation.test.ts` drives it: `bodyOf`
 * answers `full` with the html given, `conversationOf` the thread given, and `openReply`/`forward`
 * are present so the header's ⋯ menu renders and the cluster's order can be read.
 */
async function mountPane(
  open: EngineMessage,
  opts: { conversation?: EngineMessage[]; html?: string; locale?: "en" | "de"; remoteImages?: RemoteImagesChrome } = {},
): Promise<HTMLDivElement> {
  await unmount();
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  const conversation = opts.conversation ?? [];
  const html = opts.html ?? PIXEL_ONLY;
  const locale = opts.locale ?? "en";
  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale, messages: locale === "de" ? DE_MERGED : en, timeZone: "UTC", now: NOW,
        children: h(MessageChromeProvider as never, {
          value: {
            ownAddresses: ["me@x.invalid"],
            absoluteTime: false,
            onToggleAbsoluteTime: () => {},
            replyTo: null,
            replyBody: { text: "", html: "" },
            onReplyBody: () => {},
            closeReply: () => {},
            sendReply: () => {},
            replySendState: () => ({ phase: "idle" }),
            openSenderMenu: () => {},
            openAttachmentPreview: () => {},
            conversationOf: () => conversation,
            bodyOf: (m: EngineMessage) => ({
              text: m.snippet, state: "full", html, loadedRemoteContent: false,
              unsubscribe: "no_header", unsubscribeUrl: null,
            }),
            hydrateBody: () => {}, hydrateBodies: () => {},
            hydrateThread: () => {},
            openReply: () => {},
            forward: () => {},
            remoteImages: opts.remoteImages,
          },
          children: h(MessagePane as never, {
            message: open, tags: [], now: NOW, onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
          } as never),
        } as never),
      }),
    );
  });
  await settle();
  await settleFirstPaint();
  return host;
}

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

  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider, useKeyBindings } = await import("../app/shell/keymap.js");

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    useKeyBindings([{ chord: "?", group: "app", label: "Keyboard shortcuts", run: () => {} }], "global");
    const state = useScreenerState(engine, v, (() => {}) as never);
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

/* ── 1. the census ────────────────────────────────────────────────────────────────────────── */

const APP = resolve(process.cwd(), "apps/webapp/app");
const VIEWER = "components/MessageBody.tsx";
/** Every product surface that mounts the viewer — the FOUR hosts. */
const HOSTS = [
  "shell/MessageCard.tsx",
  "shell/MessagePane.tsx",
  "shell/StreamCardMemo.tsx",
  "views/ScreenerView.tsx",
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

const MOUNT = /<MessageBody(?:View)?\b[\s\S]*?\/>/g;

describe("the census: every host that mounts the viewer passes onNotice", () => {
  it("every file under app/ that mounts <MessageBody> is a known host", () => {
    const mounting = walk(APP)
      .filter((p) => relative(APP, p) !== VIEWER)
      .filter((p) => /<MessageBody(?:View)?\b/.test(readFileSync(p, "utf8")))
      .map((p) => relative(APP, p))
      .sort();
    expect(mounting, "a surface mounts the viewer and is not in HOSTS — add it here and hold it below").toEqual(HOSTS);
  });

  it("every mount on every host passes onNotice", () => {
    const missing: string[] = [];
    for (const rel of HOSTS) {
      const src = readFileSync(join(APP, rel), "utf8");
      const mounts = src.match(MOUNT) ?? [];
      expect(mounts.length, `${rel}: no <MessageBody …/> mount parsed — the census regex lost the host`).toBeGreaterThan(0);
      for (const tag of mounts) if (!/\bonNotice=/.test(tag)) missing.push(rel);
    }
    expect(missing, "host(s) still leaving the sentence to the bar").toEqual([]);
  });

  it("every host wears the report somewhere in its own chrome", () => {
    for (const rel of HOSTS) {
      const src = readFileSync(join(APP, rel), "utf8");
      // The header hosts hand it to `MessageHeader` (`notice={notice}`); the stream card and the
      // Screener card render the glyph themselves.
      expect(/BlockNoticeGloss|notice=\{notice\}/.test(src), `${rel} takes the report and renders nothing with it`).toBe(true);
    }
  });
});

/* ── 2. the renders ───────────────────────────────────────────────────────────────────────── */

describe("the reading pane", () => {
  it("wears the glyph in its header's right cluster, before the ⋯ menu and the stamp — and no bar", async () => {
    const el = await mountPane(msg("solo"));
    const t = el.querySelector(".msg-from .t")!;
    expect(t, "the premise: the focused message rendered its header").not.toBeNull();
    const g = glyphIn(t);
    expect(g, "the header carries no notice glyph").not.toBeNull();
    expect(g!.name).toBe(COPY.pixelCaption);
    expect(g!.description, "aria-describedby does not resolve to the sentence").toBe(COPY.pixelOnly);
    expect(g!.tooltipRole).toBe("tooltip");
    expect(g!.tooltipHidden, "the sentence is stated while closed").toBe(true);
    // Fact before controls: notice, then the menu, then the stamp (the order conversation.test holds).
    const notice = at(t, "mb-notice");
    const menu = at(t, "msg-menu");
    const stamp = at(t, "stamp-toggle");
    expect(notice, "no notice in the cluster").toBeGreaterThanOrEqual(0);
    expect(menu, "no ⋯ menu in the cluster (the chrome offers openReply)").toBeGreaterThanOrEqual(0);
    expect(stamp, "no stamp in the cluster").toBeGreaterThanOrEqual(0);
    expect(notice, "the notice does not lead the cluster").toBeLessThan(menu);
    expect(menu).toBeLessThan(stamp);
    // The sentence left the bar, and with nothing to load and nothing to adapt the bar is gone.
    expect(el.querySelector(".mb-bar-text"), "the sentence is still said as a bar").toBeNull();
    expect(el.querySelector(".mb-bar"), "a bar with nothing in it is still on the pane").toBeNull();
  });

  it("prints the sentence in full under \"details\", beside the exact date", async () => {
    const el = await mountPane(msg("solo"));
    expect(el.querySelector(".msg-rcpt-full")).toBeNull();
    const more = el.querySelector<HTMLButtonElement>(".msg-rcpt-more")!;
    expect(more, "the premise: a recipient renders the details press").not.toBeNull();
    await act(async () => { more.click(); });
    const full = el.querySelector(".msg-rcpt-full")!;
    expect(full.querySelector(".msg-rcpt-notice")?.textContent, "details does not print the sentence").toBe(COPY.pixelOnly);
    // The exact date is still there beside it (its wording is `conversation.test.ts`'s claim).
    expect(full.querySelector("time"), "the date left the details block").not.toBeNull();
  });

  it("a message with nothing refused wears no glyph and prints no sentence", async () => {
    const el = await mountPane(msg("plain"), { html: ONLY_WORDS });
    expect(glyphIn(el.querySelector(".msg-from .t"))).toBeNull();
    await act(async () => { el.querySelector<HTMLButtonElement>(".msg-rcpt-more")!.click(); });
    expect(el.querySelector(".msg-rcpt-notice"), "a sentence about a block that did not happen").toBeNull();
    expect(el.querySelector(".mb-bar")).toBeNull();
  });

  it("says it in German when the catalogue is German", async () => {
    setActiveCatalog("de", DE_MERGED);
    const el = await mountPane(msg("solo"), { locale: "de" });
    const g = glyphIn(el.querySelector(".msg-from .t"))!;
    expect(g.name).toBe(DE.mailBody!.pixelCaption);
    expect(g.description).toBe(DE.mailBody!.pixelOnly);
    await act(async () => { el.querySelector<HTMLButtonElement>(".msg-rcpt-more")!.click(); });
    expect(el.querySelector(".msg-rcpt-notice")?.textContent).toBe(DE.mailBody!.pixelOnly);
  });
});

describe("a conversation's panels", () => {
  const A = msg("a", { threadId: "t1", date: "2026-08-01T09:00:00.000Z" } as Partial<EngineMessage>);
  const B = msg("b", { threadId: "t1", date: "2026-08-01T10:00:00.000Z" } as Partial<EngineMessage>);
  const C = msg("c", { threadId: "t1", date: "2026-08-01T11:00:00.000Z" } as Partial<EngineMessage>);

  it("every panel — the focused one and its siblings — wears the glyph in its header; no panel wears a bar", async () => {
    const el = await mountPane(B, { conversation: [A, B, C] });
    const panels = [...el.querySelectorAll(".pm")];
    expect(panels.length, "the premise: three panels").toBe(3);
    for (const panel of panels) {
      const g = glyphIn(panel.querySelector(".msg-from .t"));
      expect(g, `panel ${panel.getAttribute("data-conv-id")} carries no notice glyph`).not.toBeNull();
      expect(g!.name).toBe(COPY.pixelCaption);
      expect(g!.description).toBe(COPY.pixelOnly);
    }
    expect(el.querySelectorAll(".mb-bar-text").length, "a boxed line survived on a panel").toBe(0);
    expect(el.querySelectorAll(".mb-bar").length).toBe(0);
  });

  it("a sibling panel's \"details\" prints the sentence in full", async () => {
    const el = await mountPane(B, { conversation: [A, B, C] });
    const sibling = el.querySelector('.pm[data-conv-id="a"]:not(.conv-focus)')!;
    expect(sibling, "the premise: an older sibling panel").not.toBeNull();
    await act(async () => { sibling.querySelector<HTMLButtonElement>(".msg-rcpt-more")!.click(); });
    expect(sibling.querySelector(".msg-rcpt-notice")?.textContent).toBe(COPY.pixelOnly);
    // Only the pressed panel opened.
    expect(el.querySelectorAll(".msg-rcpt-notice").length).toBe(1);
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
        fetchImage: async (id, url) => { fetched.push(`${id} ${url}`); await new Promise((r) => setTimeout(r, 0)); return PNG; },
        recordRemote: async (id) => { recorded.push(id); },
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

  it("the reading pane holds a screened-out letter's pictures; an Ohbox letter's load (control)", async () => {
    const held = await mountPane(msg("p1", { folder: "ohmail/Screened" }), { html: PICTURED, remoteImages: autoChrome() });
    expect(proxiedIn(held), "a screened-out sender's picture was asked for on open").toEqual([]);
    const ohbox = await mountPane(msg("p2"), { html: PICTURED, remoteImages: autoChrome() });
    expect(proxiedIn(ohbox).length, "CONTROL: the Ohbox letter asked for none").toBeGreaterThan(0);
  });
});
