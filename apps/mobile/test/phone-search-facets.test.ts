import { describe, expect, it } from "vitest";
import { matchesSearchFacets, phoneSearchQuestion } from "../src/state/search-facets";

const row = {
  from: { name: null, address: "atelier@example.test" }, to: [], cc: [{ name: null, address: "mila@example.test" }],
  folder: "ohmail/News" as const, unread: true, hasAttachments: true, date: "2026-11-14T10:00:00.000Z",
};

describe("the phone's facets ask both search doors", () => {
  it("a filter-only question uses the existing archive options", () => {
    const filters = { unread: true, folder: "ohmail/News", to: "mila@example.test" };
    expect(phoneSearchQuestion("", filters, "date_asc")).toEqual({ query: "", filters, sort: "date_asc" });
  });

  it("the first paint uses the same combination and includes Cc", () => {
    const filters = { sender: "ATELIER@example.test", to: "mila@example.test", hasAttachments: true, unread: true, folder: "ohmail/News" };
    expect(matchesSearchFacets(row, filters)).toBe(true);
    expect(matchesSearchFacets({ ...row, cc: [] }, filters)).toBe(false);
    expect(matchesSearchFacets({ ...row, unread: false }, filters)).toBe(false);
    expect(matchesSearchFacets({ ...row, folder: "INBOX" }, filters)).toBe(false);
    expect(matchesSearchFacets({ ...row, hasAttachments: false }, filters)).toBe(false);
  });

  it("date boundaries are inclusive and undated letters yield to them", () => {
    const bound = { dateFrom: row.date, dateTo: row.date };
    expect(matchesSearchFacets(row, bound)).toBe(true);
    expect(matchesSearchFacets({ ...row, date: null }, bound)).toBe(false);
    expect(matchesSearchFacets({ ...row, date: "2026-11-14T10:00:00.001Z" }, bound)).toBe(false);
    expect(phoneSearchQuestion("a", {}, "relevance")).toBeNull();
  });
});
