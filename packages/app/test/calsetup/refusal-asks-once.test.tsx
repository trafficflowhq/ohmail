/** @vitest-environment jsdom */
/**
 * ONE PRESS IS ONE ASK, AND A REFUSAL IS NEVER ASKED AGAIN BY ITSELF: a second press while the first is out sends
 * nothing; a connection the mirror says was refused shows the refusal's sentence and calls nothing; a connection that
 * has not answered yet says it is still checking and never claims a failure.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarSetupPort, ConnectAnswer } from "@ohmail/app-logic/calendar/setup";
import { calendarRecord, connectionRecord, mirror, mountFrame, setupPort } from "./world.js";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

const doors = (port: CalendarSetupPort) =>
  [
    port.connect,
    port.signInAgain,
    port.remove,
    port.check,
    port.setCalendar,
    port.saveSettings,
  ] as unknown as {
    mock: { calls: unknown[] };
  }[];

describe("a refused sign-in", () => {
  it("sends one ask for two presses while the first is out", async () => {
    let answer: (a: ConnectAnswer) => void = () => undefined;
    const connect = vi.fn(() => new Promise<ConnectAnswer>((resolve) => (answer = resolve)));
    const port = setupPort(async () => ["icloud"], { connect });
    mountFrame("#/cal/cal-setup?step=signin&way=icloud", mirror(), port);
    await act(async () => undefined);
    const fill = () => {
      fireEvent.change(screen.getByLabelText("Apple Account email address"), {
        target: { value: "a@b.test" },
      });
      fireEvent.change(screen.getByLabelText("App-specific password"), { target: { value: "x" } });
    };
    fill();
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    fill();
    fireEvent.click(screen.getByRole("button", { name: /Asking/ }));
    fireEvent.keyDown(screen.getByLabelText("App-specific password"), { key: "Enter" });
    expect(connect).toHaveBeenCalledTimes(1);
    await act(async () => answer({ kind: "refused", fault: "sign_in_refused" }));
    expect(screen.getByText(/iCloud takes an app-specific password/)).toBeTruthy();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("shows the mirror's refusal of a connection and calls nothing until Try again is pressed", async () => {
    const world = mirror();
    world.put(
      "calendar_connection",
      "conn-1",
      connectionRecord({ status: "reconnect", errorCode: "sign_in_refused" }),
    );
    const port = setupPort(async () => ["icloud"]);
    const { address } = mountFrame(
      "#/cal/cal-setup?step=calendars&way=icloud&connection=conn-1",
      world,
      port,
    );
    await act(async () => undefined);
    expect(screen.getByText(/iCloud takes an app-specific password/)).toBeTruthy();
    expect(doors(port).every((door) => door.mock.calls.length === 0)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await act(async () => undefined);
    expect(address.writes.at(-1)?.next).toMatch(/step=signin&way=icloud&again=conn-1/);
    expect(doors(port).every((door) => door.mock.calls.length === 0)).toBe(true);
  });

  it("says it is still checking while nothing has answered, and follows the calendars when they arrive", async () => {
    const world = mirror();
    world.put("calendar_connection", "conn-1", connectionRecord());
    mountFrame(
      "#/cal/cal-setup?step=calendars&way=caldav&connection=conn-1",
      world,
      setupPort(async () => ["caldav"]),
    );
    await act(async () => undefined);
    expect(screen.getByText("Reading your calendars")).toBeTruthy();
    expect(screen.queryByText(/Nothing was connected/)).toBeNull();
    act(() => world.put("calendar", "cal-1", calendarRecord()));
    expect(screen.getByText("My calendars")).toBeTruthy();
    expect(screen.getByText("Studio")).toBeTruthy();
  });
});
