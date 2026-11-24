/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { message, mountMailFrame, unmountAll, waitFor } from "./_registered-mail-frame.js";

afterEach(unmountAll);

it("the phone rail names why Trash is unavailable and leaves the Ohbox in place", async () => {
  const { el, address } = await mountMailFrame("#/ohbox", [message("one")], {
    phone: true,
    prepareEngine(engine) { engine.trashAvailable = () => false; },
  });
  const view = within(el);
  fireEvent.click(view.getByRole("button", { name: "More" }));
  const trash = () => view.queryByRole("button", { name: /^Trash.*Trash is not available here/ });
  await waitFor(() => trash() !== null, "the rail names why Trash cannot open");
  expect(trash()).toHaveProperty("disabled", true);
  expect(trash()?.textContent).toContain("Trash is not available here.");
  fireEvent.click(trash()!);
  expect(address.read()).toBe("#/ohbox");
});
