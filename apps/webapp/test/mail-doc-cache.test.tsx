/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import DOMPurify from "dompurify";
import { OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";
import { MessageBody } from "../app/components/MessageBody";
import {
  forgetMailDocs, mailDocCacheFor, MAIL_DOC_ENTRIES_MAX, type MailDocInputs,
} from "../app/components/mail-doc-cache";
import { EngineProvider } from "../app/shell/engine";
import { registerSyncGate, type SyncGate, type SyncIdentity } from "../app/shell/sync-scheduler";

/**
 * THE SANITIZED DOCUMENT IS KEPT PER ENGINE, AND SERVED ONLY FOR THE INPUTS IT WAS MADE FROM
 * (`mail-doc-cache.ts`). A switch into News re-sanitized every card's body; a revisit now reads the
 * document back. What a keep must never do is serve a document past a change that alters it — the
 * reader's consent, the pixel switch, the letter's own pictures, the theme — or serve one account's
 * document to another, or hand out proxied picture addresses once the window may no longer read
 * the account. Sanitize passes are counted at DOMPurify, which every pass goes through.
 *
 * Mutations watched red: key on the `imageProxy` prop instead of the consent-gated proxy (the
 * withdrawn-consent rows); drop `loadPixels` from the key (the pixel row); a module map keyed by
 * message id (the two-engine row); serve a proxied entry without asking the gate (the gate row);
 * the frame built in the first render with no hydration guard (the hydration row).
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const inertAdapter = (): EngineAdapter =>
  ({
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "AA", hasMore: false, serverTime: new Date().toISOString(),
    }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  }) as unknown as EngineAdapter;

const PICTURE = "https://pics.example/a.png";
const PIXEL = "https://track.example/open.gif";
/** A designed mail (a 600px canvas keeps it in its frame), one picture and one beacon. */
const DESIGNED = (n = 1): string =>
  `<table width="600" cellpadding="0"><tr><td><h1>Issue ${n}</h1>` +
  `<img src="${PICTURE}" width="200" height="100" alt="a"><p>The letter's copy.</p>` +
  `<img src="${PIXEL}" width="1" height="1"></td></tr></table>`;

const proxyFor = (mid: string) => (u: string): string =>
  `${window.location.origin}/api/img?mid=${mid}&u=${encodeURIComponent(u)}`;

let roots: Root[] = [];
/** Every DOMPurify pass, counted; a sanitize pass is at least one. */
let sanitize: { mock: { calls: unknown[][] } };

beforeEach(() => {
  sanitize = vi.spyOn(DOMPurify, "sanitize");
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
  });
});

afterEach(async () => {
  for (const r of roots) await act(() => r.unmount());
  roots = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  forgetMailDocs();
});

type BodyProps = React.ComponentProps<typeof MessageBody>;

/** Mount one body under `engine` (or none), return its frame's document and the passes it cost. */
async function show(engine: OhmailEngine | null, props: BodyProps): Promise<{ doc: string; passes: number; host: HTMLElement }> {
  const before = sanitize.mock.calls.length;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const body = h(MessageBody, props);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: messages as never, timeZone: "UTC",
      children: engine ? h(EngineProvider, { demo: false, engine, children: body }) : body,
    }));
  });
  const doc = host.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
  const passes = sanitize.mock.calls.length - before;
  await act(() => root.unmount());
  roots = roots.filter((r) => r !== root);
  host.remove();
  return { doc, passes, host };
}

const base = (over: Partial<BodyProps> = {}): BodyProps => ({
  messageId: "m1", text: "The letter's copy.", html: DESIGNED(), remoteLoaded: false,
  imageProxy: proxyFor("m1"), loadTrackingPixels: false, ...over,
});

