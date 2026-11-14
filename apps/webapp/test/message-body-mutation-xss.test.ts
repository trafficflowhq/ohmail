/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  MXSS_ANCHOR_INJECTION,
  MXSS_SPLIT_CLOSE_TAG,
  MXSS_CSS_SHAPES,
  MXSS_CSS_SHAPE_URLS,
  MXSS_HEAD_BREAKOUT,
  MXSS_HOST,
  MXSS_IMPORT_REFORM,
  MXSS_STYLE_BREAKOUT,
  quadraticCss,
} from "./fixtures/mutation-xss-payloads";
import { HOSTILE_HTML, OWNER_BILLING_HTML } from "./fixtures/owner-billing-email";

/**
 * ──–THE 2026-08-04 ADVERSARIAL PASS, AS GUARDS ─────────────────────────────
 *
 * `message-body.test.ts` asserts what the sanitizer SAYS about a message. This file asserts
 * something narrower and, it turns out, more important: **that the string the sanitizer
 * returns still means the same thing after the frame has parsed it.** Every finding below
 * lived in the gap between those two sentences.
 *
 * The mechanism, once, because all four share it: the renderer used to rewrite a `<style>`
 * element's TEXT after DOMPurify had finished. `<style>` serializes raw, so a rewrite that
 * DELETES can join the two halves of a close tag that were never adjacent — and the document
 * DOMPurify approved is not the document the browser builds.
 *
 * ── WHAT THIS FILE CANNOT PROVE, SO THAT NOBODY READS THE TICK AS THE WHOLE CLAIM ───────
 *
 * jsdom performs no layout and fetches no subresource. So (the frame-height runaway) has
 * NO guard here at all — its numbers are pixels, and pixels come from a browser; it is
 * measured in the UX suite's mutation-XSS journey, which drives real
 * Chromium under the policy production serves. The same journey is where "these urls are
 * never REQUESTED" is decided; below, the claim is only that they are never NAMED.
 */

type Mod = typeof import("../app/letter-body/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/letter-body/MessageBody.js");

async function clean(html: string, opts: Parameters<Mod["sanitizeMailHtml"]>[1] = {}) {
  const { sanitizeMailHtml } = await mod();
  return sanitizeMailHtml(html, opts);
}

/**
 * THE DOCUMENT THE FRAME WILL ACTUALLY HAVE.
 *
 * Every assertion in this file reads from HERE and never from the string, because the string
 * is exactly what was not the problem: `sanitizeMailHtml` returned markup that looked cleared
 * and became a `<form>` the moment an html parser touched it. `srcdoc` runs this same parse.
 */
