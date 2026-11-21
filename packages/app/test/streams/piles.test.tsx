/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { readerZone } from "@ohmail/app-logic/reader";
import { afterEach, describe, expect, it } from "vitest";
import { letter, mountPiles, pilesOf } from "./world.js";

afterEach(cleanup);

const LATER = [letter("l1", { subject: "Quote for the kiln" }), letter("l2", { subject: "Glaze order" })];

describe("the piles", () => {
  it("starts the Reply Run on the first letter of Answer Later, with its reply open, and sends nothing itself", () => {
    const { address, said } = mountPiles({ piles: pilesOf({ replyLater: LATER }), letters: LATER });
    fireEvent.click(screen.getByRole("button", { name: /Reply Run/ }));
    expect(said.opened).toEqual(["l1"]);
    expect(said.written).toEqual(["l1"]);
    expect(said.actions).toEqual([]);
    expect(address.read()).toBe("#/triage/m/l1");
  });

  it("starts the Reply Run with f, whatever letter stands open beside the list; f does nothing outside Answer Later", () => {
    const { address, said } = mountPiles({ piles: pilesOf({ replyLater: LATER }), letters: LATER });
    fireEvent.keyDown(document.body, { key: "f" });
    expect(said.opened).toEqual(["l1"]);
    expect(said.written).toEqual(["l1"]);
    expect(address.read()).toBe("#/triage/m/l1");
    cleanup();
    const aside = mountPiles({ piles: pilesOf({ setAside: LATER }), letters: LATER, at: "#/triage/aside" });
    fireEvent.keyDown(document.body, { key: "f" });
    expect(aside.said.opened).toEqual([]);
    cleanup();
    // A letter open: the reading column has the keys, and f is still the Reply Run's, from the pile's first letter.
    const reading = mountPiles({
      piles: pilesOf({ replyLater: LATER }),
      letters: LATER,
      at: "#/triage/m/l2",
    });
    fireEvent.keyDown(document.body, { key: "f" });
    expect(reading.said.opened).toEqual(["l1"]);
    expect(reading.said.written).toEqual(["l1"]);
    expect(reading.address.read()).toBe("#/triage/m/l1");
  });

  it("starts no Reply Run on f with Ctrl, Cmd or Alt", () => {
    const { address, said } = mountPiles({ piles: pilesOf({ replyLater: LATER }), letters: LATER });
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }])
      fireEvent.keyDown(document.body, { key: "f", ...mod });
    expect(said.opened).toEqual([]);
    expect(said.written).toEqual([]);
    expect(address.read()).toBe("#/triage");
  });

  it("offers no Reply Run outside Answer Later or on an empty pile", () => {
    mountPiles({ piles: pilesOf({ setAside: LATER }), letters: LATER, at: "#/triage/aside" });
    expect(screen.queryByRole("button", { name: /Reply Run/ })).toBeNull();
    cleanup();
    mountPiles({ piles: pilesOf({}), letters: [] });
    expect(screen.queryByRole("button", { name: /Reply Run/ })).toBeNull();
  });

  it("opens a row's letter in the reader's column on a press", () => {
    const { address, said } = mountPiles({
      piles: pilesOf({ setAside: LATER }),
      letters: LATER,
      at: "#/triage/aside",
    });
    fireEvent.click(screen.getByText("Glaze order"));
    expect(said.opened).toEqual(["l2"]);
    expect(address.read()).toBe("#/triage/aside/m/l2");
  });

  it("heads the three piles as Triage, and a row of Answer Later or Parked says when its letter came, in the seat's stamp", () => {
    mountPiles({ piles: pilesOf({ replyLater: LATER }), letters: LATER, at: "#/triage" });
    expect(screen.getByRole("heading", { name: "Triage" })).toBeTruthy();
    const when = LATER[0]!.date!.slice(11, 16);
    expect(screen.getAllByText(`at ${when}`).length).toBeGreaterThan(0);
  });

  it("says when a Resurface row is back, and its Done goes through the press seam once per press", () => {
    const date = "2026-11-20T08:00:00.000Z";
    const { said } = mountPiles({
      piles: pilesOf({ resurface: LATER }, date),
      letters: LATER,
      at: "#/triage/resurface",
    });
    const clock = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: readerZone() });
    expect(screen.getAllByText((text) => text.endsWith(clock.format(new Date(date))))).toHaveLength(2);
    expect(screen.queryByText(/^back /)).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Done" })[0]!);
    expect(said.actions).toEqual([["resurface_done", "l1"]]);
    expect(said.opened).toEqual([]);
  });
});
