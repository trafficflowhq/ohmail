/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FOLDERS_ON, listSeat } from "../places/list-seat.js";

afterEach(cleanup);

it("finds the full path and gives same-named folders their parent context", async () => {
  const names = [
    "Projects",
    "Projects/Invoices",
    "Archive",
    "Archive/Invoices",
    ...Array.from({ length: 13 }, (_, i) => `Folder ${i}`),
  ];
  const folders = Object.fromEntries(
    names.map((name, i) => [
      `folder:f${i}`,
      { id: `f${i}`, name, mailboxId: "work", mailbox: "work" + "@" + "example.test" },
    ]),
  );
  listSeat({ first: "#/ohbox", letters: [], more: folders, consent: FOLDERS_ON });
  fireEvent.click(await screen.findByRole("button", { name: "All folders" }));
  const tree = screen.getByRole("tree", { name: "All folders" });
  const field = within(tree).getByRole("textbox", { name: "Find a folder" });
  fireEvent.change(field, { target: { value: "Projects/" } });
  const match = within(tree).queryByRole("button", { name: "Invoices, Projects" });
  expect(match).not.toBeNull();
  expect(match?.textContent?.includes("Projects")).toBe(true);
  expect(within(tree).queryByRole("button", { name: "Invoices, Archive" })).toBeNull();
});

it.each([
  { first: 12, second: 0, child: true, shown: false },
  { first: 8, second: 8, child: false, shown: false },
  { first: 13, second: 0, child: false, shown: true },
  { first: 12, second: 0, child: false, orphan: true, shown: true },
])("counts roots in each mailbox for the Find threshold", async ({ first, second, child, orphan, shown }) => {
  const folder = (mailboxId: string, name: string) => {
    const id = `${mailboxId}/${name}`;
    return [`folder:${id}`, { id, name, mailboxId, mailbox: mailboxId + "@" + "example.test" }] as const;
  };
  const folders = Object.fromEntries([
    ...Array.from({ length: first }, (_, i) => folder("work", `Folder ${i}`)),
    ...Array.from({ length: second }, (_, i) => folder("personal", `Folder ${i}`)),
    ...(child ? [folder("work", "Folder 0/Invoices")] : []),
    ...(orphan ? [folder("work", "Missing parent/Invoices")] : []),
  ]);
  listSeat({ first: "#/ohbox", letters: [], more: folders, consent: FOLDERS_ON });
  fireEvent.click(await screen.findByRole("button", { name: "All folders" }));
  expect(screen.queryByRole("textbox", { name: "Find a folder" }) !== null).toBe(shown);
});
