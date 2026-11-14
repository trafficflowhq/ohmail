/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

/**
 * ═══ THREE RESIDUAL ARMS OF THE MAIL-CSS URL POLICY ════════════════════════════════════════
 *
 * `neutraliseCss` decides which url shapes in a sender's stylesheet survive into the reading
 * frame. Its own header records the three shapes it was extended to catch — `@import"…";`, a
 * scheme written in CSS escapes, and `image-set("…")` with no `url()` token — and the rule those
 * three share: a construct the scanner cannot read is one the reader is never told about, because
 * the blocked-content bar counts what this function counted.
 *
 * These are the arms that survived, and two of them FETCH rather than merely mis-count. The
 * distinction is `frameCsp`: `img-src` is `data:` while images are blocked, and `data: 'self'`
 * once the reader presses "Show images". A srcdoc document has no `<base>`, so it resolves
 * against the embedder — which makes `url(/api/…)` a same-origin, cookie-bearing GET the frame's
 * own policy PERMITS in that state. That is the hole the relative-url branch was added to close,
 * and these two spellings walked around it.
 *
 *  1. **AN ESCAPED FUNCTION NAME.** `decodeCssEscapes` normalised a token's ARGUMENT and the
 *     token finder matched its NAME literally. `\75 rl(…)` is a `url` to the CSS tokenizer,
 *     because an identifier's escapes are decoded before its name is compared; it was not one to
 *     `/url\(/`. Same for `\69 mage-set(…)` and `@\69 mport`.
 *
 *  2. **A CANDIDATE THAT ARRIVES AFTER THE VERDICT.** `image-set(var(--x) 1x)` presented an
 *     EMPTY candidate list to the "is every candidate inert?" test, and `[].every(…)` is `true`,
 *     so the set was kept verbatim. The custom property holding the url survived too: a
 *     declaration `--x: "/api/…"` contains no `url(`, no `image-set(` and no `@import`, so
 *     nothing in this scanner ever looked at it. The pair fetched.
 *
 *  3. **AND ONE FALSE POSITIVE, WHICH IS THE FAILURE A SANITIZER IS LEAST ALLOWED.**
 *     `image-set("data:…" type("image/png"))` is standards-valid and fetches nothing.
 *     `type("image/png")` is a MIME hint; `urlsIn` read its string as a candidate url, found it
 *     was not `data:`/`cid:`, and dropped the whole declaration. That costs a reader a picture
 *     that was already inline in their own message.
 *
 * ── WHAT THIS FILE PROVES AND WHAT IT CANNOT ──────────────────────────────────────────────
 *
 * jsdom fetches no subresource, so the claim here is that these urls are never NAMED in the
 * document the frame is handed — the same boundary `message-body-mutation-xss.test.ts` states
 * for itself. That they are never REQUESTED is decided in the browser journey.
 *
 * ── THE MUTATIONS EVERY CASE WAS WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · drop the `\\` alternative from `CSS_TOKEN`            → every escaped-name case goes red;
 *  · make `escapedFunctionName` accept whitespace before `(` → nothing goes red, so the case
 *    that fixes the boundary (`\75 rl (x)` is not a function token) is asserted directly;
 *  · drop `defersSubstitution` from the image-set arm      → the `var()` case goes red;
 *  · drop the `type(…)` blanking from `urlsIn`             → the inline-image case goes red.
 */

type Mod = typeof import("../app/letter-body/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/letter-body/MessageBody.js");

/** The reader's policy: nothing is proxied, so every remote url this counts becomes `none`. */
const DROP = (): null => null;

/** Every url `neutraliseCss` reported to the blocked-content bar for this sheet. */
async function counted(css: string): Promise<string[]> {
  const { neutraliseCss } = await mod();
  const seen: string[] = [];
  neutraliseCss(css, (u) => {
    seen.push(u);
    return null;
  });
  return seen;
}

async function neutralise(css: string): Promise<string> {
  const { neutraliseCss } = await mod();
  return neutraliseCss(css, DROP);
}

