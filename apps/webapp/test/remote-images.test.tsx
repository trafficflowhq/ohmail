/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { HttpAdapter, OhmailEngine } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { COPY, MessageBody, sanitizeMailHtml } from "../app/components/MessageBody";
import { AppShell } from "../app/shell/AppShell";
import type { ConsentTransport } from "../app/shell/consent-state";
import { OWNER_COOKIE } from "../app/shell/owner-cookie";
import {
  DEFERRED_SHEET_ATTR, DEFERRED_SRC_ATTR, DEFERRED_STYLE_ATTR, DEFERRED_URLS_ATTR, PARK_FLAT_ATTR, PROXIED_IMAGES_IN_FLIGHT,
  createProxiedImageQueue,
} from "../app/components/proxied-images";
import { PROXY_URL_MAX_CHARS as SERVER_URL_MAX } from "@trafficflow/services";
import { PROXY_URL_MAX_CHARS, type RemoteImagesChrome, useRemoteImages } from "../app/shell/remote-images";
import { RemoteImagesRow } from "../app/shell/RemoteImagesRow";
import { TrackingPixelsRow } from "../app/shell/TrackingPixelsRow";
import de from "../messages/de.json";
import { createSyncGate, registerSyncGate } from "../app/shell/sync-scheduler";

/**
 * ── THE SPY-PIXEL BLOCKER'S CONSENT PATH, ASSERTED ON THE FRAME A READER GETS ───────────
 *
 * `MessageBody.tsx` has blocked every remote reference since that change, and its header names the
 * one thing it deliberately did not do: *"It does not fetch a blocked image after consent,
 * and the consent button is therefore absent rather than dead… Loading one means routing it
 * through `GET /img` … and that route is deliberately unmounted."* That route is mounted now
 * (`packages/api/src/routes/privacy.ts`, `packages/api/test/privacy.test.ts`), and this file
 * is the half that proves the mount was worth making: a rendered message whose images
 * actually go through it.
 *
 * ── WHY THE ASSERTIONS READ THE `srcdoc`, NOT THE PROPS ─────────────────────────────────
 *
 * Because "the component was handed an `imageProxy`" is not the claim. The claim is about
 * what the BROWSER will request, and between the prop and the request sit the sanitizer, an
 * allow-list, a beacon rule and a CSP — any one of which can make a correctly-passed prop
 * produce nothing. So every assertion below parses the document the frame is given and reads
 * the fetching positions out of it, exactly as `message-body-mutation-xss.test.ts` does.
 *
 * ── AND WHAT THIS FILE CANNOT PROVE ─────────────────────────────────────────────────────
 *
 * jsdom fetches no subresource and enforces no CSP. That the proxied url is REQUESTED, and
 * that the sender's host is not, is a browser fact and belongs to the ux-suite journey. What
 * is decided here is narrower and is the part that was missing: which urls the frame names,
 * and whose origin they are on.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/* Two things jsdom does not have, both reached from the shell's cursor-follow rAF and neither
   of them anything this file is about: `CSS.escape`, and layout. Absent, they throw out of an
   animation frame AFTER the assertions have run — a passing test with an unhandled error
   beside it, which is the shape that gets ignored. */
(globalThis as unknown as { CSS: { escape: (v: string) => string } }).CSS = {
  escape: (v: string) => v.replace(/["\\\]\[]/g, "\\$&"),
};
(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const SENDER = "images.newsletter.example";
/** A real picture, and a beacon. The distinction is the point of half this file. */
const PICTURE = `https://${SENDER}/hero.png`;
const BEACON = `https://${SENDER}/wf/open?upn=abc`;

/**
 * A DECLARED CANVAS, and it is here so this file keeps asking about the FRAME.
 *
 * Every assertion below is about what the frame's document names and what the bar offers beside
 * it. A picture used to be enough to guarantee a frame; it is not any more — mail renders in the
 * app's own type unless it declares a canvas (`isRigidLayout`), and a frameless message names no
 * urls at all, which would turn "the frame names no remote url" into a green for the wrong
 * reason. The 600px table is what a real newsletter carrying these images would have.
 */
const HTML =
  `<table width="600"><tr><td>` +
  `<p>hello</p>` +
  `<img src="${PICTURE}" width="600" height="200">` +
  `<img src="${BEACON}" width="1" height="1">` +
  `<style>.a{background:url("https://${SENDER}/bg.png")}</style>` +
  `</td></tr></table>`;

let mockLoadRemoteCalls: string[] = [];
let mockLoadRemoteFails: string | null = null;

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    // EVERYTHING ELSE STAYS REAL. The shipped-shell walk at the bottom of this file mounts
    // `AppShell`, whose consent hook reads `consent` and `apiConfigured` from this module; a
    // mock that returned only the four keys `useRemoteImages` needs would leave that hook
    // holding `undefined` and the shell would never render at all.
    ...actual,
    API_BASE: "/api",
    apiConfigured: () => true,
    messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
    privacy: {
      loadRemote: async (id: string) => {
        mockLoadRemoteCalls.push(id);
        if (mockLoadRemoteFails) throw new Error(mockLoadRemoteFails);
        return { remoteContent: "loaded" };
      },
    },
  };
});

/* ── the rendered frame ──────────────────────────────────────────────────────────────── */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

afterEach(async () => {
  await unmount();
  mockLoadRemoteCalls = [];
  mockLoadRemoteFails = null;
});

/**
 * Mount the REAL `MessageBody` behind the REAL `useRemoteImages`, in a harness that is the
 * two lines `MessagePane` uses and nothing else.
 *
 * A harness rather than the whole `AppShell` because the shell needs an engine, a provider
 * tree and a mailbox; what is under test is the seam between the consent hook and the
 * renderer, and everything that would make this file need a shell is asserted elsewhere.
 * The seam itself is held to `MessagePane`'s source by the last test in this file.
 */
function Harness({
  messageId, html, mode, loadPixels = false, fetchImage,
}: {
  messageId: string; html: string; mode: "auto" | "manual"; loadPixels?: boolean;
  fetchImage?: (messageId: string, url: string) => Promise<string | null>;
}) {
  const [failed, setFailed] = React.useState<string | null>(null);
  const remoteImages = useRemoteImages({ onFailed: setFailed, mode, loadPixels, fetchImage });
  // The pipe-door's pair, wired exactly as `MessagePane` wires it; handed down only with a fetcher.
  const onRemoteImages = React.useCallback(
    (urls: string[]) => remoteImages?.needRemote(messageId, urls),
    [remoteImages, messageId],
  );
  return h(
    "div",
    null,
    h(MessageBody, {
      text: "plain",
      html,
      // The THREE-TERM OR the pane uses, copied here on purpose: a harness that only ored the
      // per-message press would keep passing while the account setting reached nothing.
      remoteLoaded: (remoteImages?.auto ?? false) || (remoteImages?.consented(messageId) ?? false),
      imageProxy: remoteImages ? remoteImages.proxyFor(messageId) : null,
      onLoadRemote:
        remoteImages && !remoteImages.auto ? () => remoteImages.consent(messageId) : undefined,
      // The pane's fourth line (mail 0072): the account's pixel switch, off unless the chrome says.
      loadTrackingPixels: remoteImages?.loadPixels ?? false,
      ...(fetchImage
        ? { resolvedRemoteImages: remoteImages?.resolvedFor(messageId), onRemoteImages }
        : {}),
    }),
    failed === null ? null : h("p", { role: "alert" }, failed),
  );
}

async function mount(
  messageId = "msg-1", html = HTML, mode: "auto" | "manual" = "manual", loadPixels = false,
): Promise<HTMLDivElement> {
  await unmount();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(Harness, { messageId, html, mode, loadPixels })); });
  await settle();
  return host;
}

