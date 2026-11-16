/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ohbox } from "./ohbox-world.js";
import { wideWindow } from "./setup.js";

beforeEach(wideWindow);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A sentence on screen, whatever the kit split it into (its last word carries the dot). */
const said = (text: string): boolean => document.body.textContent?.includes(text) ?? false;

describe("an Ohbox with no rows", () => {
  it("with no mailbox, leads to connecting one", () => {
    const world = ohbox({}, { side: { mail: { mailboxes: 0, screenerCandidate: false, arrived: 0 } } });
    fireEvent.click(screen.getByRole("button", { name: "Connect a mailbox" }));
    expect(world.said.went).toEqual(["mailboxes"]);
  });

  it("before the mailbox is read through says nothing about mail, then that it is loading", () => {
    vi.useFakeTimers();
    ohbox({ settled: false });
    expect(said("Nothing")).toBe(false);
    expect(said("unread")).toBe(false);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(said("Loading your mail")).toBe(true);
    expect(said("Nothing")).toBe(false);
  });

  it("while it is owed, the shell's rows as shape stand where the rows will be, and leave once it is read", () => {
    const shape = <div data-shape="" aria-hidden="true" />;
    const world = ohbox({ settled: false }, { side: { shape } });
    expect(document.querySelector("[data-shape]")).not.toBeNull();
    world.again({ settled: true });
    expect(document.querySelector("[data-shape]")).toBeNull();
    expect(said("Nothing in your Ohbox")).toBe(true);
  });

  it("read through and empty, says so once", () => {
    ohbox({});
    expect(said("Nothing in your Ohbox")).toBe(true);
  });

  it("with senders waiting at the Screener, leads there", () => {
    const world = ohbox(
      {},
      {
        side: {
          mail: { mailboxes: 1, screenerCandidate: true, arrived: 0 },
          doorbell: { count: 2, settled: true },
        },
      },
    );
    expect(said("Nothing in your Ohbox")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Screener" }));
    expect(world.said.went).toEqual(["screener"]);
  });
});
