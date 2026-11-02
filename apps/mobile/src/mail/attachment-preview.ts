/**
 * THE ATTACHMENT PREVIEW'S DOCUMENTS — pure, so the suite drives them directly. A picture or a PDF
 * is shown in a WebView of its own (`ui/AttachmentPreview.tsx`), never decoded in the app's own
 * process, which holds the session. A picture's document runs no script; a PDF's runs only the
 * scripts written here and pdf.js (each carrying the document's nonce), renders pages to canvas
 * and fetches nothing. The sender's filename and declared type never enter either document: the
 * type is one of a closed set, and the bytes are base64 checked against its alphabet.
 */

export type PreviewKind = "image" | "pdf";

const PICTURES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type PictureType = (typeof PICTURES)[number];

/** A type without its parameters, lowercased: `Image/PNG; name=a` is `image/png`. */
const bare = (type: string): string => type.split(";")[0]!.trim().toLowerCase();

/**
 * What a part previews as: both its declared type and the type the engine gave its bytes (which is
 * `application/octet-stream` for anything a browser would run as a document) must name the same
 * picture type, or both be a PDF. Everything else is shared, as before.
 */
export function previewKindOf(declared: string, blobType: string): PreviewKind | null {
  const d = bare(declared);
  if (d !== bare(blobType)) return null;
  if ((PICTURES as readonly string[]).includes(d)) return "image";
  return d === "application/pdf" ? "pdf" : null;
}

/** The picture type a document is written with, from the closed set; `null` for anything else. */
export function pictureTypeOf(declared: string): PictureType | null {
  const d = bare(declared);
  return (PICTURES as readonly string[]).includes(d) ? (d as PictureType) : null;
}

/** Whether a document of this length may be handed to a WebView on this phone (`frame-ceiling.ts`). */
export function previewFits(length: number, ceiling: number): boolean {
  return length <= ceiling;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A Content-Security-Policy from its directives, each a name and its sources. */
const csp = (directives: readonly (readonly [string, string])[]): string =>
  directives.map(([name, sources]) => `${name} ${sources}`).join("; ");

/** An opening tag: its name, then its attributes as written. */
const tag = (name: string, attrs = ""): string => `<${name}${attrs === "" ? "" : " "}${attrs}>`;

/** The CSP of a picture's document: one `data:` picture and the page's own style, nothing else. */
export const IMAGE_PREVIEW_CSP = csp([["default-src", "'none'"], ["img-src", "data:"], ["style-src", "'unsafe-inline'"]]);

/** The theme's colours the documents are drawn in (`t.c`): the window, its text, a PDF page's paper. */
export interface PreviewTheme {
  bg: string;
  ink: string;
  paper: string;
}

/** The document's head: its charset, its CSP, the phone's viewport and its style. */
const headOf = (policy: string, style: string): string =>
  tag("!doctype", "html") + tag("html") + tag("head") + tag("meta", 'charset="utf-8"')
  + tag("meta", `http-equiv="Content-Security-Policy" content="${policy}"`)
  + tag("meta", 'name="viewport" content="width=device-width,initial-scale=1"')
  + `${tag("style")}${style}</style>`;

const pageStyle = (t: PreviewTheme): string =>
  `html,body{margin:0;padding:0;background:${t.bg}}body{min-height:100vh;display:flex;align-items:center;justify-content:center}`
  + "img{display:block;max-width:100%;height:auto}";

/** A picture alone on a page, scaled to the window's width. `null` where the bytes are not base64. */
export function imagePreviewDocument(base64: string, type: string, theme: PreviewTheme): string | null {
  const picture = pictureTypeOf(type);
  if (picture === null || !BASE64.test(base64)) return null;
  return headOf(IMAGE_PREVIEW_CSP, pageStyle(theme)) + "</head>" + tag("body")
    + tag("img", `alt="" src="data:${picture};base64,${base64}"`) + "</body></html>";
}

/** The CSP of a PDF's document: scripts only by nonce, no eval, no connection, no form, no base. */
export function pdfPreviewCsp(nonce: string): string {
  return csp([
    ["default-src", "'none'"], ["script-src", `'nonce-${nonce}'`], ["style-src", "'unsafe-inline'"],
    ["img-src", "data: blob:"], ["form-action", "'none'"], ["base-uri", "'none'"],
  ]);
}

/** At most this many pages are drawn; past it the document says so. */
export const PDF_PREVIEW_MAX_PAGES = 50;
/** A page's canvas is at most this many pixels wide, and twice that tall. */
export const PDF_PREVIEW_MAX_PX = 1600;

/** The PDF page's scripts as the phone build writes them (`scripts/bundle-engine.mjs`): pdf.js's two
 *  modules, and our controller (`scripts/pdf-preview-controller.js`). */
export interface PdfScripts {
  lib: string;
  worker: string;
  controller: string;
}

/** The document's own sentences, already in the reader's language. */
export interface PdfSentences {
  /** Said when the PDF cannot be drawn here. */
  cant: string;
  /** Said under the last page drawn when the PDF has more. */
  more: string;
}

/** A fresh nonce: 128 bits from the platform's random source, or `Math.random` where it has none. */
export function previewNonce(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const pdfStyle = (t: PreviewTheme): string =>
  `html,body{margin:0;padding:0;background:${t.bg};color:${t.ink};font:16px/1.4 -apple-system,system-ui,sans-serif}`
  + `canvas{display:block;width:100%;height:auto;margin:0 0 8px;background:${t.paper}}p{margin:16px;text-align:center}`;

/**
 * A PDF drawn by pdf.js inside the document: our controller, then pdf.js's worker module (which
 * sets `globalThis.pdfjsWorker`, so pdf.js runs its worker in the page with no `Worker` and no
 * fetch), then its library. The bytes ride in the body's `data-pdf`. `null` where the bytes are not
 * base64, the nonce is not hex, or a script would end its own element.
 */
export function pdfPreviewDocument(
  base64: string, scripts: PdfScripts, said: PdfSentences, nonce: string, theme: PreviewTheme,
): string | null {
  if (!BASE64.test(base64) || !/^[0-9a-f]{16,64}$/.test(nonce)) return null;
  for (const s of [scripts.controller, scripts.lib, scripts.worker]) if (/<\/script|<!--/i.test(s)) return null;
  const script = (attrs: string, text: string) => `${tag("script", `${attrs}nonce="${nonce}"`)}${text}</script>`;
  return headOf(pdfPreviewCsp(nonce), pdfStyle(theme))
    + script("", scripts.controller)
    + script('type="module" ', scripts.worker)
    + script('type="module" ', scripts.lib)
    + "</head>"
    + tag("body", `data-pdf="${base64}" data-pages="${PDF_PREVIEW_MAX_PAGES}" data-px="${PDF_PREVIEW_MAX_PX}"`)
    + tag("div", 'id="pages"') + "</div>"
    + tag("p", 'id="more" hidden') + escapeHtml(said.more) + "</p>"
    + tag("p", 'id="cant" hidden') + escapeHtml(said.cant) + "</p>"
    + "</body></html>";
}
