/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { issue, mountStreamFrame } from "./registered-world.js";

afterEach(cleanup);

it("puts the filing suggestion between News rows without counting it as a letter", () => {
  const letters = [issue("first", 14), issue("second", 13), issue("seen", 12, { unread: false })];
  const { mail } = mountStreamFrame({
    at: "#/reads",
    letters,
    rows: {
      "view_meta:reads_ai_chip": {
        afterId: "first",
        label: "File the next issue in News",
        approvedLabel: "Rule saved",
        correctedLabel: "Goes to Ohbox",
      },
      "view_meta:reads_waterline": { newestSeenId: "seen", at: letters[2]!.date },
    },
  });
  const list = within(screen.getByRole("region", { name: "News" }));
  const suggestion = list.getByText("File the next issue in News");
  const first = list.getByRole("option", { name: /Issue 14/ });
  const second = list.getByRole("option", { name: /Issue 13/ });
  expect(first.compareDocumentPosition(suggestion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(suggestion.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(list.getAllByRole("option").map((row) => row.getAttribute("aria-posinset"))).toEqual([
    "1",
    "2",
    "1",
  ]);
  expect(list.getAllByRole("option").map((row) => row.getAttribute("aria-setsize"))).toEqual(["2", "2", "1"]);
  fireEvent.click(list.getByRole("button", { name: "Approve" }));
  expect(list.getByText("Rule saved")).toBeTruthy();
  expect(mail.mutations).toEqual([]);
});

it("shows the correction beside the same News row without writing mail", () => {
  const { mail } = mountStreamFrame({
    at: "#/reads",
    letters: [issue("first", 14), issue("second", 13)],
    rows: {
      "view_meta:reads_ai_chip": {
        afterId: "first",
        label: "File the next issue in News",
        approvedLabel: "Rule saved",
        correctedLabel: "Goes to Ohbox",
      },
    },
  });
  const list = within(screen.getByRole("region", { name: "News" }));
  fireEvent.click(list.getByRole("button", { name: "Correct" }));
  const corrected = list.getByText("Goes to Ohbox");
  const first = list.getByRole("option", { name: /Issue 14/ });
  expect(first.compareDocumentPosition(corrected) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(list.queryByRole("button", { name: "Correct" })).toBeNull();
  expect(mail.mutations).toEqual([]);
});
