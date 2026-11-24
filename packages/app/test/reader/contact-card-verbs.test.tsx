/** @vitest-environment jsdom */
/**
 * A PERSON's CARD IN THE HEAD OFFERS WHAT TODAY's POPOVER DID (the switch's point 65; by RULING-JOIN J-1 an act does
 * what today's did): Copy the address, the stored form, where the host hands the reader a clipboard; Everything from and
 * to this address, the address place at that person, where the host mounts that place; and Write. Each withheld
 * where its door is none. The Screener's rows on the card are the Screener's mount's.
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlaceEntry } from "../../src/frame/contract.js";
import { letter, mountReader, READER_PLACE, WRITE_PLACE } from "./support/mail.js";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

const ADDRESS_PLACE: PlaceEntry = {
  id: "address",
  body: "address",
  rail: null,
  panes: { kind: "wide", Wide: () => <p>everything with one address</p> },
};

/** A letter with a Cc person whose domain is internationalized: the stored form is its A-label. */
const CC = { name: "Ada", address: "ada@xn--bcher-kva.example" };

function openCard(
  host: Parameters<typeof mountReader>[0]["host"] = {},
  copy?: (text: string) => Promise<boolean>,
) {
  const made = mountReader({
    letters: [letter("m1", { cc: [CC] })],
    open: "m1",
    host,
    ...(copy ? { parts: { copy } } : {}),
  });
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Ada" }));
  });
  return { ...made, card: () => screen.queryByRole("dialog", { name: "Options for Ada" }) };
}

describe("a person's card in the letter's head", () => {
  it("copies the person's stored address through the clipboard the host hands the reader, and closes", async () => {
    const copied: string[] = [];
    const { card } = openCard({}, async (text: string) => {
      copied.push(text);
      return true;
    });
    expect(card()).not.toBeNull();
    await act(async () => {
      fireEvent.click(within(card()!).getByRole("button", { name: "Copy address" }));
    });
    expect(copied).toEqual([CC.address]);
    expect(card(), "the card closed").toBeNull();
  });

  it("offers no Copy where the host hands the reader no clipboard", () => {
    const { card } = openCard();
    expect(card()).not.toBeNull();
    expect(within(card()!).queryByRole("button", { name: "Copy address" })).toBeNull();
  });

  it("leads to everything from and to that person, at the address place, where the host mounts it", () => {
    const { card, address } = openCard({
      places: { ohbox: READER_PLACE, write: WRITE_PLACE, address: ADDRESS_PLACE },
    });
    act(() => {
      fireEvent.click(within(card()!).getByRole("menuitem", { name: "Everything from and to this address" }));
    });
    expect(decodeURIComponent(address.read())).toBe(`#/address/${CC.address}`);
    expect(card(), "the card closed").toBeNull();
  });

  it("offers no way to the address place where the host mounts none; Write stands either way", () => {
    const { card } = openCard();
    expect(
      within(card()!).queryByRole("menuitem", { name: "Everything from and to this address" }),
    ).toBeNull();
    expect(within(card()!).getByRole("menuitem", { name: "Write" })).toBeTruthy();
  });
});
