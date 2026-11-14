/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContactCard } from "../../src/mail/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const contact = {
  open: true,
  label: "Change screening",
  closeWhenFull: "Close",
  person: { name: "A sender", address: "" },
};

function measure(height: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 375, 812),
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(height);
}

it("offers a named close when the card uses the full viewport", () => {
  measure(900);
  const onClose = vi.fn();
  render(<ContactCard {...contact} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps the fitted card's existing close behavior", () => {
  measure(340);
  render(<ContactCard {...contact} onClose={() => {}} />);
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
});