describe("a body shown again is read back, not sanitized again", () => {
  it("a remount with equal inputs runs no sanitize pass, and draws the same document", async () => {
    const engine = new OhmailEngine({ adapter: inertAdapter() });
    const first = await show(engine, base());
    expect(first.passes, "positive control: the first mount must sanitize, or no zero below reads").toBeGreaterThan(0);
    expect(first.doc).toContain("Issue 1");
    const again = await show(engine, base());
    expect(again.passes, "a revisit sanitized the body again").toBe(0);
    expect(again.doc).toBe(first.doc);
  });

  it("each input that changes the document is a new document", async () => {
    const engine = new OhmailEngine({ adapter: inertAdapter() });
    await show(engine, base());
    const changes: [string, Partial<BodyProps>][] = [
      ["the html", { html: DESIGNED(2) }],
      ["the reader's consent", { remoteLoaded: true }],
      ["the pixel switch", { remoteLoaded: true, loadTrackingPixels: true }],
      ["the letter's own pictures", { cidImages: new Map([["p@x", "data:image/png;base64,AA=="]]) }],
      ["the fetched pictures", { resolvedRemoteImages: new Map([[PICTURE, "data:image/png;base64,AA=="]]) }],
      ["the text part", { text: "" }],
    ];
    for (const [what, over] of changes) {
      const r = await show(engine, base(over));
      expect(r.passes, `${what} changed and the kept document was served`).toBeGreaterThan(0);
    }
  });

  it("withdrawn consent and a pixel switch turned off draw no proxied picture and no beacon", async () => {
    const engine = new OhmailEngine({ adapter: inertAdapter() });
    const auto = await show(engine, base({ remoteLoaded: true, loadTrackingPixels: true }));
    expect(auto.doc, "control: under auto with pixels on, the picture rides the proxy").toContain("/api/img?mid=m1");
    expect(auto.doc, "control: …and so does the beacon").toContain(encodeURIComponent(PIXEL));
    // The account goes back to asking: the same message, the same proxy prop, no consent.
    const manual = await show(engine, base({ remoteLoaded: false, loadTrackingPixels: true }));
    expect(manual.doc, "a document minted under consent was served after it was withdrawn").not.toContain("/api/img?");
    // Pictures on, the pixel switch off.
    const noPixels = await show(engine, base({ remoteLoaded: true, loadTrackingPixels: false }));
    expect(noPixels.doc).toContain(encodeURIComponent(PICTURE));
    expect(noPixels.doc, "the beacon rode a document kept from when pixels were allowed").not.toContain(encodeURIComponent(PIXEL));
  });
});

describe("the documents are one engine's", () => {
  it("two engines holding the same message id each draw their own document", async () => {
    const a = new OhmailEngine({ adapter: inertAdapter() });
    const b = new OhmailEngine({ adapter: inertAdapter() });
    const inA = await show(a, base({ html: DESIGNED(1) }));
    const inB = await show(b, base({ html: DESIGNED(7) }));
    expect(inA.doc).toContain("Issue 1");
    expect(inB.doc, "the second engine was served the first engine's document").toContain("Issue 7");
    expect(inB.doc).not.toContain("Issue 1");
    expect(inB.passes, "the second engine's body was never sanitized").toBeGreaterThan(0);
    // …and each still reads its own back.
    expect((await show(a, base({ html: DESIGNED(1) }))).passes).toBe(0);
    expect((await show(b, base({ html: DESIGNED(7) }))).passes).toBe(0);
  });

  it("a body replaced under the same id is a miss, and the new document stands", async () => {
    const engine = new OhmailEngine({ adapter: inertAdapter() });
    await show(engine, base({ html: DESIGNED(1) }));
    const replaced = await show(engine, base({ html: DESIGNED(3) }));
    expect(replaced.passes).toBeGreaterThan(0);
    expect(replaced.doc).toContain("Issue 3");
    expect((await show(engine, base({ html: DESIGNED(3) }))).passes).toBe(0);
  });

  it("no message id and no engine never hit", async () => {
    const engine = new OhmailEngine({ adapter: inertAdapter() });
    await show(engine, base({ messageId: undefined }));
    expect((await show(engine, base({ messageId: undefined }))).passes, "an unnamed body was served from the keep").toBeGreaterThan(0);
    await show(null, base());
    expect((await show(null, base())).passes, "a bare mount kept a document").toBeGreaterThan(0);
  });

  it("a sign-out forgets every engine's documents, and a clear forgets one engine's", async () => {
    const engine = new OhmailEngine({ adapter: inertAdapter() });
    await show(engine, base());
    forgetMailDocs();
    expect((await show(engine, base())).passes, "a document outlived the sign-out").toBeGreaterThan(0);
    mailDocCacheFor(engine).clear();
    expect((await show(engine, base())).passes, "a document outlived the clear").toBeGreaterThan(0);
  });
});

