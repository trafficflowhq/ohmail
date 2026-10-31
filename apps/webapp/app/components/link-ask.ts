/**
 * THE ASK BEFORE A MARKED LINK OPENS, ON THE WEB — outside the letter, where its styles cannot reach.
 * The sanitizer marks a link whose label names another site (`markElsewhere` in `MessageBody.tsx`);
 * on a page that asks in a tab of its own its address waits in {@link ASK_ATTR} and its `href` is
 * gone, so a press before the frame is armed opens nothing. Once the frame has loaded,
 * {@link armAsks} points each such link at a page this window builds: the press opens it in a new
 * tab under the frame's sandbox, and it names the real host and holds the one link that goes there.
 * Attributes only: the frame runs no script and carries no listener. The desktop asks in its own
 * window instead (`link_ask_open` in `engine.rs`).
 */
import { color, radius, shadow, typography } from "@ohmail/tokens";

/** Where a marked link's address waits. Written only by the sanitizer's post-pass. */
export const ASK_ATTR = "data-ohmail-ask";

/** Ask pages kept per frame, one per address; a marked link past them keeps no address. */
export const ASK_PAGES_MAX = 256;

/** The ask page's sentences, in the reader's language. */
export interface AskCopy {
  lang: string;
  title: string;
  elsewhere: string;
  goes: (host: string) => string;
  open: (host: string) => string;
  stay: string;
}

/** The page loads nothing, runs nothing and submits nothing. */
const ASK_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const L = color.light;
const D = color.dark;
const ASK_PAGE_CSS = [
  ":root{color-scheme:light dark}",
  `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:${L.canvas};color:${L.ink};` +
    `font:${typography.size.prose}/1.55 ${typography.family.ui}}`,
  `main{box-sizing:border-box;width:min(440px,calc(100% - 32px));margin:24px 0;padding:28px 26px 24px;background:${L.float};` +
    `border-radius:${radius.card};box-shadow:${shadow.light.lift2}}`,
  `h1{margin:0 0 10px;font-size:${typography.size.h1Mobile};font-weight:${typography.weight.bold};` +
    `letter-spacing:${typography.tracking.display};line-height:${typography.leading.tight}}`,
  `p{margin:0 0 8px;color:${L.ink2}}`,
  `.url{margin:14px 0 18px;padding:8px 10px;border-radius:${radius.keycap};background:${L.tint2};color:${L.ink};` +
    `font:${typography.size.control}/1.5 ${typography.family.mono};overflow-wrap:anywhere}`,
  `a{display:inline-block;padding:9px 18px;border-radius:${radius.pill};background:${L.accent};color:${L.onAccent};` +
    `font-weight:${typography.weight.semibold};text-decoration:none;overflow-wrap:anywhere}`,
  `a:focus-visible{outline:2px solid ${L.accentHair};outline-offset:2px}`,
  `.stay{margin:16px 0 0;font-size:${typography.size.body};color:${L.ink3}}`,
  "@media (prefers-color-scheme:dark){" +
    `body{background:${D.canvas};color:${D.ink}}main{background:${D.float};box-shadow:${shadow.dark.lift2}}p{color:${D.ink2}}` +
    `.url{background:${D.tint2};color:${D.ink}}a{background:${D.accent};color:${D.onAccent}}` +
    `a:focus-visible{outline-color:${D.accentHair}}.stay{color:${D.ink3}}}`,
].join("");

/**
 * The page that asks about one address. Built as elements and serialised, never joined from
 * strings: the address is only ever text and one attribute value. It names the real host
 * (`URL.hostname`, ASCII), never the one the label named.
 */
export function askPage(url: string, copy: AskCopy): string {
  const host = new URL(url).hostname;
  const doc = document.implementation.createHTMLDocument(copy.title);
  doc.documentElement.setAttribute("lang", copy.lang);
  const add = <K extends keyof HTMLElementTagNameMap>(
    parent: Element, tag: K, attrs: Record<string, string> = {}, text?: string,
  ): HTMLElementTagNameMap[K] => {
    const el = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    if (text !== undefined) el.textContent = text;
    parent.append(el);
    return el;
  };
  const head = doc.head;
  const title = head.querySelector("title");
  add(head, "meta", { charset: "utf-8" });
  add(head, "meta", { "http-equiv": "Content-Security-Policy", content: ASK_PAGE_CSP });
  add(head, "meta", { name: "referrer", content: "no-referrer" });
  add(head, "meta", { name: "viewport", content: "width=device-width,initial-scale=1" });
  // The browser asks for a favicon otherwise; this one is already here.
  add(head, "link", { rel: "icon", href: "data:," });
  if (title) head.append(title);
  add(head, "style", {}, ASK_PAGE_CSS);
  const main = add(doc.body, "main");
  add(main, "h1", {}, copy.title);
  add(main, "p", {}, copy.elsewhere);
  add(main, "p", {}, copy.goes(host));
  add(main, "p", { class: "url" }, url);
  add(main, "a", { href: url, rel: "noopener noreferrer" }, copy.open(host));
  add(main, "p", { class: "stay" }, copy.stay);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/**
 * Point every marked link of a loaded frame that has no address at the page {@link askPage} builds
 * for its own, one page per address and at most {@link ASK_PAGES_MAX}. The address is checked
 * again here. Answers what takes the pages back, for the next document and the unmount.
 */
export function armAsks(doc: Document | null | undefined, page: (url: string) => string): () => void {
  const made = new Map<string, string>();
  // Where the page can make no object URL (a test document), the links keep no address.
  if (typeof URL.createObjectURL !== "function") return () => {};
  for (const a of doc?.querySelectorAll(`a[${ASK_ATTR}]:not([href])`) ?? []) {
    const url = httpAddress(a.getAttribute(ASK_ATTR) ?? "");
    if (url === null) continue;
    let blob = made.get(url);
    if (blob === undefined) {
      if (made.size >= ASK_PAGES_MAX) continue;
      blob = URL.createObjectURL(new Blob([page(url)], { type: "text/html;charset=utf-8" }));
      made.set(url, blob);
    }
    a.setAttribute("href", blob);
  }
  return () => {
    for (const blob of made.values()) URL.revokeObjectURL(blob);
    made.clear();
  };
}

/** `URL.href` of an absolute http(s) address, else null: the rule `linkHref` reports links by. */
function httpAddress(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
