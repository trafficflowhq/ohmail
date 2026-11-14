/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A, B, M, NOW, drawPane, fakePane, ok, row } from "./support.js";

/**
 * A ROUTE'S WORD IS A CLAIM, NEVER AN ID. The word opens the account's own row that holds it, in place, and presses
 * nothing; every verb of that row then names the row's own id. A word no row holds opens nothing and reaches no wire.
 */
const settle = (): Promise<void> => act(async () => {});
const rowButton = (address: string) =>
  screen.getByRole("button", { name: new RegExp(address.replace(".", "\\.")) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ROWS = [row("mbx-a", A), row("mbx-b", B)];

describe("the route's word opens a row, and presses nothing", () => {
  it("opens the row whose id it names, and only that one", async () => {
    const pane = fakePane({ list: [ok(ROWS)], allowance: [ok({ emailVerified: true, access: null })] });
    drawPane(pane.wire, { opened: "mbx-b" });
    await settle();
    expect(rowButton(B).getAttribute("aria-expanded")).toBe("true");
    expect(rowButton(A).getAttribute("aria-expanded")).toBe("false");
    expect(pane.writes()).toEqual([]);
  });

  it("the opened row's verbs name the row's own id", async () => {
    const pane = fakePane({
      list: [ok(ROWS)],
      allowance: [ok({ emailVerified: true, access: null })],
      resync: [ok(null)],
    });
    drawPane(pane.wire, { opened: "mbx-b" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: M.syncNow }));
    await settle();
    expect(pane.of("resync").map((c) => c.args)).toEqual([["mbx-b"]]);
  });

  it.each([
    ["another account's id", "mbx-elsewhere"],
    ["dots and slashes", "../../mailboxes"],
    ["a query and a fragment", "mbx-a?x=1#y"],
    ["a prototype's name", "__proto__"],
    ["5 kB of letters", "x".repeat(5000)],
  ])("%s opens nothing and reaches no wire", async (_, word) => {
    const pane = fakePane({ list: [ok(ROWS)], allowance: [ok({ emailVerified: true, access: null })] });
    drawPane(pane.wire, { opened: word });
    await settle();
    expect(rowButton(A).getAttribute("aria-expanded")).toBe("false");
    expect(rowButton(B).getAttribute("aria-expanded")).toBe("false");
    expect(pane.calls.map((c) => c.verb).sort()).toEqual(["allowance", "list"]);
  });

  it("a word changed under an opened row opens the new row and closes nothing the person opened", async () => {
    const pane = fakePane({ list: [ok(ROWS)], allowance: [ok({ emailVerified: true, access: null })] });
    const view = drawPane(pane.wire, { opened: "mbx-a" });
    await settle();
    view.redraw({ opened: "mbx-b" });
    await settle();
    expect(rowButton(B).getAttribute("aria-expanded")).toBe("true");
    expect(pane.writes()).toEqual([]);
  });
});
