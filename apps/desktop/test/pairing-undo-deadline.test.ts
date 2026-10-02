import { describe, expect, it } from "vitest";

import { SIGN_OUT_AT_HOST_MS } from "../../sidecar/src/pair-undo.js";
import { AT_HOST_WAIT_MS } from "../src/bridge-fetch.js";

/**
 * ONE DEADLINE, AND THE WINDOW WAITS PAST IT. The engine's `DELETE /cloud/session` — a sign-out, or
 * an undone pairing — spends at most `SIGN_OUT_AT_HOST_MS` at the server, every segment together;
 * the window gives the whole request `AT_HOST_WAIT_MS`. A window bound at or under the engine's would
 * cut the answer off mid-sign-out, so the sentence could not be chosen.
 */
describe("the sign-out's two bounds", () => {
  it("the window's is longer than the engine's", () => {
    expect(SIGN_OUT_AT_HOST_MS).toBeGreaterThan(0);
    expect(AT_HOST_WAIT_MS).toBeGreaterThan(SIGN_OUT_AT_HOST_MS);
  });
});
