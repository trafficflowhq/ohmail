/**
 * The signature on an outgoing message — state model and serialization.
 * Every compose surface offers the stored text (`mailboxes.signature`) as a
 * distinct, removable block; all clients derive the block and seal the send
 * here. States: `following` (the resolved sending mailbox's text, derived
 * per render), `edited`, `removed` — the user's choice wins over any From
 * switch, held per message. What is shown is what ships:
 * {@link effectiveSignature} answers the block, {@link withSignature} seals
 * both send halves; {@link effectiveSignatureHtml}: markup, `following` only.
 */

export type SignatureState =
  | { kind: "following" }
  | { kind: "edited"; text: string }
  | { kind: "removed" };

/** The resting state — one shared object so resets don't mint per-render identities. */
export const SIG_FOLLOWING: SignatureState = { kind: "following" };

/**
 * WHAT THE BLOCK SHOWS — and therefore what the send appends. `null` is "no block": removed,
 * edited down to nothing, a sender that stores nothing, or a sender nothing can name.
 *
 * An `edited` text that is blank after trimming answers `null` rather than the whitespace:
 * deleting every character of the block is the removal gesture performed with the keyboard,
 * and shipping a message whose tail is two newlines and some spaces would be serializing a
 * block the screen no longer shows.
 */
export function effectiveSignature(
  state: SignatureState,
  signatures: Readonly<Record<string, string>>,
  mailboxId: string | null,
): string | null {
  if (state.kind === "removed") return null;
  if (state.kind === "edited") return state.text.trim().length > 0 ? state.text : null;
  if (mailboxId === null) return null;
  const stored = signatures[mailboxId];
  return stored !== undefined && stored.trim().length > 0 ? stored : null;
}

/**
 * What the block renders as markup — `null` for "no markup here", which is
 * every case except one: `following` with a resolved mailbox that stores
 * markup. Separate from {@link effectiveSignature} rather than a second
 * field on it: the text half of the send always carries the text, the html
 * half carries this when non-null — one return would let a caller take the
 * markup and forget the text, breaking `multipart/alternative` by
 * construction. Blank-after-trimming markup answers `null`: an empty
 * `<p></p>` is markup and no signature.
 */
export function effectiveSignatureHtml(
  state: SignatureState,
  signaturesHtml: Readonly<Record<string, string>>,
  mailboxId: string | null,
): string | null {
  // The reader spoke — their words are plain text and BOTH halves carry them. See the header.
  if (state.kind !== "following") return null;
  if (mailboxId === null) return null;
  const stored = signaturesHtml[mailboxId];
  return stored !== undefined && stored.trim().length > 0 ? stored : null;
}

/** The five characters that stop signature text from becoming markup when it joins the html. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * What the block renders as markup — `null` for "no markup here", which is
 * every case except `following` with a mailbox that stores markup. Separate
 * from {@link effectiveSignature}: the text half of the send always carries
 * the text, the html half carries this when non-null — one combined return
 * would let a caller take the markup and forget the text, breaking
 * `multipart/alternative` by construction. Blank-after-trimming markup
 * answers `null`: an empty `<p></p>` is markup and no signature.
 */
const NBSP = "\u00a0";
function expandTabs(line: string): string {
  let out = "";
  for (const ch of line) {
    if (ch === "\t") out += " ".repeat(4 - (out.length % 4));
    else out += ch;
  }
  return out;
}
function preserveWhitespace(escapedLine: string): string {
  return escapedLine
    .replace(/ {2}/g, ` ${NBSP}`)
    .replace(/^ /, NBSP);
}
export function signatureHtml(sig: string): string {
  return `<p>${sig.split("\n").map((l) => preserveWhitespace(escapeHtml(expandTabs(l)))).join("<br>")}</p>`;
}

/**
 * SEAL THE SIGNATURE INTO THE MUTATION — the one place the block's text joins the message.
 *
 * `sig === null` returns the mutation UNCHANGED (the same object, so the no-signature request is
 * byte-identical on the wire). Otherwise the plain body gains `\n\n` + the text, and a rich
 * body — when the mutation carries one — gains markup: the server derives the delivered
 * plaintext from the markup, so a rich send that appended to `body` alone would show the
 * signature locally and drop it from what recipients read.
 *
 * ── THE THIRD ARGUMENT IS THE MAILBOX'S STORED MARKUP, OR NOTHING ────────────────────────
 *
 * `sigHtml` is {@link effectiveSignatureHtml}'s answer — the markup the Settings editor wrote,
 * already reduced to the compose grammar by the server that stored it, and reduced again by the
 * server that sends it (`sanitizeOutboundHtml` runs on the way out and is idempotent, so this
 * is never the only gate). Absent, `undefined` or `null` takes {@link signatureHtml}'s escaped
 * text path, which is what EVERY caller did before this argument existed and what the phone's
 * two send arms still do — so the two-argument call is byte-identical to the one it replaced.
 *
 * THE TEXT HALF IS NEVER THE MARKUP. `sig` goes onto `body` in both branches, because `body` is
 * the `text/plain` part and a recipient reading it must see words rather than tags.
 *
 * A mutation with NO `html` stays plain in both branches too. `html` present is what puts a
 * message on the wire as `multipart/alternative` (`compose.ts`), and a signature must not turn
 * somebody's plain note into a two-part message.
 *
 * Structural over the two fields it touches (`mail_send` carries them on every client), so
 * the webapp's `MailSend` plan and the engine's own mutation both satisfy it unchanged.
 */
export function withSignature<M extends { body: string; html?: string }>(
  m: M, sig: string | null, sigHtml?: string | null,
): M {
  if (sig === null) return m;
  const tail = sigHtml !== undefined && sigHtml !== null && sigHtml.trim().length > 0
    ? sigHtml
    : signatureHtml(sig);
  return {
    ...m,
    body: `${m.body}\n\n${sig}`,
    ...(m.html !== undefined ? { html: m.html + tail } : {}),
  };
}
