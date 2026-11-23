/** @vitest-environment jsdom */
/**
 * A WAY OUR SERVER DOES NOT OFFER IS NEVER DRAWN: Google and Microsoft have no capsule, no step and no address that
 * reaches one; a failing list reads as none; and where connecting has no door nothing is offered at all.
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CalendarWay } from "@ohmail/app-logic/calendar/setup";
import { mirror, mountFrame, NONE, setupPort } from "./world.js";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

const capsules = () => {
  const group = screen.queryByRole("group", { name: "Ways to connect a calendar" });
  return group
    ? within(group)
        .queryAllByRole("button")
        .map((b) => b.textContent?.replace("↵", "").trim())
    : [];
};

describe("the ways drawn", () => {
  it("draws a capsule for each way the server lists that has a step, in the server's order", async () => {
    mountFrame(
      "#/cal/cal-setup",
      mirror(),
      setupPort(async () => ["ics", "microsoft", "icloud", "caldav"]),
    );
    await act(async () => undefined);
    expect(capsules()).toEqual(["A subscription", "iCloud", "Another CalDAV server"]);
    expect(screen.queryByText(/Google|Microsoft/)).toBeNull();
  });

  it("narrows to nothing while the typed words fit no way that is drawn", async () => {
    mountFrame(
      "#/cal/cal-setup",
      mirror(),
      setupPort(async () => ["icloud", "ics"]),
    );
    await act(async () => undefined);
    fireEvent.change(screen.getByLabelText("Where your calendar is"), { target: { value: "goo" } });
    expect(capsules()).toEqual([]);
    fireEvent.change(screen.getByLabelText("Where your calendar is"), { target: { value: "icl" } });
    expect(capsules()).toEqual(["iCloud"]);
  });

  it("folds an address that names a way not offered to the first step", async () => {
    for (const ways of [["google", "icloud"], ["icloud"]] as CalendarWay[][]) {
      mountFrame(
        "#/cal/cal-setup?step=signin&way=google",
        mirror(),
        setupPort(async () => ways),
      );
      await act(async () => undefined);
      expect(screen.queryByLabelText(/password/i)).toBeNull();
      expect(capsules()).toEqual(["iCloud"]);
      cleanup();
    }
  });

  it("draws no way when the list fails, throws or is not a list, and says so in one line", async () => {
    const failing: (() => Promise<readonly CalendarWay[]>)[] = [
      () => Promise.reject(new Error("offline")),
      () => {
        throw new Error("no door");
      },
      async () => ({ ways: ["icloud"] }) as unknown as CalendarWay[],
    ];
    for (const ways of failing) {
      mountFrame("#/cal/cal-setup?step=signin&way=icloud", mirror(), setupPort(ways));
      await act(async () => undefined);
      expect(capsules()).toEqual([]);
      expect(screen.queryByLabelText(/password/i)).toBeNull();
      expect(screen.getByRole("heading", { name: "No calendar can be connected from here" })).toBeTruthy();
      cleanup();
    }
  });

  it("offers nothing where connecting has no door, or where the host hands in no port", async () => {
    mountFrame(
      "#/cal/cal-setup",
      mirror(),
      setupPort(async () => ["icloud", "ics"], { connect: "none" }),
    );
    await act(async () => undefined);
    expect(capsules()).toEqual([]);
    cleanup();
    mountFrame("#/cal/cal-setup?step=signin&way=icloud", mirror(), NONE);
    await act(async () => undefined);
    expect(capsules()).toEqual([]);
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "No calendar can be connected from here" })).toBeTruthy();
  });
});