describe("1. a function name written in CSS escapes is still that function", () => {
  it("`\\75 rl(/api/…)` does not survive as a same-origin fetch", async () => {
    const out = await neutralise(String.raw`.a{background:\75 rl(/api/messages/secret)}`);
    expect(out, "the escaped-name url survived into the frame").not.toContain("/api/messages/secret");
    expect(out).toContain("none");
  });

  it("`\\75 rl(https://…)` is counted, so the reader is told the message tried", async () => {
    const seen = await counted(String.raw`.a{background:\75 rl(https://tracker.example/beacon.png)}`);
    expect(seen, "a remote url the bar never counted is a bar that lies").toEqual([
      "https://tracker.example/beacon.png",
    ]);
  });

  it("an escape ANYWHERE in the name counts, not only at the front", async () => {
    for (const css of [
      String.raw`.a{background:u\72 l(/api/x)}`,
      String.raw`.a{background:ur\6c(/api/x)}`,
      String.raw`.a{background:\75 \72 \6c(/api/x)}`,
    ]) {
      expect(await neutralise(css), `survived: ${css}`).not.toContain("/api/x");
    }
  });

  it("an escaped `image-set` name is an image-set", async () => {
    const out = await neutralise(String.raw`.a{background:\69 mage-set("/api/x" 1x)}`);
    expect(out).not.toContain("/api/x");
    expect(out).toContain("none");
  });

  it("an escaped `-webkit-image-set` name is one too", async () => {
    const out = await neutralise(String.raw`.a{background:-webkit-\69 mage-set("/api/x" 1x)}`);
    expect(out).not.toContain("/api/x");
  });

  it("an escaped `@import` name is still cut, and its sheet is reported", async () => {
    const { neutraliseCss } = await mod();
    const sheets: string[] = [];
    const out = neutraliseCss(
      String.raw`@\69 mport"https://evil.example/x.css";.a{color:red}`,
      DROP,
      (u) => sheets.push(u),
    );
    expect(out).not.toContain("evil.example");
    expect(sheets, "an @import the reader is never told about renders a newsletter unstyled").toEqual([
      "https://evil.example/x.css",
    ]);
  });

  it("an escaped name that is NOT one of ours is left exactly as it was", async () => {
    // The walk decodes to decide and never to rewrite. `\63 alc()` is `calc()`, which names no
    // resource, so neutralising must be a no-op — dropping every escaped function would break
    // ordinary layout for the sake of a rule about urls.
    const css = String.raw`.a{width:\63 alc(100% - 2px)}`;
    expect(await neutralise(css)).toBe(css);
  });

  it("whitespace between the name and the paren is not a function token, and is left alone", async () => {
    // CSS Syntax §4.3.4 admits no whitespace there, so `\75 rl (x)` is an ident followed by a
    // parenthesized group and fetches nothing. Treating it as a url would be a false positive.
    const css = String.raw`.a{background:\75 rl (/api/x)}`;
    expect(await neutralise(css)).toBe(css);
  });

  it("an escape inside an ordinary string is not mistaken for a function name", async () => {
    /**
     * THIS CASE USED TO ASSERT NOTHING, and that is worth keeping written down. It was
     * `content:"a\75 b"`, whose escape decodes to `u` — an identifier that is not `url`, so the
     * branch declined it for the wrong reason and the assertion passed whether or not the scanner
     * knew about strings at all. The payload now decodes to `url` and is followed by `(`, so only
     * quote-awareness can keep it intact.
     *
     * The browser displays the literal text `url(/api/target)` here and fetches nothing. A
     * sanitizer that rewrote it to `none` would be silently editing a sender's visible words.
     */
    const css = String.raw`.a::before{content:"\75 rl(/api/target)"}`;
    expect(await neutralise(css), "the sanitizer rewrote text inside a CSS string").toBe(css);
  });

  it("a single-quoted string is equally text, and an escaped quote does not end one early", async () => {
    for (const css of [
      String.raw`.a::before{content:'\75 rl(/api/target)'}`,
      String.raw`.a::before{content:"a\"b \75 rl(/api/target)"}`,
    ]) {
      expect(await neutralise(css), `rewrote inside a string: ${css}`).toBe(css);
    }
  });

  it("but a real token AFTER a string still goes — the state does not latch", async () => {
    const out = await neutralise(String.raw`.a{content:"x";background:\75 rl(/api/target)}`);
    expect(out).not.toContain("/api/target");
    expect(out).toContain('content:"x"');
  });

  it("an unterminated string ends at the newline, exactly as the browser ends it", async () => {
    // A sender cannot open a quote and thereby cover the rest of the sheet: CSS ends the string
    // at the newline, and so does the scan — otherwise this would be one quote away from a
    // blanket opt-out of the escape branch.
    const out = await neutralise(".a{content:\"x\n}\n.b{background:" + String.raw`\75 rl(/api/target)` + "}");
    expect(out, "an unterminated string covered the rest of the sheet").not.toContain("/api/target");
  });

  // CSS turns CRLF into one newline before it tokenizes (Syntax §3.3), so CRLF ends a hex escape once.
  it("a hex escape ended by CRLF still names `url`, and is counted and cut", async () => {
    const css = ".a{background:\\75\r\nrl(https://tracker.example/a.png)}";
    expect(await counted(css)).toEqual(["https://tracker.example/a.png"]);
    expect(await neutralise(css)).not.toContain("tracker.example");
    expect(await neutralise(".a{background:\\75\r\nrl(/api/x)}")).not.toContain("/api/x");
  });

  it("a hex escape ended by CRLF still names `image-set`, and is counted and cut", async () => {
    const css = '.a{background:\\69\r\nmage-set("https://tracker.example/b.png" 1x)}';
    expect(await counted(css)).toEqual(["https://tracker.example/b.png"]);
    expect(await neutralise(css)).not.toContain("tracker.example");
  });

  it("a hex escape ended by CRLF still names `@import`, which is cut and reported", async () => {
    const { neutraliseCss } = await mod();
    const sheets: string[] = [];
    const out = neutraliseCss('@\\69\r\nmport"https://evil.example/x.css";.a{color:red}', DROP, (u) => sheets.push(u));
    expect(out).not.toContain("evil.example");
    expect(sheets).toEqual(["https://evil.example/x.css"]);
  });

  it("an escaped CRLF inside a string continues it, so the string cannot reopen over a real token", async () => {
    const css = '.a{content:"x\\\r\ny";background:\\75 rl(https://tracker.example/d.png)}';
    expect(await counted(css)).toEqual(["https://tracker.example/d.png"]);
    expect(await neutralise(css)).not.toContain("tracker.example");
  });

  it("an escaped quote inside an image-set string does not close it, so the next candidate is read", async () => {
    const css = '.a{background:image-set("data:image/png;base64,AA\\")" 1x, "https://tracker.example/e.png" 2x)}';
    expect(await counted(css)).toEqual(["https://tracker.example/e.png"]);
    expect(await neutralise(css)).not.toContain("tracker.example");
  });

  it("an escaped newline inside a url string is a removed continuation, so the url is the one CSS means", async () => {
    expect(await counted('.a{background:url("https://t.example/css3\\\r\n.png")}')).toEqual(["https://t.example/css3.png"]);
    expect(await counted(".a{background:url('https://t.example/a\\\nb.png')}")).toEqual(["https://t.example/ab.png"]);
  });
});

