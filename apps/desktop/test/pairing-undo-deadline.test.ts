import { describe, expect, it } from "vitest";

import { PAIR_UNDO_REVOKE_MS } from "../../sidecar/src/pair-undo.js";
import { UNDO_AT_HOST_MS } from "../src/doors.js";

/**
 * ONE DEADLINE, AND THE WINDOW WAITS PAST IT. The engine's undo (`DELETE /cloud/session?revoke=host`)
 * spends at most `PAIR_UNDO_REVOKE_MS` on the other computer, both its segments together; the
 * window gives the whole request `UNDO_AT_HOST_MS`. A window bound at or under the engine's would
 * cut the answer off and restore the door mid-sign-out, so the sentence could not be chosen.
 */
describe("the undo's two bounds", () => {
  it("the window's is longer than the engine's", () => {
    expect(PAIR_UNDO_REVOKE_MS).toBeGreaterThan(0);
    expect(UNDO_AT_HOST_MS).toBeGreaterThan(PAIR_UNDO_REVOKE_MS);
  });
});
