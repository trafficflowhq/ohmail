/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { issue, mountStreamFrame } from "./registered-world.js";

afterEach(cleanup);

it("keeps the News rows and waterline in order without a filing suggestion", () => {
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
  const first = list.getByRole("option", { name: /Issue 14/ });
  const second = list.getByRole("option", { name: /Issue 13/ });
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(list.queryByText("File the next issue in News")).toBeNull();
  expect(list.getAllByRole("option").map((row) => row.getAttribute("aria-posinset"))).toEqual([
    "1",
    "2",
    "1",
  ]);
  expect(list.getAllByRole("option").map((row) => row.getAttribute("aria-setsize"))).toEqual(["2", "2", "1"]);
  expect(list.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(list.queryByText("Rule saved")).toBeNull();
  expect(mail.mutations).toEqual([]);
});

it("ignores stale correction copy and controls without writing mail", () => {
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
  expect(list.getAllByRole("option")).toHaveLength(2);
  expect(list.queryByText("File the next issue in News")).toBeNull();
  expect(list.queryByText("Goes to Ohbox")).toBeNull();
  expect(list.queryByRole("button", { name: "Correct" })).toBeNull();
  expect(mail.mutations).toEqual([]);
});
