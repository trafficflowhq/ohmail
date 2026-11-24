/** @vitest-environment jsdom */
/**
 * A FIELD OF A DATE, A TIME OR A NUMBER TAKES ITS LEAST AND ITS LAST: Send
 * later's day offers no day before today nor past what the server keeps files for; the browser's own picker is told
 * so, and a field that is handed neither stays open as before.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Field } from "../../src/base/index.js";

afterEach(cleanup);

describe("a field's least and last", () => {
  it("a day field hands its least and its last day to the browser's own picker", () => {
    render(
      <Field
        label="Day"
        type="date"
        value="2026-11-18"
        min="2026-11-18"
        max="2026-11-19"
        onChange={() => {}}
      />,
    );
    const day = screen.getByLabelText("Day");
    expect([day.getAttribute("min"), day.getAttribute("max")]).toEqual(["2026-11-18", "2026-11-19"]);
  });

  it("a number field likewise", () => {
    render(<Field label="Days" type="number" value="3" min="1" max="30" onChange={() => {}} />);
    const days = screen.getByLabelText("Days");
    expect([days.getAttribute("min"), days.getAttribute("max")]).toEqual(["1", "30"]);
  });

  it("a field handed neither has neither", () => {
    render(<Field label="Day" type="date" value="2026-11-18" onChange={() => {}} />);
    const day = screen.getByLabelText("Day");
    expect([day.hasAttribute("min"), day.hasAttribute("max")]).toEqual([false, false]);
  });
});
