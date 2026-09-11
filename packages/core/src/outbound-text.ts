/**
 * Plain text → the two halves of one outbound message. A drafter answers with prose; the send
 * path puts `body` and `html` on the wire as `multipart/alternative` when the second is present —
 * until this module, a generated draft never wrote it, so a model-written reply went out
 * `text/plain`. The SERVER promotes, not the model: two independent answers could disagree. The
 * grammar is the smallest that survives the round trip — `<p>`, `<br />`, `<p></p>`; `&`, `<`,
 * `>` escaped — inside the outbound sanitizer's allow-list, asserted as a fixed point. Both
 * halves return together: the text half is the NORMALIZED source, what every renderer of the html
 * shows. In `core` because both generated-draft writers live in different packages.
 */

/** The two halves of one message, derived together and never separately. */
export interface PromotedBody {
  /** The markup half. `""` when the source has no words in it — then there is nothing to promote. */
  html: string;
  /** The text/plain half: the normalized source the markup above was built from. */
  text: string;
}

/**
 * The three characters that are markup rather than punctuation.
 *
 * `"` and `'` are deliberately absent: nothing here emits an attribute, so a quote in a
 * sentence is a quote in a sentence. It is also what the sanitizer's own text escaper does, and
 * the two must agree or the fixed-point property below fails on ordinary prose.
 */
const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Promote a plain-text body to `{html, text}`.
 *
 * Empty in, empty out — a whitespace-only body promotes to `{html: "", text: ""}` rather than to
 * an empty paragraph, so a caller can tell "there is nothing here" from "here is a blank
 * message" and store no html at all.
 */
export function plainTextToOutboundBody(source: string): PromotedBody {
  // Line endings first. A model answer is not guaranteed to use `\n`, and a stray `\r` left in
  // the text half would be a byte the html half cannot possibly carry.
  const normalized = source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    // `\s+`, not `[ \t]+`: a renderer collapses every kind of whitespace, non-breaking spaces
    // and form feeds included, and the text half has to say what the markup will show.
    .map((line) => line.replace(/\s+/g, " ").trim());

  // Blank runs collapse to ONE blank line and both ends lose theirs — again because that is
  // what the markup renders as, and a text half holding six trailing blank lines reads as a
  // mistake somebody made rather than as spacing somebody chose.
  const lines: string[] = [];
  for (const line of normalized) {
    if (line === "" && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { html: "", text: "" };

  let html = "";
  let paragraph: string[] = [];
  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    // `<br />`, not `<br>`, because that is the form the sanitizer re-serializes a break into.
    // The two spellings render identically; only one of them is a fixed point.
    html += `<p>${paragraph.join("<br />")}</p>`;
    paragraph = [];
  };

  for (const line of lines) {
    if (line === "") {
      closeParagraph();
      // An EMPTY PARAGRAPH is how a rich editor holds the gap between two paragraphs, and it is
      // the one construct `htmlToPlainText` renders back as a blank line. Expressing the gap as
      // paragraph margins instead would look right and would lose the blank line on the way
      // back to text — the two halves would then disagree about where the message breathes.
      html += "<p></p>";
      continue;
    }
    paragraph.push(escapeText(line));
  }
  closeParagraph();

  return { html, text: lines.join("\n") };
}
