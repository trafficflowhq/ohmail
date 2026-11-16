/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { msg, ohbox } from "./ohbox-world.js";
import { wideWindow } from "./setup.js";

beforeEach(wideWindow);
afterEach(cleanup);

const rows = () => [msg({ id: "a" })];

describe("the doorbell in the head", () => {
  it("says how many wait and leads to the Screener", () => {
    const world = ohbox({ newForYou: rows() }, { side: { doorbell: { count: 6, settled: true } } });
    const bell = screen.getByRole("button", { name: "6 first-time senders waiting — open the Screener" });
    expect(bell.textContent).toContain("6");
    fireEvent.click(bell);
    expect(world.said.went).toEqual(["screener"]);
  });

  /* The number it prints is the number its name says: a reader who sees one and hears the other hears one fact.
     The name groups the thousands, so the bell does too. */
  it("prints the number its name says: one in the singular, a thousand grouped as the name groups it", () => {
    const world = ohbox({ newForYou: rows() }, { side: { doorbell: { count: 1, settled: true } } });
    const one = screen.getByRole("button", { name: "1 first-time sender waiting — open the Screener" });
    expect(one.textContent).toBe("1");
    world.again({}, { doorbell: { count: 1042, settled: true } });
    const many = screen.getByRole("button", { name: "1,042 first-time senders waiting — open the Screener" });
    expect(many.textContent, "the bell prints a raw number its name groups").toBe("1,042");
  });

  it("is withheld until the Screener's queue is read and the Ohbox may speak, and at zero", () => {
    const world = ohbox({ newForYou: rows() }, { side: { doorbell: { count: 6, settled: false } } });
    expect(screen.queryByRole("button", { name: /waiting/ })).toBeNull();
    world.again({ settled: false }, { doorbell: { count: 6, settled: true } });
    expect(screen.queryByRole("button", { name: /waiting/ })).toBeNull();
    world.again({ settled: true }, { doorbell: { count: 0, settled: true } });
    expect(screen.queryByRole("button", { name: /waiting|All clear/ })).toBeNull();
  });

  it("where nothing organizes any mailbox and nobody agreed, it leads to setting organizing up", () => {
    const world = ohbox(
      { newForYou: rows() },
      {
        side: {
          notOrganizing: { every: true, mailboxes: [{ id: "mb1", address: "mila@ex.example" }] },
          doorbell: { count: 3, settled: true },
        },
      },
    );
    expect(screen.queryByRole("button", { name: /waiting/ })).toBeNull();
    /* Said to every eye, not only to a screen reader: the statement printed, its action after it. */
    expect(document.body.textContent).toMatch(/Not organizing yet\s*Set up ›/);
    fireEvent.click(screen.getByRole("button", { name: /Not organizing yet/ }));
    expect(world.said.went).toEqual(["organize:mb1"]);
  });

  it("where it was handed back, it says so and leads to Mailboxes", () => {
    const world = ohbox(
      { newForYou: rows() },
      {
        side: {
          notOrganizing: {
            every: true,
            mailboxes: [{ id: "mb1", address: "mila@ex.example", why: "handed_back" }],
          },
        },
      },
    );
    expect(document.body.textContent).toMatch(/Handed back\s*Mailboxes ›/);
    fireEvent.click(screen.getByRole("button", { name: /Handed back/ }));
    expect(world.said.went).toEqual(["mailboxes"]);
  });

  it("where one of several mailboxes is not organized and nobody waits, it names that mailbox", () => {
    ohbox(
      { newForYou: rows() },
      {
        side: { notOrganizing: { every: false, mailboxes: [{ id: "mb2", address: "ben@ex.example" }] } },
      },
    );
    expect(screen.getByRole("button", { name: /ben@ex\.example/ })).toBeTruthy();
    expect(document.body.textContent).toMatch(/Not organizing ben@ex\.example\s*Set up ›/);
  });
});
