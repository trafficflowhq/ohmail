/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  OWNER_BILLING_HTML,
  OWNER_BILLING_TEXT,
  OWNER_TRACKING_PIXEL,
  OWNER_REMOTE_HOSTS,
  HOSTILE_HTML,
  HOSTILE_HOST,
} from "./fixtures/owner-billing-email";

/**
 * ── WHAT A MESSAGE MAY DO WHEN IT IS OPENED, WHICH IS ALMOST NOTHING ─────────────
 *
 * `apps/webapp/app/components/MessageBody.tsx` renders sender-authored html. That is the
 * single most hostile input this product accepts — anyone who knows the address chooses
 * every byte — so every assertion in this file was watched go RED against a named mutation
 * of the component and then restored. The mutation is written on each `it`, so the next
 * person can repeat the experiment rather than trust this sentence.
 *
 * ── WHAT THIS FILE CAN AND CANNOT PROVE ─────────────────────────────────────────────────
 *
 * jsdom does not enforce `sandbox`, does not apply a `<meta>` CSP, and does not load
 * subresources. So the assertions here are about **what the document says**: that a
 * `<script>` is gone, that no remote url survives in a fetching position, that the CSP and
 * the sandbox string are what they claim to be, and that the mail's markup never enters the
 * app's own DOM. Whether a real engine then refuses to fetch the fixture's tracking pixel is a
 * question about a BROWSER, and it is answered by driving one — reported separately, with the
 * network log. Neither half is sufficient alone and this comment exists so nobody reads the
 * green tick here as the whole claim.
 *
 * **The browser half is `pnpm gate:frame-csp` (`scripts/frame-csp-live.mjs`)** and it is named
 * here rather than left to be rediscovered, because the two halves divide one claim. That
 * script serves the built document from a loopback origin under the app's own policy, reverts
 * each earlier mail-CSS fix inside the bundle it loads, and reads the network: with `img-src`
 * naming the proxy's own path the reverted payloads fetch nothing, and with `'self'` put back
 * they each issue a cookie-bearing GET. It ends with a control that must leak.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}
afterEach(async () => { await unmount(); });

type Mod = typeof import("../app/components/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/components/MessageBody.js");

/** The body markup the sanitizer produced, plus what it refused. */
async function clean(html: string, opts: Parameters<Mod["sanitizeMailHtml"]>[1] = {}) {
  const { sanitizeMailHtml } = await mod();
  return sanitizeMailHtml(html, opts);
}

/** The whole `srcdoc` a frame would be given for this html. */
async function docFor(
  html: string,
  opts: Parameters<Mod["buildMailDocument"]>[1] = {},
): Promise<string> {
  const { buildMailDocument } = await mod();
  const { html: body } = await clean(html);
  return buildMailDocument(body, opts);
}

/** Mount the component and hand back the container `MessagePane` wraps it in. */
async function render(props: Parameters<Mod["MessageBody"]>[0]): Promise<HTMLDivElement> {
  await unmount();
  const { MessageBody } = await mod();
  host = document.createElement("div");
  host.className = "msg-body";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(MessageBody, props)); });
  return host;
}

const frame = (): HTMLIFrameElement | null => host!.querySelector("iframe");
const srcdoc = (): string => frame()?.getAttribute("srcdoc") ?? "";

/**
 * A url in a position the BROWSER WOULD FETCH — `src`, `srcset`, `background`, CSS `url()`.
 *
 * Deliberately not "any http url anywhere": an `<a href>` to `x.example` is a link a reader may
 * click and must survive, and an assertion that forbade it would have to be weakened the
 * first time it met a real message. This one never has to be.
 */