function reparse(bodyHtml: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${bodyHtml}</body></html>`,
    "text/html",
  );
}

/** Every element the frame ends up with, in document order, lowercased. */
function tagsIn(bodyHtml: string): string[] {
  return [...reparse(bodyHtml).body.querySelectorAll("*")].map((el) => el.tagName.toLowerCase());
}

/**
 * EVERY REMOTE URL THE FRAME WOULD FETCH ON OPEN, read from the parsed DOM rather than from
 * the string — and the distinction is the whole finding.
 *
 * `"the url does not appear in the output"` is the WRONG claim and would have to be weakened
 * the first time it met a correct implementation: a neutralised stylesheet keeps the sender's
 * bytes as inert CSS text, and text in a `<style>` is not a fetching position. What the
 * browser acts on is an element's `src`/`srcset`/`background`, and a `url()` TOKEN in css.
 * `href` is excluded for the reason `mail-lab.ts` excludes it — a link is fetched on click.
 */
function fetchedOnOpen(bodyHtml: string): string[] {
  const found: string[] = [];
  const push = (raw: string): void => {
    const u = raw.trim();
    if (/^https?:\/\//i.test(u) && !found.includes(u)) found.push(u);
  };
  const urlTokens = (css: string): void => {
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]*)/gi)) push(m[1] ?? "");
  };
  const doc = reparse(bodyHtml);
  for (const el of doc.body.querySelectorAll("*")) {
    push(el.getAttribute("src") ?? "");
    push(el.getAttribute("background") ?? "");
    for (const cand of (el.getAttribute("srcset") ?? "").split(",")) {
      push(cand.trim().split(/\s+/)[0] ?? "");
    }
    urlTokens(el.getAttribute("style") ?? "");
    if (el.tagName.toLowerCase() === "style") urlTokens(el.textContent ?? "");
  }
  return found;
}

// ══ 1. the rewrite may not invent markup ══════════════════════════════════════════

describe("the sanitizer's output cannot become live markup when the frame parses it", () => {
  /**
   * THE CLASS GUARD, and it is the one to keep if only one survives.
   *
   * It does not enumerate a tag, a host or a payload. It states the property the whole slice
   * rests on and that nothing was checking: **the markup we hand the frame parses to the tree
   * we built.** A text rewrite that invents a close tag breaks it by construction, whatever
   * the invented element happens to be, and so does the next one nobody has thought of.
   *
   * Mutation: `const CUT = ""` (i.e. delete `@import` rather than replace it). Real failure
   * text against the shipped build:
   *   AssertionError: MXSS_STYLE_BREAKOUT does not survive a parse: expected
   *   '<style></style><form action="https://ev…' to be '<style></style><form action="https://ev…'
   *   (the two differ at the point the parser re-opened the document)
   */
  it("every fixture's output is a FIXED POINT of an html parse", async () => {
    for (const [name, fixture] of [
      ["MXSS_STYLE_BREAKOUT", MXSS_STYLE_BREAKOUT],
      ["MXSS_HEAD_BREAKOUT", MXSS_HEAD_BREAKOUT],
      ["MXSS_ANCHOR_INJECTION", MXSS_ANCHOR_INJECTION],
      ["MXSS_SPLIT_CLOSE_TAG", MXSS_SPLIT_CLOSE_TAG],
      ["MXSS_IMPORT_REFORM", MXSS_IMPORT_REFORM],
      ["MXSS_CSS_SHAPES", MXSS_CSS_SHAPES],
      ["OWNER_BILLING_HTML", OWNER_BILLING_HTML],
      ["HOSTILE_HTML", HOSTILE_HTML],
    ] as const) {
      const { html } = await clean(fixture);
      expect(reparse(html).body.innerHTML, `${name} does not survive a parse`).toBe(html);
    }
  });

  /**
   * THE ACCEPTANCE CASE, VERBATIM, AND THE ASSERTION IS THE TAG LIST.
   *
   * Shipped build, read from the frame's own `contentDocument`: `["style","form","input"]` —
   * a complete credential prompt, which is verbatim the thing `MessageBody.tsx:36-38` says
   * the sanitizer exists to prevent. Mutation: `const CUT = ""`. Real failure text:
   *   AssertionError: expected [ 'style', 'form', 'input' ] to deeply equal [ 'style', 'p' ]
   */
  it("the first payload yields a stylesheet and a paragraph — no form, no input", async () => {
    const { html } = await clean(MXSS_STYLE_BREAKOUT);
    expect(tagsIn(html)).toEqual(["style", "p"]);
    // Deliberately NOT `html.not.toContain("evil.example/h")`. A neutralised stylesheet keeps
    // the sender's bytes as inert CSS text, and text in a `<style>` is not a fetching
    // position — an assertion that forbade the STRING would forbid a correct implementation
    // and would have to be weakened the first time somebody read it.
    expect(fetchedOnOpen(html)).toEqual([]);
  });

  /**
   * THE HEAD IS NOT A SECOND CODE PATH. `sanitizeMailHtml` hoists head stylesheets into the
   * body before sanitizing; the hoist moves NODES, so the body case's protection has to cover
   * this one by construction. Mutation: `const CUT = ""` — same red, from `<head>`.
   */
  it("and the same trick from a <style> in <head> yields the same nothing", async () => {
    const { html } = await clean(MXSS_HEAD_BREAKOUT);
    expect(tagsIn(html)).toEqual(["style", "p"]);
    expect(fetchedOnOpen(html)).toEqual([]);
  });

  /**
   * THE CLOSE TAG ASSEMBLED FROM THREE FRAGMENTS, NONE OF WHICH IS MARKUP.
   *
   * This is the payload that says why the fix is a property of the SUBSTITUTION rather than a
   * search of the input. DOMPurify already condemns a `<style>` whose text matches
   * `/<[/\w!]/`, so a payload that writes `</sty` and lets a removal finish it never gets
   * that far. This one writes `<`, `/sty` and `le>` as three fragments; both of DOMPurify's
   * probes see `<@` and pass. **There is no string in the input to escape.**
   *
   * Mutation: `const CUT = ""`. Real failure text against the shipped build:
   *   AssertionError: expected [ 'style', 'img', 'p' ] to deeply equal [ 'style', 'p' ]
   *   AssertionError: a remote image reached a fetching position: expected
   *   [ 'https://evil.example/split.png' ] to deeply equal []
   */
  it("a close tag assembled out of three non-markup fragments stays inert", async () => {
    const { html } = await clean(MXSS_SPLIT_CLOSE_TAG);
    expect(tagsIn(html)).toEqual(["style", "p"]);
    expect(fetchedOnOpen(html), "a remote image reached a fetching position").toEqual([]);
  });
});

// ══ 2. the link affordance applies to the FINAL document ══════════════════════════

describe("every <a> the frame ends up with carries this file's own annotations", () => {
  /**
   * THE GUARD FOR "NO INJECTED NODES EXIST", WHICH IS THE ASSUMPTION THAT JUST FAILED.
   *
   * The annotation used to be written by a DOMPurify hook, which by definition only reaches
   * nodes DOMPurify walked. An `<a>` that materialises when the FRAME re-parses is reached by
   * nobody: `MessageBody.tsx`'s whole anti-phishing surface — `rel`, the real destination host
   * on hover and focus, the mismatch marker — is silently absent on the one link that is
   * actually hostile.
   *
   * The assertion is deliberately NOT "it has a rel": the injected markup can carry any
   * attribute the sender likes, and {@link MXSS_ANCHOR_INJECTION} carries a forged
   * `data-ohmail-host="www.bank.example"` beside an `href` to `evil.example`. What no forgery
   * can satisfy is **the host we print equals the host of the link's own href**, so that is
   * the claim.
   *
   * Mutation: `const CUT = ""`. Real failure text against the shipped build:
   *   AssertionError: <a href="https://evil.example/login"> prints a host it does not go to:
   *   expected 'www.bank.example' to be 'evil.example'
   */
  it("annotates by the href, so a forged host cannot survive", async () => {
    const { html } = await clean(MXSS_ANCHOR_INJECTION);
    const { hostOfUrl, textDisagreesWithHref } = await mod();
    const anchors = [...reparse(html).querySelectorAll("a")];
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      const href = a.getAttribute("href") ?? "";
      expect(a.getAttribute("target"), `${a.outerHTML} opens in the frame`).toBe("_blank");
      expect(a.getAttribute("rel"), `${a.outerHTML} can reach back`).toBe(
        "noopener noreferrer nofollow",
      );
      const real = /^https?:\/\//i.test(href) ? hostOfUrl(href) : "";
      expect(
        a.getAttribute("data-ohmail-host") ?? "",
        `<a href="${href}"> prints a host it does not go to`,
      ).toBe(real);
      // And the mismatch marker is decided from the SAME href, not from the sender's copy.
      expect(
        a.hasAttribute("data-ohmail-elsewhere"),
        `<a href="${href}"> disagrees with its own text and does not say so`,
      ).toBe(real !== "" && textDisagreesWithHref(a.textContent ?? "", real));
    }
  });

  /**
   * The same claim over the two fixtures that are not attacks, so the guard is not passing
   * because it only ever meets one anchor. `HOSTILE_HTML`'s `javascript:` link is the
   * counter-case: no href at all, so no host to print, and it must NOT be handed one.
   */
  it("holds for the reported billing mail and for HOSTILE_HTML, inert links included", async () => {
    const { hostOfUrl } = await mod();
    for (const fixture of [OWNER_BILLING_HTML, HOSTILE_HTML]) {
      const { html } = await clean(fixture);
      const anchors = [...reparse(html).querySelectorAll("a")];
      expect(anchors.length).toBeGreaterThan(0);
      for (const a of anchors) {
        if (a.hasAttribute("data-ohmail-inert")) {
          expect(a.hasAttribute("href"), `${a.outerHTML} is marked inert and still clickable`)
            .toBe(false);
          expect(a.hasAttribute("data-ohmail-host")).toBe(false);
          continue;
        }
        const href = a.getAttribute("href") ?? "";
        expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
        expect(a.getAttribute("data-ohmail-host") ?? "").toBe(
          /^https?:\/\//i.test(href) ? hostOfUrl(href) : "",
        );
      }
    }
  });
});

// ══ 3. the rewrite may not invent CSS either ═════════════════════════════════════

describe("one neutralising pass is a fixed point, not a first attempt", () => {
  /**
   * PUTTING THE REWRITE BEFORE THE SANITIZER PUTS EVERY ELEMENT IT CAN INVENT UNDER THE
   * ALLOW-LIST. It does nothing about a CSS RULE it invents, because it has already run.
   *
   * `@im` + `@import q;` + `port"…"` holds no `@import` until the middle is removed. A
   * `;`-separated substitution makes that arithmetic impossible; an empty one makes it
   * routine. Mutation: `const CUT = ""`. Real failure text:
   *   AssertionError: a removal re-formed a live rule: expected
   *   '<style>@import"https://evil.example/re…' not to contain '@import'
   */
  it("a deletion cannot re-form an @import out of its own neighbours", async () => {
    const { html } = await clean(MXSS_IMPORT_REFORM);
    expect(html, "a removal re-formed a live rule").not.toContain("@import");
    expect(fetchedOnOpen(html)).toEqual([]);
  });

  /**
   * The property, stated directly on the unit rather than through a fixture: neutralising
   * twice is neutralising once. If a pass can create work for a second pass, there is no
   * number of passes that is provably enough.
   */
  it("neutraliseCss is idempotent on every payload here", async () => {
    const { neutraliseCss } = await mod();
    const drop = (): null => null;
    /* A token the CSS parser would FETCH. Not "the url does not appear" — a neutralised sheet
       keeps the sender's bytes as inert text (`@im;port"https://…"` is an unknown at-rule
       followed by garbage), and forbidding the string would forbid a correct implementation. */
    const fetching = /@import|url\(\s*['"]?\s*https?:|image-set\([^)]*https?:/i;
    for (const css of [
      `@im@import q;port"https://${MXSS_HOST}/x.css";`,
      `<@import x;/style><@import y;form>`,
      `a{}</sty@import q;le>`,
      `ur@import q;l(https://${MXSS_HOST}/joined.png)`,
      `.a{background:url("https://${MXSS_HOST}/a.png")}`,
      `@import url("https://${MXSS_HOST}/i.css");.b{background:url(data:image/gif;base64,AA)}`,
    ]) {
      const once = neutraliseCss(css, drop);
      expect(neutraliseCss(once, drop), `not a fixed point: ${css}`).toBe(once);
      expect(once, `a fetching token survived: ${css}`).not.toMatch(fetching);
    }
  });
});

