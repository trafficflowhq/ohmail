import { describe, expect, it } from "vitest";
import { IMPORT_OPEN_MAX_MS } from "../packages/services/src/search-coverage.js";
import { IMPORT_FLOOR_MAX_MS } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ONE NUMBER FOR AN UNWRITTEN FIRST-IMPORT STAMP (SEARCH-SCOPE-READS-AN-UNSTAMPED-IMPORT-AS-OPEN).
 * The sync line reads a mailbox with no stamp as importing for this long after it was connected;
 * search reads it for this long after the later of the connect and the import's last progress
 * (`sync_progress_at`). The ANCHORS differ until SYNC-LINE-IMPORT-FLOOR-IGNORES-THE-PROGRESS-CLOCK
 * closes; the number is one. Two constants by necessity (the rail ships in a client bundle that may
 * not import a server package); a repository test because neither workspace may import the other.
 */
describe("the sync line and search read an unwritten import stamp by one window", () => {
  it("the search coverage window is the sync line's import floor", () => {
    expect(IMPORT_OPEN_MAX_MS).toBe(IMPORT_FLOOR_MAX_MS);
    expect(IMPORT_OPEN_MAX_MS, "a day, the floor's own bound").toBe(86_400_000);
  });
});