describe("the keep itself", () => {
  const inputs = (over: Partial<MailDocInputs> = {}): MailDocInputs => ({
    messageId: "m1", html: "<p>x</p>", proxied: false, imgSource: null, cidImages: undefined,
    resolvedRemoteImages: undefined, loadPixels: false, hasText: true, darkWanted: false, forward: false, ...over,
  });

  it("a proxied document is served only while the window may read the account", () => {
    const engine = new OhmailEngine({ adapter: inertAdapter() });
    let identity: SyncIdentity = "holds";
    registerSyncGate(engine, { identity: () => identity } as unknown as SyncGate);
    const cache = mailDocCacheFor<string>(engine);
    cache.write(inputs({ proxied: true }), "proxied doc", 10);
    cache.write(inputs(), "plain doc", 10);
    expect(cache.read(inputs({ proxied: true }))?.value).toBe("proxied doc");
    identity = "revoked";
    expect(cache.read(inputs({ proxied: true })), "a proxied document was served past the gate").toBeUndefined();
    expect(cache.read(inputs())?.value, "a document with no proxied address is the account's own text").toBe("plain doc");
    cache.write(inputs({ proxied: true, html: "<p>y</p>" }), "minted past the gate", 10);
    identity = "holds";
    expect(cache.read(inputs({ proxied: true, html: "<p>y</p>" })), "a document made past the gate was kept").toBeUndefined();
  });

  it("the theme and a forward's subject are keys, and the keep is bounded", () => {
    const engine = new OhmailEngine({ adapter: inertAdapter() });
    const cache = mailDocCacheFor<string>(engine);
    cache.write(inputs(), "light", 10);
    expect(cache.read(inputs({ darkWanted: true })), "a light document was served to a dark theme").toBeUndefined();
    expect(cache.read(inputs({ forward: true })), "a reply's fold was served to a forward").toBeUndefined();
    for (let i = 0; i < MAIL_DOC_ENTRIES_MAX + 20; i += 1) cache.write(inputs({ messageId: `n${i}` }), "x", 1);
    expect(cache.size).toBe(MAIL_DOC_ENTRIES_MAX);
    expect(cache.read(inputs()), "the oldest entry outlived the bound").toBeUndefined();
  });
});

describe("the server render and the hydration agree", () => {
  it("the server draws the text, the hydration matches it, and the frame follows", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const props = base({ messageId: undefined });
    // The server's half: no sanitizer is asked for a frame, the text part stands in.
    const html = renderToString(h(MessageBody, props));
    expect(html).toContain("The letter&#x27;s copy.");
    expect(html).not.toContain("<iframe");
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    let root: Root | null = null;
    await act(async () => { root = hydrateRoot(host, h(MessageBody, props)); });
    roots.push(root!);
    const mismatch = errors.mock.calls.filter((c) => /hydrat|did not match|server/i.test(String(c[0])));
    expect(mismatch, "the first client render did not match the server's").toEqual([]);
    expect(host.querySelector("iframe"), "the frame never followed the hydration").not.toBeNull();
  });
});