const FETCHES_REMOTE =
  /(?:\bsrc\s*=\s*["']?|\bsrcset\s*=\s*["']?|\bbackground\s*=\s*["']?|url\(\s*["']?)https?:\/\//i;

// ══ 1. execution ═══════════════════════════════════════════════════════════════════════

describe("nothing in a message can execute", () => {
  it("a <script> does not survive sanitization, and neither does its text", async () => {
    // THE GUARD, and finding a mutation for it took two attempts, which is the interesting
    // part. Adding `"script"` to `ALLOWED_TAGS` leaves this GREEN — DOMPurify refuses to
    // allow-list `script` however it is configured, so that experiment proves nothing about
    // this file. The mutation that DOES prove it is bypassing the sanitizer:
    // `return { html: parsed.body.innerHTML, blocked }` before the `purify.sanitize` call.
    //
    // And THAT experiment failed the first time too, for a reason worth keeping: the fixture's
    // only `<script>` was in `<head>`, and this file hands the sanitizer `body.innerHTML`, so
    // the head script never reached it and the assertion passed with no sanitizer at all. The
    // fixture now carries one in `<body>` as well. Real failure text:
    //   AssertionError: expected '<style>\n  @import url("https://evil.…' not to contain
    //   '<script'
    const { html } = await clean(HOSTILE_HTML);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("postMessage");
    expect(html).not.toContain("evil.example/body-script");
    expect(html.toLowerCase()).not.toContain("document.cookie");
  });

  it("an onerror= / onload= attribute does not survive", async () => {
    // THE GUARD. Mutation: add `"onerror"` and `"onload"` to `ALLOWED_ATTR`. Real failure text:
    //   AssertionError: expected '…<img src="data:image/gif;base64,R0lGOD…" onerror="fetch(…'
    //   to not contain 'onerror'
    const { html } = await clean(HOSTILE_HTML);
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(html).not.toContain("evil.example/onerror");
    expect(html).not.toContain("evil.example/onload");
  });

  it("a javascript: href loses its destination and says so on screen", async () => {
    // THE GUARD, and the deletion point is the CONSTANT — see `SAFE_HREF`'s comment for why
    // there is one value rather than two checks. Mutation: `const SAFE_HREF = /./`. Real
    // failure text:
    //   AssertionError: expected '<a href="javascript:fetch(&#39;https:/…' to not contain
    //   'javascript:'
    const { html } = await clean(HOSTILE_HTML);
    expect(html).not.toContain("javascript:");
    // Not merely stripped — MARKED, so the reader sees a link that goes nowhere instead of
    // one that looks live and silently does nothing.
    expect(html).toContain("data-ohmail-inert");
    expect(html).toContain("Click me");
  });

  it("no <iframe>, <object>, <embed>, <form>, <input>, <base> or <meta refresh> survives", async () => {
    // THE GUARD. Mutation: add `"iframe"`, `"form"` and `"object"` to `ALLOWED_TAGS`. Real
    // failure text:
    //   AssertionError: <iframe survived: expected '<style>\n  \n  :root { --accent: #ff0…'
    //   not to contain '<iframe'
    //
    // Emptying a `FORBID_TAGS` list was the FIRST mutation tried here, and it left this
    // green — which is how the redundant list that used to sit beside `ALLOWED_TAGS` was
    // found and deleted. The allow-list is the only gate, so widening it is the only
    // mutation that can prove anything.
    const { html } = await clean(HOSTILE_HTML);
    for (const tag of ["<iframe", "<object", "<embed", "<form", "<input", "<button",
      "<base", "<meta", "<link", "<svg", "<video", "<noscript", "<template"]) {
      expect(html, `${tag} survived`).not.toContain(tag);
    }
    // `<base href>` is the quiet one: it re-points every relative url in the message and
    // leaves no visible trace at all. Asserted as "the element is gone AND the frame refuses
    // a base uri", not as "the string `evil.example` is absent" — that broader claim would be
    // FALSE for a correct implementation, because the fixture's `<a href="https://evil.example
    // /login">` is a link a reader may click and must survive. An assertion that forbids
    // correct output is one somebody has to weaken later.
    expect(html).not.toMatch(/<base\b/i);
    expect(await docFor(HOSTILE_HTML)).toContain("base-uri 'none'");
    // The credential prompt's own words stay — that is `KEEP_CONTENT`, and it is right: the
    // reader should see what the mail asked for. It just cannot be submitted anywhere.
    expect(html).toContain("Verify your account");
  });

  it("a sender cannot supply the markers this file writes", async () => {
    // THE GUARD. Mutation: `ALLOW_DATA_ATTR: true`. Real failure text:
    //   AssertionError: expected '<a data-ohmail-host="paypal.example" …' not to contain
    //   'paypal.example'
    //
    // `ADD_ATTR: ["data-ohmail-host", "target"]` was tried first and left this GREEN, because
    // the hook overwrites both on any http(s) link. The case that is NOT overwritten is a
    // scheme with no host — so the fixture is a `mailto:`, which is the shape that would
    // actually have printed a host of the sender's choosing.
    const { html } = await clean(
      `<a data-ohmail-host="paypal.example" data-ohmail-elsewhere="1" href="mailto:x@y.example">Pay</a>`,
    );
    expect(html).not.toContain("paypal.example");
    expect(html).not.toContain("data-ohmail-");
    // And on an http link the hook's own value is the one that survives.
    const { html: web } = await clean(
      `<a data-ohmail-host="paypal.example" target="_self" href="https://evil.example/x">Pay</a>`,
    );
    expect(web).toContain('data-ohmail-host="evil.example"');
    expect(web).not.toContain("paypal.example");
    expect(web).toContain('target="_blank"');
    expect(web).not.toContain('target="_self"');
  });
});

// ══ 2. remote content ══════════════════════════════════════════════════════════════════

describe("remote content is blocked, and blocked means not named", () => {
  it("the billing notice's own tracking pixel does not appear in the document at all", async () => {
    // THE ACCEPTANCE GUARD, on the reported mail. Mutation: in the `img` branch of
    // `onAttributes`, `node.setAttribute("src", src)` instead of `BLANK_GIF`. Real failure:
    //   AssertionError: expected '<!doctype html><html><head>…<img src=…' to not contain
    //   'https://url8792.mail.wolkenmail.example/wf/open?upn=u001.Hx4mQs9dWbPz5eRk9mNqTt2wVx'
    const doc = await docFor(OWNER_BILLING_HTML);
    expect(doc).not.toContain(OWNER_TRACKING_PIXEL);
    expect(doc).not.toContain("/wf/open");
  });

  it("no remote url survives in any position a browser would fetch", async () => {
    // THE GUARD that covers the shapes an `<img src>`-only blocker misses: `srcset`, the
    // html-3.2 `background=` attribute, and CSS `url()`. Mutation: delete the `srcset`
    // handling. Real failure text:
    //   AssertionError: expected '…srcset="https://cdn.wolkenmail.example/images/ema…' not to match
    //   /(?:\bsrc\s*=\s*["']?|\bsrcset…
    for (const fixture of [OWNER_BILLING_HTML, HOSTILE_HTML]) {
      const doc = await docFor(fixture);
      expect(doc, "a fetching url survived").not.toMatch(FETCHES_REMOTE);
    }
    // Named hosts, so a future rewrite that neutralises the SHAPE while leaving the string
    // somewhere fetchable still fails. Per-host and per-position, NOT "the host does not
    // appear": `<a href>` to any of these is a link and must survive — see the `<base>` case.
    const owner = await docFor(OWNER_BILLING_HTML);
    const hostile = await docFor(HOSTILE_HTML);
    for (const [doc, hostName] of [
      ...OWNER_REMOTE_HOSTS.map((hn) => [owner, hn] as const),
      [hostile, HOSTILE_HOST] as const,
    ]) {
      const fetching = new RegExp(
        `(?:\\bsrc\\s*=\\s*["']?|\\bsrcset\\s*=\\s*["']?|\\bbackground\\s*=\\s*["']?|url\\(\\s*["']?)https?://${hostName}`,
        "i",
      );
      expect(doc, `${hostName} is still fetchable`).not.toMatch(fetching);
    }
  });

  it("@import and remote url() are removed from the sender's stylesheet", async () => {
    // THE GUARD. Mutation: `return css` at the top of `neutraliseCss`. Real failure text:
    //   AssertionError: expected '<style>\n  @import url("https://evil.…' to not contain
    //   '@import'
    const { html, blocked } = await clean(HOSTILE_HTML);
    expect(html).not.toContain("@import");
    expect(html).not.toContain("css-beacon.gif");
    // Counted, not merely removed — the bar's sentence is built from this list.
    expect(blocked.map((b) => b.url)).toContain("https://evil.example/css-beacon.gif");
    expect(blocked.some((b) => b.url.endsWith("imported.css"))).toBe(false); // @import is cut whole
  });

  it("a data: URI is left alone — it fetches nothing", async () => {
    // The counter-case, and it is what keeps the rule from being "delete every url": inline
    // art is bytes the message already carries and cannot phone home. Mutation: drop the
    // `if (!REMOTE_URL.test(url)) return full` line in `neutraliseCss`; this goes red while
    // every assertion above stays green, which is the point of having it.
    const { html, blocked } = await clean(
      `<div style="background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)">x</div>`,
    );
    expect(html).toContain("data:image/gif;base64");
    expect(blocked).toHaveLength(0);
    // And a `cid:` — an attachment part of this very message — is left alone for the same
    // reason: `img-src data:` refuses it, so it renders nothing, but it names no host.
    const cid = await clean(`<div style="background-image:url(cid:part1@x)">x</div>`);
    expect(cid.blocked).toHaveLength(0);
  });

  it("a RELATIVE or PROTOCOL-RELATIVE css url() is cut — the attribute path already refuses one", async () => {
    // THE ASYMMETRY THIS CLOSES. `SAFE_HREF` is a POSITIVE scheme allow-list and DOMPurify
    // applies it to `href`/`src`/`background`, so `<img src="/api/x">` loses its attribute.
    // `style` is in DOMPurify's own `URI_SAFE_ATTRIBUTES` and a `<style>` element is text, so
    // NEITHER is checked against it — the only url policy on the css path is `neutraliseCss`,
    // and its final branch used to keep everything that was not `https?://` verbatim while its
    // comment said "data: and cid: stay". A relative url is neither, and it survived.
    //
    // A srcdoc document has no `<base>` (the head is discarded) so it resolves against the
    // embedder: `/api/…` becomes `https://ohmail.app/api/…`, which the frame's own
    // `img-src data: 'self'` PERMITS once the reader loads images, and which the sandbox's
    // `allow-same-origin` makes a cookie-bearing request. A protocol-relative `//host/x`
    // becomes `https://host/x` — a remote fetch that never passed the proxy or the counter.
    //
    // Mutation: restore `replacement = css.slice(start, end)` as the final `else` in
    // `neutraliseCss` — both halves of this go red while every assertion above stays green.
    const rel = await clean(`<div style="background-image:url(/api/messages/secret)">x</div>`);
    expect(rel.html, "a same-origin css url is an authenticated GET the reader did not ask for")
      .not.toContain("/api/messages/secret");
    const proto = await clean(`<style>.a{background:url(//evil.example/beacon.gif)}</style><p class="a">x</p>`);
    expect(proto.html, "a protocol-relative css url is a remote fetch wearing no scheme")
      .not.toContain("evil.example");

    // `image-set()` is the third spelling and it took its own narrowing: the branch asked
    // "did this set name a REMOTE url?", so a set whose only candidate was relative counted
    // zero and was kept whole. Mutation: drop `|| !allInert` from that branch.
    const set = await clean(
      `<div style="background-image:image-set(url(/api/messages/secret) 1x)">x</div>`,
    );
    expect(set.html, "a set whose candidates are relative is not a set with no urls in it")
      .not.toContain("/api/messages/secret");

    // AND THE COUNTER-CASE STAYS: the two schemes the comment names are still kept verbatim,
    // so this is a narrowing of the branch and not a deletion of it. Without this half, "cut
    // every url that is not https" would pass and inline art would stop rendering.
    const ok = await clean(
      `<div style="background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)">x</div>`,
    );
    expect(ok.html).toContain("data:image/gif;base64");
  });

  it("classifies the billing notice's beacon as a pixel and the logo as a picture", async () => {
    // Nothing is BLOCKED because of this flag — everything remote is blocked either way — so
    // what it guards is a SENTENCE, and the test says so rather than implying a safety
    // property. The reported mail's beacon matches BOTH signals (1×1 and `/wf/open`), which is
    // why asserting on it alone proved neither: `return false` in `declaresPixel` left this
    // green. The two signals therefore get a fixture each, below.
    const { blocked } = await clean(OWNER_BILLING_HTML);
    const beacon = blocked.find((b) => b.url === OWNER_TRACKING_PIXEL);
    expect(beacon).toBeDefined();
    expect(beacon!.pixel).toBe(true);
    expect(beacon!.host).toBe("url8792.mail.wolkenmail.example");
    const logo = blocked.find((b) => b.url.includes("wolkenmail_logo_chip.png"));
    expect(logo).toBeDefined();
    expect(logo!.pixel).toBe(false);
  });

  it("a hidden preheader stays in the frame document, and a beacon hidden in it is still refused", async () => {
    // The frame keeps what the letter hides (a "mobile-show" @media rule can re-show it); only
    // the prose walk skips it. Guard: the sanitizer's output is not where the fix lives.
    const out = await clean(
      `<div style="display:none;font-size:1px;max-height:0;overflow:hidden;mso-hide:all">` +
        `Your weekly picks&#847;&zwnj;&nbsp;&shy;</div><p>Hello Ben,</p><p>The plan is in.</p>` +
        `<div style="display:none"><img src="https://t.example/o.gif?uid=1" width="1" height="1"></div>`,
    );
    const doc = new DOMParser().parseFromString(out.html, "text/html");
    const hidden = doc.querySelector("div[style]");
    expect(hidden?.getAttribute("style")).toMatch(/display:\s*none/);
    expect(hidden?.textContent).toContain("Your weekly picks");
    expect(out.blocked.map((b) => [b.url, b.pixel])).toEqual([["https://t.example/o.gif?uid=1", true]]);
  });

  it("1×1 dimensions alone are enough to call it a beacon", async () => {
    // THE GUARD for the dimension signal, on a url with NO beacon shape at all. Mutation:
    // `return false` in `declaresPixel`. Real failure text:
    //   AssertionError: expected false to be true // Object.is equality
    const byAttr = await clean(`<img src="https://cdn.example/plain.jpg" width="1" height="1">`);
    expect(byAttr.blocked[0]!.pixel).toBe(true);
    const byStyle = await clean(
      `<img src="https://cdn.example/plain.jpg" style="width:1px;height:1px">`,
    );
    expect(byStyle.blocked[0]!.pixel).toBe(true);
    // A real image of a real size is not a beacon, or the word means nothing.
    const picture = await clean(`<img src="https://cdn.example/hero.jpg" width="600" height="200">`);
    expect(picture.blocked[0]!.pixel).toBe(false);
  });

  it("a beacon-shaped path alone is enough, at any declared size", async () => {
    // THE GUARD for the url signal, on an image that declares an ordinary size. Mutation:
    // `const BEACON_PATH = /$^/`. Real failure text:
    //   AssertionError: expected false to be true // Object.is equality
    const { blocked } = await clean(
      `<img src="https://esp.example/wf/open?upn=abc" width="20" height="20">`,
    );
    expect(blocked[0]!.pixel).toBe(true);
  });

  it("the frame's CSP is what makes this true for a vector nobody listed", async () => {
    // THE ENFORCEMENT, asserted separately from the rewriting so each can fail alone.
    // Mutation: change `default-src 'none'` to `default-src *` in `frameCsp`. Real failure:
    //   AssertionError: expected '<!doctype html>…content="default-src *…' to contain
    //   "default-src 'none'"
    const { frameCsp } = await mod();
    const doc = await docFor(OWNER_BILLING_HTML);
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("img-src data:");
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain("form-action 'none'");
    expect(doc).toContain("base-uri 'none'");
    expect(doc).toContain('name="referrer" content="no-referrer"');
    // There is NO policy under which the frame may name a sender's host. Consent adds ONE
    // source — our own proxy's own path, which fetches server-side — and nothing else.
    // `blob:` is the message's own pictures by reference (the object URLs this window minted);
    // it names no host, and no preview scheme or plain `http` source rides beside it.
    expect(frameCsp(null)).toBe(
      "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; " +
      "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
    );
    expect(frameCsp("https://ohmail.app/api/img")).toContain(
      "img-src data: blob: https://ohmail.app/api/img",
    );
    for (const policy of [frameCsp(null), frameCsp("https://ohmail.app/api/img")]) {
      expect(policy, "the frame may load a staged preview").not.toContain("attachment-preview");
      expect(policy, "the frame names a plain-http source").not.toMatch(/(^|[ ;])http:/);
    }
    expect(frameCsp(null), "the blocked policy names a scheme with a host").not.toMatch(/https?:/);
  });

  it("the consented policy names the proxy's PATH, never all of `'self'`", async () => {
    // ──. THE DOOR, RATHER THAN A SPELLING THAT REACHES IT ────────
    //
    // `img-src data: 'self'` admitted EVERY url on this origin, so any url a sanitizer
    // defect left behind resolved against the embedder (a srcdoc has no `<base>`) and became
    // an authenticated, cookie-bearing GET at a path the SENDER chose. Two hardening passes
    // each closed one spelling of that; this closes the ending they share.
    //
    // Mutation: `img-src data: 'self'` back into `frameCsp`. Real failure text:
    //   AssertionError: expected "default-src 'none'; img-src data: 'self'; …" not to match
    //   /(^|[; ])'self'/
    const { frameCsp } = await mod();
    const consented = frameCsp("https://ohmail.app/api/img");
    expect(consented).not.toMatch(/(^|[; ])'self'/);
    expect(frameCsp(null)).not.toMatch(/(^|[; ])'self'/);
    // The source carries a path, which is what makes it narrower than the origin. A source
    // that lost its path would be `https://ohmail.app` — every url on the origin again, by
    // another spelling — so the path is asserted rather than the string as a whole.
    const imgSrc = /(?:^|; )img-src ([^;]*)/.exec(consented)?.[1];
    expect(imgSrc).toBe("data: blob: https://ohmail.app/api/img");
  });

  it("the CSP source is MINTED by the proxy, so the policy cannot drift from the url", async () => {
    // The narrowing is only true if the path named is the path used. A second constant would
    // drift silently in both directions — a stale name blocks every consented image, a name
    // the app still serves turns the narrowing back into a widening — so the source is read
    // back out of the caller's own url-minting function.
    //
    // Mutation: return a hard-coded `"https://ohmail.app/api/img"` from `proxyImgSource`.
    // Real failure text:
    //   AssertionError: expected 'https://ohmail.app/api/img' to be
    //   'https://mail.example/v2/pic'
    const { proxyImgSource } = await mod();
    const origin = "https://mail.example";
    expect(proxyImgSource((u) => `/v2/pic?u=${encodeURIComponent(u)}`, origin))
      .toBe("https://mail.example/v2/pic");
    // Absolute is the shape the real chrome mints (`imageProxyUrl` builds against
    // `location.origin`), and it must read identically.
    expect(proxyImgSource((u) => `${origin}/api/img?mid=m1&u=${encodeURIComponent(u)}`, origin))
      .toBe("https://mail.example/api/img");
    // The probe url is not a real fetch and must not survive into the source — a source
    // carrying a query would be a policy that names the SENDER's url.
    expect(proxyImgSource((u) => `/api/img?u=${encodeURIComponent(u)}`, origin))
      .not.toContain("csp-probe");
  });

  it("a source this file cannot state truthfully is `null`, and null is the blocked policy", async () => {
    // EVERY REFUSAL IS FAIL-CLOSED, and each is a separate arm because each fails alone.
    //
    // Mutation: drop the `u.origin !== origin` guard in `proxyImgSource`. Real failure text:
    //   AssertionError: expected 'https://evil.example/pic' to be null
    const { proxyImgSource, frameCsp } = await mod();
    const origin = "https://mail.example";
    // A foreign host. The frame may never name one, and this is the file's oldest rule.
    expect(proxyImgSource(() => "https://evil.example/pic", origin)).toBeNull();
    // A scheme that is not http(s) — a custom shell protocol, a `data:` proxy.
    expect(proxyImgSource(() => "tauri://localhost/api/img", origin)).toBeNull();
    // A path carrying a CSP delimiter would APPEND a directive of the caller's choosing:
    // `img-src data: https://mail.example/a; script-src 'unsafe-inline'`. Refused as syntax.
    expect(proxyImgSource(() => "/a;script-src 'unsafe-inline'", origin)).toBeNull();
    // A throw and an unparseable answer are the same answer.
    expect(proxyImgSource(() => { throw new Error("no"); }, origin)).toBeNull();
    expect(proxyImgSource(() => "http://", origin)).toBeNull();
    // And `null` is not a degraded policy — it is exactly the policy a message with no
    // consent gets, so a misconfigured proxy blocks rather than half-loads.
    expect(frameCsp(proxyImgSource(() => "https://evil.example/pic", origin))).toBe(frameCsp(null));
  });

  it("consent routes an image through the proxy and NEVER at the sender directly", async () => {
    // The seam the consent path lands on, exercised so it is not an untested branch waiting
    // to be wrong. Mutation: `node.setAttribute("src", src)` in the `proxy` branch. Real
    // failure text:
    //   AssertionError: expected '…<img src="https://cdn.wolkenmail.example/images/e…' to not match
    //   /src\s*=\s*["']?https?:\/\/cdn\.wolkenmail\.example/i
    const { html } = await clean(OWNER_BILLING_HTML, {
      imageProxy: (u) => `/api/img?mid=m1&u=${encodeURIComponent(u)}`,
    });
    expect(html).toContain("/api/img?mid=m1&amp;u=https%3A%2F%2Fcdn.wolkenmail.example");
    expect(html).not.toMatch(/src\s*=\s*["']?https?:\/\/cdn\.wolkenmail\.example/i);
    expect(html).not.toContain(OWNER_TRACKING_PIXEL);
  });

  it("and consent does NOT extend to the beacon, even through the proxy", async () => {
    // THE GUARD, and it was found by driving a browser rather than by reading the code: with
    // consent granted, the reported mail's beacon was going through the proxy alongside the four real
    // images. The reader's IP was never exposed — but the ESP still learns the message was
    // opened, and nobody consents to that by asking for pictures.
    //
    // Mutation: `if (proxy)` in place of `if (proxy && !pixel)`. Real failure text:
    //   AssertionError: expected '<style type="text/css">…' not to contain
    //   'u=https%3A%2F%2Furl8792.mail.wolkenmail.example'
    const { html } = await clean(OWNER_BILLING_HTML, {
      imageProxy: (u) => `/api/img?mid=m1&u=${encodeURIComponent(u)}`,
    });
    expect(html).not.toContain("u=https%3A%2F%2Furl8792.mail.wolkenmail.example");
    // The four real images DID go through it, so this is not "the proxy is broken".
    // Distinct: a parked css url is named by its live style and by the queue's list.
    expect(new Set(html.match(/\/api\/img\?mid=m1&amp;u=[^"&\s)]+/g) ?? []).size).toBe(4);
  });
});

// ══ 2b. dark viewing is one attribute, not a second document ════════════════════════════

describe("the dark transform is a root attribute and nothing else", () => {
  it("buildMailDocument(dark) is the light document plus the root attribute, byte for byte", async () => {
    // THE STRUCTURAL GUARD. The whole dark rendering lives in the injected sheet, gated on
    // `:root[data-ohmail-dark]`; the ONLY thing the dark build may change is whether the root
    // element carries that attribute. That is what lets the live flip be a `toggleAttribute`
    // on the frame's own document rather than a rebuilt srcdoc — a rebuild would re-parse the
    // sender's html and re-measure it.
    //
    // Mutation: in `buildMailDocument`'s dark path, wrap the body — e.g.
    // `opts.dark ? "<div>" + bodyHtml + "</div>" : bodyHtml`. Real failure text:
    //   AssertionError: expected '…<body><div>hi</div>…' to be '…<body>hi…'
    const { buildMailDocument } = await mod();
    const body = '<p>hi</p><img src="cid:x">';
    const light = buildMailDocument(body);
    const dark = buildMailDocument(body, { dark: true });

    // The attribute the sheet's transform is gated on, on the root and nowhere the light
    // build put anything.
    expect(dark).toContain('<html data-ohmail-dark="1">');
    expect(light).toContain("<html>");
    // The ROOT ELEMENT carries no such attribute in the light build — the string still appears
    // below, in the dormant `:root[data-ohmail-dark]` selectors, which is the whole point.
    expect(light).not.toContain("<html data-ohmail-dark");
    // Strip that one attribute back off and the two documents are identical. A dark path that
    // wrapped, reordered or re-sheeted the body breaks this equality.
    expect(dark.replace(' data-ohmail-dark="1"', "")).toBe(light);

    // And the transform ships in BOTH builds, dormant in the light one — which is the other
    // half of "flip, don't rebuild": the sheet the reader already has can be switched on in
    // place. Mutation: move the `invert(1) hue-rotate(180deg)` rules out of `FRAME_CSS` and
    // into the dark branch, and this goes red while the equality above still passes.
    expect(light).toContain("invert(1) hue-rotate(180deg)");
    expect(light).toContain("[data-ohmail-dark]");
  });
});

// ══ 3. containment ═════════════════════════════════════════════════════════════════════

describe("a message cannot reach the app around it", () => {
  it("the sandbox grants no script, no forms and no top navigation", async () => {
    // THE GUARD. Mutation: add ` allow-scripts` to `FRAME_SANDBOX`. Real failure text:
    //   AssertionError: expected 'allow-same-origin allow-popups allow-…' not to contain
    //   'allow-scripts'
    const { FRAME_SANDBOX } = await mod();
    const el = await render({ text: OWNER_BILLING_TEXT, html: OWNER_BILLING_HTML });
    expect(el.querySelector("iframe")!.getAttribute("sandbox")).toBe(FRAME_SANDBOX);
    // EXACT, and that is the point: the loop below only catches tokens it thought to name,
    // but this catches ANY token added anywhere in the string. Mutation: add ` allow-scripts`
    // to `FRAME_SANDBOX`. Real failure text:
    //   AssertionError: expected 'allow-same-origin allow-popups allow-…-sandbox allow-scripts'
    //   to be 'allow-same-origin allow-popups allow-popups-to-escape-sandbox'
    expect(FRAME_SANDBOX).toBe("allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    for (const token of ["allow-scripts", "allow-forms", "allow-top-navigation",
      "allow-modals", "allow-pointer-lock", "allow-presentation"]) {
      expect(FRAME_SANDBOX, `${token} was granted`).not.toContain(token);
    }
    // The two that ARE granted, named so removing one is a decision and not a typo.
    // `allow-popups` is load-bearing for the desktop: a link leaves the frame as a new-window
    // request, and without the token WebKit refuses it before the shell's door is asked.
    expect(FRAME_SANDBOX).toContain("allow-same-origin");
    expect(FRAME_SANDBOX).toContain("allow-popups");
  });

  it("mail CSS never enters the app's own document", async () => {
    // THE CONTAINMENT GUARD. Mutation: replace the `<iframe srcDoc={mail.doc}>` with
    // `<div dangerouslySetInnerHTML={{ __html: mail.doc }} />`. Real failure text:
    //   AssertionError: expected <div class="mb-sheet">…</div> to be null
    // — and, with the style assertion, the mail's `.msg-body{display:none}` rule would then
    // be live in the app's stylesheet, which is the defect the whole shape exists to prevent.
    //
    // WRAPPED IN A CANVAS, and that is load-bearing rather than incidental. This test is about
    // the FRAMED path's containment, and the hostile fixture on its own no longer takes it: a
    // stylesheet stopped disqualifying a document from `prose` when that criterion was measured
    // against real mail and found to be answering "did the sender's client emit markup?".
    // Without the canvas the assertions about `srcdoc()` below would read an empty string and
    // this guard would pass for the reason it exists to rule out. The prose path's own
    // containment is asserted in `message-body-prose.test.ts`, over this same fixture.
    const el = await render({
      text: "fallback",
      html: `<table width="600"><tr><td>${HOSTILE_HTML}</td></tr></table>`,
    });
    // Not one element of the message is in the app's tree.
    expect(el.querySelector("style")).toBeNull();
    expect(el.querySelector("p.leak")).toBeNull();
    // THE PRECISE FORM OF THE CLAIM: delete the frame and NOTHING of the message is left.
    // `el.innerHTML` on its own cannot say this — it serializes the `srcdoc` ATTRIBUTE, so
    // the mail's text is inside it either way and the assertion would pass for the broken
    // implementation too. Removing the iframe is what distinguishes "the markup is a value
    // held by an element" from "the markup IS the elements".
    const clone = el.cloneNode(true) as HTMLElement;
    for (const f of [...clone.querySelectorAll("iframe")]) f.remove();
    expect(clone.innerHTML).not.toContain("display");
    expect(clone.innerHTML).not.toContain(".msg-body");
    expect(clone.innerHTML).not.toContain("--accent");
    expect(clone.innerHTML).not.toContain(HOSTILE_HOST);
    // It is all inside the frame's `srcdoc`, where it applies to the sender's document only.
    expect(srcdoc()).toContain(".msg-body");
    expect(srcdoc()).toContain("<style>");
  });

  it("keeps the sender's stylesheet, which is why mail looks like mail", async () => {
    // The reason the frame exists rather than a stripped-down inline render. Mutation: remove
    // `"style"` from `ALLOWED_TAGS`. Real failure text:
    //   AssertionError: expected '<!doctype html>…' to contain '.cta'
    // Every designed message would arrive as unstyled left-aligned text with this mutation in
    // place, and no security assertion in this file would notice.
    const doc = await docFor(OWNER_BILLING_HTML);
    expect(doc).toContain(".cta");
    expect(doc).toContain("@media only screen and (max-width:620px)");
    expect(doc).toContain("background:#d97757");
  });

  it("survives html truncated mid-tag at the storage cap", async () => {
    // `prepareHtmlForStorage` cuts `message_bodies.html` at 256 KiB on a BYTE boundary, so
    // what arrives here can end inside an attribute. Mutation: none needed to break it — this
    // is a regression guard for anyone who replaces the parser with a string transform.
    const cut = OWNER_BILLING_HTML.slice(0, 1400) +
      "\n<!-- ohmail: body truncated at the storage cap; the full message is in your mailbox -->";
    const { html } = await clean(cut);
    expect(html.length).toBeGreaterThan(0);
    expect(html).not.toMatch(FETCHES_REMOTE);
  });
});

// ══ 4. links ═══════════════════════════════════════════════════════════════════════════

describe("links look like links and say where they go", () => {
  it("shows the sender's words, not the url — the reported defect, inverted", async () => {
    // The reported paste rendered the CTA as `Manage usage credits
    // [url8792.mail.wolkenmail.example/ls/click?upn=…]`. Mutation: none — this is the acceptance
    // assertion, and it fails the moment the component falls back to the text renderer.
    const doc = await docFor(OWNER_BILLING_HTML);
    expect(doc).toContain(">Manage usage credits</a>");
    expect(doc).not.toContain("[url8792");
  });

  it("every link opens in a new tab and cannot reach back", async () => {
    // THE GUARD. Mutation: delete the `node.setAttribute("rel", …)` line. Real failure text:
    //   AssertionError: expected '…<a target="_blank" href="https://url…' to contain
    //   'rel="noopener noreferrer nofollow"'
    // Without a `target`, a click navigates the FRAME and the message is replaced by the
    // destination — with the sandbox still on it, so the page renders scriptless and broken.
    const { html } = await clean(OWNER_BILLING_HTML);
    const anchors = [...html.matchAll(/<a\b[^>]*>/gi)].map((m) => m[0]);
    expect(anchors.length).toBeGreaterThan(3);
    for (const a of anchors) {
      expect(a, a).toContain('target="_blank"');
      expect(a, a).toContain('rel="noopener noreferrer nofollow"');
    }
  });

  it("names the real destination host for hover, focus and assistive tech", async () => {
    // THE GUARD. Mutation: delete the `node.setAttribute("title", …)` line. Real failure:
    //   AssertionError: expected '…<a target="_blank" rel="noopener nor…' to contain
    //   'title="Goes to url8792.mail.wolkenmail.example"'
    const doc = await docFor(OWNER_BILLING_HTML);
    expect(doc).toContain('title="Goes to url8792.mail.wolkenmail.example"');
    expect(doc).toContain('data-ohmail-host="url8792.mail.wolkenmail.example"');
    // The `::after` that reveals it without a line of script — the frame has none.
    expect(doc).toContain("a[data-ohmail-host]:hover::after");
    expect(doc).toContain("a[data-ohmail-host]:focus::after");
  });

  it("marks a link whose visible text names somewhere else", async () => {
    // THE GUARD for the phishing shape. Mutation: `return false` in
    // `textDisagreesWithHref`. Real failure text:
    //   AssertionError: expected '…>https://www.bank.example/secure</a>' to contain
    //   'data-ohmail-elsewhere'
    const { html } = await clean(HOSTILE_HTML);
    expect(html).toContain("data-ohmail-elsewhere");
    // And it must NOT fire on an ordinary link, or it means nothing by the second message.
    const { html: ordinary } = await clean(
      `<a href="https://url8792.mail.wolkenmail.example/ls/click?upn=x">Manage usage credits</a>`,
    );
    expect(ordinary).not.toContain("data-ohmail-elsewhere");
  });

  it("textDisagreesWithHref: the unit, at its edges", async () => {
    const { textDisagreesWithHref } = await mod();
    expect(textDisagreesWithHref("https://www.bank.example/secure", "evil.example")).toBe(true);
    expect(textDisagreesWithHref("bank.example", "evil.example")).toBe(true);
    // A subdomain of the claimed host is not a disagreement.
    expect(textDisagreesWithHref("wolkenmail.example", "mail.wolkenmail.example")).toBe(false);
    // Ordinary prose naming no host is not a disagreement.
    expect(textDisagreesWithHref("Manage usage credits", "url8792.mail.wolkenmail.example")).toBe(false);
    expect(textDisagreesWithHref("Read more →", "example.com")).toBe(false);
  });

  it("`links` is exactly the http(s) anchors the frame keeps, as `URL.href`", async () => {
    // What the desktop shell may open for this frame (`rendered-links.ts`). Mutations: report the
    // raw href → the spelling rows go red; report every anchor → the mailto/tel/cid/inert rows go
    // red; skip the anchor branch → the list is empty.
    const { html, links } = await clean([
      '<a href="https://example.test/a?b=1&amp;c=2#f">one</a>',
      '<a href="HTTP://EXAMPLE.TEST/Path">two</a>',
      '<a href="https://bücher.example/ü">three</a>',
      '<a href=" https://example.test/x y ">four</a>',
      '<a href="https://example.test/?ids=1|2">five</a>',
      '<a href="https:example.test/no-slashes">six</a>',
      '<a href="https://example.test/a?b=1&amp;c=2#f">one again</a>',
      '<a href="/relative">rel</a>',
      '<a href="//example.test/protocol-relative">pr</a>',
      '<a href="mailto:x@y.test">mail</a>',
      '<a href="tel:+41000000000">tel</a>',
      '<a href="cid:part1@x.test">cid</a>',
      '<a href="javascript:alert(1)">js</a>',
      '<a href="https://">no host</a>',
    ].join(" "));
    expect(links).toEqual([
      "https://example.test/a?b=1&c=2#f",
      "http://example.test/Path",
      "https://xn--bcher-kva.example/%C3%BC",
      "https://example.test/x%20y",
      "https://example.test/?ids=1|2",
      "https://example.test/no-slashes",
    ]);
    // Every http(s) anchor the frame keeps resolves to an entry, and no entry is anything else.
    const kept = new DOMParser().parseFromString(html, "text/html");
    const resolved = [...kept.querySelectorAll("a[href]")]
      .map((a) => { try { return new URL(a.getAttribute("href")!); } catch { return null; } })
      .filter((u): u is URL => u !== null && (u.protocol === "http:" || u.protocol === "https:"))
      .map((u) => u.href);
    expect(new Set(resolved)).toEqual(new Set(links));
    // A message with no html to sanitize has nothing to report.
    expect((await clean("")).links).toEqual([]);
  });
});

// ══ 5. the surface ═════════════════════════════════════════════════════════════════════

describe("what the reader is told, and what they are offered", () => {
  it("the bar reports what LOADED, not what the reader consented to", async () => {
    // ── CONSENT IS NOT THE SAME FACT AS DELIVERY, AND THE BAR IS ABOUT THE SECOND ────────
    //
    // `remoteLoaded` is the reader's answer — a stored flag, a press, or the account's auto
    // mode. Whether anything then loaded depends on there being a usable proxy, and there are
    // two ways there is not: a client with no image proxy at all (the demo, any build with no
    // API), and the fail-closed branch where `proxyImgSource` cannot state a source the
    // frame's CSP would accept. In both, the pictures ARE counted in `blocked` and the reader
    // must be told; keying the bar on consent showed them blank boxes and said nothing.
    //
    // Mutation: `const remoteShown = remoteLoaded` in `MessageBody`. Real failure text:
    //   AssertionError: consent without a usable proxy blanked the picture and said nothing:
    //   expected null not to be null
    const consentedButUndeliverable = await render({
      text: "Hello there.",
      html: `<p>Hi</p><p><img src="https://cdn.example.com/pic.png" width="40" height="40"></p>`,
      remoteLoaded: true,
      // No `imageProxy`: consent is recorded and there is nothing to deliver it with.
    });
    const bar = consentedButUndeliverable.querySelector(".mb-bar");
    expect(bar, "consent without a usable proxy blanked the picture and said nothing")
      .not.toBeNull();
    expect(bar!.textContent).toMatch(/remote image/i);

    // The SAME message with a usable proxy loads and therefore reports nothing — which is
    // what stops this from degenerating into "the bar always shows".
    const delivered = await render({
      text: "Hello there.",
      html: `<p>Hi</p><p><img src="https://cdn.example.com/pic.png" width="40" height="40"></p>`,
      remoteLoaded: true,
      imageProxy: (u) => `/api/img?mid=m1&u=${encodeURIComponent(u)}`,
      onLoadRemote: () => {},
    });
    expect(delivered.querySelector(".mb-bar")?.textContent ?? "").not.toMatch(/remote image/i);
  });

  it("a proxy the frame's policy would refuse is not used, and is not offered", async () => {
    // The other half of the same value. A proxy minting a CROSS-ORIGIN url has no expressible
    // source in this frame's policy (`proxyImgSource` returns null), so using it would render
    // an <img> the browser then refuses — a broken picture under a bar that had stopped
    // counting it. The component must instead behave exactly as it does with no proxy at all:
    // the picture stays blocked, the bar says so, and no "Show images" button is offered,
    // because pressing one would consent to something that cannot be delivered.
    //
    // Mutation: `const proxy = remoteLoaded ? imageProxy : null` (drop the `imgSource !== null`
    // term). Real failure text:
    //   AssertionError: a url the frame's CSP cannot name was written into the document:
    //   expected '…<img src="https://evil.example/p?u=…' not to contain 'evil.example'
    // A DESIGNED mail, so the framed path renders and there is a policy to inspect: the
    // frameless prose path draws no images at all, which would make every assertion below
    // true for a reason that has nothing to do with the policy.
    const el = await render({
      text: "Hello there.",
      html: `<table width="600" cellpadding="0"><tr><td>` +
        `<img src="https://cdn.example.com/pic.png" width="400" height="200"></td></tr></table>`,
      remoteLoaded: true,
      imageProxy: (u) => `https://evil.example/p?u=${encodeURIComponent(u)}`,
      onLoadRemote: () => {},
    });
    const frame = el.querySelector("iframe");
    expect(frame, "no frame was rendered").not.toBeNull();
    const doc = frame!.getAttribute("srcdoc") ?? "";
    expect(doc, "a url the frame's CSP cannot name was written into the document")
      .not.toContain("evil.example");
    // …and the policy stayed the blocked one rather than naming that host.
    expect(doc).toContain("img-src data: blob:;");
    // The bar tells the truth about it, and there is no button over a dead capability.
    expect(el.querySelector(".mb-bar")?.textContent ?? "").toMatch(/remote image/i);
    expect(el.textContent ?? "").not.toMatch(/show images/i);
  });

  it("reports the blocked count and names the pixel", async () => {
    // THE GUARD for the bar. Mutation: `const showBar = false`. Real failure text:
    //   AssertionError: expected null not to be null
    const el = await render({ text: OWNER_BILLING_TEXT, html: OWNER_BILLING_HTML });
    const bar = el.querySelector(".mb-bar");
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toMatch(/\d+ remote images blocked\./);
    expect(bar!.textContent).toContain("tracking pixel");
  });

  it("no bar when images are loaded and nothing else is blocked — Show original still stays", async () => {
    // ITEM 2 / GUARD. Two removals meet on this message. The "Images loaded for this
    // message." status line fired on every auto-loaded message and told the reader nothing —
    // it is gone. And a letter with nothing blocked no longer raises a bar just to hold the
    // flip: `showBar` reads `hasBlocked || canAdapt`, and this message has neither. So there is
    // NO bar at all — which is also why the removed banner cannot reappear here. The way to the
    // sender's own layout survives as its own control (`.mb-flip`).
    //
    // Mutation: `const showBar = hasBlocked || canAdapt || proseable` (the empty-bar condition
    // this slice removed) — the bar comes back with nothing in it. Real failure text:
    //   AssertionError: an empty bar was raised for a letter with nothing blocked: expected
    //   <div class="mb-bar" …> to be null
    //
    // ── THE FIXTURE CARRIES AN `imageProxy`, AND IT DID NOT UNTIL THE POLICY NARROWING ────
    //
    // It used to pass `remoteLoaded: true` and no proxy, which is a message whose picture had
    // no way to load: the sanitizer blanked it and counted it, and the bar said nothing —
    // exactly the disclosure gap the `remoteShown` term now closes. The old shape made this
    // test's own premise false ("nothing else is blocked" while something was), so the fix is
    // to give the letter a picture that really does load rather than to soften the assertion.
    const el = await render({
      text: "Hello there.\n\nRegards.",
      html: `<p>Hello there.</p><p><img src="https://cdn.example.com/pic.png"></p><p>Regards.</p>`,
      remoteLoaded: true,
      imageProxy: (u) => `/api/img?mid=m1&u=${encodeURIComponent(u)}`,
      onLoadRemote: () => {},
    });
    expect(el.querySelector(".mb-bar"), "an empty bar was raised for a letter with nothing blocked")
      .toBeNull();
    // The removed noise line cannot reappear: there is no bar to carry it.
    expect(el.textContent ?? "").not.toMatch(/images loaded/i);
    const flip = el.querySelector(".mb-flip");
    expect(flip, "the way back to the sender's own rendering was lost").not.toBeNull();
    expect(flip!.textContent).toBe("Show original");
  });

  it("offers no button when there is no way to load an image", async () => {
    // THE HONESTY GUARD. `GET /img` is not mounted (`packages/api/src/routes/privacy.ts`),
    // so `imageProxy` is null and a "Show images" button would be a control that does
    // nothing. Mutation: `const canLoad = !remoteLoaded`. Real failure text:
    //   AssertionError: expected <button class="mb-bar-btn">Show images</button> to be null
    const el = await render({ text: OWNER_BILLING_TEXT, html: OWNER_BILLING_HTML });
    expect(el.querySelector(".mb-bar-btn")).toBeNull();
    // Given a proxy AND a handler, it appears. Both, not either: a button with a proxy and
    // no handler is inert, and one with a handler and no proxy loads nothing.
    const withProxy = await render({
      text: OWNER_BILLING_TEXT, html: OWNER_BILLING_HTML,
      imageProxy: (u) => `/api/img?u=${encodeURIComponent(u)}`, onLoadRemote: () => {},
    });
    expect(withProxy.querySelector(".mb-bar-btn")!.textContent).toBe("Show images");
  });

  it("no bar at all for a message that named nothing remote", async () => {
    // Mutation: `const showBar = true`. A bar on every message is a bar nobody reads.
    //
    // The fixture DECLARES A CANVAS, and that is not decoration: `<p>Thanks — see you
    // Friday.</p>` alone is the PROSE class and renders frameless, which would make the
    // `iframe` line below a green for a reason that has nothing to do with the bar. A declared
    // canvas is now the ONLY thing that keeps a message in the frame — a picture no longer
    // does, which is exactly the change this comment used to describe from the other side.
    const el = await render({
      text: "hi",
      html: `<table width="600"><tr><td><p>Thanks — see you Friday.</p></td></tr></table>`,
    });
    expect(el.querySelector(".mb-bar")).toBeNull();
    expect(el.querySelector("iframe")).not.toBeNull();
  });

  it("falls back to the text renderer when there is no html, unchanged", async () => {
    // THE NO-REGRESSION GUARD. THE paragraph + linkify behaviour is delegated to
    // `BodyText`, not reimplemented. Mutation: return `null` instead of `<BodyText/>` on the
    // `!mail` branch. Real failure text:
    //   AssertionError: expected +0 to be 3 // Object.is equality
    const el = await render({ text: "First.\n\nSecond.\n\nThird.", html: null });
    expect(el.querySelectorAll("p.msg-p")).toHaveLength(3);
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("falls back to text when the html sanitizes away to nothing", async () => {
    // A message whose entire html part is a script is a message with no renderable html.
    // Mutation: drop the `clean.trim().length === 0` check — an empty frame renders instead
    // of the words the reader could have had.
    const el = await render({ text: "the words", html: "<script>x()</script>" });
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.textContent).toContain("the words");
  });

  it("the frame is sized to the message, not to a guess", async () => {
    // jsdom lays nothing out, so this asserts the WIRING rather than a pixel height: the
    // element carries no fixed `height` attribute and the sizing is the effect's job.
    // Mutation: add `height="600"` to the iframe — a fixed-height frame with its own
    // scrollbar is the thing every reader hates about webmail.
    // The declared canvas keeps this message OUT of the prose class, which renders no frame at
    // all — see `isRigidLayout`. `<p>short</p>` on its own is a letter, and this test is about
    // the frame.
    const el = await render({
      text: "x",
      html: '<table width="600"><tr><td><p>short</p></td></tr></table>',
    });
    const f = el.querySelector("iframe")!;
    expect(f.getAttribute("height")).toBeNull();
    expect(f.className).toBe("mb-frame");
    expect(f.getAttribute("title")).toBe("Message content");
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});

describe("a press in the letter leaves the app its keys", () => {
  // Tester round 34: after a click into a framed letter, j, k, Escape and g o did nothing until a
  // click outside it. The focus sat in the letter's document, where WebKit runs no listener.
  const letter = '<table width="600"><tr><td><p>Thanks, see you Friday.</p><a href="https://example.com/">link</a></td></tr></table>';
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function pressInto(): Promise<HTMLIFrameElement> {
    const el = await render({ text: "x", html: letter });
    const f = el.querySelector<HTMLIFrameElement>("iframe.mb-frame")!;
    f.focus();
    expect(document.activeElement).toBe(f);
    window.dispatchEvent(new Event("blur"));
    return f;
  }

  it("a plain press gives the focus back to the app", async () => {
    // Mutation: drop the watch from MessageBody; the focus stays in the letter.
    await pressInto();
    await wait(250);
    expect(document.activeElement?.tagName).not.toBe("IFRAME");
  });

  it("a selection in the letter hands the keys back too, and stays; select-all then selects the letter", async () => {
    // Copy itself is read in real engines: letter-focus-browser.test.ts.
    const f = await pressInto();
    const inner = f.contentDocument!;
    inner.body.innerHTML = "<p>some words to copy</p><p>and more</p>";
    const range = inner.createRange();
    range.selectNodeContents(inner.body.firstChild!);
    inner.getSelection()!.addRange(range);
    await wait(250);
    expect(document.activeElement?.tagName).not.toBe("IFRAME");
    expect(inner.getSelection()!.toString()).toBe("some words to copy");
    const all = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(all);
    expect(all.defaultPrevented).toBe(true);
    expect(inner.getSelection()!.toString()).toBe("some words to copyand more");
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const own = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(own);
    expect(own.defaultPrevented, "a press in the app gives select-all back to it").toBe(false);
  });

  it("no focus is taken while the window is behind another", async () => {
    const away = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      const f = await pressInto();
      await wait(250);
      expect(document.activeElement).toBe(f);
    } finally {
      away.mockRestore();
    }
  });
});
