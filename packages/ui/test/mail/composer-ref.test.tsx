/** @vitest-environment jsdom */
/**
 * THE COMPOSER HANDS ITS SHEET (the switch's point 70): the app finds a field of the letter, or brings the
 * sheet into view, through the sheet the part hands it, never by a search of the whole page.
 */
import { createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Composer } from "../../src/mail/index.js";

afterEach(cleanup);

describe("the composer's sheet", () => {
  it("is handed to the ref it is given: the sheet the person sees, by its name", () => {
    const sheet = createRef<HTMLElement>();
    render(
      <Composer
        ref={sheet}
        label="Reply to Giulia"
        head={<input aria-label="To" />}
        foot={{ label: "Send or discard" }}
      >
        <p>Thursday works</p>
      </Composer>,
    );
    expect(sheet.current).toBe(screen.getByRole("region", { name: "Reply to Giulia" }));
    expect(sheet.current?.querySelector('[aria-label="To"]')).toBe(
      screen.getByRole("textbox", { name: "To" }),
    );
  });
});