describe("the inline STYLE attribute goes through the same scanner as a stylesheet", () => {
  /**
   * `neutraliseStyleAttr` guards the scanner with a cheap precheck so that the vast majority of
   * style attributes — which name no resource — are not tokenized. That precheck listed the three
   * LITERAL token starts, so when the scanner learned to read an escaped function name the fast
   * path did not, and it decided on the scanner's behalf that there was nothing to scan.
   *
   * An inline style is the easiest place in a message to put one, so the fix in `neutraliseCss`
   * bought nothing at all on the most likely surface. These drive the sanitizer end to end rather
   * than the scanner directly, which is the gap that let it through.
   */
  it("an escaped url in a style attribute does not reach the frame", async () => {
    const { sanitizeMailHtml } = await mod();
    const { html } = sanitizeMailHtml(
      String.raw`<div style="background-image:\75 rl(/api/messages/secret)">x</div>`,
      {},
    );
    expect(html, "an inline style skipped the scanner entirely").not.toContain("/api/messages/secret");
  });

  it("an escaped image-set in a style attribute is neutralised too", async () => {
    const { sanitizeMailHtml } = await mod();
    const { html } = sanitizeMailHtml(
      String.raw`<div style="background:\69 mage-set(&quot;/api/x&quot; 1x)">x</div>`,
      {},
    );
    expect(html).not.toContain("/api/x");
  });

  it("a style attribute that names nothing is still returned unchanged", async () => {
    // The precheck is now over-inclusive (any backslash hands the attribute to the scanner), which
    // is only free if the scanner is a no-op on text that names no resource.
    const { sanitizeMailHtml } = await mod();
    const { html } = sanitizeMailHtml(String.raw`<div style="color:red;font-family:&quot;a\62 c&quot;">x</div>`, {});
    expect(html).toContain("color:red");
  });
});

