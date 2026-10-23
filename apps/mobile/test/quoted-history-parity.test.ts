/** @vitest-environment jsdom */
/**
 * ONE READING ON BOTH DOORS: the shared detector over the phone's htmlparser2 parse (`quoted-tree.ts`)
 * and over the web's DOM (`quotedDomTree`) must start and end every fixture's history at the same
 * place — the same count of visible characters before the start node and before the end node.
 */
import { describe, expect, it } from "vitest";
import { parseDocument } from "htmlparser2";
import { Element, type AnyNode } from "domhandler";
import { quotedDomTree, quotedHistoryOfHtml, type QuotedDomNode, type QuotedTree } from "@ohmail/client-engine";
import { phoneQuotedTree } from "../src/mail/quoted-tree";
import { qhFixtures } from "../../../packages/client-engine/test/quoted-history-fixtures";

const SKIP = new Set(["style", "script", "head", "title", "template", "noscript", "svg", "math", "xml"]);

/** Visible characters before `target` in document order (-1: the body's end). */
function offsetOf<N>(root: N, tree: QuotedTree<N>, target: N | null): number {
  if (target === null) return -1;
  let n = 0;
  let found = -1;
  const walk = (node: N): boolean => {
    if (node === target) { found = n; return true; }
    const kind = tree.kind(node);
    if (kind === "text") { n += tree.text(node).replace(/[\s ]+/g, "").length; return false; }
    if (kind !== "element" || SKIP.has(tree.tag(node).toLowerCase())) return false;
    for (const c of tree.children(node)) if (walk(c)) return true;
    return false;
  };
  for (const c of tree.children(root)) if (walk(c)) break;
  return found;
}

function phoneBody(html: string): AnyNode {
  const doc = parseDocument(html, { lowerCaseTags: true, lowerCaseAttributeNames: true });
  const find = (nodes: readonly AnyNode[]): Element | null => {
    for (const n of nodes) {
      if (!(n instanceof Element)) continue;
      if (n.tagName === "body") return n;
      if (n.tagName === "html") { const b = find(n.children); if (b) return b; }
    }
    return null;
  };
  return find(doc.children) ?? doc;
}

describe("the phone's tree and the DOM agree on every fixture", () => {
  for (const fx of qhFixtures()) {
    if (fx.html === null) continue;
    it(fx.name, () => {
      const web = new DOMParser().parseFromString(fx.html!, "text/html").body as unknown as QuotedDomNode;
      const phone = phoneBody(fx.html!);
      const a = quotedHistoryOfHtml(web, quotedDomTree);
      const b = quotedHistoryOfHtml(phone, phoneQuotedTree);
      expect(b === null, "both fold, or neither").toBe(a === null);
      if (a === null || b === null) return;
      expect(b.at).toBe(a.at);
      expect(offsetOf(phone, phoneQuotedTree, b.start), "the start").toBe(offsetOf(web, quotedDomTree, a.start));
      expect(offsetOf(phone, phoneQuotedTree, b.end), "the end").toBe(offsetOf(web, quotedDomTree, a.end));
    });
  }
});

describe("the phone's tree reads a hostile body in one linear pass", () => {
  it("4,000 container runs between label lines", { timeout: 4000 }, () => {
    const html = `<p>Hello there, a short note.</p>${'<div id="mail-editor-reference-message-container">From: a1:</div><div>From: a1:</div>'.repeat(4000)}`;
    const phone = phoneBody(html);
    const t0 = Date.now();
    quotedHistoryOfHtml(phone, phoneQuotedTree);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
