import { describe, it, expect } from "vitest";
import {
  DRAFT_BODY_MAX_BYTES, draftBodyOverCeiling, draftOverCeiling, repairLegacyDraftHtml, utf8ByteLength,
} from "../src/outbound-text.js";

/**
 * THE PLAIN BODY'S CEILING, AND THE COUNTER IT IS MEASURED WITH.
 *
 * `utf8ByteLength` exists because the compose editor asks this question on every keystroke and
 * `TextEncoder`/`Buffer` answer it by allocating the whole body again. A second implementation of
 * a standard encoding is only worth having if it is proved equal to the standard one, so that is
 * what this file does — over the shapes a mail body actually contains, plus the three a
 * hand-rolled counter gets wrong: a surrogate PAIR (four bytes for two units), a LONE surrogate
 * (which both encoders render as U+FFFD, three bytes), and a zero-width-joiner sequence, where
 * one glyph on screen is several code points on the wire.
 */
const CORPUS = [
  "",
  "a",
  "plain ascii, the ordinary case",
  "Grüezi — ä ö ü ß, and a nbsp here",
  "日本語のメールの本文です",
  "an emoji 🙂 and a joined family 👩‍👩‍👧",
  "\u0000\u0001\u001f control bytes weigh one byte each",
  "😀",
  "\ud83d",
  "\udc00",
  "a\ud83db",
  "line\nbreak\r\nand tabs\t\t",
];

describe("utf8ByteLength answers what Buffer.byteLength answers", () => {
  it.each(CORPUS.map((s, i) => [i, s] as const))("case %i", (_i, s) => {
    expect(utf8ByteLength(s)).toBe(Buffer.byteLength(s, "utf8"));
  });

  it("agrees on bodies that straddle the ceiling", () => {
    for (const n of [DRAFT_BODY_MAX_BYTES - 1, DRAFT_BODY_MAX_BYTES, DRAFT_BODY_MAX_BYTES + 1]) {
      const s = "a".repeat(n);
      expect(utf8ByteLength(s)).toBe(Buffer.byteLength(s, "utf8"));
    }
  });
});

describe("draftBodyOverCeiling", () => {
  it("admits a body AT the ceiling and refuses one byte over", () => {
    expect(draftBodyOverCeiling("a".repeat(DRAFT_BODY_MAX_BYTES))).toBe(false);
    expect(draftBodyOverCeiling("a".repeat(DRAFT_BODY_MAX_BYTES + 1))).toBe(true);
  });

  it("is decided in BYTES, so the fast paths cannot answer for the counter", () => {
    // Under the ceiling in `String.length` and over it in bytes — the case a length check admits
    // and Postgres `octet_length` refuses. It also lands in the band between the two fast paths,
    // which is the only input that reaches the walk at all.
    const body = "ä".repeat(DRAFT_BODY_MAX_BYTES / 2 + 1);
    expect(body.length).toBeLessThan(DRAFT_BODY_MAX_BYTES);
    expect(body.length * 3).toBeGreaterThan(DRAFT_BODY_MAX_BYTES);
    expect(draftBodyOverCeiling(body)).toBe(true);
    expect(utf8ByteLength(body) > DRAFT_BODY_MAX_BYTES).toBe(true);
  });

  it("takes the cheap answer where the answer is certain, and it is the same answer", () => {
    const wayUnder = "a".repeat(1000);
    const wayOver = "a".repeat(DRAFT_BODY_MAX_BYTES + 1000);
    expect(draftBodyOverCeiling(wayUnder)).toBe(utf8ByteLength(wayUnder) > DRAFT_BODY_MAX_BYTES);
    expect(draftBodyOverCeiling(wayOver)).toBe(utf8ByteLength(wayOver) > DRAFT_BODY_MAX_BYTES);
  });

  it("is the number the rich half already carries", () => {
    // Not a literal restated for its own sake: `0037_draft_html.sql` argues that two ceilings
    // which differ are a second number to keep true, and this holds that argument as a test. The
    // rich cap's own reconciliation to its migration lives in `services/test/outbound-html.test.ts`.
    expect(DRAFT_BODY_MAX_BYTES).toBe(262144);
  });
});
/**
 * THE EFFECTIVE BODY — whichever half of a draft will be stored.
 *
 * The rich half carries the SAME ceiling and has been refused at the server since it shipped,
 * with nothing said to the composer beforehand. One predicate over the larger of the two halves
 * is how the request door prices its worst legal body: a request carrying `body` alongside `html`
 * is a 400, so no legal draft holds both and the MAXIMUM is the whole answer.
 */
describe("draftOverCeiling", () => {
  const over = "a".repeat(DRAFT_BODY_MAX_BYTES + 1);
  const at = "a".repeat(DRAFT_BODY_MAX_BYTES);

  it("refuses whichever half is over, and admits when neither is", () => {
    expect(draftOverCeiling("short", "<p>short</p>")).toBe(false);
    expect(draftOverCeiling(over, "<p>short</p>")).toBe(true);
    expect(draftOverCeiling("short", over)).toBe(true);
    expect(draftOverCeiling(over, over)).toBe(true);
  });

  it("is exactly the plain predicate when there is no markup", () => {
    // THE ABSENT-MARKUP ARM, from the one caller that can express it: `undefined` and `null` are
    // "this draft is plain", not "measure the string 'null'".
    for (const html of [undefined, null, ""] as const) {
      expect(draftOverCeiling("short", html)).toBe(false);
      expect(draftOverCeiling(at, html)).toBe(false);
      expect(draftOverCeiling(over, html)).toBe(true);
    }
    expect(draftOverCeiling("short")).toBe(false);
  });

  it("the ceiling is one byte wide on the markup half too", () => {
    expect(draftOverCeiling("", at)).toBe(false);
    expect(draftOverCeiling("", over)).toBe(true);
  });

  it("counts the markup in BYTES, not in characters", () => {
    // Under the ceiling by `String.length`, over it on the wire — the same trap the plain half
    // has a case for, on the half nothing measured before.
    const accented = "\u00e4".repeat(DRAFT_BODY_MAX_BYTES / 2 + 1);
    expect(accented.length).toBeLessThan(DRAFT_BODY_MAX_BYTES);
    expect(draftOverCeiling("short", accented)).toBe(true);
  });
});


describe("legacy generated draft HTML", () => {
  const bare = "<p>Plans &amp; notes</p><p></p><p>Friday works.</p>";
  const text = "Plans & notes\n\nFriday works.";

  it("repairs an exact match without changing the words", () => {
    expect(repairLegacyDraftHtml(bare, text)).toBe("<p>Plans &amp; notes<br /><br />Friday works.</p>");
  });

  it("keeps markup with formatting or different text", () => {
    const formatted = bare.replace("Friday", "<strong>Friday</strong>");
    expect(repairLegacyDraftHtml(formatted, text)).toBe(formatted);
    expect(repairLegacyDraftHtml(bare, text.replace("Friday", "Monday"))).toBe(bare);
  });
});
