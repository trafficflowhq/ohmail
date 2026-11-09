/**
 * The document the reader's frame loads — the sanitized body wrapped in the app's own head.
 * The CSP meta is the frame's second layer (the first is the sanitizer, the third is JS being
 * off at the engine level): nothing may fetch, images may only be `data:` (cid parts and
 * consented remote images are minted to `data:` before they enter the document), styles are
 * the sender's own inline ones. The base styles carry the app's typography so a letter that
 * brings no design of its own reads in the app's voice, and bound every image and table to the
 * pane width. `:root,:root>body{height:auto !important}` is the web frame's measurement rule: the
 * frame is sized to its document, so a sender's `body{height:100%}` may not pin it to the frame.
 *
 * A LETTER IS SET ON A LIGHT SHEET IN BOTH SCHEMES, as on the web: a sender's html assumes a light
 * page (`color:#333` and no background), so a dark reader never re-tints the paper under it. It
 * inverts the letter as a whole instead (`invert`), and turns the pictures back.
 *
 * The scale is pinned at 1 (`minimum-scale=1`): a WebView that shrank a wide page to fit would report its
 * height in units the frame does not draw in. A letter wider than its frame is zoomed by `fit` instead
 * (`src/mail/frame-height.ts`).
 */

export interface MailDocumentTheme {
  /** The sheet's paper — the light palette's panel (or the mail's own dark paper), never the dark canvas. */
  bg: string;
  ink: string;
  ink2: string;
  accent: string;
  /** Device font scale; the document text follows the reader's setting like every screen. */
  fontScale: number;
  /** Dark viewing of a light letter: `paper` is what the inversion turns into `canvas`, the sheet. */
  invert?: { paper: string; canvas: string } | null;
  /** The letter laid out at its own width and zoomed to the frame's (below 1), or as written (1, unset). */
  fit?: number;
}

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
const FLIP = "invert(1) hue-rotate(180deg)";

/**
 * The one place the frame's html is assembled; `MailBodyFrame` renders nothing else. ONE
 * template on purpose: the copy census reads it as one markup string, licensed by name in
 * `copy-census.test.ts` (`NAMED_LINES`) — html scaffolding, not a sentence anybody reads.
 */
export function buildPhoneMailDocument(bodyHtml: string, t: MailDocumentTheme): string {
  const px = (n: number) => `${Math.round(n * t.fontScale * 10) / 10}px`;
  // A filtered body's background is not the canvas's, so `:root` carries the sheet's own colour.
  const zoom = t.fit !== undefined && t.fit < 1 ? Math.floor(t.fit * 10_000) / 10_000 : 0;
  // !important: a sender's own `body{zoom}` comes later in the cascade.
  const fit = zoom > 0 ? `body{zoom:${zoom} !important}` : "";
  const dark = t.invert ? `body{background:${t.invert.paper};filter:${FLIP}}:root{background:${t.invert.canvas}}img,video,picture,[style*="url(" i]{filter:${FLIP}}` : "";
  return `<!doctype html><html><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="${CSP}"/><meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1"/><style>:root{color-scheme:light}:root,:root>body{height:auto !important}body{margin:0;padding:14px 16px 20px;background:${t.bg};color:${t.ink};font:400 ${px(16.5)}/1.78 -apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;overflow-wrap:break-word;word-break:break-word}a{color:${t.accent}}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}td,th{word-break:normal}blockquote{margin:0 0 0 2px;padding-left:14px;border-left:2px solid ${t.ink2}}pre{white-space:pre-wrap}${fit}${dark}</style></head><body>${bodyHtml}</body></html>`;
}
