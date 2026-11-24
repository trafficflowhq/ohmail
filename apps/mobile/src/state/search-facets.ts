import type { EngineMessage } from "@ohmail/wire";
import type { ServerSearchOpts } from "./live";

export type SearchFilters = NonNullable<ServerSearchOpts["filters"]>;
export type SearchOrder = NonNullable<ServerSearchOpts["sort"]>;
type SearchRow = Pick<EngineMessage, "from" | "to" | "cc" | "folder" | "unread" | "hasAttachments" | "date">;

export function matchesSearchFacets(message: SearchRow, filters: SearchFilters): boolean {
  const sameAddress = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
  if (filters.sender && !sameAddress(message.from?.address, filters.sender)) return false;
  if (filters.to && ![...message.to, ...message.cc].some((person) => sameAddress(person.address, filters.to!))) return false;
  if (filters.folder && message.folder !== filters.folder) return false;
  if (filters.unread !== undefined && message.unread !== filters.unread) return false;
  if (filters.hasAttachments !== undefined && message.hasAttachments !== filters.hasAttachments) return false;
  if (filters.dateFrom || filters.dateTo) {
    const date = Date.parse(message.date ?? "");
    if (!Number.isFinite(date)) return false;
    if (filters.dateFrom && date < Date.parse(filters.dateFrom)) return false;
    if (filters.dateTo && date > Date.parse(filters.dateTo)) return false;
  }
  return true;
}

export function phoneSearchQuestion(query: string, filters: SearchFilters, sort: SearchOrder) {
  const asked = query.trim();
  const narrowed = Object.values(filters).some((value) => value !== undefined);
  if (asked.length < 2 && (asked.length !== 0 || !narrowed)) return null;
  return { query: asked, ...(narrowed ? { filters } : {}), ...(sort === "relevance" ? {} : { sort }) };
}

export function compareSearchRows(order: SearchOrder) {
  return (a: EngineMessage, b: EngineMessage): number => {
    if (order === "mailbox") return a.mailboxId.localeCompare(b.mailboxId);
    if (order === "sender") return (a.from?.name || a.from?.address || "").localeCompare(b.from?.name || b.from?.address || "");
    const date = (b.sortAt ?? b.date ?? "").localeCompare(a.sortAt ?? a.date ?? "");
    return order === "date_asc" ? -date : date;
  };
}
