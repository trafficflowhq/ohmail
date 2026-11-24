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
import { useEffect, useState } from "react";
import { typography } from "@ohmail/tokens";
import { design } from "@ohmail/tokens/design";

/** Where a marked link's address waits. Written only by the sanitizer's post-pass and the prose path's asked link. */
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

/* The design's paper face, light and dark: the page stands on the ground, the card is a sheet, the one button is solid. */
const P = design.faces.paper.light;
const PD = design.faces.paper.dark;
const ASK_PAGE_CSS = [
  ":root{color-scheme:light dark}",
  `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:${P.ground};color:${P.ink};` +
    `font:${P["t-ui"]}/1.4 ${P["f-text"]}}`,
  `main{box-sizing:border-box;width:min(480px,calc(100% - 32px));margin:24px 0;padding:32px;background:${P.sheet};` +
    `border-radius:${P["r-sheet"]}}`,
  `h1{margin:0 0 10px;font-family:${P["f-display"]};font-size:${P["t-head"]};font-weight:${P["w-display"]};` +
    `letter-spacing:${P.track};line-height:${typography.leading.tight};overflow-wrap:anywhere}`,
  `p{margin:0;color:${P.ink2}}`,
  `.url{margin:18px 0 24px;padding:10px 12px;border-radius:${P["r-row"]};background:${P["soft-sheet"]};color:${P.ink};` +
    `font:${P["t-meta"]}/1.6 ${typography.family.mono};overflow-wrap:anywhere}`,
  `a{display:inline-flex;align-items:center;gap:10px;padding:13px 24px;border-radius:${P["r-pill"]};background:${P.solid};` +
    `color:${P["on-solid"]};font-weight:${P["w-bold"]};text-decoration:none;overflow-wrap:anywhere}`,
  "a svg{flex:none;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}",
  `a:focus-visible{outline:2px solid ${P.focus};outline-offset:2px}`,
  `.stay{margin:24px 0 0;font-size:${P["t-meta"]};color:${P.ink3}}`,
  "@media (prefers-color-scheme:dark){" +
    `body{background:${PD.ground};color:${PD.ink}}main{background:${PD.sheet}}p{color:${PD.ink2}}` +
    `.url{background:${PD["soft-sheet"]};color:${PD.ink}}a{background:${PD.solid};color:${PD["on-solid"]}}` +
    `a:focus-visible{outline-color:${PD.focus}}.stay{color:${PD.ink3}}}`,
].join("");

/** The arrow on the button: a path drawn here, nothing fetched. */
const ARROW = "M5 11 11 5M6 5h5v5";

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
  add(main, "h1", {}, copy.goes(host));
  add(main, "p", {}, copy.elsewhere);
  add(main, "p", { class: "url" }, url);
  const go = add(main, "a", { href: url, rel: "noopener noreferrer" });
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ARROW);
  svg.append(path);
  go.append(svg, doc.createTextNode(copy.open(host)));
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

/** Ask pages the app's own anchors hold (the prose path): one per address, counted per holder. */
const held = new Map<string, { href: string; holders: number }>();

/**
 * The ask page a marked link of the app's own document points at, while it is mounted: one page per
 * address shared by every holder, at most {@link ASK_PAGES_MAX} at once, taken back with the last
 * holder. `null` until it is made, past the cap, or where no object URL can be made: no address.
 */
export function useAskPage(url: string, page: (url: string) => string): string | null {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const at = httpAddress(url);
    if (at === null || typeof URL.createObjectURL !== "function") return undefined;
    let had = held.get(at);
    if (had === undefined) {
      if (held.size >= ASK_PAGES_MAX) return undefined;
      had = { href: URL.createObjectURL(new Blob([page(at)], { type: "text/html;charset=utf-8" })), holders: 0 };
      held.set(at, had);
    }
    had.holders += 1;
    setHref(had.href);
    return () => {
      setHref(null);
      if (--had.holders > 0) return;
      held.delete(at);
      URL.revokeObjectURL(had.href);
    };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps -- a page is made once per address
  return href;
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
