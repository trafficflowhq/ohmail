/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { letter, mountReader } from "./support/mail.js";

/**
 * UNDO THROUGH THE ONE SEAM: a verb of the panel says one sentence with Undo; `z` inside its window takes it back with
 * the act's own inverse, and nothing after.
 */

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("undo in the reader", () => {
  it("Later says one sentence with Undo, and z takes it back", async () => {
    const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", {
          name: "Later",
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((s) => s.textContent?.startsWith("Later"))).toBe(true),
    );
    expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z" });
    });
    expect(mail.mutations).toEqual([
      { kind: "triage_set", messageId: "m1", state: "reply_later" },
      expect.objectContaining({ kind: "triage_set", messageId: "m1" }),
    ]);
    expect(mail.mutations[1]).not.toMatchObject({ state: "reply_later" });
  });

  it("Delete leaves the letter: the column closes, Undo keeps it, and the reader never calls it gone", async () => {
    const { address, mail } = mountReader({ letters: [letter("m1")], open: "m1" });
    const panel = () => screen.queryByRole("toolbar", { name: "Actions" });
    await act(async () => {
      fireEvent.click(within(panel()!).getByRole("button", { name: "More" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    });
    await waitFor(() => expect(address.read()).toBe("#/ohbox"));
    expect(panel()).toBeNull();
    expect(screen.queryByText(/moved or deleted elsewhere/)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    });
    await act(async () => {
      address.visit("#/ohbox/m/m1");
    });
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(screen.queryByText(/moved or deleted elsewhere/)).toBeNull();
    expect(mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([]);
  });
});