/** The document the frame was handed, parsed — never the string. */
function frameDoc(el: HTMLDivElement): Document {
  const frame = el.querySelector("iframe");
  expect(frame, "no message frame was rendered").toBeTruthy();
  return new DOMParser().parseFromString(frame!.getAttribute("srcdoc") ?? "", "text/html");
}

/** Every url the frame would actually fetch on open, from the FETCHING positions only. */
function fetchedOnOpen(el: HTMLDivElement): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const u = raw.trim();
    if (/^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
  };
  const doc = frameDoc(el);
  for (const node of doc.querySelectorAll("*")) {
    push(node.getAttribute("src") ?? "");
    // A parked picture: `proxied-images.ts` starts it once the frame has loaded.
    push(node.getAttribute(DEFERRED_SRC_ATTR) ?? "");
    push(node.getAttribute("background") ?? "");
    // A parked style or sheet: its live css is swapped in once its urls have loaded.
    for (const css of [node.getAttribute("style"), node.getAttribute(DEFERRED_STYLE_ATTR), node.getAttribute(DEFERRED_SHEET_ATTR)]) {
      for (const m of (css ?? "").matchAll(/url\(\s*['"]?([^'")]*)/gi)) push(m[1] ?? "");
    }
    if (node.tagName.toLowerCase() === "style") {
      for (const m of (node.textContent ?? "").matchAll(/url\(\s*['"]?([^'")]*)/gi)) push(m[1] ?? "");
    }
  }
  return out;
}

const showButton = (el: HTMLDivElement): HTMLButtonElement | null =>
  [...el.querySelectorAll("button")].find((b) => /show images/i.test(b.textContent ?? "")) ?? null;

async function click(node: Element): Promise<void> {
  await act(async () => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

describe("a consented image is fetched through our proxy, never from the sender", () => {
  /**
   * THE STATE THAT SHIPPED, RESTATED SO THE CHANGE CANNOT SILENTLY LOOSEN IT. Before consent
   * nothing remote is named at all, and that is unchanged by this slice.
   */
  it("before consent the frame names no remote url and offers the button", async () => {
    const el = await mount();
    expect(fetchedOnOpen(el)).toEqual([]);
    expect(showButton(el), "the proxy is mounted, so the consent button must exist").toBeTruthy();
  });

  /**
   * THE SLICE, AND THE ASSERTION IS ABOUT THE ORIGIN.
   *
   * A weaker test — "the src changed" or "the src contains the proxy path" — would pass for
   * `https://images.newsletter.example/hero.png?via=/api/img`. What matters is that the url
   * the browser will connect to is OURS: the sender's host may appear only inside the query,
   * as data we hand our own server.
   */
  it("after consent the picture is on OUR origin, with the sender's url as a parameter", async () => {
    const el = await mount();
    await click(showButton(el)!);

    expect(mockLoadRemoteCalls, "consent must be recorded server-side").toEqual(["msg-1"]);

    const urls = fetchedOnOpen(el);
    expect(urls.length, "consent loaded nothing at all").toBeGreaterThan(0);

    for (const u of urls) {
      const parsed = new URL(u);
      expect(parsed.origin, `${u} is fetched from a host we do not control`)
        .toBe(window.location.origin);
      expect(parsed.pathname).toBe("/api/img");
      // `mid` is the AUTHORISATION, not decoration: the service refuses a message the
      // caller's account does not own before it spends a DNS lookup.
      expect(parsed.searchParams.get("mid")).toBe("msg-1");
      expect(parsed.searchParams.get("u")).toMatch(/^https:\/\//);
    }

    // The picture and the CSS background both go through it…
    expect(urls.some((u) => new URL(u).searchParams.get("u") === PICTURE)).toBe(true);
    expect(urls.some((u) => new URL(u).searchParams.get("u") === `https://${SENDER}/bg.png`)).toBe(true);
    // …and no fetching position is the sender's url DIRECTLY.
    //
    // Deliberately NOT `not.toContain(SENDER)`: the sender's host is supposed to appear, as
    // the `u=` parameter of a url on our own origin, and an assertion that forbade the string
    // would forbid the correct implementation and have to be weakened the first time it met
    // one. What must never appear is the host in the AUTHORITY position of something the
    // browser will connect to, which is what `new URL(u).origin` above reads and what this
    // spells out over the raw markup for the shape a parse might normalise away.
    const doc = frameDoc(el);
    expect(doc.body.innerHTML, "a raw sender url survived as a src")
      .not.toMatch(new RegExp(`src=["']https?://${SENDER}`, "i"));
  });

  /**
   * A BEACON IS NEVER FETCHED, NOT EVEN AFTER CONSENT, NOT EVEN THROUGH THE PROXY.
   *
   * The proxy protects the reader's IP; it cannot protect the FACT that the message was
   * opened, because somebody has to ask for the bytes. "Show images" is a request for the
   * pictures, and there is no picture behind a 1×1 beacon to show. `MessageBody.tsx:745-762`
   * is where `pixel` overrides `proxy`; this is the assertion that it still does once a real
   * proxy exists to override — which was untestable while the proxy was always `null`.
   *
   * Mutation: drop `&& !pixel` from that branch. Real failure text:
   *   AssertionError: the open-tracking beacon was fetched after consent: expected
   *   [ 'https://…/wf/open?upn=abc' ] to deeply equal []
   */
  it("the tracking pixel stays unfetched after consent, while the picture loads", async () => {
    const el = await mount();
    await click(showButton(el)!);

    const proxied = fetchedOnOpen(el).map((u) => new URL(u).searchParams.get("u"));
    expect(proxied, "the open-tracking beacon was fetched after consent").not.toContain(BEACON);
    expect(proxied, "consent did not load the picture it was given for").toContain(PICTURE);
  });

  /**
   * A CONSENT THE SERVER DID NOT RECORD LOADS NOTHING, AND SAYS SO.
   *
   * The optimistic shape is wrong here for a reason specific to this feature: the local flag
   * decides what THIS render fetches and the server flag decides what the next one does, so
   * flipping locally on a failed write gives a reader images now and no images after a
   * reload, with nothing said either time.
   *
   * Mutation: move `setAllowed` above the `await` in `remote-images.ts`. Real failure text:
   *   AssertionError: a write that failed still loaded the images: expected [ '/api/img?…' ]
   *   to deeply equal []
   */
  it("a refused consent write loads no images and reports the server's sentence", async () => {
    mockLoadRemoteFails = "ohmail could not record that just now.";
    const el = await mount();
    await click(showButton(el)!);

    expect(fetchedOnOpen(el), "a write that failed still loaded the images").toEqual([]);
    expect(el.querySelector('[role="alert"]')?.textContent)
      .toBe("ohmail could not record that just now.");
  });

  /**
   * ABSENCE IS A REAL ANSWER. A client with no API — `?demo=1`, the desktop shell — must
   * offer NO button rather than a dead one, which is the state `MessageBody.tsx`'s header
   * describes and the state this slice must not remove.
   */
  it("a client with no proxy offers no button and still blocks everything", async () => {
    const api = await import("../app/api-client");
    const spy = vi.spyOn(api, "apiConfigured").mockReturnValue(false);
    try {
      const el = await mount();
      expect(showButton(el), "a button over a capability nothing can serve").toBeNull();
      expect(fetchedOnOpen(el)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * ── THE DEFAULT MOVED, AND BOTH ARMS ARE HELD HERE ────────────────────────────────────────
 *
 * `account_settings.block_remote_images_at` (mail 0048) decides which of two behaviours a reader
 * gets, and the whole describe above is now the OPT-OUT arm. These are the two things that must
 * be true of the pair:
 *
 *   · auto loads the PICTURES with no press, and drops the button rather than leaving a dead one;
 *   · **the beacon is refused in BOTH arms.** That is the claim the product's copy makes, and it
 *     is the one an "images by default" change is most likely to quietly break — the pixel rule
 *     lives in the sanitizer, one layer below anything this setting touches, and nothing about the
 *     mode reaches it.
 */
describe("mail 0048 — images by default, and the pixel that is still never fetched", () => {
  /**
   * AUTO: THE PICTURE ARRIVES WITHOUT ANYBODY ASKING, AND ON OUR ORIGIN.
   *
   * The origin half is not decoration. "Images load by default" is only affordable because the
   * request is ours — a mode that loaded them from the sender's host would be the feature every
   * other mail client has, and the one this product exists not to have.
   *
   * Mutation: drop the `auto` term from the harness's `remoteLoaded` (i.e. from `MessagePane`'s
   * three-term OR). Real failure text:
   *   AssertionError: auto mode did not load the message's picture: expected [] to contain
   *   'https://images.newsletter.example/hero.png'
   */
  it("auto mode loads the picture through our proxy, with no press", async () => {
    const el = await mount("msg-auto", HTML, "auto");

    const fetched = fetchedOnOpen(el);
    expect(fetched.length, "auto mode fetched nothing at all").toBeGreaterThan(0);
    for (const u of fetched) {
      expect(new URL(u).origin, "a remote image was named on the SENDER's origin")
        .toBe(window.location.origin);
    }
    const proxied = fetched.map((u) => new URL(u).searchParams.get("u"));
    expect(proxied, "auto mode did not load the message's picture").toContain(PICTURE);
    // And nothing was recorded per message: the account already answered this question once.
    expect(mockLoadRemoteCalls, "auto mode wrote a per-message consent row").toEqual([]);
  });

  /**
   * AND NO BUTTON. `MessageBody` renders no control it cannot honour — the same rule the
   * no-proxy case above follows — and "Show images" over images that are already showing is a
   * control whose press does nothing.
   *
   * ── THIS ONE IS DOUBLY GUARDED, AND SAYING SO IS THE HONEST VERSION ────────────────────
   *
   * TWO independent terms suppress the button here, and MUTATING EITHER ONE ALONE LEAVES THIS
   * GREEN — measured, not assumed, because a guard that survives its own mutation is exactly the
   * decoration this repo keeps finding:
   *
   *   · `MessagePane` withholds `onLoadRemote` in auto mode, so nothing is handed over; and
   *   · `MessageBody`'s `canLoad` ands in `!remoteLoaded`, so a handed-over callback is still
   *     not drawn while the images are showing.
   *
   * So the reader-facing fact is asserted here, and the two terms are pinned separately below —
   * the pane's by the source check in the last describe, and `canLoad`'s by
   * `message-body.test.ts`, which names `const canLoad = !remoteLoaded` as its own mutation.
   * Deleting the pane's gate would leave a callback that can never fire, which is worth refusing
   * even though no pixel moves.
   */
  it("auto mode offers no per-message button", async () => {
    expect(
      showButton(await mount("msg-auto2", HTML, "auto")),
      "auto mode still offers a button whose press cannot do anything",
    ).toBeNull();
  });

  /**
   * THE ARM THAT MUST NOT MOVE. An account that opted out gets exactly what shipped: nothing
   * remote named on open, and the button.
   */
  it("manual mode is unchanged — nothing loads until the reader asks", async () => {
    const el = await mount("msg-manual", HTML, "manual");
    expect(fetchedOnOpen(el), "the opt-out arm loaded something on open").toEqual([]);
    expect(showButton(el), "the opt-out arm lost its button").toBeTruthy();
  });

  /**
   * ── THE PIXEL, IN BOTH MODES, AND THIS IS THE GUARD THE SLICE IS FOR ────────────────────
   *
   * `declaresPixel` and `BEACON_PATH` classify a beacon, and `if (proxy && !pixel)` in the
   * sanitizer's img branch refuses it the proxy. Neither line knows this setting exists, which is
   * the design — but "it cannot break because nothing touches it" is the argument every silently
   * broken guard was once given, so it is measured instead.
   *
   * MUTATION, and it is the one named in the ruling: make the classifier answer non-pixel for
   * everything — in `MessageBody.tsx`, `const pixel = false` in `onAttributes`. Real failure text:
   *   AssertionError: auto mode fetched the open-tracking beacon: expected
   *   [ 'https://images.newsletter.example/hero.png',
   *     'https://images.newsletter.example/wf/open?upn=abc' ]
   *   to not contain 'https://images.newsletter.example/wf/open?upn=abc'
   *
   * The same mutation reddens the consent-arm test above it, which is the point of asserting the
   * pair: the rule is one rule, and it has to hold on whichever side of the setting a reader is.
   */
  it("the beacon is never fetched — in auto mode as much as after a press", async () => {
    for (const mode of ["auto", "manual"] as const) {
      const el = await mount(`msg-pixel-${mode}`, HTML, mode);
      if (mode === "manual") await click(showButton(el)!);
      const proxied = fetchedOnOpen(el).map((u) => new URL(u).searchParams.get("u"));
      expect(proxied, `${mode} mode fetched the open-tracking beacon`).not.toContain(BEACON);
      expect(proxied, `${mode} mode did not load the picture`).toContain(PICTURE);
    }
  });

  /**
   * A REMOTE STYLESHEET STAYS BLOCKED IN BOTH MODES, and for a reason that is structural rather
   * than a policy: an `@import` is a SHEET, and a sheet cannot travel through an IMAGE proxy, so
   * there is no private version of it to admit. `neutraliseCss` cuts it and records it under
   * `sheets`, which is deliberately kept apart from the list the images path loads — see
   * `SanitizedMail.sheets`, whose comment says an entry there "would make that button lie about
   * what it does".
   *
   * A css `url()` BACKGROUND is not this case and is not asserted here: it names a picture, it
   * has a proxied form, and auto mode loads it exactly as it loads an `<img>`. Writing this test
   * against a background url is how it was written first, and it failed — correctly.
   *
   * Mutation: give `recordSheet`'s branch in `neutraliseCss` the proxy. Real failure text:
   *   AssertionError: auto mode fetched a remote stylesheet, which no proxy can make private:
   *   expected [ 'https://…/sheet.css' ] to not include 'https://…/sheet.css'
   */
  it("a remote stylesheet is not loaded by the auto mode either", async () => {
    const sheet = `https://${SENDER}/sheet.css`;
    // The CANVAS is in the fixture so the message keeps its FRAME: a message that declares none
    // renders in the app's own type, and a frameless message fetches nothing at all — a green
    // for the wrong reason. See `isRigidLayout`.
    const el = await mount(
      "msg-sheet",
      `<table width="600"><tr><td><style>@import url("${sheet}");</style>` +
        `<img src="${PICTURE}" width="600" height="200"></td></tr></table>`,
      "auto",
    );
    const named = fetchedOnOpen(el).map((u) => new URL(u).searchParams.get("u") ?? u);
    expect(named, "auto mode fetched a remote stylesheet, which no proxy can make private")
      .not.toContain(sheet);
  });

  /**
   * ── THE READ-FAILURE ARM, RED FIRST ─────────────────────────────────────────────────────
   *
   * The mode is resolved from `useConsentState().blockRemoteImages`, and the whole reason that
   * field starts TRUE is this case: a settings read that failed cannot tell "no opt-out stored"
   * from "I could not ask", and loading a sender's content for somebody who opted out is the one
   * outcome this feature may not produce. It is asserted against the real module's real resting
   * value rather than against a copy of the rule.
   *
   * Mutation: `blockRemoteImages: false` in `RESTING` (`consent-state.ts`), which is exactly the
   * edit somebody makes to "ship the new default properly". Real failure text:
   *   AssertionError: a consent read that FAILED left this tab loading remote images:
   *   expected false to be true
   */
  it("a failed consent read leaves the reader on the manual flow", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/consent-state.ts"), "utf8",
    );
    // The resting value, read out of the module rather than restated: `RESTING` is what a failed
    // fetch leaves in place (the catch is empty, by design — see the module header).
    const resting = /const RESTING: ConsentState = \{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
    expect(resting, "RESTING no longer names the remote-images flag at all").toContain(
      "blockRemoteImages:",
    );
    expect(
      /blockRemoteImages:\s*true/.test(resting),
      "a consent read that FAILED left this tab loading remote images",
    ).toBe(true);
    // And the second half of the same rule: an API too old to carry the field reads as manual,
    // which is `=== undefined` rather than the `!= null` its neighbours use.
    expect(
      src,
      "an API from before mail 0048 would be read as 'no opt-out' and load images",
    ).toContain("wire.blockRemoteImagesAt === undefined");
  });
});

/**
 * ── MAIL 0072 — THE PIXEL SWITCH, AND THE DEFAULT THAT PROTECTS ───────────────────────────
 *
 * "Block tracking pixels" is ON by default and the two tests above this describe already prove
 * that arm (the beacon test runs with `loadPixels` absent). What is proven here is the OTHER
 * position — the reader's own opt-out actually loads the beacon, through the proxy and nowhere
 * else — and the sentence the bar says while the default stands.
 */
describe("mail 0072 — the pixel switch", () => {
  /**
   * Mutation: revert either `(!pixel || loadPixels)` in the sanitizer's img branch to `!pixel`.
   * Real failure text:
   *   AssertionError: the pixel switch did not load the beacon: expected [ 'https://…/hero.png' ]
   *   to include 'https://images.newsletter.example/wf/open?upn=abc'
   */
  it("turned off, the beacon loads WITH the pictures — proxied, like everything else", async () => {
    const el = await mount("msg-pixels-off", HTML, "auto", true);
    const fetched = fetchedOnOpen(el);
    for (const u of fetched) {
      expect(new URL(u).origin, "a pixel bypassed the proxy").toBe(window.location.origin);
    }
    const proxied = fetched.map((u) => new URL(u).searchParams.get("u"));
    expect(proxied, "the pixel switch did not load the beacon").toContain(BEACON);
    expect(proxied, "the switch loaded the beacon and lost the picture").toContain(PICTURE);
  });

  /**
   * THE NOTICE THE DEFAULT KEEPS: with pictures loading, the refused beacon is the only thing
   * left to report, and it is still reported — the "images by default" world would otherwise
   * say nothing at all about the one refusal this product is named for.
   *
   * Mutation: drop the `pixelsRefused > 0` term from `hasBlocked` in `MessageBody.tsx`. Real
   * failure text:
   *   AssertionError: auto mode blocked a pixel and told nobody: expected null not to be null
   */
  it("under auto mode the bar still says a pixel was blocked — and stops saying it when the switch is off", async () => {
    const on = await mount("msg-pixels-notice", HTML, "auto");
    const bar = on.querySelector(".mb-bar-text");
    expect(bar, "auto mode blocked a pixel and told nobody").not.toBeNull();
    expect(bar!.textContent).toContain(COPY.pixelOnly);

    const off = await mount("msg-pixels-quiet", HTML, "auto", true);
    // Nothing was refused, so nothing is said — a notice about a block that did not happen
    // would be the mirror image of blocking silently.
    expect(off.querySelector(".mb-bar-text")?.textContent ?? "").not.toContain(COPY.pixelOnly);
  });

  /**
   * THE RESTING VALUE PROTECTS, read out of the module the way the images test above reads its
   * sibling — `RESTING` is what a failed consent read leaves in place.
   *
   * Mutation: `blockTrackingPixels: false` in `RESTING` (`consent-state.ts`). Real failure text:
   *   AssertionError: a consent read that FAILED left this tab loading beacons: expected false
   *   to be true
   */
  /**
   * ── THE CHROME'S IDENTITY IS A PERFORMANCE CONTRACT ─────────────────────────────────────
   *
   * `StreamCardMemo` compares the chrome BY REFERENCE, and `AppShell` passes `onFailed` as an
   * inline arrow whose identity changes on every shell render — one per `/sync` apply. If that
   * identity reaches the hook's dependency arrays, every poll hands the stream a fresh chrome,
   * re-rendering every mounted card and re-running the sanitizer over each, which is precisely
   * the work the stream memo exists to avoid. So `onFailed` rides a ref, and this pins it.
   *
   * Mutation: add `opts.onFailed` back to the `consent` callback's dependency array in
   * `remote-images.ts`. Real failure text:
   *   AssertionError: a fresh onFailed identity minted a fresh chrome: expected {…} to be {…}
   */
  it("a re-render with a fresh onFailed keeps the same chrome object", async () => {
    const seen: unknown[] = [];
    function Probe({ n }: { n: number }) {
      // A NEW inline callback every render — exactly the shape the shell passes.
      const chrome = useRemoteImages({ onFailed: () => void n, mode: "auto", loadPixels: false });
      seen.push(chrome);
      return null;
    }
    await unmount();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(h(Probe, { n: 1 })); });
    await act(async () => { root!.render(h(Probe, { n: 2 })); });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1], "a fresh onFailed identity minted a fresh chrome")
      .toBe(seen[seen.length - 2]);
  });

  it("a failed consent read leaves pixels blocked", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/consent-state.ts"), "utf8",
    );
    const resting = /const RESTING: ConsentState = \{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
    expect(resting, "RESTING no longer names the pixel flag at all").toContain(
      "blockTrackingPixels:",
    );
    expect(
      /blockTrackingPixels:\s*true/.test(resting),
      "a consent read that FAILED left this tab loading beacons",
    ).toBe(true);
  });
});

describe("a window that is not this account's loads no pictures for it", () => {
  /**
   * ═══ THE PROXY PATH, OR NOTHING — NEVER THE ORIGIN ═══════════════════════════════════════
   *
   * Remote images are fetched by the BROWSER from an `<img src>`, so they never pass through
   * `api()` and the account boundary cannot see them. On its own that is not a leak: a message id
   * from one account's mirror answers 404 under another's session. It stops being harmless the
   * moment anything else has put a valid id from the other account in front of this window —
   * which is the state every other guard in this slice exists to prevent, so this one is defence
   * in depth and it is cheap.
   *
   * Asserted through the SANITIZER, because that is where a `src` is actually rewritten and it is
   * the only place that can show the third possibility: not "proxied" versus "blocked", but
   * proxied versus **reaching the sender directly**, which is the one outcome that must never
   * happen for a picture in somebody's mail.
   */
  it("rewrites to the proxy while identity holds, and to nothing when it does not", async () => {
    const { imageProxyUrl } = await import("../app/shell/remote-images");
    const { sanitizeMailHtml } = await import("../app/components/MessageBody");

    const ORIGIN = "https://mail.example";
    const REMOTE = "https://tracker.example/pixel.png";
    const html = `<p>hello</p><img src="${REMOTE}">`;

    /* AppShell's own composition: the door's proxy, behind the identity predicate. `mayRead` is
       read at USE time — a cookie can be rewritten by a sign-in in another tab between the render
       that built this and the press that uses it. */
    let mayRead = true;
    const proxyFor = (messageId: string) => (url: string) =>
      (mayRead ? imageProxyUrl("/api", ORIGIN, messageId, url) : "");

    const held = sanitizeMailHtml(html, { imageProxy: proxyFor("m1"), loadPixels: true });
    expect(held.html, "the picture never reached the proxy at all").toContain("/api/img?");
    expect(held.html, "the reader's browser was sent straight at the sender")
      .not.toContain(REMOTE);

    mayRead = false;
    const foreign = sanitizeMailHtml(html, { imageProxy: proxyFor("m1"), loadPixels: true });
    expect(foreign.html, "another account's picture was loaded through the proxy")
      .not.toContain("/api/img?");
    expect(foreign.html, "…and it fell back to loading from the sender directly")
      .not.toContain(REMOTE);
  });

  /**
   * ═══ THE SAME QUESTION, ASKED OF THE SHIPPED SHELL ═══════════════════════════════════════
   *
   * The case above drives the sanitizer through a copy of `AppShell`'s composition, written out
   * by hand. That is precisely the blind spot the last test in this file exists for: this seam
   * has shipped unsupplied on the live path three times — `fetchBody`, `searchServer`, and then
   * this predicate — and every unit test stayed green all three times, because a test that
   * builds the collaborator itself can never notice that nothing builds it.
   *
   * So this one mounts the real thing: `AppShell`, its engine, its consent hook, its sync gate,
   * its `MessageBody`, and it reads the frame a reader would be looking at. Delete `mayRead:`
   * from the shell's `useRemoteImages({…})` call and this case fails on its own.
   *
   * ── TWO MOUNTS OVER ONE WARM MIRROR, AND WHY A SINGLE ONE WOULD PROVE NOTHING ────────────
   *
   * Mounting once under a contradicted gate would pass for the wrong reason. The gate also
   * guards the engine's transport, so the body fetch is refused, so there is no html to rewrite
   * and no url in the frame — a green over an empty message. The refusal under test has to be
   * the IMAGE DOOR's, over a body that is on screen.
   *
   * So: the first mount is the ordinary open. It puts the body in the mirror and shows the
   * picture through the proxy — that is the control, and it is what makes the second mount
   * meaningful. Between them the jar becomes another account's, which is what a sign-in in a
   * second tab does to every tab on the origin. The second mount reads the SAME mirror and
   * renders the SAME body — asserted, not assumed — and mints no image url for it.
   */
  it("the shipped shell: a warm window whose jar changed hands renders the body and no picture", async () => {
    const ACCOUNT = "acct-A";
    const OTHER = "acct-B";
    const ISO = "2026-08-04T09:00:00.000Z";

    /* One message and one rule for its sender. The rule is not decoration: with a consent
       answer in hand the shell partitions the mirror, and an undecided sender waits in the
       Screener rather than appearing in the Ohbox — there would be no card to open. */
    const MESSAGE = {
      id: "m-shell", accountId: ACCOUNT, mailboxId: "mb-1", threadId: null, messageIdHeader: null,
      subject: "A picture", from: { name: "Lena", address: "lena@example.invalid" },
      to: [], cc: [], date: ISO, folder: "INBOX", snippet: "hello", unread: true,
      hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
      remoteContent: "none", updatedAt: ISO,
    };
    const RULE = {
      id: "r-1", kind: "sender", match: "lena@example.invalid", destination: "INBOX",
      priority: 100, provenance: "manual", enabled: true, subjectTerm: null,
      createdAt: ISO, updatedAt: ISO,
    };

    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const serve = async (url: string): Promise<Response> => {
      const path = String(url);
      if (path.includes("/messages/") && path.includes("/body")) {
        return json({ text: "hello", html: HTML, loadedRemoteContent: false, unsubscribe: "no_header" });
      }
      if (path.includes("/sync")) {
        return json({
          changes: {
            creates: [
              { type: "message", id: MESSAGE.id, op: "create", seq: 1, updatedAt: ISO, entity: MESSAGE },
              { type: "rule", id: RULE.id, op: "create", seq: 2, updatedAt: ISO, entity: RULE },
            ],
            updates: [], moves: [], deletes: [],
          },
          cursor: "2", hasMore: false, serverTime: ISO,
        });
      }
      return json({ items: [] });
    };

    /* The account's own answer, which is what puts the shell in the product's default images
       mode — pictures come through the proxy on open, with no per-message press. `null` here is
       a server saying it read the row and found no opt-out. */
    const consentTransport = {
      foldersStorable: true,
      state: async () => ({
        seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 30,
        blockRemoteImagesAt: null, loadTrackingPixelsAt: null,
      }),
      setAutoSuggest: async () => ({ autoSuggestAt: null }),
      setDormancyDays: async () => ({ dormancyDays: 30, screeningResetAt: null }),
      setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
      setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
      setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
      setFoldersEnabled: async () => ({ foldersEnabledAt: null }),
      setMailboxFoldersEnabled: async () => ({ foldersEnabledAt: null, folderMailboxesOff: {} }),
      setMailboxSignature: async () => ({ signatures: {} }),
    } as unknown as ConsentTransport;

    const mountShell = async (engine: OhmailEngine): Promise<void> => {
      await unmount();
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        /* The product door's own provider stack (`app/(product)/providers.tsx`), children passed
           as PROPS: both of these declare `children` on their props type, and the third-argument
           form of `createElement` does not satisfy a required one. */
        const shell = h(AppShell, { demo: false, engine, consentTransport });
        const themed = h(ThemeProvider, {
          storageKey: "ohmail.theme", faces: true, children: h(ToastHost, { children: shell }),
        });
        root!.render(h(NextIntlClientProvider, {
          locale: "en", messages: messages as never, children: themed,
        }));
      });
      await settle();
    };

    /** Open the card the way a reader does, and hand back the document the frame was given. */
    const openTheMessage = async (): Promise<string> => {
      const row = host!.querySelector<HTMLButtonElement>("button.srow");
      expect(row, "no card to open — the message never reached a pile, so this proves nothing")
        .not.toBeNull();
      await act(async () => { row!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await settle();
      const frames = [...host!.querySelectorAll("iframe")];
      expect(frames.length, "the message body never rendered at all").toBeGreaterThan(0);
      return frames.map((f) => f.getAttribute("srcdoc") ?? "").join("\n");
    };

    try {
      document.cookie = `${OWNER_COOKIE}=${ACCOUNT}; path=/`;
      const gate = createSyncGate(ACCOUNT);
      gate.confirm(ACCOUNT);
      const engine = new OhmailEngine({
        adapter: new HttpAdapter({ baseUrl: "/api", fetch: serve as never }),
      });
      registerSyncGate(engine, gate);

      // ── The control: this window IS the account's, and the picture loads through the proxy.
      await mountShell(engine);
      const held = await openTheMessage();
      expect(held, "the shell never minted a proxy url — the walk cannot show a refusal")
        .toContain("/api/img?mid=m-shell");
      expect(held, "the reader's browser was pointed straight at the sender").not.toContain(`src="${PICTURE}"`);

      // ── Another account signs in on this origin. Nothing about this window changed but the jar.
      document.cookie = `${OWNER_COOKIE}=${OTHER}; path=/`;
      expect(gate.identity(), "the premise failed: the gate does not consider this window foreign")
        .toBe("contradicted");

      // ── The same mirror, the same body, re-rendered.
      await mountShell(engine);
      const foreign = await openTheMessage();
      expect(foreign, "the body did not render, so the absence below is not a refusal")
        .toContain("hello");
      expect(foreign, "another account's picture was fetched through our proxy")
        .not.toContain("/api/img?");
      expect(foreign, "…and the sender's host is not named anywhere in the frame either")
        .not.toContain(SENDER);
    } finally {
      document.cookie = `${OWNER_COOKIE}=; path=/; max-age=0`;
    }
  });
});

describe("the pane is the consumer, not just the harness", () => {
  /**
   * THE WIRING, ASSERTED STRUCTURALLY, AND THE REASON IT IS WORTH A TEST OF ITS OWN.
   *
   * This seam has shipped unsupplied on the LIVE path twice (`fetchBody`, `searchServer`) —
   * every unit test stayed green both times, because tests construct the collaborator
   * directly and the shell is the only place the wire is actually made. The harness above has
   * exactly that blind spot by construction, so the two ends are pinned here: `MessagePane`
   * passes the props, and `AppShell` supplies the chrome they come from.
   */
  it("MessagePane hands MessageBody the proxy, and AppShell supplies it", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

    const pane = read("apps/webapp/app/shell/MessagePane.tsx");
    expect(pane, "the pane renders a body with no way to load an image").toContain("imageProxy=");
    expect(pane).toContain("onLoadRemote=");
    expect(pane).toContain("remoteImages");

    const shell = read("apps/webapp/app/shell/AppShell.tsx");
    expect(shell, "the chrome would be undefined on the live path only").toContain("useRemoteImages");
    expect(shell, "the capability is built and then not put in the chrome")
      .toMatch(/attachments,\s*remoteImages/);
    /* AND THE IDENTITY PREDICATE, which is the third thing this seam has now shipped without.
       `/img` is fetched by the browser from an `<img src>`, so the account boundary in `api()`
       never sees it; the door asks the same question every other direct reader asks. Deleting
       this one argument leaves a window that has stopped syncing still able to load another
       account's pictures — with every unit test green, because they build the hook directly. */
    expect(shell, "the image door was built without the identity predicate")
      .toMatch(/useRemoteImages\(\{[\s\S]{0,400}?mayRead:\s*mayReadOlderBody/);

    /* mail 0048's own half of the same blind spot. The mode is an account setting, so the
       harness above can prove both behaviours while the live path is wired to a constant —
       which is precisely the `fetchBody`/`searchServer` shape this test exists for. Both ends:
       the shell resolves the mode from the consent hook, and the sibling renderer ors the same
       `auto` term the pane does (one setting must not produce two answers on one screen). */
    expect(shell, "the shell passes a hard-coded mode instead of the account's setting")
      .toMatch(/mode:\s*consent\.blockRemoteImages\s*\?\s*"manual"\s*:\s*"auto"/);
    // The sibling renderer moved out of `Conversation.tsx` into `MessageCard.tsx` (the expanded
    // sibling), which is where the same three-term OR now lives. Its `auto` term is the one
    // default-read function both renderers call (`autoLoadsImages`, mail 0148: a message whose
    // sender's name claims a company the address is not loads no pictures on open).
    const card = read("apps/webapp/app/shell/MessageCard.tsx");
    expect(card, "a sibling message would keep the button the focused one dropped")
      .toContain("autoLoadsImages(chrome.remoteImages, message) ||");
    expect(pane, "the pane and the sibling answer the account's setting through one term")
      .toContain("autoLoadsImages(chrome.remoteImages, message) ||");
    /* And the pane's half of the doubly-guarded button. `MessageBody`'s `!remoteLoaded` would
       hide it anyway, which is why this cannot be asserted behaviourally without mutating two
       things at once — so the term is pinned where it is written. A callback handed over for a
       press that can never happen is worth refusing on its own. */
    expect(pane, "the pane hands over a consent callback nothing can ever press")
      .toMatch(/!autoLoadsImages\(chrome\.remoteImages, message\)/);
  });
});

/* ── WHO FETCHES THE PICTURE, SAID WHERE THE SWITCH IS ─────────────────────────────────── */

describe("the Settings copy names the machine that fetches the pictures", () => {
  /** Both rows as Settings mounts them, in one language, pictures ON and pixels ON. */
  async function rows(fromComputer: boolean, locale: "en" | "de"): Promise<string> {
    await unmount();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const noop = async () => true;
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale, messages: (locale === "en" ? messages : de) as never,
        children: [
          h(RemoteImagesRow, { key: "i", blocked: false, setBlockRemoteImages: noop, fromComputer }),
          h(TrackingPixelsRow, { key: "p", blocked: false, setBlockTrackingPixels: noop, fromComputer }),
        ],
      }));
    });
    return host.textContent ?? "";
  }

  it("a computer of the reader's own promises no proxy, in either language", async () => {
    for (const locale of ["en", "de"] as const) {
      const text = await rows(true, locale);
      expect(text, `${locale}: the desktop's own door promised a proxy`).not.toMatch(/proxy/i);
      const cat = locale === "en" ? messages.settings : de.settings;
      expect(text).toContain(cat.images.microcopyComputer);
      expect(text).toContain(cat.pixels.offComputer);
    }
  });

  it("CONTROL: the Cloud door keeps the proxy sentence it can keep", async () => {
    const text = await rows(false, "en");
    expect(text).toContain(messages.settings.images.microcopy);
    expect(text).toContain(messages.settings.pixels.off);
  });
});

/* ── THE PIPE-DOOR'S PICTURES ARE FETCHED ONCE ─────────────────────────────────────────── */

/**
 * The desktop hands `fetchImage` to every door. A picture that had just arrived was asked for
 * again on the next render, so one open message kept fetching until the parts cap or the byte
 * budget stopped it, and every arrival re-measured the frame (the macOS scroll-bar flicker).
 * The first two cases each hold one half alone; the third is the loop; the fourth the per-message proxy; the fifth the probe.
 */
describe("a picture the desktop fetched is never fetched again", () => {
  const PNG_1X1 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const ICONS = [1, 2, 3, 4, 5].map((n) => `https://${SENDER}/icon-${n}.png`);
  const canvas = (urls: string[]): string =>
    `<table width="600"><tr><td><p>weekly report</p>` +
    urls.map((u) => `<img src="${u}" width="48" height="48">`).join("") +
    `<img src="${BEACON}" width="1" height="1">` +
    `</td></tr></table>`;

  /**
   * A fixture door: every picture answers the same 1×1 PNG a task later, as the pipe does. Nothing
   * leaves. A microtask answer made the base tree loop inside ONE act scope for ever, and a
   * sibling test then passed for nothing behind the open scope (measured).
   */
  const fixtureFetcher = () =>
    vi.fn(async (_messageId: string, _url: string): Promise<string | null> => {
      await new Promise((r) => setTimeout(r, 0));
      return PNG_1X1;
    });

  async function render(node: React.ReactElement): Promise<void> {
    if (!root) {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
    }
    await act(async () => { root!.render(node); });
  }

  /** One round: the door's answers land, then React renders and runs the effects they cause. */
  async function rounds(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
      await settle();
    }
  }

  /** The hook alone, its chrome handed out of the render so a test can press it directly. */
  function useChrome(
    fetchImage?: ReturnType<typeof fixtureFetcher>, mayRead?: () => boolean,
  ): { current: RemoteImagesChrome | undefined; Probe: () => null } {
    const box: { current: RemoteImagesChrome | undefined; Probe: () => null } = {
      current: undefined,
      Probe: () => {
        box.current = useRemoteImages({
          onFailed: () => {}, mode: "auto", loadPixels: false, fetchImage, mayRead,
        });
        return null;
      },
    };
    return box;
  }

  it("needRemote asked twice for a held picture fetches it once", async () => {
    const fetchImage = fixtureFetcher();
    const chrome = useChrome(fetchImage);
    await render(h(chrome.Probe));
    await act(async () => { chrome.current!.needRemote("m1", [ICONS[0]!]); });
    await rounds(1);
    expect(chrome.current!.resolvedFor("m1").get(ICONS[0]!), "control: the picture never arrived")
      .toBe(PNG_1X1);
    await act(async () => { chrome.current!.needRemote("m1", [ICONS[0]!]); });
    await rounds(1);
    expect(fetchImage, "a picture already held was fetched a second time").toHaveBeenCalledTimes(1);
    // Held is per message: another message naming the same url is its own authorisation.
    await act(async () => { chrome.current!.needRemote("m2", [ICONS[0]!]); });
    await rounds(1);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it("the frame asks only for the pictures it does not hold", async () => {
    const asked: string[][] = [];
    const three = ICONS.slice(0, 3);
    const body = (held: string[]) => h(MessageBody, {
      text: "plain", html: canvas(three), remoteLoaded: true, imageProxy: null,
      resolvedRemoteImages: new Map(held.map((u) => [u, PNG_1X1] as const)),
      onRemoteImages: (urls: string[]) => { asked.push(urls); },
    });
    await render(body(three.slice(0, 2)));
    await settle();
    expect(asked, "the ask list named a picture the frame already shows").toEqual([[three[2]]]);
    await unmount();
    asked.length = 0;
    await render(body(three));
    await settle();
    expect(asked, "every picture is held, and the frame still asked").toEqual([]);
  });

  it("five pictures are fetched five times, and the count stays there", async () => {
    const fetchImage = fixtureFetcher();
    await render(h(Harness, { messageId: "msg-1", html: canvas(ICONS), mode: "auto", fetchImage }));
    await rounds(10);
    const atTen = fetchImage.mock.calls.length;
    await rounds(40);
    const atFifty = fetchImage.mock.calls.length;
    expect({ atTen, atFifty }, "a picture already held was asked for again").toEqual({ atTen: 5, atFifty: 5 });
    expect(fetchImage.mock.calls.map(([, u]) => u).sort(), "the beacon was asked for")
      .toEqual([...ICONS].sort());
    const shown = [...frameDoc(host!).querySelectorAll("img")].filter((i) => i.src === PNG_1X1);
    expect(shown.length, "control: the fetched pictures never reached the frame").toBe(5);
  });

  it("proxyFor hands back one function per message, still asking mayRead at call time", async () => {
    let allowed = true;
    const chrome = useChrome(undefined, () => allowed);
    await render(h(chrome.Probe));
    const c = chrome.current!;
    expect(c.proxyFor("m1"), "a new proxy function per call re-sanitizes per render")
      .toBe(c.proxyFor("m1"));
    expect(c.proxyFor("m2")).not.toBe(c.proxyFor("m1"));
    expect(c.proxyFor("m1")(ICONS[0]!)).toContain("/api/img?");
    allowed = false;
    // The answer is taken once per task (the next test); the next task asks again.
    await Promise.resolve();
    expect(c.proxyFor("m1")(ICONS[0]!), "a cached proxy stopped asking mayRead").toBe("");
    allowed = true;
    await Promise.resolve();
    for (let i = 0; i < 300; i += 1) c.proxyFor(`other-${i}`);
    expect(c.proxyFor("m1")(ICONS[0]!), "the bounded cache lost a working proxy")
      .toContain("/api/img?");
  });

  /**
   * ONE ANSWER PER TASK. A newsletter names thirty pictures, each minted through the proxy in the
   * one sanitize pass, and each used to read and parse the account cookie again. Mutations: drop the
   * memo → thirty asks; never clear it → the second task's flip is not seen.
   */
  it("mayRead is asked once per task, however many pictures one pass mints", async () => {
    let allowed = true;
    let asked = 0;
    const chrome = useChrome(undefined, () => { asked += 1; return allowed; });
    await render(h(chrome.Probe));
    const c = chrome.current!;
    asked = 0;
    for (let i = 0; i < 30; i += 1) expect(c.proxyFor(`m${i % 3}`)(`${ICONS[0]!}?n=${i}`)).toContain("/api/img?");
    expect(asked, "the predicate was asked per picture").toBe(1);
    allowed = false;
    await Promise.resolve();
    expect(c.proxyFor("m1")(ICONS[0]!), "the next task kept the last task's answer").toBe("");
    expect(asked).toBe(2);
  });

  /**
   * a re-render handing the same pictures in a new Map is the same document, so it may not
   * probe the frame again. Probes are counted as writes of the 600px probe height to the frame's
   * style; the open itself is the positive control, without which a zero reads nothing.
   */
  it("a new Map with the same pictures probes the frame no further", async () => {
    const heights: string[] = [];
    const keep = (recs: MutationRecord[]): void => {
      for (const r of recs) if (r.target instanceof HTMLIFrameElement) heights.push(r.oldValue ?? "");
    };
    const seen = new MutationObserver(keep);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    seen.observe(host, {
      subtree: true, attributes: true, attributeFilter: ["style"], attributeOldValue: true,
    });
    const held = () => new Map(ICONS.map((u) => [u, PNG_1X1] as const));
    const body = () => h(MessageBody, {
      text: "plain", html: canvas(ICONS), remoteLoaded: true, imageProxy: null,
      resolvedRemoteImages: held(), onRemoteImages: () => {},
    });
    const probes = (): number => {
      keep(seen.takeRecords());
      return heights.filter((v) => /height:\s*600px/.test(v)).length;
    };
    await render(body());
    await rounds(5);
    const atOpen = probes();
    expect(atOpen, "positive control: the frame was never measured, so no zero below is a reading")
      .toBeGreaterThan(0);
    for (let i = 1; i <= 10; i += 1) {
      await render(body());
      await settle();
    }
    expect(probes(), "a re-render with the same document probed the frame again").toBe(atOpen);
    seen.disconnect();
  });
});

/**
 * The frame probe in jsdom, where every layout read is 0: the open probes the frame once (onLoad, then the
 * effect's call over the same state reads nothing), a repeat call probes nothing, and a changed
 * box (a stubbed `offsetHeight`) probes once more. The browser half is `test/reader-frame/`.
 */
describe("a measurement whose inputs have not moved writes nothing", () => {
  it("the open probes once, a repeat not at all, a changed box once more", async () => {
    const heights: string[] = [];
    const keep = (recs: MutationRecord[]): void => {
      for (const r of recs) if (r.target instanceof HTMLIFrameElement) heights.push(r.oldValue ?? "");
    };
    const seen = new MutationObserver(keep);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    seen.observe(host, {
      subtree: true, attributes: true, attributeFilter: ["style"], attributeOldValue: true,
    });
    const probes = (): number => {
      keep(seen.takeRecords());
      return heights.filter((v) => /height:\s*600px/.test(v)).length;
    };
    await act(async () => {
      root!.render(h(MessageBody, { text: "plain", html: HTML, remoteLoaded: false, imageProxy: null }));
    });
    for (let i = 0; i < 5; i += 1) await settle();
    expect(probes(), "the open probed the frame more than once").toBe(1);
    const frame = host.querySelector("iframe")!;
    const again = async (): Promise<void> => {
      await act(async () => { frame.dispatchEvent(new Event("load")); });
      await settle();
    };
    await again();
    expect(probes(), "a call over the same state probed the frame").toBe(1);
    Object.defineProperty(frame.contentDocument!.documentElement, "offsetHeight", {
      configurable: true, get: () => 480,
    });
    await again();
    expect(probes(), "control: a changed box must probe").toBe(2);
    expect(frame.style.height).toBe("480px");
    seen.disconnect();
  });
});

/**
 * 2026-10-26: one tab's Screener drew 27 newsletters of 40 pictures at once, 1,080 `GET /img` in six
 * seconds, and the API's database pool filled for everyone. A frame runs no script, so its pictures
 * are parked by the sanitizer and handed out by one queue per tab. The real-engine half (every
 * picture draws, at most six asked at once) is `thread-read-browser.test.ts`.
 */
describe("proxied pictures are asked for a few at a time", () => {
  it("a consented picture is parked over a blank, never in a fetching src, until its frame loads", async () => {
    const el = await mount("msg-1", HTML, "auto");
    const pic = [...frameDoc(el).querySelectorAll("img")].find((i) => i.hasAttribute(DEFERRED_SRC_ATTR));
    expect(pic, "the picture was not parked").toBeTruthy();
    expect(new URL(pic!.getAttribute(DEFERRED_SRC_ATTR)!).searchParams.get("u")).toBe(PICTURE);
    expect(pic!.getAttribute("src"), "the parked picture is fetched at parse").toMatch(/^data:image\/gif;/);
  });

  function parked(n: number, tag: string): { box: HTMLDivElement; imgs: HTMLImageElement[]; done: Set<Element> } {
    const box = document.createElement("div");
    document.body.appendChild(box);
    const done = new Set<Element>();
    const imgs = Array.from({ length: n }, (_, i) => {
      const img = document.createElement("img");
      img.setAttribute("src", "data:image/gif;base64,R0lGODlhAQABAAAAACw=");
      img.setAttribute(DEFERRED_SRC_ATTR, `/api/img?u=${tag}-${i}`);
      // A picture has ended once the test says so (jsdom loads nothing).
      Object.defineProperty(img, "complete", { configurable: true, get: () => done.has(img) });
      box.appendChild(img);
      return img;
    });
    return { box, imgs, done };
  }
  const started = (imgs: HTMLImageElement[]): string[] =>
    imgs.filter((i) => !i.hasAttribute(DEFERRED_SRC_ATTR)).map((i) => i.getAttribute("src")!);

  it("starts six, and one more as each ends, top to bottom", () => {
    vi.useFakeTimers();
    try {
      const q = createProxiedImageQueue();
      const a = parked(20, "a");
      q.admit(document);
      expect(PROXIED_IMAGES_IN_FLIGHT).toBe(6);
      expect(started(a.imgs)).toEqual([0, 1, 2, 3, 4, 5].map((i) => `/api/img?u=a-${i}`));
      a.done.add(a.imgs[0]!).add(a.imgs[3]!);
      vi.advanceTimersByTime(60);
      expect(started(a.imgs)).toHaveLength(8);
      expect(q.inFlight()).toBe(6);
      for (const img of a.imgs) a.done.add(img);
      for (let i = 0; i < 10; i += 1) vi.advanceTimersByTime(60);
      expect(started(a.imgs), "a parked picture never started").toHaveLength(20);
      expect(q.inFlight()).toBe(0);
      a.box.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the frame newest to load goes first; a frame taken away and a stalled picture free their slots", () => {
    vi.useFakeTimers();
    try {
      const q = createProxiedImageQueue(2);
      const old = parked(4, "old");
      q.admit(old.box as unknown as Document);
      const fresh = parked(2, "new");
      q.admit(fresh.box as unknown as Document);
      old.box.remove();
      vi.advanceTimersByTime(60);
      expect(started(fresh.imgs), "the newest frame waited behind an older one").toEqual(["/api/img?u=new-0", "/api/img?u=new-1"]);
      expect(started(old.imgs), "a frame taken away kept asking").toHaveLength(2);
      vi.advanceTimersByTime(15_100);
      expect(q.inFlight(), "a stalled picture held its slot").toBe(0);
      fresh.box.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a proxied css url is parked as none in its style and its sheet; a picture with no declared height waits flat", () => {
    const via = (u: string): string => `/api/img?u=${encodeURIComponent(u)}`;
    const { html } = sanitizeMailHtml(
      `<style>.a{background:url(https://${SENDER}/s.png)}</style>` +
        `<div style="color:red;background-image:url(https://${SENDER}/c.png)">x</div>` +
        `<img src="https://${SENDER}/w.png" width="564"><img src="https://${SENDER}/a.png" width="600" style="height:auto">` +
        `<img src="https://${SENDER}/h.png" width="600" height="200">`,
      { imageProxy: via },
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const cell = doc.querySelector(`[${DEFERRED_STYLE_ATTR}]`)!;
    expect(cell.getAttribute("style"), "a parked background is fetched at parse").toBe("color:red;background-image:none");
    expect(cell.getAttribute(DEFERRED_STYLE_ATTR)).toContain(via(`https://${SENDER}/c.png`));
    expect(JSON.parse(cell.getAttribute(DEFERRED_URLS_ATTR)!)).toEqual([via(`https://${SENDER}/c.png`)]);
    const sheet = doc.querySelector("style")!;
    expect(sheet.textContent, "a parked sheet is fetched at parse").toBe(".a{background:none}");
    expect(sheet.getAttribute(DEFERRED_SHEET_ATTR)).toBe(`.a{background:url("${via(`https://${SENDER}/s.png`)}")}`);
    expect(JSON.parse(sheet.getAttribute(DEFERRED_URLS_ATTR)!)).toEqual([via(`https://${SENDER}/s.png`)]);
    const flat = [...doc.querySelectorAll("img")].map((i) => i.hasAttribute(PARK_FLAT_ATTR));
    expect(flat, "width only, height:auto, both declared").toEqual([true, true, false]);
  });

  it("a parked style or sheet is swapped in once every url of its own has ended, within the same budget; a refused url as none", () => {
    vi.useFakeTimers();
    const ended = new Set<string>();
    const refused = new Set(["/s2"]);
    const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!;
    const naturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth")!;
    // A probe has ended once the test says so, and drew unless refused (jsdom loads nothing).
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true, get(this: HTMLImageElement) { return ended.has(this.getAttribute("src") ?? ""); },
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
      configurable: true, get(this: HTMLImageElement) { return refused.has(this.getAttribute("src") ?? "") ? 0 : 8; },
    });
    const box = document.createElement("div");
    try {
      const q = createProxiedImageQueue(2);
      const cell = document.createElement("div");
      cell.setAttribute("style", "background:none");
      cell.setAttribute(DEFERRED_STYLE_ATTR, 'background:url("/c")');
      cell.setAttribute(DEFERRED_URLS_ATTR, JSON.stringify(["/c"]));
      const sheet = document.createElement("style");
      sheet.textContent = ".a{background:none}.b{background:none}";
      sheet.setAttribute(DEFERRED_SHEET_ATTR, '.a{background:url("/s1")}.b{background:url("/s2")}');
      sheet.setAttribute(DEFERRED_URLS_ATTR, JSON.stringify(["/s1", "/s2"]));
      box.append(cell, sheet);
      document.body.appendChild(box);
      q.admit(box as unknown as Document);
      expect(q.inFlight()).toBe(2);
      expect(cell.getAttribute("style"), "swapped in before its url ended").toBe("background:none");
      ended.add("/c");
      vi.advanceTimersByTime(60);
      expect(cell.getAttribute("style")).toBe('background:url("/c")');
      expect(cell.hasAttribute(DEFERRED_STYLE_ATTR) || cell.hasAttribute(DEFERRED_URLS_ATTR)).toBe(false);
      expect(q.inFlight(), "the sheet's second url waited for a slot").toBe(2);
      ended.add("/s1");
      vi.advanceTimersByTime(60);
      expect(sheet.textContent, "a sheet swapped in with a url still loading").toBe(".a{background:none}.b{background:none}");
      ended.add("/s2");
      vi.advanceTimersByTime(60);
      // A refusal carries no cache lifetime: written live, the sheet would ask for it again, outside the budget.
      expect(sheet.textContent, "a refused url was swapped in live").toBe('.a{background:url("/s1")}.b{background:none}');
      expect(q.inFlight()).toBe(0);
    } finally {
      Object.defineProperty(HTMLImageElement.prototype, "complete", complete);
      Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", naturalWidth);
      box.remove();
      vi.useRealTimers();
    }
  });

  it("a url the proxy refuses on sight is never asked for", async () => {
    expect(PROXY_URL_MAX_CHARS, "the client's ceiling is the server's").toBe(SERVER_URL_MAX);
    const chrome = (() => {
      const box: { current: RemoteImagesChrome | undefined } = { current: undefined };
      const Probe = (): null => {
        box.current = useRemoteImages({ onFailed: () => {}, mode: "auto", loadPixels: false });
        return null;
      };
      return { box, Probe };
    })();
    await unmount();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(h(chrome.Probe)); });
    const proxy = chrome.box.current!.proxyFor("m1");
    const fits = `https://${SENDER}/${"a".repeat(PROXY_URL_MAX_CHARS - SENDER.length - 9)}`;
    expect(fits.length).toBe(PROXY_URL_MAX_CHARS);
    expect(proxy(fits), "control: the longest url the proxy takes").toContain("/api/img?");
    expect(proxy(`${fits}a`), "an over-long url was asked for").toBe("");
    expect(proxy("ftp://images.example/a.png")).toBe("");
    expect(proxy("//images.example/a.png")).toBe("");
  });
});
