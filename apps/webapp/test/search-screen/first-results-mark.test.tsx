/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginSearch, resetUiVitalsForTest, takeUiVitals } from "@ohmail/app-logic/session/ui-vitals";
import { letter, page, search, settle, wideWindow } from "./search-world.js";

/**
 * THE FIRST-RESULTS MARK, ONCE PER QUESTION: a search begun is ended by the device's first answer on screen, and
 * recorded once; the store's later page, and the keys typed after it, record nothing more until the next begins.
 */
const GLAZE = letter({ id: "glaze", subject: "Glaze order 2291" });
const type = async (q: string) => {
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: q } });
  });
};

beforeEach(() => {
  wideWindow();
  resetUiVitalsForTest();
});
afterEach(() => cleanup());

describe("the first-results mark", () => {
  it("is ended once by the first results on screen, never again by the store's page or later keys", async () => {
    await search([GLAZE], { store: page([GLAZE]) });
    beginSearch();
    await type("gla");
    await settle(50);
    await type("glaze");
    await settle();
    expect(takeUiVitals().searchCount).toBe(1);
  });

  it("records nothing where no search was begun", async () => {
    await search([GLAZE], { store: page([GLAZE]) });
    await type("glaze");
    await settle();
    expect(takeUiVitals().searchCount).toBe(0);
  });
});
