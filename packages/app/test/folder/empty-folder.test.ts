/** @vitest-environment jsdom */
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLDERS_ON, listSeat } from "../places/list-seat.js";

afterEach(cleanup);

describe("an empty folder is a question until the server has answered — the reach-past", () => {
  it("a whole-mailbox client keeps the plain empty state — no offer it cannot keep", async () => {
    const listOlder = vi.fn(() => {
      throw new Error("unavailable must never be asked");
    });
    listSeat({
      letters: [],
      more: {
        "folder:fd1": { id: "fd1", name: "Projects", mailboxId: "mb1", mailbox: "mailbox@example.invalid" },
      },
      first: "#/folder/fd1",
      consent: FOLDERS_ON,
      engine: () => ({
        listOlderAvailable: () => true,
        storeCoverage: () => ({ state: "whole" }),
        listOlder,
      }),
    });

    await waitFor(() => expect(document.body.textContent).toContain("Nothing in this folder"));
    expect(document.body.textContent).not.toContain("Load older mail");
    expect(listOlder).not.toHaveBeenCalled();
  });
});
