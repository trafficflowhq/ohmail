/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { modelOf, mountPlace } from "../../../packages/app/test/screener/screener-world";
import messages from "../../../packages/app/messages/screener.en.json";

afterEach(cleanup);

describe("Screener zero-state renders once, not once per pane", () => {
  it("an empty Spam segment shows exactly one empty state", () => {
    const { view } = mountPlace(modelOf({ flushes: 0 }), { at: "#/screener/spam" });
    expect(view.getAllByText((_, node) => node?.textContent === messages.screener.place.empty.spam, { selector: "p" })).toHaveLength(1);
  });

  it("an empty Screened out segment shows exactly one empty state", () => {
    const { view } = mountPlace(modelOf({ flushes: 0 }), { at: "#/screener/screened" });
    expect(view.getAllByText((_, node) => node?.textContent === messages.screener.place.empty.screened, { selector: "p" })).toHaveLength(1);
  });
});
