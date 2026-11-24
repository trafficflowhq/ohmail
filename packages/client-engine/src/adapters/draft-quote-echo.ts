import { hasEditedQuotedHistory, QUOTED_HISTORY_ATTRIBUTE } from "@trafficflow/core/outbound-text";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { MutationRejectedError } from "../types.js";

type Child = DefaultTreeAdapterTypes.ChildNode;

/** Compare the marked quote in parsed HTML, independently of entity and void-tag spelling. */
function canonicalQuote(html: string): string {
  const quotes: unknown[] = [];
  function visit(node: Child, withinQuote: boolean): unknown {
    if ("value" in node) return node.value;
    if (!("tagName" in node)) return undefined;
    const marked = node.tagName === "blockquote" &&
      node.attrs.some((attr) => attr.name === QUOTED_HISTORY_ATTRIBUTE && attr.value === "edited");
    const children = node.childNodes.map((child) => visit(child, withinQuote || marked))
      .filter((child) => child !== undefined);
    const href = node.tagName === "a" ? node.attrs.find((attr) => attr.name === "href")?.value : undefined;
    const shape = [node.tagName, marked, href, children];
    if (marked && !withinQuote) quotes.push(shape);
    return withinQuote ? shape : undefined;
  }
  for (const node of parseFragment(html).childNodes) visit(node, false);
  return JSON.stringify(quotes);
}

export function requireDraftQuoteEcho(written: unknown, echoed: unknown, row: string): void {
  if (typeof written !== "string" || !hasEditedQuotedHistory(written)) return;
  if (typeof echoed === "string" && hasEditedQuotedHistory(echoed) && canonicalQuote(written) === canonicalQuote(echoed)) return;
  throw new MutationRejectedError(
    "The server did not save the edited quoted history.",
    { code: "draft_unsaved", retryable: false, entityId: row },
  );
}
