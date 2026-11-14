/** @vitest-environment jsdom */
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FOLDERS_ON, listSeat } from "../places/list-seat.js";
import { letter } from "../reader/support/mail.js";

afterEach(cleanup);

it("names the full folder in History while still listing the letter in its folder", async () => {
  const path = "Projects/Acme";
  const item = letter("old-letter", {
    subject: "Studio order",
    unread: false,
    folder: path as ReturnType<typeof letter>["folder"],
  });
  const { address } = listSeat({
    first: "#/history",
    consent: FOLDERS_ON,
    letters: [item],
    more: { "folder:projects": { id: "projects", name: path, mailboxId: item.mailboxId } },
  });
  const row = screen.getByRole("option", { name: /Studio order/ });
  expect(row.textContent?.includes(path)).toBe(true);
  await screen.findByRole("button", { name: "Folders" });
  act(() => address.visit("#/folder/projects"));
  expect(
    within(await screen.findByRole("listbox", { name: "Earlier" })).getByRole("option", {
      name: /Studio order/,
    }),
  ).toBeTruthy();
});
