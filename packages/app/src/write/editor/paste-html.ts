/**
 * A PASTE's MARKUP, ITS LINES AS LINES: the half of the paste rule (`paste.ts`) that reads markup from a page or another
 * program before ProseMirror parses it. Moved out of `paste.ts` as it stood.
 */

/* ── markup ───────────────────────────────────────────────────────────────────────────────── */

/** Block elements other than the two that hold lines; the schema decides what they become. */
const BLOCKS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "CAPTION",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);
/** Markup that starts inside a table: the browser's parser would drop its tags, so it is left as is. */
const TABLE_PART = /^\s*(?:<meta[^>]*>\s*)*<(?:tr|td|th|thead|tbody|tfoot|col|colgroup|caption)\b/i;

/** Do these declarations set both vertical margins to zero? `null` when they do not say. */
function zeroMargins(declarations: string): boolean | null {
  let top: string | undefined;
  let bottom: string | undefined;
  for (const d of declarations.split(";")) {
    const at = d.indexOf(":");
    if (at < 0) continue;
    const name = d.slice(0, at).trim().toLowerCase();
    const v = d
      .slice(at + 1)
      .replace(/!important/i, "")
      .trim()
      .split(/\s+/);
    if (name === "margin") [top, bottom] = [v[0], v[2] ?? v[0]];
    else if (name === "margin-top") top = v[0];
    else if (name === "margin-bottom") bottom = v[0];
  }
  const zero = (x: string): boolean => parseFloat(x) === 0;
  if ((top !== undefined && !zero(top)) || (bottom !== undefined && !zero(bottom))) return false;
  return top !== undefined && bottom !== undefined ? true : null;
}

/** The classes a style sheet in the markup gives no vertical margin (`p.MsoNormal{margin:0}`). */
function lineClasses(doc: Document): Set<string> {
  const found = new Set<string>();
  for (const sheet of Array.from(doc.querySelectorAll("style"))) {
    const css = (sheet.textContent ?? "").replace(/\/\*[\s\S]*?\*\/|<!--|-->/g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const zero = zeroMargins(rule[2]);
      for (const selector of rule[1].split(",")) {
        const cls = /^\s*(?:p)?\.([\w-]+)\s*$/i.exec(selector)?.[1];
        if (cls && zero === true) found.add(cls);
        else if (cls && zero === false) found.delete(cls);
      }
    }
  }
  return found;
}

type Item = { kind: "line" | "para" | "empty"; content: Node[] };

const blank = (n: Node): boolean => (n.textContent ?? "").replace(/[\s ]/g, "") === "";
const isBr = (n: Node): boolean => n.nodeName === "BR";
const hasBlock = (el: Element): boolean =>
  Array.from(el.querySelectorAll("*")).some((e) => BLOCKS.has(e.nodeName));

/** The nodes without their last `<br>`, which a browser never draws as a line of its own. */
function withoutTrailingBreak(nodes: Node[]): Node[] {
  let end = nodes.length;
  while (end > 0 && nodes[end - 1].nodeType === 3 && blank(nodes[end - 1])) end -= 1;
  return end > 0 && isBr(nodes[end - 1]) ? nodes.slice(0, end - 1) : nodes;
}

/** Loose inline nodes between blocks: one line, or as many empty lines as they hold `<br>`s. */
function inlineItems(nodes: Node[]): Item[] {
  const words = nodes.some((n) => !isBr(n) && n.nodeType !== 8 && !blank(n));
  if (words) return [{ kind: "line", content: withoutTrailingBreak(nodes) }];
  return nodes.filter(isBr).map(() => ({ kind: "empty", content: [] }));
}

/** A `<div>` or `<p>` holding only inline content, as an item. */
function blockItem(el: Element, lines: ReadonlySet<string>): Item {
  if (blank(el)) return { kind: "empty", content: [] };
  let content = withoutTrailingBreak(Array.from(el.childNodes));
  const style = el.getAttribute("style");
  if (style) {
    // The block's own bold or italic is a style on it; a span keeps it on the words.
    const span = el.ownerDocument.createElement("span");
    span.setAttribute("style", style);
    span.append(...content);
    content = [span];
  }
  if (el.nodeName === "DIV") return { kind: "line", content };
  const own = zeroMargins(style ?? "");
  const line = own ?? Array.from(el.classList).some((c) => lines.has(c));
  return { kind: line ? "line" : "para", content };
}

/**
 * A run of line items and paragraphs as ONE `<p>`: one break between two lines, an empty line
 * where a paragraph stood apart or an empty block stood between; empty lines at the run's edges
 * are the neighbouring blocks' own spacing and go.
 */
function joinRun(doc: Document, items: Item[]): HTMLElement | null {
  const first = items.findIndex((i) => i.kind !== "empty");
  if (first < 0) return null;
  const p = doc.createElement("p");
  let prev: Item | null = null;
  let empties = 0;
  for (const item of items.slice(first)) {
    if (item.kind === "empty") {
      empties += 1;
      continue;
    }
    if (prev) {
      const apart = prev.kind === "para" || item.kind === "para" ? 2 : 1;
      for (let i = Math.max(empties + 1, apart); i > 0; i -= 1) p.append(doc.createElement("br"));
    }
    p.append(...item.content);
    prev = item;
    empties = 0;
  }
  return p;
}

/** Rewrites `el`'s runs of lines and paragraphs, innermost first; code blocks are left whole. */
function readBlocks(el: Element, lines: ReadonlySet<string>): void {
  for (const child of Array.from(el.children)) if (child.nodeName !== "PRE") readBlocks(child, lines);
  const doc = el.ownerDocument;
  let items: Item[] = [];
  let loose: Node[] = [];
  let sources: Node[] = [];
  const endLoose = (): void => {
    items.push(...inlineItems(loose));
    loose = [];
  };
  // Only where blocks stand: the inline content of a line is never taken apart.
  const holdsBlocks = Array.from(el.children).some((c) => BLOCKS.has(c.nodeName) || hasBlock(c));
  const endRun = (before: Node | null): void => {
    endLoose();
    const rewrite = holdsBlocks && (items.length > 1 || (items.length === 1 && items[0].kind === "empty"));
    if (rewrite) {
      const p = joinRun(doc, items);
      if (p) el.insertBefore(p, before);
      for (const n of sources) if (n.parentNode === el) el.removeChild(n);
    }
    items = [];
    sources = [];
  };
  for (const node of Array.from(el.childNodes)) {
    const elem = node.nodeType === 1 ? (node as Element) : null;
    const textHolder = elem && (elem.nodeName === "DIV" || elem.nodeName === "P") && !hasBlock(elem);
    if (elem && !textHolder && (BLOCKS.has(elem.nodeName) || hasBlock(elem))) {
      endRun(node);
      continue;
    }
    sources.push(node);
    if (elem && textHolder) {
      endLoose();
      items.push(blockItem(elem, lines));
    } else loose.push(node);
  }
  endRun(null);
}

/**
 * Markup from a page or another program, its lines as lines: a `<div>` per line (Gmail, Apple
 * Mail) or a `<p>` with no vertical margin (Google Docs, Outlook, Apple's text programs) is a
 * line; any other `<p>` is a paragraph, set apart by one empty line. ProseMirror's own copies
 * (`data-pm-slice`) are the editor's structure already and pass untouched.
 */
export function htmlAsLines(html: string): string {
  if (html.includes("data-pm-slice") || TABLE_PART.test(html) || typeof DOMParser === "undefined")
    return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  readBlocks(doc.body, lineClasses(doc));
  return doc.body.innerHTML;
}
