/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BESIDE, modelOf, mountPlace, sender } from "../../../packages/app/test/screener/screener-world";
import en from "../messages/en.json";

afterEach(cleanup);

describe("a door that never says its copy is behind (controls)", () => {
  it("the direct door, mail owed: withheld as before", () => {
    const model = modelOf({ flushes: 0 }, {
      copyBehind: false,
      screenedOut: Array.from({ length: 35 }, (_, i) => sender(`screened-${i}`, "Screened sender")),
      spam: Array.from({ length: 212 }, (_, i) => ({
        sender: sender(`spam-${i}`, "Spam sender"),
        pinned: false,
      })),
    });
    mountPlace(model, {
      beside: { ...BESIDE, facts: { ...BESIDE.facts, owed: true, storeImportOpen: true } },
    });
    const sections = within(screen.getByRole("group", { name: en.screener.segAria }));
    const badges = [en.screener.segWaiting, en.screener.segScreened, en.screener.segSpam].map((label) =>
      sections.getByRole("button", { name: new RegExp(`^${label}(?: [0-9]+)?$`) })
        .getAttribute("aria-label")?.slice(label.length).trim() ?? "",
    );
    expect(badges).toEqual(["", "", ""]);
  });
});
