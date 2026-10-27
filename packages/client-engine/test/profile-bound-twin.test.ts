import { describe, expect, it } from "vitest";
import { PROFILE_APPLIED_MAX as CORE_APPLIED_MAX, PROFILE_LIST_MAX } from "@trafficflow/core/adapters/organizer-profile";
import { PROFILE_APPLIED_MAX, PROFILE_RULES_SENT_MAX } from "../src/index.js";

/** The client's copy of the settings document's rule bound is the serializer's own. */
describe("the rules bound a client states", () => {
  it("is the one the settings document is written under", () => {
    expect(PROFILE_RULES_SENT_MAX).toBe(PROFILE_LIST_MAX.rules);
    expect(PROFILE_APPLIED_MAX).toBe(CORE_APPLIED_MAX);
  });
});
