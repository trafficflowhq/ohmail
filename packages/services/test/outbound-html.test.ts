import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DRAFT_HTML_CAP_BYTES,
  htmlByteLength,
  htmlToPlainText,
  prepareOutboundBody,
  sanitizeOutboundHtml,
} from "../src/outbound-html.js";

/**
 * THE OUTBOUND ALLOWLIST, AND THE TEXT HALF OF THE ALTERNATIVE.
 *
 * Two claims are under test here and they fail in opposite directions, so they are asserted
 * separately rather than through one "it works" fixture:
 *
 *  1. Nothing outside the grammar survives. This is the security claim, and every line of it is
 *     written as a payload that WOULD execute or exfiltrate if the corresponding line of
 *     `POLICY` were missing or defaulted. `sanitize-html`'s options object selects permissive
 *     defaults for anything left undefined, so a policy is exactly as good as the fields it
 *     states — which makes "the field is stated" the thing worth pinning.
 *  2. Everything INSIDE the grammar survives into BOTH parts. This is the honesty claim. A
 *     sanitizer that dropped every tag would pass claim 1 perfectly and ship an empty message,
 *     and a text renderer that dropped link targets would ship two parts that say different
 *     things to two readers of the same mail.
 */

const CAP_SQL = fileURLToPath(
  new URL("../../db-mail/drizzle/0037_draft_html.sql", import.meta.url),
);

describe("the cap is one number, written down twice", () => {
  /**
   * A migration freezes when it is applied; a constant does not. The two can only be kept equal
   * by a reconciliation, and this is it — the same arrangement `STORED_HTML_CAP_BYTES` has with
   * `0022_message_body_html_cap.sql`. Reading the SQL rather than restating the literal is the
   * point: a test that said `expect(DRAFT_HTML_CAP_BYTES).toBe(262144)` would agree with itself
   * forever while the database enforced something else.
   */
  it("DRAFT_HTML_CAP_BYTES is the literal the migration's CHECK enforces", () => {
    const sql = readFileSync(CAP_SQL, "utf8");
    const m = /CHECK \(octet_length\("html"\) <= (\d+)\)/.exec(sql);
    expect(m, "0037's CHECK is not in the shape this test reads").not.toBeNull();
    expect(Number(m![1])).toBe(DRAFT_HTML_CAP_BYTES);
  });

  it("measures BYTES, not characters — an emoji is four, not one", () => {
    // `octet_length` counts bytes. A cap checked in JS `.length` would let a body of astral
    // characters through at four times the size the database will accept, and the refusal would
    // arrive as a constraint violation instead of a validation error.
    expect(htmlByteLength("😀")).toBe(4);
    expect(htmlByteLength("é")).toBe(2);
    expect(htmlByteLength("abc")).toBe(3);
  });
});