describe("an escaped candidate INSIDE an image-set is a candidate", () => {
  /**
   * The outer branch reads the whole `image-set(...)` body and then asks `urlsIn` what is in it.
   * `urlsIn` matched a LITERAL `url(`, so `image-set(\75 rl(/api/x) 1x)` presented NO candidates,
   * `[].every(inert)` was vacuously true, and the entire set was copied through verbatim — and
   * because the outer branch advances the scan past the set, the top-level escape-aware pass never
   * visited that backslash either. A live reference, kept and never counted.
   */
  it("`image-set(\\75 rl(/api/x))` does not survive", async () => {
    const out = await neutralise(String.raw`.a{background:image-set(\75 rl(/api/x) 1x)}`);
    expect(out, "an escaped candidate hid inside a literal image-set").not.toContain("/api/x");
    expect(out).toContain("none");
  });

  it("an escaped REMOTE candidate inside an image-set is still counted for the reader", async () => {
    const seen = await counted(
      String.raw`.a{background:image-set(\75 rl(https://tracker.example/b.png) 1x)}`,
    );
    expect(seen).toEqual(["https://tracker.example/b.png"]);
  });

  it("an escaped `type()` hint does not cost the reader an inline image", async () => {
    // The mirror of the case above: the hint is not literal, so its MIME string was read as a
    // candidate url, judged not inert, and a standards-valid inline image was deleted.
    const css = String.raw`.a{background:image-set("data:image/png;base64,AA" \74 ype("image/png"))}`;
    expect(await neutralise(css), "an escaped MIME hint deleted a valid inline image").toBe(css);
  });
});

describe("2. a candidate that is substituted after the verdict is not a candidate we read", () => {
  it("`image-set(var(--x))` is dropped rather than passed", async () => {
    const out = await neutralise(
      `:root{--x:"/api/messages/secret"}.a{background:image-set(var(--x) 1x)}`,
    );
    expect(
      out,
      "the set was kept because it presented no candidates, and the variable resolved later",
    ).not.toContain("image-set(var(--x)");
    expect(out).toContain("none");
  });

  it("the same is true of the -webkit- alias and of a remote value", async () => {
    for (const css of [
      `.a{background:-webkit-image-set(var(--x) 1x)}`,
      `.a{background:image-set(var(--y) 2x,var(--z) 1x)}`,
    ]) {
      expect(await neutralise(css), `kept: ${css}`).toContain("none");
    }
  });

  it("an image-set with real inert candidates is still kept — this is not `drop everything`", async () => {
    const css = `.a{background:image-set("data:image/gif;base64,AA" 1x)}`;
    expect(await neutralise(css)).toBe(css);
  });
});

describe("3. the MIME hint is not a url, and reading it as one deletes a legitimate picture", () => {
  it("`type(…)` beside an inline candidate does not cost the reader the image", async () => {
    const css = `.a{background:image-set("data:image/png;base64,AA" type("image/png"))}`;
    expect(
      await neutralise(css),
      "a standards-valid inline image-set was deleted by its own MIME hint",
    ).toBe(css);
  });

  it("a `type()` hint does not launder a remote candidate", async () => {
    const seen = await counted(
      `.a{background:image-set("https://tracker.example/b.png" type("image/png"))}`,
    );
    expect(seen).toEqual(["https://tracker.example/b.png"]);
    expect(await neutralise(`.a{background:image-set("https://tracker.example/b.png" type("image/png"))}`))
      .toContain("none");
  });

  it("a `type()` hint does not launder a RELATIVE candidate either", async () => {
    const out = await neutralise(`.a{background:image-set("/api/x" type("image/png"))}`);
    expect(out).not.toContain("/api/x");
  });
});