// ══ 4. three shapes that reached the network and counted as zero ═════════════════

describe("the count is what the browser would have requested", () => {
  /**
   * THE GUARD. All three were requested by Chromium on the shipped build and refused by the
   * frame's `default-src 'none'` — so nothing leaked, and `blocked` was empty, and the reader
   * was told nothing. `MessageBody.tsx:270-281` is explicit that this layer is accounting
   * rather than enforcement; the accounting still has to be true.
   *
   * Mutation: restore `\s+` in the `@import` rule (`@import"…"` survives), or drop the CSS
   * escape decoding (`url(htt\70 s://…)` survives), or drop the `image-set` branch. Each one
   * reds a different line below, which is why they are three assertions and not one.
   */
  it("image-set, a CSS-escaped scheme and @import with no space are all neutralised", async () => {
    const { html, blocked, sheets } = await clean(MXSS_CSS_SHAPES);
    for (const url of MXSS_CSS_SHAPE_URLS) {
      expect(html, `${url} is still named in the stylesheet`).not.toContain(url);
    }
    expect(html, "an escaped scheme survived").not.toContain("htt\\70");
    expect(html).not.toContain("image-set(\"https");
    expect(html).not.toContain("@import");

    // COUNTED, not merely removed: the bar's sentence is built from these lists, and a blocker
    // that silently counts zero is the defect this finding is about.
    const urls = blocked.map((b) => b.url);
    expect(urls, "image-set() named an image and nothing counted it").toContain(
      `https://${MXSS_HOST}/image-set.png`,
    );
    expect(urls, "a CSS-escaped scheme named an image and nothing counted it").toContain(
      `https://${MXSS_HOST}/escaped.png`,
    );
    // A STYLESHEET IS COUNTED SEPARATELY AND SAID SEPARATELY. It stays out of `blocked`
    // because that list feeds "Show images", and an entry there that can never be consented
    // to would make the button lie — `message-body.test.ts:241` pins that decision down. It
    // is still said, because an @import-only newsletter renders unstyled and the reader is
    // owed the reason. Mutation: drop `onSheet` from the `@import` branch. Real failure:
    //   AssertionError: an @import was refused and nothing anywhere says so:
    //   expected [] to contain 'https://evil.example/nospace.css'
    expect(sheets, "an @import was refused and nothing anywhere says so").toContain(
      `https://${MXSS_HOST}/nospace.css`,
    );
    expect(urls, "a stylesheet is in the list that feeds Show images").not.toContain(
      `https://${MXSS_HOST}/nospace.css`,
    );
  });

  /**
   * AN UNCLOSED `url(` IS STILL A REFERENCE, and the DoS-safe answer is the leak-unsafe one.
   *
   * CSS Syntax §4.3.6 closes a `url` token at EOF and returns it, so a stylesheet ending
   * `background:url(https://evil.example/x.png` names a resource Chromium will attempt. The
   * obvious way to make the scanner linear — "no closing paren, copy the rest verbatim and
   * stop" — leaves that reference live AND invisible to every count, including
   * `mail-lab.ts`'s `remoteAssetsNamedBy`, which needs the paren to match.
   *
   * Mutation: `replacement = css.slice(start, end)` for the `token === null` branch. Real
   * failure text:
   *   AssertionError: an unterminated url( kept its reference: expected
   *   '<style>.a{background:url(https://evi…' not to contain 'evil.example/unterminated.png'
   */
  it("an unterminated url( is cut to the end of the sheet, and counted", async () => {
    const { html, blocked } = await clean(
      `<style>.a{background:url(https://${MXSS_HOST}/unterminated.png</style><p>x</p>`,
    );
    expect(html, "an unterminated url( kept its reference").not.toContain(
      `${MXSS_HOST}/unterminated.png`,
    );
    expect(blocked.map((b) => b.url)).toContain(`https://${MXSS_HOST}/unterminated.png`);
  });

  /** The counter-case, so the escape decoding is a rule about REMOTE and not about escapes. */
  it("an escaped data: url is decoded, recognised, and left exactly alone", async () => {
    const { html, blocked } = await clean(
      `<style>.a{background:url(dat\\61 :image/gif;base64,R0lGODlhAQABAAAAACw=)}</style><p>x</p>`,
    );
    expect(html).toContain("dat\\61 :image/gif");
    expect(blocked).toEqual([]);
  });
});

