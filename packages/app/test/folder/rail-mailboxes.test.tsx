/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { FOLDERS_ON, listSeat } from "../places/list-seat.js";

const primary = "work" + "@" + "example.test";
const secondary = "home" + "@" + "example.test";

afterEach(cleanup);

it("labels a single tree when there is a second mailbox without folders", async () => {
  const folders = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `folder:f${i}`,
      { id: `f${i}`, name: `Project ${i}`, mailboxId: "work", mailbox: primary },
    ]),
  );
  listSeat({
    letters: [],
    more: folders,
    first: "#/ohbox",
    consent: FOLDERS_ON,
    mailboxes: async () =>
      [
        { id: "work", address: primary, status: "connected" },
        { id: "home", address: secondary, status: "connected" },
      ] as MailboxFacts[],
  });
  fireEvent.click(await screen.findByRole("button", { name: "All folders" }));
  const tree = screen.getByRole("tree", { name: "All folders" });
  await waitFor(() => expect(within(tree).queryByText(primary)).not.toBeNull());
});