describe("the value walk: what a literal pattern could not tell apart", () => {
  /**
   * Four defects, one root. Every one of these was a literal pattern asking a question about
   * text that CSS reads differently — two bypasses and two false positives, from the same
   * assumption. `scanCssValue` walks the body instead, so the distinctions are structural.
   */
  it("a comment cannot open a string and disable the rule for the rest of the sheet", async () => {
    // `/* " */` left an unmatched quote open, so every escaped url AFTER it looked quoted to the
    // escape branch and was passed through. One character of comment, whole rule off.
    const out = await neutralise(String.raw`/* " */ .x{background:\75 rl(/api/target)}`);
    expect(out, "a comment quote disabled the escaped-name rule").not.toContain("/api/target");
  });

  it("a comment quote does not disable it for a LATER rule either", async () => {
    const out = await neutralise(
      String.raw`.a{color:red}/* it's fine */.b{background:\75 rl(/api/target)}`,
    );
    expect(out).not.toContain("/api/target");
  });

  it("an escaped `var` is still a substitution", async () => {
    // `/\bvar\(/` on raw text missed `v\61 r(`, restoring the exact bypass the guard closed.
    const out = await neutralise(
      `:root{--x:"/api/target"}.a{background:image-set(v\\61 r(--x) 1x)}`,
    );
    expect(out, "an escaped var() name walked past the deferred-substitution guard").toContain("none");
    expect(out).not.toContain("image-set(v");
  });

  it("`var(` inside a quoted data URL is payload, not substitution", async () => {
    /**
     * The mirror: a literal test deleted a legitimate inline SVG because its own bytes said
     * `var(`.
     *
     * The payload carries a real space before `var(`. The first version of this case used
     * `fill%3Avar(`, where the percent-escape's trailing `A` is a word character — so `\bvar\(`
     * never matched it and the case passed against the literal implementation it was written to
     * refute. A guard that cannot fail is the failure this file exists to avoid, so the boundary
     * is now genuine.
     */
    const css =
      `.a{background:image-set("data:image/svg+xml,<svg style='fill: var(--paint,red)'></svg>" 1x)}`;
    expect(await neutralise(css), "an inline SVG was deleted for text inside its own payload").toBe(css);
  });

  it("an escaped quote inside a data URL is a character, not a delimiter", async () => {
    // Decoding the whole body turned `\22` into a real `"`, splitting one valid candidate into
    // two bogus ones and deleting the image. The walk decodes per token instead.
    const css =
      String.raw`.a{background:image-set("data:image/svg+xml,%3Csvg%20xmlns%3D\22 http%3A%2F%2Fx%3E%3C%2Fsvg%3E" 1x)}`;
    expect(await neutralise(css), "escaped quote data was read as syntax").toBe(css);
  });

  it("a `)` inside a comment does not close the function it sits in", async () => {
    /**
     * CSS strips comments before it parses, so `image-set(/* ) *\/ "/api/x" 1x)` is one function
     * with a bare-string candidate. `closingParen` counted the comment's `)` as the close: the
     * body it then scanned was an unterminated comment with no candidates, the vacuous
     * `every(inert)` kept the prefix, and the real candidate sat in the text the scan resumed
     * into — where no token start matches a bare string. Live, kept, and uncounted, from one
     * comment.
     */
    const out = await neutralise(`.x{background:image-set(/* ) */ "/api/messages/secret" 1x)}`);
    expect(out, "a comment's paren truncated the token and freed the candidate").not.toContain(
      "/api/messages/secret",
    );
  });

  it("the same comment trick does not hide a remote candidate from the reader's count", async () => {
    const seen = await counted(`.x{background:image-set(/* ) */ "https://tracker.example/c.png" 1x)}`);
    expect(seen).toEqual(["https://tracker.example/c.png"]);
  });

  it("a comment that never closes ends the function, and the rest is not passed through", async () => {
    const out = await neutralise(`.x{background:image-set(/* never closed "/api/x" 1x)}`);
    expect(out).not.toContain("/api/x");
  });

  it("an escaped quote OUTSIDE a string does not open one", async () => {
    // `\"` in an ordinary declaration is a legal escaped character, not a delimiter. Reading it
    // as one opened a string nothing closed, and every escaped function name after it was treated
    // as quoted text — the same one-character disable as the comment case, reached another way.
    const out = await neutralise(String.raw`.a{font-family:a\"b;background:\75 rl(/api/target)}`);
    expect(out, "an escaped quote outside a string disabled the rule").not.toContain("/api/target");
  });

  it("an `@import` does not end at a semicolon inside its own url string", async () => {
    /**
     * The sharpest of the lot, because the rewrite MANUFACTURED the reference rather than missing
     * it. Cutting at `indexOf(";")` removed the opening quote and left the rest of the string as
     * live CSS, so this payload emitted a working `background:url(/api/private)` that did not
     * exist in the message. It also broke the standing idempotency property: a second pass removed
     * what the first had created.
     */
    const css = String.raw`@import url("https://evil.invalid/a;}.x{background:\75 rl(/api/private)}");`;
    const out = await neutralise(css);
    expect(out, "the rewrite manufactured a live reference").not.toContain("/api/private");
    const { neutraliseCss } = await mod();
    expect(neutraliseCss(out, DROP), "and the result is not a fixed point").toBe(out);
  });

  it("an `@import` whose string never closes still takes the rest of the sheet", async () => {
    // A raw newline ends an unterminated string, and the at-rule then runs to EOF with no `;`.
    const css = "@import url(\"https://evil.invalid/a\n.x{background:\\75 rl(/api/x)}";
    expect(await neutralise(css)).not.toContain("/api/x");
  });

  it("a `format()` hint is a hint too, and does not make a candidate", async () => {
    const css = `.a{background:image-set("data:image/png;base64,AA" format("png"))}`;
    expect(await neutralise(css)).toBe(css);
  });

  it("and none of that lets a real remote candidate through", async () => {
    for (const css of [
      String.raw`.a{background:image-set(\75 rl(https://tracker.example/a.png) 1x)}`,
      String.raw`/* " */ .a{background:image-set("https://tracker.example/b.png" 1x)}`,
      `.a{background:image-set(v\\61 r(--x) 1x)}`,
    ]) {
      expect(await neutralise(css), `survived: ${css}`).toContain("none");
    }
  });
});