describe("nothing outside the grammar survives", () => {
  it("drops a script tag AND its source — not just the tag", () => {
    const out = sanitizeOutboundHtml('<p>hi</p><script>fetch("//evil")</script>');
    expect(out).not.toContain("script");
    // `disallowedTagsMode: "discard"` keeps the TEXT of a dropped tag. `nonTextTags` is what
    // stops that rule from pasting executable source into the body as prose.
    expect(out).not.toContain("fetch");
    expect(out).toContain("hi");
  });

  it("refuses a javascript: href", () => {
    const out = sanitizeOutboundHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript");
    expect(out).toContain("click");
  });

  it("refuses a data: href", () => {
    const out = sanitizeOutboundHtml('<a href="data:text/html,<script>x</script>">click</a>');
    expect(out).not.toContain("data:");
  });

  it("refuses a PROTOCOL-RELATIVE href, which passes a scheme allowlist by having no scheme", () => {
    // `//evil.example/x` resolves to `https://evil.example/x` in a browser and to nothing at all
    // in a scheme check that only inspects what precedes a colon. `allowProtocolRelative: false`
    // is the line under test.
    const out = sanitizeOutboundHtml('<a href="//evil.example/x">click</a>');
    expect(out).not.toContain("evil.example");
  });

  it("keeps http, https and mailto", () => {
    for (const href of ["http://a.example/x", "https://a.example/x", "mailto:a@example.com"]) {
      expect(sanitizeOutboundHtml(`<a href="${href}">go</a>`)).toContain(href);
    }
  });

  it("preserves a COMPOSED https link whole, through the same pipeline that sends it", () => {
    // The composer's link popover writes `<a href>`; this is the claim that what it writes
    // SURVIVES the send — anchor intact in the html part, target carried into the text part.
    // The single-purpose sanitize cases above each pin one policy line; this one pins the
    // product promise those lines add up to.
    const { html, text } = prepareOutboundBody('<p>see <a href="https://a.example/x">the docs</a></p>');
    expect(html).toContain('<a href="https://a.example/x">the docs</a>');
    expect(text).toBe("see the docs (https://a.example/x)");
  });

  it("strips every attribute but href, including event handlers and style", () => {
    const out = sanitizeOutboundHtml(
      '<p onclick="steal()" style="position:fixed" class="x" id="y">t</p>' +
        '<a href="https://a.example" target="_blank" onmouseover="steal()">l</a>',
    );
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onmouseover");
    expect(out).not.toContain("style");
    expect(out).not.toContain("class");
    expect(out).not.toContain("target");
    expect(out).toContain('href="https://a.example"');
  });

  it("drops images entirely — there is no way to carry an inline payload out of this editor", () => {
    // The 2026-08-01 storage outage arrived through inbound `data:` images. There is no `img`
    // in the grammar, so a composed message cannot manufacture the same bytes on the way out.
    const out = sanitizeOutboundHtml('<p>a<img src="data:image/png;base64,AAAA">b</p>');
    expect(out).not.toContain("img");
    expect(out).not.toContain("base64");
  });

  it("drops tables, headings and iframes but keeps the words in them", () => {
    const out = sanitizeOutboundHtml(
      "<h1>Title</h1><table><tr><td>cell</td></tr></table><iframe src=\"https://a.example\"></iframe>",
    );
    expect(out).not.toMatch(/<(h1|table|tr|td|iframe)/);
    expect(out).toContain("Title");
    expect(out).toContain("cell");
  });

  it("is IDEMPOTENT — the send-time pass is a no-op on anything the store-time pass produced", () => {
    // Two gates are only safe while they cannot disagree. `DraftsService` sanitizes on write and
    // `SendService` sanitizes again before the envelope, so what is stored must be a fixed point
    // or the two would ship different bytes for the same draft.
    const messy =
      '<p>hi <b onclick="x()">there</b></p><script>x</script>' +
      '<a href="javascript:x">l</a><ul><li>one</li></ul><h2>H</h2>';
    const once = sanitizeOutboundHtml(messy);
    expect(sanitizeOutboundHtml(once)).toBe(once);
  });
});

