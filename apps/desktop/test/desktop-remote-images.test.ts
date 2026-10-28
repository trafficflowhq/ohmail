/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { COPY, frameCsp, MessageBody, sanitizeMailHtml } from "../../webapp/app/components/MessageBody";
import { DEFERRED_SRC_ATTR } from "../../webapp/app/components/proxied-images";
import { autoLoadsImages, imageProxyUrl, useRemoteImages } from "../../webapp/app/shell/remote-images";
import { localImageWire, localLoadRemote } from "../src/local-images.js";

/* The names the pane's hook reads, as the desktop bundle has them (`vite.config.ts` aliases the
   module to `src/no-api-client.ts`): no Cloud base, and the Cloud press and its sentence refuse. */
vi.mock("../../webapp/app/api-client", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/api-client")>("../../webapp/app/api-client");
  const desktop = await import("../src/no-api-client");
  return {
    ...real,
    API_BASE: desktop.API_BASE,
    apiConfigured: desktop.apiConfigured,
    messageOf: desktop.messageOf,
    privacy: desktop.privacy,
  };
});

/**
 * THE DESKTOP CANNOT SHOW A PICTURE, AND THIS IS THE FRAME SAYING SO.
 *
 * Pictures do not load here, and the reason is not the setting: the hosted client has loaded
 * them by default since mail 0048, and the desktop never has. Not a default, a capability — `apps/desktop/vite.config.ts` defines `NEXT_PUBLIC_API_BASE` as
 * `undefined`, so `apiConfigured()` is false, `useRemoteImages` returns `undefined`, and the
 * pane hands `MessageBody` a null `imageProxy`. These assertions read the FRAME, which is
 * where the claim actually lives: the sanitized document a desktop reader is served, and the
 * policy it is served under.
 */

const SENDER = "images.newsletter.example";
const PICTURE = `https://${SENDER}/hero.png`;
const BEACON = `https://${SENDER}/wf/open?upn=abc`;
const HTML =
  `<table width="600"><tr><td><p>hello</p>` +
  `<img src="${PICTURE}" width="600" height="200">` +
  `<img src="${BEACON}" width="1" height="1">` +
  `</td></tr></table>`;

/**
 * Every url the frame's document names in a fetching position, EXCLUDING `data:`.
 *
 * The exclusion is the point rather than a convenience: a blocked image is not removed from
 * the document, it is replaced by a transparent `data:` GIF so the layout does not collapse.
 * A test that read every `src` would therefore see two urls for a frame that fetches nothing
 * and call that "the picture loaded" — measured, on the first run of this file.
 */
function namedInFrame(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("img")]
    // A proxied picture is parked in `DEFERRED_SRC_ATTR` until the frame loads, then fetched.
    .map((n) => n.getAttribute(DEFERRED_SRC_ATTR) ?? n.getAttribute("src") ?? "")
    .filter((s) => s.length > 0 && !s.startsWith("data:"));
}

describe("the desktop reading pane and the picture it cannot show", () => {
  /**
   * THE RED. A desktop pane sanitizes with `imageProxy: null` — the only value it can pass,
   * since the hook that would supply one hands back `undefined` on a client with no API base.
   * The picture is therefore named nowhere, and no press can change that: there is no button
   * either, because `MessageBody` draws no control it cannot honour.
   *
   * Mutation that must redden this once the seam lands: remove the local proxy from the
   * desktop's composition, i.e. return to `imageProxy: null`.
   */
  it("names the sender's picture nowhere, because it has no proxy to name it through", () => {
    const out = sanitizeMailHtml(HTML, { imageProxy: null });
    expect(
      namedInFrame(out.html),
      "the desktop frame named a remote url with no proxy behind it",
    ).toEqual([]);
    expect(out.blocked.map((b) => b.url), "the picture was not even counted as blocked")
      .toContain(PICTURE);
  });

  /**
   * AND THE POLICY AGREES, which is the half that makes the first assertion structural rather
   * than incidental: with no proxy source the frame's `img-src` admits `data:` and the window's
   * own `blob:` URLs and nothing else, so even a desktop pane that DID name `https://…/hero.png`
   * would be refused by its own document's policy. This is the line that decides whether a
   * picture can ever arrive.
   */
  it("serves a policy that admits data: and blob: and no remote source at all", () => {
    const csp = frameCsp(null);
    expect(csp, "the desktop frame's img-src gained a source").toContain("img-src data: blob:;");
    expect(csp, "the desktop frame admitted a remote origin").not.toMatch(/img-src[^;]*https?:/);
  });

  /**
   * THE BEACON STAYS REFUSED — the arm that must not move when the seam lands. Asserted here
   * so the red above cannot be answered by loosening the pixel rule: a 1×1 is classified from
   * the message's own declaration and overrides any proxy, in every mode.
   */
  it("classifies the 1x1 as a pixel, which no proxy may override", () => {
    const out = sanitizeMailHtml(HTML, { imageProxy: (u) => `/img?u=${encodeURIComponent(u)}` });
    const named = namedInFrame(out.html);
    expect(named.some((u) => u.includes(encodeURIComponent(PICTURE))),
      "a proxy was supplied and the picture still did not load").toBe(true);
    expect(named.some((u) => u.includes(encodeURIComponent(BEACON))),
      "the tracking pixel rode the proxy").toBe(false);
  });
});