// ══ 5. the neutraliser is linear, and there is a floor under the tab ═════════════

describe("a message cannot freeze the tab it is opened in", () => {
  /**
   * THE GUARD, and it is a wall clock on purpose: the defect is not a wrong answer, it is a
   * synchronous 95 seconds inside `useMemo`, on the main thread, during render.
   *
   * `[^'")]+` cannot cross `)`, so with no `)` in the input every `url(` start scans to the
   * end of the string. Measured against the shipped build in a browser: 125 KB → 6.1 s,
   * 500 KB → 95.3 s; 4× the input for 15.6× the time.
   *
   * Mutation: restore `/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi`. Real failure text:
   *   AssertionError: 128 KiB of `url(` took 6113 ms: expected 6113 to be less than 500
   */
  it("128 KiB of unterminated url( is neutralised in well under a second", async () => {
    const { neutraliseCss } = await mod();
    const css = quadraticCss(128 * 1024);
    const started = performance.now();
    neutraliseCss(css, () => null);
    const ms = Math.round(performance.now() - started);
    expect(ms, `128 KiB of \`url(\` took ${ms} ms`).toBeLessThan(500);
  }, 120_000);

  /** And it stays linear rather than merely fast: 4× the input, nothing like 16× the time. */
  it("stays linear at 512 KiB", async () => {
    const { neutraliseCss } = await mod();
    const css = quadraticCss(512 * 1024);
    const started = performance.now();
    neutraliseCss(css, () => null);
    const ms = Math.round(performance.now() - started);
    expect(ms, `512 KiB of \`url(\` took ${ms} ms`).toBeLessThan(2_000);
  }, 300_000);

  /**
   * THE FLOOR. Linear is not a promise about an input nobody has measured, so there is a cap,
   * and crossing it renders the text part WITH A STATED REASON rather than hanging.
   *
   * Mutation: raise `MAX_HTML_CHARS` past the fixture. Real failure text:
   *   AssertionError: expected undefined to be true // Object.is equality
   */
  it("an html part past the cap renders as text and says why", async () => {
    const { MAX_HTML_CHARS, COPY } = await mod();
    /* THE FIXTURE SIZE IS A LITERAL, AND THE FIRST VERSION OF THIS TEST WAS NOT.
       It said `"x".repeat(MAX_HTML_CHARS)`, which scales WITH the constant — so raising the
       cap moved the fixture with it and the mutation stayed green. A guard whose input is
       derived from the thing it is guarding cannot fail. */
    expect(MAX_HTML_CHARS, "the cap moved past this test's own fixture").toBeLessThan(600 * 1024);
    const out = await clean(`<p>${"x".repeat(600 * 1024)}</p>`);
    expect(out.oversize).toBe(true);
    expect(out.html).toBe("");
    expect(out.blocked).toEqual([]);
    // The reason is a sentence a reader can act on, not a blank frame.
    expect(COPY.oversize).toMatch(/plain-text/i);
    // And an ordinary message is an ordinary message.
    const ok = await clean(`<p>${"x".repeat(64 * 1024)}</p>`);
    expect(ok.oversize).toBeUndefined();
    expect(ok.html.length).toBeGreaterThan(0);
  }, 60_000);
});