describe("everything inside the grammar survives, into both parts", () => {
  it("keeps emphasis, strike and inline code as markup", () => {
    const out = sanitizeOutboundHtml(
      "<p><strong>b</strong> <em>i</em> <s>s</s> <code>c</code></p>",
    );
    for (const tag of ["strong", "em", "s", "code"]) expect(out).toContain(`<${tag}>`);
  });

  it("accepts the pasted synonyms b/i/strike as well as the editor's own tags", () => {
    // A paste from another application arrives as `b`/`i`/`strike`. Dropping those would
    // silently unformat text the user can see is formatted.
    const out = sanitizeOutboundHtml("<b>b</b><i>i</i><strike>s</strike><del>d</del>");
    for (const tag of ["b", "i", "strike", "del"]) expect(out).toContain(`<${tag}>`);
  });

  it("renders emphasis as its text and nothing else — no invented markers", () => {
    // `**bold**` in the text part would put characters in the message the sender did not type,
    // and a reader has no way to tell them from literal asterisks.
    expect(htmlToPlainText("<p><strong>bold</strong> and <em>italic</em></p>"))
      .toBe("bold and italic");
  });

  it("carries a link's TARGET into the text part", () => {
    // The one construct whose loss makes the two parts say different things: a plaintext reader
    // with the anchor text and no href cannot follow the link at all.
    expect(htmlToPlainText('<p>see <a href="https://a.example/x">this</a></p>'))
      .toBe("see this (https://a.example/x)");
  });

  it("does not repeat a link whose text is already the url", () => {
    expect(htmlToPlainText('<p><a href="https://a.example">https://a.example</a></p>'))
      .toBe("https://a.example");
  });

  it("renders a bullet list as bullets and an ordered list as numbers", () => {
    expect(htmlToPlainText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
    expect(htmlToPlainText("<ol><li>one</li><li>two</li><li>three</li></ol>"))
      .toBe("1. one\n2. two\n3. three");
  });

  it("indents a nested list and restarts its counter", () => {
    const out = htmlToPlainText("<ul><li>a</li><li>b<ol><li>x</li><li>y</li></ol></li></ul>");
    expect(out).toBe("- a\n- b\n  1. x\n  2. y");
  });

  it("prefixes a block quote the way mail has meant a quotation since before html", () => {
    expect(htmlToPlainText("<blockquote><p>quoted</p></blockquote><p>mine</p>"))
      .toBe("> quoted\nmine");
  });

  it("nests quote prefixes", () => {
    expect(htmlToPlainText("<blockquote><blockquote><p>deep</p></blockquote></blockquote>"))
      .toBe("> > deep");
  });

  it("turns paragraphs and <br> into line breaks", () => {
    expect(htmlToPlainText("<p>one</p><p>two</p>")).toBe("one\ntwo");
    expect(htmlToPlainText("<p>one<br>two</p>")).toBe("one\ntwo");
  });

  it("mirrors a deliberate blank line: one <br> is a single break, a doubled <br> is a gap", () => {
    // A single Enter is a SOFT line break — one newline, no vertical gap. Two in a row is a
    // deliberate blank line the author put between two thoughts, and in the html half a second
    // <br> renders as that gap. The text/plain half has to show the same gap or the two parts
    // of the alternative disagree: one reader sees a blank line, the other a run-on. This is
    // what the editor now emits (Enter is a <br>, a blank line is <br><br>), so the text
    // renderer mirrors it rather than collapsing the second break the way an empty flush did.
    expect(htmlToPlainText("<p>one<br>two</p>")).toBe("one\ntwo");
    expect(htmlToPlainText("<p>one<br><br>two</p>")).toBe("one\n\ntwo");
    // Three breaks is still one gap — a run of blank lines reads as a mistake, and the trailing
    // collapse already caps it. This pins that the collapse survives the change.
    expect(htmlToPlainText("<p>a<br><br><br>b</p>")).toBe("a\n\nb");
    // A leading blank line is a gap before the first word, not between two of them: dropped,
    // exactly as blankLine() drops a leading empty paragraph.
    expect(htmlToPlainText("<p><br>a</p>")).toBe("a");
  });

  it("decodes entities rather than shipping them as literal text", () => {
    // A text/plain part reading `caf&eacute;` is wrong in a way no recipient can undo.
    expect(htmlToPlainText("<p>caf&eacute; &amp; bar &lt;tag&gt;</p>")).toBe("café & bar <tag>");
  });

  it("derives the text part from the SANITIZED html, never from what arrived", () => {
    // The claim that makes the alternative honest: a payload the sanitizer removed must not
    // reappear as words in the part a plaintext reader sees.
    const { html, text } = prepareOutboundBody(
      '<p>hello</p><script>secret()</script><a href="javascript:steal()">click</a>',
    );
    expect(html).not.toContain("secret");
    expect(text).not.toContain("secret");
    // The anchor survives as its text; its refused href does not appear in either part.
    expect(text).toBe("hello\nclick");
  });

  it("gives an empty body for markup that is entirely decoration", () => {
    expect(prepareOutboundBody("<p></p><p><br></p>")).toEqual({ html: "<p></p><p><br /></p>", text: "" });
  });
});

/**
 * THE CODE BLOCK — the widening this file's allowlist took, and the whole of what it cost.
 *
 * `pre` entered `ALLOWED_TAGS` in the same commit that switched `codeBlock` on in
 * `RichEditor.tsx`, because the two ends of that grammar are one decision enforced at two trust
 * boundaries. So the claims split the same way the module's own do: the tag survives (or the
 * editor has a control the server flattens), and the text/plain half renders it faithfully (or
 * the two parts of the alternative say different things about somebody's code).
 *
 * MUTATION WATCH — three mutations, run and watched red, and the SPLIT between them is the
 * reason they are listed separately. The rendering cases call {@link htmlToPlainText} on the
 * markup directly, so they are not guarded by the allowlist and would stay green if `pre` were
 * dropped from it; the survival cases are, and say nothing about the rendering. Neither set
 * alone covers the tag.
 *
 *   · Remove `"pre"` from `ALLOWED_TAGS` → 2 red: "keeps <pre>…" and "derives both halves…",
 *     both on `expected '<code>def f():…' to contain '<pre>'`.
 *   · Neutralise the `pre` branch in `htmlToPlainText`'s `onopentag` → 5 red, every one of them
 *     the collapsing prose path eating the code: `expected 'def f(): return 1' to be
 *     'def f():\n    return 1'`.
 *   · Drop the `codeSpans` exemption from the final collapse → exactly 1 red, the blank-lines
 *     case, which is why that case is written on its own rather than folded into the one above.
 */
describe("a code block survives, and its whitespace is meaning rather than layout", () => {
  const BLOCK = "<pre><code>def f():\n    return 1\n</code></pre>";

  it("keeps <pre> and the <code> inside it", () => {
    const out = sanitizeOutboundHtml(BLOCK);
    expect(out).toContain("<pre>");
    expect(out).toContain("<code>");
    expect(out).toContain("return 1");
  });

  it("keeps the LINE BREAKS and the INDENTATION, which is the only reason to have the tag", () => {
    // A sanitizer that kept `<pre>` and collapsed what is inside it would ship a code block
    // that is not code. The characters have to arrive exactly as they left.
    expect(sanitizeOutboundHtml(BLOCK)).toContain("def f():\n    return 1");
  });

  it("strips the language class off it like every other attribute", () => {
    // `class="language-ts"` is what a paste from a docs site carries. There is no styling in an
    // outbound message for it to select, so it is one more thing for a policy to be wrong about.
    const out = sanitizeOutboundHtml('<pre><code class="language-ts">x</code></pre>');
    expect(out).not.toContain("class");
    expect(out).toContain("x");
  });

  it("renders the block VERBATIM in the text half — no fence, no re-indentation", () => {
    // Same rule as emphasis: inventing ``` would put characters in the message the sender did
    // not type. Unlike emphasis, the whitespace IS the content, so nothing about it collapses.
    expect(htmlToPlainText(BLOCK)).toBe("def f():\n    return 1");
    expect(htmlToPlainText(`<p>like this:</p>${BLOCK}<p>done</p>`))
      .toBe("like this:\ndef f():\n    return 1\ndone");
  });

  it("keeps two blank lines INSIDE a block, where the prose collapse would have eaten one", () => {
    // Two blank lines between two definitions is how a great deal of real code is written. The
    // blank-run collapse that keeps a message from ending in six empty lines would silently
    // reformat it, so the collapse skips the spans a code block wrote.
    const out = htmlToPlainText("<pre><code>a()\n\n\nb()</code></pre>");
    expect(out).toBe("a()\n\n\nb()");
    // …and it is still a collapse everywhere else, which is the half that must not be lost.
    expect(htmlToPlainText("<p>x<br><br><br><br>y</p>")).toBe("x\n\ny");
  });

  it("drops the newline html itself drops — the one immediately after <pre>", () => {
    // Every browser ignores a line break directly after the tag, so a text half that kept it
    // would show a leading blank line the html half does not have.
    expect(htmlToPlainText("<pre><code>\nfirst\nsecond</code></pre>")).toBe("first\nsecond");
  });

  it("carries the quote prefix onto every line of a quoted block", () => {
    expect(htmlToPlainText("<blockquote><pre><code>one\ntwo</code></pre></blockquote>"))
      .toBe("> one\n> two");
  });

  it("is a FIXED POINT, so the send-time pass ships the same bytes the store-time pass did", () => {
    const once = sanitizeOutboundHtml(`<p>hi</p>${BLOCK}`);
    expect(sanitizeOutboundHtml(once)).toBe(once);
  });

  it("still refuses a script inside a code block — `pre` is a container, not an exemption", () => {
    // `nonTextTags` has to keep winning in here: the text of a `<script>` is executable source,
    // and a `<pre>` around it must not turn that into "prose the author is quoting".
    const out = sanitizeOutboundHtml("<pre><script>fetch('//evil')</script></pre>");
    expect(out).not.toContain("fetch");
    expect(out).not.toContain("script");
  });

  it("a no-break space is CONTENT: the collapse steps around it, and the delivered text carries its width as ordinary spaces", () => {
    // The compose surface's signature serializer encodes indentation and aligned columns with
    // U+00A0 precisely because ordinary spaces collapse (its own `style` cannot survive the
    // sanitizer). `\s` includes U+00A0, so an unguarded `\s+` collapse — and a bare `trim()`,
    // which also strips it — shipped plaintext narrower than the html half showed. The width
    // must reach text/plain, as ordinary spaces.
    expect(htmlToPlainText("<p>sig:<br>\u00a0\u00a0indented<br>a \u00a0b</p>"))
      .toBe("sig:\n  indented\na  b");
    // …while ordinary whitespace still collapses exactly as before.
    expect(htmlToPlainText("<p>a   b</p>")).toBe("a b");
    // An NBSP-ONLY paragraph is the common empty-paragraph placeholder — a gap, never a
    // space-only line beside a blank one (review round 3).
    expect(htmlToPlainText("<p>a</p><p>\u00a0</p><p>b</p>")).toBe("a\n\nb");
    // …and inside a code block the bytes are the author's verbatim: an NBSP in pasted source
    // stays an NBSP — the prose conversion must not reach in (review round 3).
    expect(htmlToPlainText("<pre>a\u00a0b</pre>")).toBe("a\u00a0b");
    // A list item that OPENS with the placeholder keeps its marker: the hard break keeps
    // NBSP-only segments (the author's explicit break structure), so the item numbers hold
    // (review round 4). Bare `<li>` first — the minimal case.
    expect(htmlToPlainText("<ol><li>\u00a0<br>visible</li><li>two</li></ol>"))
      .toBe("1.  \nvisible\n2. two");
    // …and the markup RichEditor (TipTap) actually emits: `<li><p>…</p></li>`, one level
    // deeper. The paragraph's OPENING flush is empty (nothing written yet) and must not
    // consume the marker the `<li>` just set, or the fix above never engages the real input
    // (review round 5 — the round-4 fixture did not exercise this).
    expect(htmlToPlainText("<ol><li><p>\u00a0<br>visible</p></li><li><p>two</p></li></ol>"))
      .toBe("1.  \nvisible\n2. two");
    // An EMPTY item's marker must not escape the list onto unrelated prose after it — every
    // boundary flush inside `<li><p></p></li>` is empty, so nothing ever consumes it unless
    // the closing `<li>`/list clears it explicitly (review round 6).
    expect(htmlToPlainText("<ol><li><p></p></li></ol><p>after</p>")).toBe("after");
    // …and a marker that closes with the ITEM must not bleed into the NEXT item's own text.
    expect(htmlToPlainText("<ol><li></li><li><p>two</p></li></ol>")).toBe("2. two");
    // A LIST WRAPPED IN AN ANCHOR — markup the sanitizer permits and no editor of ours
    // produces — renders its flattened line UNNUMBERED: the item's text deferred into the
    // anchor's buffer and never flushed inside the item, and only a flush inside its own item
    // earns a marker. Rounds 7–12 each falsified a heuristic that tried to predict what the
    // anchor's close would contribute; the flush rule replaced prediction entirely, and the
    // markers this withholds belong to pathological markup in the sender's own message.
    expect(htmlToPlainText('<a href="https://x.example">one</a>')).toBe("one (https://x.example)");
    expect(htmlToPlainText('<a href="https://x.example"><ol><li>one</li></ol></a>'))
      .toBe("one (https://x.example)");
    // …but an anchor-wrapped item that IS empty still clears its marker: an open anchor is
    // not itself evidence of content — only what it will actually produce is (review
    // round 8, on round 7's own guard). No `href`, so the anchor's own close contributes
    // nothing either — the case is genuinely empty end to end.
    expect(htmlToPlainText('<a><ol><li></li></ol></a><p>after</p>')).toBe("after");
    // An HREF-ONLY anchor wrapping an empty item: the href is the ANCHOR's content, emitted
    // at its close onto whatever line is current there — never the item's. The empty item
    // carries no number, and the address renders unnumbered (round 10, superseding round 9's
    // reading of this corner: numbering prose that sits outside the item is the worse error).
    expect(htmlToPlainText('<a href="https://x.example"><ol><li></li></ol></a>'))
      .toBe("https://x.example");
    // The decisive case for that rule: sibling text AFTER the list, inside the anchor — an
    // empty item's marker must not reach it (review round 10).
    expect(htmlToPlainText('<a href="https://x.example"><ol><li></li></ol>after</a>'))
      .toBe("after (https://x.example)");
    // …siblings, nesting, whitespace-only items and inner anchors inside a wrapping anchor
    // all land on the same unnumbered flattened line — no marker can survive an item nothing
    // flushed in, so none of these can misnumber the prose around them (rounds 10–12's cases).
    expect(htmlToPlainText('<a href="https://x.example"><ol><li>one</li><li></li></ol>after</a>'))
      .toBe("oneafter (https://x.example)");
    expect(htmlToPlainText('<a href="https://x.example"><ol><li>outer<ul><li></li></ul></li></ol></a>'))
      .toBe("outer (https://x.example)");
    expect(htmlToPlainText('<a href="https://x.example"><ol><li> <ul><li></li></ul></li></ol></a>'))
      .toBe("https://x.example");
    // THE RESTORE, in ordinary markup: an item whose EMPTY sublist precedes its own trailing
    // text must still number that text — the child's close hands the parent's pending marker
    // back rather than clearing it (round 11's rule, needed with no anchor anywhere).
    expect(htmlToPlainText("<ol><li><ul><li></li></ul><p>tail</p></li></ol>")).toBe("1. tail");
    // The inner anchor flushes inside ITS item and earns that item's marker; the outer
    // anchor's tail ships unnumbered (round 12's second case — no leaked "1." on "after").
    // Nested anchors are illegal HTML; the one-anchor model keeps the INNER one and the outer
    // href goes unrendered — prior behavior, and the honest floor for markup browsers
    // themselves refuse to nest.
    expect(htmlToPlainText(
      '<a href="https://outer.example"><ol><li>one</li>'
      + '<li><a href="https://inner.example">two</a></li></ol>after</a>',
    )).toBe("2. two (https://inner.example)\nafter");
  });

  it("derives both halves together for a message that has one", () => {
    const { html, text } = prepareOutboundBody(`<p>see:</p>${BLOCK}`);
    expect(html).toContain("<pre>");
    expect(text).toBe("see:\ndef f():\n    return 1");
  });

  it("a long newline run inside a block costs linear time, not the run squared", () => {
    const n = 100_000;
    const started = performance.now();
    const { text } = prepareOutboundBody(`<pre>${"\n".repeat(n)}a${"\n".repeat(n)}b${"\n".repeat(n)}</pre><p>after</p>`);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(text).toBe(`${"\n".repeat(n - 1)}a${"\n".repeat(n)}b\nafter`);
  });

  it("a quote or list nested past 32 levels renders 32, so a line's prefix stays bounded", () => {
    expect(htmlToPlainText(`${"<blockquote>".repeat(40)}<p>deep</p>`)).toBe(`${"> ".repeat(32)}deep`);
    expect(htmlToPlainText(`${"<ul><li>".repeat(40)}x`)).toBe(`${"  ".repeat(32)}- x`);
    expect(htmlToPlainText(`${"<ol><li>".repeat(40)}x`)).toBe(`${"  ".repeat(32)}1. x`);
  });

  it("thousands of nested quotes or lists give a text part linear in the letter's size", () => {
    for (const html of [
      `${"<blockquote>".repeat(3_000)}<pre>${"x\n".repeat(100_000)}</pre>`,
      `${"<ul>".repeat(2_000)}${"<li>x</li>".repeat(20_000)}`,
    ]) {
      const started = performance.now();
      const { text } = prepareOutboundBody(html);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(text.length).toBeLessThan(40 * html.length);
    }
  });
});
