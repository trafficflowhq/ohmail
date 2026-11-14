/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { modelOf, mountPlace, sender } from "./screener-world.js";

afterEach(cleanup);

it("says claims-only filing writes no rule and omits the generic rule line", () => {
  const waiting = sender("list", "List sender", {
    checked: {
      reason: "impersonation",
      brand: "Example Brand",
      domain: "list.example",
      domainShared: false,
      claimsOnly: true,
    },
  });
  mountPlace(modelOf({ flushes: 0 }, { waiting: [waiting], waitingCount: 1 }));
  const reading = within(screen.getByRole("region", { name: "Reading" }));
  expect(reading.getByText(/only the messages that claim to be Example Brand.*make no rule/)).toBeTruthy();
  expect(reading.queryByText(/Becomes a rule/)).toBeNull();
});
