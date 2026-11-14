import { describe, expect, it } from "vitest";
import { firstImportsOf } from "@ohmail/app-logic/press/consent-options";

/**
 * THE STAMP THE SCREENER DATES A HELD CLAIM AGAINST (REVIEW-026 LOW 4). A Cloud-paired desktop's row
 * carries the ACCOUNT's first-import stamp beside its mirror's own first pull; the server dates a Cloud
 * claim by the account's, so the shell reads that one first. Every other door sends only its own.
 */
describe("firstImportsOf", () => {
  it("reads the account's stamp where the row carries one, the row's own otherwise", () => {
    expect(firstImportsOf([
      { id: "paired", initialImportCompletedAt: "2026-10-09T09:00:00.000Z", hostedImportCompletedAt: "2026-09-29T09:00:00.000Z" },
      { id: "paired-importing", initialImportCompletedAt: "2026-10-09T09:00:00.000Z", hostedImportCompletedAt: null },
      { id: "own-door", initialImportCompletedAt: "2026-10-01T09:00:00.000Z" },
      { id: "older-server" },
    ])).toEqual({
      "paired": "2026-09-29T09:00:00.000Z", "paired-importing": null, "own-door": "2026-10-01T09:00:00.000Z",
    });
    expect(firstImportsOf(null)).toBeUndefined();
  });
});
