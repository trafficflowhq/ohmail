/**
 * Where a search document's body words came from (mail 0125's `message_search.source`): the
 * stored text part, text rendered from the stored html (a message with no text part), or none.
 * The ONE definition — the CHECK, the writer's type and the closed-set census read it.
 */
export const SEARCH_SOURCES = ["text", "html", "headers_only"] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

export function isSearchSource(v: unknown): v is SearchSource {
  return typeof v === "string" && (SEARCH_SOURCES as readonly string[]).includes(v);
}
