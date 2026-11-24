/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import en from "../messages/en.json";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor } from "./_draft-shell.js";

/**
 * A DECISION TAKEN FROM THE SENDER SHEET OFFERS THE UNDO THE LIST'S DECISION DOES. From the
 * Screener's preview, a place pressed in the sheet sent the decision at once with a sentence and
 * no Undo, where the list's own press holds it for the undo window. The sheet's press about a
 * sender still at the gate now goes through the Screener's door.
 * Mutation: the gate row not handed to `screener.decide` → red on the missing Undo.
 */

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(unmountAll);

const STRANGER = { address: "stranger@newcomer.example", name: "A newcomer" };
const held = message("h1", { from: STRANGER, folder: "ohmail/Screener", unread: true });

const row = (root: HTMLElement) =>
  within(root).queryByRole("option", { name: /^A newcomer:/ });
const undo = () => within(document.body).queryByRole("button", { name: "Undo" });

async function openCard() {
  const shell = await mountShell("#/screener", [held]);
  await waitFor(() => row(shell.el) !== null, "the waiting sender");
  await press(row(shell.el), "the waiting sender");
  const preview = within(shell.el).getByRole("region", { name: "Reading" });
  const letter = within(preview).getByRole("article");
  const sender = within(letter).getByRole("button", { name: /^A newcomer/ });
  await press(sender, "the sender's contact");
  const card = within(document.body).getByRole("dialog", { name: en.screener.place.keyCard });
  return { shell, card };
}

const chooseOhbox = (card: HTMLElement) =>
  press(within(card).getByRole("radio", { name: "Ohbox" }), "Ohbox");

describe("the sender sheet's decision can be taken back", () => {
  it("a place pressed in the sheet holds the decision, offers Undo, and Undo keeps the sender waiting", async () => {
    const { shell, card } = await openCard();
    await chooseOhbox(card);
    await waitFor(() => undo() !== null, "the decision's Undo");
    expect(undo()).not.toBeNull();
    expect(shell.sent.filter((m) => m.kind === "screener_decide"), "decided at once, with nothing to undo").toEqual([]);
    await waitFor(() => row(shell.el) === null, "the decided sender leaving the list");
    await press(undo(), "the decision's Undo");
    await waitFor(() => row(shell.el) !== null, "the sender back in the list");
    expect(shell.sent.filter((m) => m.kind === "screener_decide")).toEqual([]);
  }, 20_000);

  it("the sheet's past-mail answer rides the decision when the window closes", async () => {
    const { shell, card } = await openCard();
    const retro = within(card).getByRole("switch", { name: en.screening.retroToggleAria });
    if (retro.getAttribute("aria-checked") === "true") await press(retro, "apply to past mail");
    expect(retro.getAttribute("aria-checked")).toBe("false");
    await chooseOhbox(card);
    await waitFor(() => undo() !== null, "the decision's Undo");

    await act(async () => { window.location.hash = "#/ohbox"; });
    await waitFor(() => shell.sent.some((m) => m.kind === "screener_decide"), "the decision on the wire");
    const decide = shell.sent.find((m) => m.kind === "screener_decide");
    expect(decide?.applyRetro, "the past-mail answer was dropped on the way").toBe(false);
  }, 20_000);
});
