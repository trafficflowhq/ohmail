/**
 * The document the reader's frame loads — the sanitized body wrapped in the app's own head.
 * The CSP meta is the frame's second layer (the first is the sanitizer, the third is JS being
 * off at the engine level): nothing may fetch, images may only be `data:` (cid parts and
 * consented remote images are minted to `data:` before they enter the document), styles are
 * the sender's own inline ones. The base styles carry the app's typography so a letter that
 * brings no design of its own reads in the app's voice, and bound every image and table to the
 * pane width — "at stored size, bounded to the pane" is `max-width:100%` on a device screen.
 */

export interface MailDocumentTheme {
  /** The pane background — the theme's own, so the frame never flashes white in the dark. */
  bg: string;
  ink: string;
  ink2: string;
  accent: string;
  /** Device font scale; the document text follows the reader's setting like every screen. */
  fontScale: number;
}

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/**
 * The frame's height, ESTIMATED — with JavaScript off (the security ruling) the document
 * cannot report its own height, so the frame gets a content-derived guess and scrolls
 * internally past it. Wrong in both directions by design: a short mail gets a short frame, a
 * long one fills most of the window and scrolls. A stated trade, not an oversight: the
 * alternative — a measuring script inside the document — costs the JS-off posture.
 */
export function frameHeightEstimate(bodyHtml: string, windowHeight: number): number {
  const text = bodyHtml.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]*>/g, "");
  const images = (bodyHtml.match(/<img/gi) ?? []).length;
  const estimate = 120 + Math.ceil(text.length / 38) * 30 + Math.min(images, 6) * 200;
  const ceiling = Math.max(320, Math.round(windowHeight * 0.72));
  return Math.min(Math.max(220, estimate), ceiling);
}

/**
 * The one place the frame's html is assembled; `MailBodyFrame` renders nothing else. ONE
 * template on purpose: the copy census reads it as one markup string, licensed by name in
 * `copy-census.test.ts` (`NAMED_LINES`) — html scaffolding, not a sentence anybody reads.
 */
export function buildPhoneMailDocument(bodyHtml: string, t: MailDocumentTheme): string {
  const px = (n: number) => `${Math.round(n * t.fontScale * 10) / 10}px`;
  return `<!doctype html><html><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="${CSP}"/><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/><style>:root{color-scheme:light dark}body{margin:0;padding:14px 20px 20px;background:${t.bg};color:${t.ink};font:400 ${px(16.5)}/1.78 -apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;overflow-wrap:break-word;word-break:break-word}a{color:${t.accent}}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}blockquote{margin:0 0 0 2px;padding-left:14px;border-left:2px solid ${t.ink2}}pre{white-space:pre-wrap}</style></head><body>${bodyHtml}</body></html>`;
}
