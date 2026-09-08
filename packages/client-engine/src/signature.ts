/**
 * THE SIGNATURE ON AN OUTGOING MESSAGE — the state model and the serialization, and nothing
 * framework-shaped in either.
 *
 * A mailbox can store a signature (Settings → Signatures; `mailboxes.signature`, mail 0075).
 * When it does, every compose surface offers the text as a DISTINCT, REMOVABLE BLOCK below the
 * writing area — visibly part of the outgoing message, never silently pasted into the prose.
 * The reader can strike it for this one message (×), or edit it inline (it is their text); at
 * send it serializes into the body EXACTLY AS SHOWN.
 *
 * It lives in this package because every client composes the same message: the webapp shell
 * (and the desktop window, which ships that shell) and the React Native app all derive the
 * block and seal the send from THIS one module — the RN app cannot import the webapp shell,
 * and a mirrored copy would be the divergence the one-derivation rule exists to prevent.
 * `apps/webapp/app/shell/signature.ts` re-exports it for the shell's importers.
 *
 * ── THE STATE MODEL: FOLLOWS THE FROM, UNLESS THE USER SPOKE ─────────────────────────────
 *
 * The block follows the From selector: switching the sending mailbox swaps the block to that
 * mailbox's signature. The one rule on top of that is that THE USER'S CHOICE WINS — a removal
 * or a hand-edit sticks whatever the From selector later does, because a swap that resurrects
 * a struck signature (or overwrites an edited one) is the exact surprise the block exists to
 * avoid. Three states, one discriminated union:
 *
 *   `following`   nothing said — the block shows the RESOLVED sending mailbox's stored text,
 *                 derived per render, so a From switch swaps it with no state change at all.
 *   `edited`      the user typed in the block — their text stands, on every From.
 *   `removed`     the user struck it — no block, no serialization, on every From.
 *
 * The state is held by the SURFACE that owns the message being written (the compose form's
 * fields; the shell's per-reply state; the phone sheet's own state), never globally: a removal
 * belongs to one message. A surface with no From selector (the phone's reply/forward sheet)
 * still follows the same resolution — the sending mailbox its mutation will carry.
 *
 * ── SERIALIZATION: WHAT IS SHOWN IS WHAT SHIPS ───────────────────────────────────────────
 *
 * {@link effectiveSignature} answers what the block shows, and {@link withSignature} appends
 * exactly that to the mutation — one derivation, two consumers, so a send pressed mid-edit
 * ships the block's current text and never a torn mix. The plain body gains the text after
 * one blank line; a rich body ALSO gains it as escaped markup (the server derives the
 * delivered plaintext from the markup, so both halves must carry it or a rich send would drop
 * the signature from what recipients read). Nothing is appended when the block is absent —
 * removed, empty, or the mailbox stores nothing — and then the mutation is byte-identical to
 * one built before this module existed.
 *
 * ── THE SECOND HALF: A SIGNATURE THAT CARRIES FORMATTING (0.16) ──────────────────────────
 *
 * A mailbox may also store MARKUP for its signature — `mailboxes.signature_html`, written by
 * the Settings editor, which is the compose editor's own component and therefore speaks the
 * compose editor's own small grammar (bold, italic, strike, link, lists, quote, code). That
 * column is the AUTHORITY and `mailboxes.signature` beside it is DERIVED FROM IT BY THE SERVER
 * with the same converter the drafts use, so the two halves cannot drift and every reader that
 * only ever knew about `signature` keeps working unchanged.
 *
 * {@link effectiveSignatureHtml} is the second derivation, and it answers markup in the
 * `following` state ONLY. That is not a shortcut — it is what keeps the serialization promise
 * above true once two shapes exist. `edited` holds a STRING (the block is a text field; typing
 * in it is typing plain words), so from the first keystroke the block is showing text and both
 * halves of the send must carry that text. A state in which the block rendered bold and the
 * wire carried something else is the state the split makes unrepresentable.
 *
 * A mailbox with no markup — which is every mailbox that existed before this — takes the
 * escaped-text path unchanged, and {@link withSignature}'s two-argument call is byte-identical
 * to the one it was before the third argument existed.
 *
 * On a forward, the server appends the quoted original AFTER the body it was handed
 * (`send-service.ts`: `text: d.body + fwdText`), so a signature serialized into the body sits
 * ABOVE the quoted history — the ruling's placement, structurally. A reply carries no quoted
 * history at all (the body is exactly what was typed), so the same append is trivially above
 * everything quoted: there is nothing quoted.
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
 * WHAT THE BLOCK RENDERS AS MARKUP — `null` for "there is no markup here", which is every case
 * except one: the reader has said nothing (`following`) and the resolved sending mailbox stores
 * markup for its signature.
 *
 * SEPARATE FROM {@link effectiveSignature} RATHER THAN A SECOND FIELD ON IT, because the two
 * questions have different answers and the caller needs both: the text half of the send always
 * carries `effectiveSignature`, and the html half carries this when it is non-null and the
 * escaped text otherwise. Folding them into one return would let a caller take the markup and
 * forget the text, which is the `multipart/alternative` promise broken by construction.
 *
 * Blank-after-trimming markup answers `null` for {@link effectiveSignature}'s reason: an empty
 * `<p></p>` is four characters of markup and no signature, and shipping it would put an empty
 * paragraph on the tail of every message.
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
 * The signature as markup — ONE paragraph, lines joined with `<br>`, every character escaped,
 * and the WHITESPACE the block showed preserved.
 *
 * `<br>` rather than a paragraph per line because a signature's lines are one block (name,
 * role, address) and paragraph spacing between them would render a shape the block on screen
 * does not have; a blank line in the stored text becomes two `<br>`s, which is the same
 * vertical gap the plain half's newlines carry.
 *
 * ── WHY THE NO-BREAK SPACES AND THE TAB STOPS ─────────────────────────────────────
 *
 * Ordinary paragraph text collapses leading and repeated spaces, and the server's html→text
 * derivation used to collapse them the same way — so a signature using indentation or aligned
 * columns would ship narrower than the block and the Settings preview showed it. A `style`
 * attribute cannot carry the fix: the outbound sanitizer strips every style. So the width is
 * preserved at the character level — each leading space and the second of every space pair
 * becomes a no-break space, leaving single interior spaces real so long lines still wrap —
 * and the server's converter now carries no-break spaces through to the delivered plaintext
 * as ordinary spaces at the same width (`outbound-html.ts`).
 *
 * TABS EXPAND TO 4-COLUMN STOPS — column-aware, next multiple of four, not a fixed run —
 * and the FOUR surfaces that show a signature (`.sig-text`, `.sig-rich`, the Settings editor
 * and its preview) declare `tab-size: 4`, so the stops agree for the plain ASCII text
 * signatures are made of. It was three until the block gained a rendered shape. STATED AS AN APPROXIMATION, deliberately: the column count is code units, so a
 * combining mark or a wide glyph before a tab shifts the stop, and the surfaces render a
 * proportional face in which no character-level encoding can promise pixel alignment — a
 * signature that needs true columns needs a monospaced block, which is a design decision this
 * module must not smuggle in. The PLAIN body half ships the user's raw text untransformed
 * (their tab is their character); only markup, which needs encoding anyway, expands.
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
