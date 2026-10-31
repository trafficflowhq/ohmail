/**
 * THE FOLDED DOCUMENT — the sanitized, post-passed tree cut at the shared detector's range
 * (`quotedHistoryOfHtml`). Whole subtrees move out of the document that is already safe; the same
 * serializer writes what is left, so the cut can drop markup but never invent any. What the
 * folded document fetches and links is what is still in it: a folded history loads no picture
 * and reports no link.
 */
import { quotedDomTree, quotedHistoryCut, quotedHistoryReadingOfHtml, type QuotedAt, type QuotedDomNode, type QuotedVerdict } from "@ohmail/client-engine";
import type { BodyNode, RichFold } from "../shell/BodyText";

interface Blocked { url: string; via: string }

export interface SanitizedFold<B extends Blocked = Blocked> {
  at: QuotedAt;
  /** The body markup with the history cut out: before it, and after it. */
  html: string;
  blocked: B[];
  cids: string[];
  links: string[];
  /** The marked links' addresses still in it (`SanitizedMail.asks`). */
  asks: string[];
  /** The prose walk of each side of the cut, or null where the prose path renders the text part. */
  rich: RichFold | null;
}

/** Where each recorded entry was met in the post-pass. An entry met nowhere (a head sheet) stays. */
export interface MetAt {
  blocked: ReadonlyMap<string, readonly Element[]>;
  cids: ReadonlyMap<string, readonly Element[]>;
  links: ReadonlyMap<string, readonly Element[]>;
  asks: ReadonlyMap<string, readonly Element[]>;
}

/**
 * Cut `root` (mutated: it is left holding only what comes before the history) and answer the
 * folded document, or null when the body has no history to fold, with the html's verdict its text
 * part follows. `walk` is the prose walker, run only when `prose` (the whole body walked).
 */
export function foldSanitized<B extends Blocked>(root: HTMLElement, o: {
  prose: boolean;
  blocked: readonly B[];
  cids: readonly string[];
  links: readonly string[];
  asks: readonly string[];
  met: MetAt;
  walk: (holder: Element) => BodyNode[] | null;
  /** The message's subject: a forward's prefix keeps the forwarded message open. */
  subject?: string | null;
}): { historyAt: QuotedVerdict; fold: SanitizedFold<B> | null } {
  const tree = root as unknown as QuotedDomNode;
  const { range, verdict: historyAt } = quotedHistoryReadingOfHtml(tree, quotedDomTree, { subject: o.subject });
  if (range === null) return { historyAt, fold: null };
  const cut = quotedHistoryCut(tree, quotedDomTree, range);
  if (cut.history.length === 0) return { historyAt, fold: null };
  const doc = root.ownerDocument;
  const history = doc.createElement("div");
  for (const n of cut.history) history.appendChild(n as unknown as Node);
  const html = root.innerHTML;
  const kept = (els: readonly Element[] | undefined): boolean => !els || els.length === 0 || els.some((e) => root.contains(e));
  const blocked = o.blocked.filter((b) => kept(o.met.blocked.get(`${b.via}:${b.url}`)));
  const cids = o.cids.filter((c) => kept(o.met.cids.get(c)));
  const links = o.links.filter((l) => kept(o.met.links.get(l)));
  const asks = o.asks.filter((l) => kept(o.met.asks.get(l)));
  const after = doc.createElement("div");
  for (const n of cut.after) after.appendChild(n as unknown as Node);
  let rich: RichFold | null = null;
  if (o.prose) {
    const parts = [o.walk(root), o.walk(history), o.walk(after)];
    if (parts.every((p) => p !== null)) rich = { at: range.at, before: parts[0]!, history: parts[1]!, after: parts[2]! };
  }
  return { historyAt, fold: { at: range.at, html, blocked, cids, links, asks, rich } };
}
