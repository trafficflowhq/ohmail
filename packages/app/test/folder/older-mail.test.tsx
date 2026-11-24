/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FOLDERS_ON, listSeat } from "../places/list-seat.js";
import { letter } from "../reader/support/mail.js";

afterEach(cleanup);

const path = "Projects" as ReturnType<typeof letter>["folder"];
const old = letter("prior-note", { folder: path, subject: "Prior note", unread: false });
const more = {
  "folder:projects": { id: "projects", name: path, mailboxId: old.mailboxId },
  "folder:archive": { id: "archive", name: "Archive", mailboxId: old.mailboxId },
};

it("asks for older mail before calling an empty mirror an empty folder and resets on return", async () => {
  const listOlder = vi.fn(async () => ({ state: "ready", items: [old], nextCursor: null }));
  const { address, mail } = listSeat({
    first: "#/folder/projects",
    consent: FOLDERS_ON,
    letters: [],
    more,
    engine: () => ({
      storeCoverage: () => ({ state: "partial" }),
      listOlderAvailable: () => true,
      listOlder,
      storePageRow: (item: typeof old) => item,
    }),
  });
  await waitFor(() => expect(listOlder.mock.calls.length).toBe(1));
  expect(await screen.findByRole("option", { name: /Prior note/ })).toBeTruthy();
  expect(screen.getByText("That is everything on your server.")).toBeTruthy();
  expect(screen.queryByText("Nothing here")).toBeNull();

  act(() => address.visit("#/folder/archive"));
  act(() => address.visit("#/folder/projects"));
  await waitFor(() => expect(listOlder.mock.calls.length).toBe(3));

  act(() => mail.add(old));
  expect(screen.getAllByRole("option", { name: /Prior note/ })).toHaveLength(1);
});

it("offers older mail explicitly when the mirror already has a row", async () => {
  const listOlder = vi.fn(async () => ({ state: "ready", items: [], nextCursor: null }));
  listSeat({
    first: "#/folder/projects",
    consent: FOLDERS_ON,
    letters: [old],
    more,
    engine: () => ({
      storeCoverage: () => ({ state: "partial" }),
      listOlderAvailable: () => true,
      listOlder,
    }),
  });
  const load = await screen.findByRole("button", { name: "Load older mail" });
  expect(listOlder).not.toHaveBeenCalled();
  fireEvent.click(load);
  await waitFor(() => expect(listOlder.mock.calls.length).toBe(1));
});