describe("the properties the whole scanner is held to still hold", () => {
  it("neutralising twice is neutralising once, on every payload here", async () => {
    const { neutraliseCss } = await mod();
    for (const css of [
      String.raw`.a{background:\75 rl(/api/x)}`,
      String.raw`.a{background:\69 mage-set("https://evil.example/x" 1x)}`,
      String.raw`@\69 mport"https://evil.example/x.css";`,
      `:root{--x:"/api/x"}.a{background:image-set(var(--x) 1x)}`,
      `.a{background:image-set("data:image/png;base64,AA" type("image/png"))}`,
      ".a{background:\\75\r\nrl(/api/x)}",
      '.a{content:"x\\\r\ny";background:\\75 rl(https://tracker.example/d.png)}',
    ]) {
      const once = neutraliseCss(css, DROP);
      expect(neutraliseCss(once, DROP), `not a fixed point: ${css}`).toBe(once);
    }
  });

  it("the escaped-name walk is bounded, so a hostile sheet cannot make it quadratic", async () => {
    /**
     * The tokenizer this file replaced was measured at 95.3 s on 500 KB, and the escape
     * alternative is a NEW way to reach that shape: an identifier-run walk from every backslash
     * is quadratic in the length of the run. Both directions are therefore capped by
     * `ESCAPED_NAME_MAX`.
     *
     * 40 KB rather than 400: this input is one unbroken identifier run, which is the worst case
     * for the walk specifically, and removing the cap on 400 KB does not merely fail this budget
     * — it does not finish, so the mutation run that is supposed to prove the guard never
     * reports. Measured at this size on 2026-08-31, both directions: with the cap removed the
     * case fails at 37 839 ms; with it, the whole file runs in under a second. A guard whose
     * failure nobody can sit through is a guard nobody checks.
     */
    const css = `.a{background:${"\\61".repeat(20_000)}}`;
    const started = Date.now();
    await neutralise(css);
    expect(Date.now() - started, "the escaped-name walk is not bounded").toBeLessThan(2_000);
  });
});