/**
 * ── THE SEAM THAT MAKES A PICTURE ARRIVE ON A DOOR WITH NO ORIGIN ────────────────────────
 *
 * The desktop's engine is reached over a pipe, not a port — `bridge-fetch.ts` says why, and the
 * posture stands: nothing listens, so no `<img src>` can name it. The bytes therefore travel the
 * way a `cid:` part's already do, through the same image proxy, and arrive as a `data:` URI. What
 * is asserted here is that the policy did not have to move an inch to allow it.
 */
const RESOLVED = "data:image/png;base64,iVBORw0KGgo=";

describe("a picture the desktop already holds the bytes of", () => {
  /**
   * CONTROL (a). Mutation: drop the `resolved` branch from the sanitizer's img arm. Real failure
   * text: "the resolved picture did not reach the frame: expected [] to contain '<data uri>'".
   */
  it("renders the picture, and still refuses the tracker beside it", () => {
    const out = sanitizeMailHtml(HTML, {
      imageProxy: null,
      resolvedRemoteImages: new Map([[PICTURE, RESOLVED]]),
    });
    const doc = new DOMParser().parseFromString(out.html, "text/html");
    const srcs = [...doc.querySelectorAll("img")].map((n) => n.getAttribute("src") ?? "");
    expect(srcs, "the resolved picture did not reach the frame").toContain(RESOLVED);
    /* The beacon is still the transparent placeholder and still MARKED, which is the fact the
       caption is drawn from — a resolved map must not be a way round the pixel rule. */
    const beacon = [...doc.querySelectorAll("img")].find(
      (n) => n.getAttribute("data-ohmail-pixel") === "1",
    );
    expect(beacon, "the 1x1 lost its pixel marking").toBeTruthy();
    expect(beacon!.getAttribute("src"), "the tracker was served real bytes").not.toBe(RESOLVED);
  });

  /** A size query on a sized picture is not a beacon: the desktop draws its bytes like any picture. */
  it("renders a sized picture whose url carries a size query", () => {
    const sized = "https://images.example/p.png?w=120";
    const out = sanitizeMailHtml(`<table width="600"><tr><td><img src="${sized}" width="120" height="120"></td></tr></table>`, {
      imageProxy: null,
      resolvedRemoteImages: new Map([[sized, RESOLVED]]),
    });
    expect(out.blocked.map((b) => b.pixel), "the sized picture was called a tracking pixel").toEqual([false]);
    const doc = new DOMParser().parseFromString(out.html, "text/html");
    expect(doc.querySelector("img")!.getAttribute("src"), "the sized picture stayed blank").toBe(RESOLVED);
  });

  /**
   * AND A MAP THAT CARRIES THE BEACON ANYWAY. The map is built by this app, so this is a
   * defence against our own future bug rather than against a sender — which is exactly the
   * class of thing that is worth making unrepresentable in the one place it is decided.
   *
   * Mutation: drop the `!pixel` term from the `resolved` line. Real failure text:
   * "a beacon was served from the resolved map: expected 'data:image/png;base64,…' not to be …".
   */
  it("refuses a beacon even when the resolved map names one", () => {
    const out = sanitizeMailHtml(HTML, {
      imageProxy: null,
      resolvedRemoteImages: new Map([[PICTURE, RESOLVED], [BEACON, RESOLVED]]),
    });
    const doc = new DOMParser().parseFromString(out.html, "text/html");
    const beacon = [...doc.querySelectorAll("img")].find(
      (n) => n.getAttribute("data-ohmail-pixel") === "1",
    );
    expect(beacon!.getAttribute("src"), "a beacon was served from the resolved map")
      .not.toBe(RESOLVED);
  });

  /**
   * CONTROL (e), and it is a byte comparison rather than a reading of the policy's parts: the
   * whole argument for `data:` over a door origin is that a resolved remote picture adds no
   * source to the frame's policy, and "img-src still mentions data:" would stay green through a
   * widening that added one beside it. (`blob:` is the message's own embedded parts, in-process.)
   */
  it("leaves the frame's policy byte-identical", () => {
    expect(
      frameCsp(null),
      "the desktop's frame policy moved to let a resolved picture in",
    ).toBe(
      "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; "
      + "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; "
      + "base-uri 'none'",
    );
  });

  /**
   * A PICTURE THAT IS NOT IN THE MAP IS THE BLANKED BOX — which is what "over the ceiling"
   * looks like from here, and also what "not fetched yet" and "the fetch failed" look like.
   * One rendering for all three is the point: the frame never shows a broken-image icon, which
   * would be a claim about the mail rather than about this app's budget.
   *
   * The CEILING ITSELF is asserted where it is spent, against the constant the embedded
   * pictures already use — a number restated here would be a second budget, which is the thing
   * this design exists not to create.
   */
  it("leaves an unresolved picture as the blanked box", () => {
    const out = sanitizeMailHtml(HTML, { imageProxy: null, resolvedRemoteImages: new Map() });
    const doc = new DOMParser().parseFromString(out.html, "text/html");
    const blanked = [...doc.querySelectorAll("img[data-ohmail-blocked]")];
    expect(blanked.length, "an unresolved picture was not left as a blanked box").toBe(2);
  });
});

