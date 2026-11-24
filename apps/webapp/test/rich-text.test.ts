/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  EMPTY_RICH,
  appendRich,
  escapeAsParagraphs,
  isRichEmpty,
  parseRichValue,
  richToHtml,
  serializeRichValue,
  type RichValue,
} from "@ohmail/app-logic/writing/rich-text";

/**
 * THE SCRATCH BUFFER'S STORAGE RULES — the half of rich compose that must not lose anybody's
 * words.
 *
 * The reply buffer is a data-loss guarantee, not a convenience: `reply-run.test.ts` and
 * `inline-reply.test.ts` both pin that typed text survives leaving and re-entering an editor,
 * and one of those guards protects a defect that shipped. Adding a second field to the value
 * those buffers hold is exactly the kind of change that quietly voids the guarantee for
 * anybody who was mid-sentence when the deploy landed — so the legacy read is the first thing
 * asserted here, before anything about the new shape.
 */

const round = (v: RichValue): RichValue => parseRichValue(serializeRichValue(v));

describe("a value written by the bundle BEFORE this one still reads", () => {
  it("takes a bare string as plain text — the pre-deploy reply survives", () => {
    expect(parseRichValue("half a sentence")).toEqual({ text: "half a sentence", html: "" });
  });

  it("does NOT mistake pasted JSON for an envelope", () => {
    // Somebody replying with a fragment of config is ordinary. A parse-based read would
    // restore their message as an envelope and lose the braces; the shape check is what
    // stops it, and this is the case that forces the check to exist.
    const pasted = '{"retries": 3}';
    expect(parseRichValue(pasted)).toEqual({ text: pasted, html: "" });
  });

  it("does not mistake a JSON ARRAY, or an envelope with a non-string text, for one either", () => {
    expect(parseRichValue('["a","b"]')).toEqual({ text: '["a","b"]', html: "" });
    expect(parseRichValue('{"text": 42}')).toEqual({ text: '{"text": 42}', html: "" });
  });

  it("reads absent and empty as empty", () => {
    expect(parseRichValue(null)).toEqual(EMPTY_RICH);
    expect(parseRichValue(undefined)).toEqual(EMPTY_RICH);
    expect(parseRichValue("")).toEqual(EMPTY_RICH);
  });
});

describe("what gets written", () => {
  it("stores a PLAIN value as a bare string, not as a wrapper around an empty field", () => {
    // Also the forward courtesy: a bundle that predates this module reads the key back and
    // finds the reply, not a JSON blob it would show the user verbatim.
    expect(serializeRichValue({ text: "just words", html: "" })).toBe("just words");
  });

  it("stores a RICH value as an envelope, and reads it back whole", () => {
    const v: RichValue = { text: "bold words", html: "<p><strong>bold</strong> words</p>" };
    expect(round(v)).toEqual(v);
  });

  it("stores NOTHING for an empty value — an empty draft removes its key", () => {
    expect(serializeRichValue(EMPTY_RICH)).toBeNull();
    expect(serializeRichValue({ text: "   ", html: "" })).toBeNull();
  });

  it("stores nothing for an editor holding only empty markup", () => {
    // An empty ProseMirror document serialises to `<p></p>`. Judging emptiness by the html
    // would leave a stored buffer behind after every visit to Compose.
    expect(serializeRichValue({ text: "", html: "<p></p>" })).toBeNull();
    expect(isRichEmpty({ text: "", html: "<p></p>" })).toBe(true);
  });

  it("round-trips text that LOOKS like an envelope", () => {
    // The other direction of the shape rule: if a user types the exact shape, storing it as a
    // bare string and reading it back must still give them their words.
    const v: RichValue = { text: '{"text":"gotcha"}', html: "" };
    expect(round(v)).toEqual(v);
  });

  it("round-trips a multi-line plain reply byte for byte", () => {
    const v: RichValue = { text: "one\n\ntwo\n  indented", html: "" };
    expect(round(v)).toEqual(v);
  });
});

describe("emptiness is decided on the text", () => {
  it("is empty when the text is blank however much markup there is", () => {
    expect(isRichEmpty({ text: "  \n ", html: "<p></p><blockquote><p></p></blockquote>" })).toBe(true);
  });

  it("is not empty when there are words", () => {
    expect(isRichEmpty({ text: "a", html: "" })).toBe(false);
  });
});

describe("a value becomes a document the same way through both doors", () => {
  it("escapes a plain value rather than letting it be parsed as markup", () => {
    // `richToHtml` feeds the editor's INITIAL content and its sync effect alike. The initial
    // one used to skip this, so a legacy buffer holding a tag mounted as formatting and the
    // next keystroke persisted markup the person never wrote.
    expect(richToHtml({ text: "a <b>tag</b>", html: "" }))
      .toBe("<p>a &lt;b&gt;tag&lt;/b&gt;</p>");
  });

  it("prefers the markup when there is any", () => {
    expect(richToHtml({ text: "x", html: "<p><em>x</em></p>" })).toBe("<p><em>x</em></p>");
  });

  it("keeps single newlines as breaks and blank lines as paragraphs", () => {
    // The pair that makes the editor's "is there formatting here" round trip exact: a plain
    // document must serialise to precisely this, or every plain message would report markup.
    expect(escapeAsParagraphs("a\nb\n\nc")).toBe("<p>a<br>b</p><p>c</p>");
  });
});

describe("adding a drafted reply below what was written", () => {
  it("stays PLAIN when both halves are plain", () => {
    // Markup present is what puts the html on the wire instead of the text (`compose.ts`), so
    // inventing a markup half here would turn a plain message into a multipart on the way out.
    expect(appendRich({ text: "one", html: "" }, { text: "two", html: "" }))
      .toEqual({ text: "one\n\ntwo", html: "" });
  });

  it("escapes the PLAIN half when the other one carries markup", () => {
    // The mixed case is the whole reason this is not a concatenation: a drafted reply arrives
    // as text and the editor may hold markup, so joining the raw strings would let the draft's
    // characters become formatting when the result is parsed back into a document.
    const out = appendRich(
      { text: "bold", html: "<p><strong>bold</strong></p>" },
      { text: "and <i>this</i>", html: "" },
    );
    expect(out.html).toBe("<p><strong>bold</strong></p><p>and &lt;i&gt;this&lt;/i&gt;</p>");
    expect(out.text).toBe("bold\n\nand <i>this</i>");
  });

  it("returns the other side untouched when one of them is empty", () => {
    const v: RichValue = { text: "only", html: "" };
    expect(appendRich(EMPTY_RICH, v)).toBe(v);
    expect(appendRich(v, EMPTY_RICH)).toBe(v);
  });
});
