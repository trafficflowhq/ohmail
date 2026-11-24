/** @vitest-environment jsdom */
import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { FOLDERS_ON, listSeat } from "../places/list-seat.js";

const mailbox = (id: string, junkFolder: string | null) =>
  ({
    id,
    junkFolder,
    address: id + "@" + "example.test",
    status: "connected",
  }) as MailboxFacts;

afterEach(cleanup);

it.each([
  { folders: ["INBOX/Spam"], expected: "Spam folder is not listed here" },
  { folders: ["Spam", "Junk"], expected: "junk folder is not listed here" },
])("leaves the provider Junk explanation out of the Folder rail", async ({ folders, expected }) => {
  listSeat({
    letters: [],
    first: "#/ohbox",
    consent: FOLDERS_ON,
    mailboxes: async () => folders.map((name, index) => mailbox(String(index), name)),
  });
  await screen.findByRole("navigation", { name: "Places" });
  expect(screen.queryByText((text) => text.includes(expected))).toBeNull();
  expect(screen.queryByText("Read it under Junk in the Screener.")).toBeNull();
});