/**
 * ── A HELD LETTER'S SHOW IMAGES, DOWN THE PIPE ──────────────────────────────────────────────
 *
 * `MessagePane`'s wiring over the desktop's own api-client and its two image wires, driven through
 * a stand-in shell. A sender not let in loads nothing on open, so the press is the one road to its
 * pictures, on both window origins: `http://tauri.localhost` (WebView2, Windows) and
 * `tauri://localhost` (WebKit, macOS and Linux), where the proxy has no source a frame could name.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG = `data:image/png;base64,${PNG_B64}`;
const HELD = { id: "22222222-2222-4222-8222-222222222222", folder: "ohmail/Screened" };
const ONE_PICTURE = `<table width="600"><tr><td><p>hello</p><img src="${PICTURE}" width="600" height="200"></td></tr></table>`;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const desktop = globalThis as { __TAURI_INTERNALS__?: { invoke: Invoke } };

/** An answer in the shell's frame: [4-byte length][metadata JSON][body]. */
function frame(status: number, body: Uint8Array, type: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [["content-type", type]] }));
  const out = new Uint8Array(4 + meta.byteLength + body.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(body, 4 + meta.byteLength);
  return out;
}
const said = (status: number, message: string): Uint8Array =>
  frame(status, new TextEncoder().encode(JSON.stringify({ error: { code: "refused", message } })), "application/json");

/** The engine behind the pipe: `/img` serves a letter only once its press is stored; `refuse` fails the press. */
function engineBehindThePipe(refuse: string | null = null): string[] {
  const asked: string[] = [];
  const pressed = new Set<string>();
  desktop.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command !== "engine_request") throw new Error(`unexpected shell command: ${command}`);
      const { method, url } = payload as { method: string; url: string };
      asked.push(`${method} ${url}`);
      const press = /^\/messages\/([^/?]+)\/load-remote$/.exec(url);
      if (method === "POST" && press) {
        if (refuse) return said(403, refuse);
        pressed.add(decodeURIComponent(press[1]!));
        return frame(200, new TextEncoder().encode('{"remoteContent":"loaded"}'), "application/json");
      }
      const img = new URL(url, "http://engine.invalid");
      if (method === "GET" && img.pathname === "/img") {
        if (!pressed.has(img.searchParams.get("mid") ?? "")) return said(403, "not loaded by the reader");
        return frame(200, Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0)), "image/png");
      }
      throw new Error(`unexpected engine request: ${method} ${url}`);
    },
  };
  return asked;
}

/** What `proxyFor` mints on a `tauri://localhost` window: the real url builder, that origin. */
const tauriProxies = new Map<string, (url: string) => string>();
function tauriProxyFor(id: string): (url: string) => string {
  if (!tauriProxies.has(id)) tauriProxies.set(id, (url) => imageProxyUrl("", "tauri://localhost", id, url));
  return tauriProxies.get(id)!;
}

/** `MessagePane`'s lines for one held letter, over the desktop's wires. */
function Pane({ tauri, failed, notices, html }: { tauri: boolean; failed: string[]; notices: (string | null)[]; html: string }) {
  const real = useRemoteImages({
    onFailed: (sentence) => { failed.push(sentence); }, mode: "auto", loadPixels: false,
    fetchImage: localImageWire, recordRemote: localLoadRemote,
  });
  const chrome = React.useMemo(() => (real && tauri ? { ...real, proxyFor: tauriProxyFor } : real), [real, tauri]);
  const onRemoteImages = React.useCallback((urls: string[]) => chrome?.needRemote(HELD.id, urls), [chrome]);
  return h(MessageBody, {
    messageId: HELD.id, text: "plain", html,
    remoteLoaded: autoLoadsImages(chrome, HELD) || (chrome?.consented(HELD.id) ?? false),
    imageProxy: chrome ? chrome.proxyFor(HELD.id) : null,
    onLoadRemote: chrome && !autoLoadsImages(chrome, HELD) ? () => chrome.consent(HELD.id) : undefined,
    loadTrackingPixels: chrome?.loadPixels ?? false,
    resolvedRemoteImages: chrome?.resolvedFor(HELD.id),
    onRemoteImages,
    onNotice: (n: { caption: string } | null) => { notices.push(n?.caption ?? null); },
  });
}

