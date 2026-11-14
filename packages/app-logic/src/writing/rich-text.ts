"use client";

/**
 * The two halves of a typed message, and how they survive a deploy. A rich editor holds two strings
 * — the markup and the plain text it renders as — and both must survive navigation: the scratch
 * buffers are a data-loss guarantee, which is why this module is separate from the editor component
 * (the storage rules are testable without a DOM). The legacy read is SHAPE-based, not parse-based:
 * a stored value is an envelope only if it parses to a non-array object whose `text` is a string —
 * "it parsed as JSON" would silently turn a reply of `{"text": "see attached"}` (config pasted
 * into an email) into an envelope and lose the braces. No version field: it would not remove the
 * legacy read, so it would be a second thing to keep true in exchange for nothing.
 */

/** What the editor holds: the markup, and the plain text it renders as. */
export interface RichValue {
  /** The plain-text rendering, kept for the send path's local checks and the optimistic row. */
  text: string;
  /** The markup, or `""` for a message with no formatting in it. */
  html: string;
}

export const EMPTY_RICH: RichValue = { text: "", html: "" };

/**
 * Is there anything here to send, or to keep?
 *
 * Decided on the TEXT, never on the html. An empty ProseMirror document serialises to
 * `<p></p>`, which is four characters of markup and no message at all — testing the html
 * would make every visit to Compose leave a stored buffer behind and would light up Send on
 * an empty editor.
 */
export const isRichEmpty = (v: RichValue): boolean => v.text.trim() === "";

/**
 * Read a scratch value that may have been written by this bundle or by the one before it.
 *
 * `null`/absent reads as empty. See the header for why the envelope is recognised by shape.
 */
export function parseRichValue(raw: string | null | undefined): RichValue {
  if (raw == null || raw === "") return EMPTY_RICH;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all — the ordinary legacy case, and the ordinary answer.
    return { text: raw, html: "" };
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    typeof (parsed as RichValue).text !== "string"
  ) {
    return { text: raw, html: "" };
  }
  const env = parsed as Partial<RichValue>;
  return {
    text: env.text as string,
    // Guarded separately, so an envelope written by a bundle that only knew about `text`
    // still reads, and one written here is still readable by a bundle that ignores `html`.
    html: typeof env.html === "string" ? env.html : "",
  };
}

/**
 * The string to store for a value, or `null` when there is nothing worth storing. No text ⇒ nothing at
 * all (an empty draft removes its key; an empty envelope would resurrect an empty editor on every
 * navigation). Text but no markup ⇒ the bare string, readable by a bundle that predates this module.
 * Except when the text is itself envelope-shaped: the literal `{"text":"gotcha"}` — config pasted into an
 * email — stored bare would be read back as an envelope and lose its braces; the shape rule closes that
 * from an OLD key, this closes it from a new write, and together the buffer is lossless. The condition is
 * the round trip itself, not a hand-written "looks like JSON" test: a second predicate could drift from
 * {@link parseRichValue}, invisibly, until somebody's message came back wrong.
 */
export function serializeRichValue(v: RichValue): string | null {
  if (isRichEmpty(v)) return null;
  if (v.html === "" && parseRichValue(v.text).text === v.text) return v.text;
  return JSON.stringify({ text: v.text, html: v.html });
}

/* ── turning a value into a document ──────────────────────────────────────────────────── */

/**
 * Plain text as paragraphs, escaped. Escaping is not optional even though the text came from the
 * user's own keyboard, because every consumer hands the result to an HTML parser: somebody who typed
 * `<b>` into the old textarea must get `<b>` back when their draft is restored — not bold text, and
 * certainly not bold text the next keystroke persists as markup they never wrote. It lives here for
 * the reason the rest of the module does: DOM-free, the part that must not break, three consumers
 * (the editor's initial content, its sync effect, and {@link appendRich}).
 */
export function escapeAsParagraphs(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>") || "<br>"}</p>`)
    .join("");
}

/**
 * A value as the document to load — the markup when there is any, and the plain text as escaped paragraphs when there
 * is not. One helper for the editor's initial `content` AND for its sync effect, because both hand their string to
 * the same parser and therefore need the same escaping. They did not have it: the effect escaped and the initial
 * content did not, so a legacy plain buffer went in raw and was silently corrected a tick later by the effect — which
 * is exactly why the guard on the escaping was green. The visible defect was one frame wide; the real one is that
 * only one of the two doors was locked.
 */
export function richToHtml(v: RichValue): string {
  return v.html || (v.text ? escapeAsParagraphs(v.text) : "");
}

/**
 * `b` placed below `a` — what "Add below" means when a drafted reply lands on top of something already written. THE
 * MIXED CASE IS WHY THIS IS NOT A CONCATENATION. A generated draft arrives as plain text and the editor may hold
 * markup; joining `a.html` to `b.text` would hand the parser a string whose second half was never escaped, so a draft
 * mentioning `<script>` or an `a > b` would become markup on the way in. {@link richToHtml} escapes whichever half
 * needs it, which is the same rule the editor loads a document by. The result is plain when BOTH sides are plain —
 * appending must not invent formatting on a message that had none, because `html` present is what puts the markup on
 * the wire instead of the text (`compose.ts`).
 */
export function appendRich(a: RichValue, b: RichValue): RichValue {
  if (isRichEmpty(a)) return b;
  if (isRichEmpty(b)) return a;
  return {
    // A blank line between them: two paragraphs of somebody else's prose run together read as
    // one, and this is the plain half a plaintext recipient may end up reading.
    text: `${a.text}\n\n${b.text}`,
    html: a.html || b.html ? richToHtml(a) + richToHtml(b) : "",
  };
}
