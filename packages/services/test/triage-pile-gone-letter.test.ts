import { describe, it } from "vitest";
import { makeCtx } from "./helpers.js";
import { expungeLeavesThePile } from "./_pile-gone-letter.js";

/**
 * An expunged letter leaves Answer Later on the embedded stores: PGlite here, the device's SQLite
 * through `test/vitest.sqlite.config.ts`. The real-Postgres twin is `triage-pile-gone-letter.pg.test.ts`.
 * Mutation watched: dropping `isNull(messages.deletedAt)` from `listByState` reddens all three.
 */
describe("a letter expunged on the server leaves its pile (embedded store)", () => {
  it("the reaper's tombstone takes it out of Answer Later and Reply Run; its return files it again", async () => {
    const w = await makeCtx(new Date("2026-10-12T02:00:00Z"));
    await expungeLeavesThePile(w.db, w.ctx, w.mailboxId);
  });
});