let root: Root | null = null;
let mounted: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  mounted?.remove();
  mounted = null;
  delete desktop.__TAURI_INTERNALS__;
});

/** One round: the pipe's answers land, then React renders and runs the effects they cause. */
async function rounds(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
    await act(async () => { for (let j = 0; j < 12; j += 1) await Promise.resolve(); });
  }
}

async function openHeld(tauri: boolean, failed: string[], notices: (string | null)[] = [], html = ONE_PICTURE) {
  mounted = document.createElement("div");
  document.body.appendChild(mounted);
  root = createRoot(mounted);
  await act(async () => { root!.render(h(Pane, { tauri, failed, notices, html })); });
  await rounds(3);
  return {
    show: () => [...mounted!.querySelectorAll("button")].find((b) => b.textContent === COPY.show) ?? null,
    drawn: () => [...new DOMParser().parseFromString(mounted!.querySelector("iframe")?.getAttribute("srcdoc") ?? "", "text/html")
      .querySelectorAll("img")].filter((i) => i.getAttribute("src") === PNG).length,
  };
}

describe("a held letter's Show images on the desktop", () => {
  for (const [door, tauri] of [["http://tauri.localhost (Windows)", false], ["tauri://localhost (macOS, Linux)", true]] as const) {
    it(`${door}: nothing on open; the press is stored down the pipe, then the picture arrives`, async () => {
      const asked = engineBehindThePipe();
      const failed: string[] = [];
      const notices: (string | null)[] = [];
      const pane = await openHeld(tauri, failed, notices);
      expect(asked, "a held sender's picture was asked for on open").toEqual([]);
      expect(notices.at(-1), "the held letter did not say its pictures are blocked").toBe(COPY.imagesCaption);
      expect(pane.show(), "the held letter offers no Show images").not.toBeNull();
      await act(async () => { pane.show()!.click(); });
      await rounds(6);
      expect(asked).toEqual([
        `POST /messages/${HELD.id}/load-remote`,
        `GET /img?mid=${HELD.id}&u=${encodeURIComponent(PICTURE)}`,
      ]);
      expect(pane.drawn(), "the picture never reached the frame").toBe(1);
      expect(notices.at(-1), "the shown picture is still said to be blocked").toBeNull();
      expect(failed).toEqual([]);
    });
  }

  /* The pipe fetches `<img>` pictures only, at most INLINE_IMAGE_MAX_PARTS a letter: what it leaves blank stays said. */
  const BACKGROUND = `https://${SENDER}/banner.jpg`;
  for (const [what, html, gets] of [
    ["a CSS background", `<table width="600"><tr><td style="background-image:url(${BACKGROUND})"><p>hello</p></td></tr></table>`, 0],
    ["a CSS background beside a picture", `<table width="600"><tr><td style="background-image:url(${BACKGROUND})">${ONE_PICTURE}</td></tr></table>`, 1],
    ["14 pictures", `<table width="600"><tr><td><p>hello</p>${
      Array.from({ length: 14 }, (_, i) => `<img src="${PICTURE}?n=${i}" width="600" height="200">`).join("")}</td></tr></table>`, 12],
  ] as const) {
    it(`tauri://localhost: ${what} the pipe cannot draw keeps the letter's Images blocked`, async () => {
      const asked = engineBehindThePipe();
      const notices: (string | null)[] = [];
      const pane = await openHeld(true, [], notices, html);
      await act(async () => { pane.show()!.click(); });
      await rounds(8);
      expect(asked.filter((a) => a.startsWith("GET ")).length).toBe(gets);
      expect(pane.drawn()).toBe(gets);
      expect(notices.at(-1), "a blank picture was said to be shown").toBe(COPY.imagesCaption);
    });
  }

  it("a refused press says the engine's sentence and loads nothing", async () => {
    const asked = engineBehindThePipe("ohmail could not record that just now.");
    const failed: string[] = [];
    const pane = await openHeld(false, failed);
    await act(async () => { pane.show()!.click(); });
    await rounds(4);
    expect(failed).toEqual(["ohmail could not record that just now."]);
    expect(asked).toEqual([`POST /messages/${HELD.id}/load-remote`]);
    expect(pane.drawn()).toBe(0);
  });
});
