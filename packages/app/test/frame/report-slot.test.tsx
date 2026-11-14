/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastFn } from "@ohmail/app-logic/press/report";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import { ReportHost } from "../../src/frame/ReportHost.js";
import { PLAIN_MS, useReportSlot } from "../../src/frame/report-slot.js";

let report: ToastFn = () => undefined;
let reportCalendar: (scope: symbol, message: string) => void = () => undefined;
function Slot() {
  const slot = useReportSlot();
  useEffect(() => {
    report = slot.report;
    reportCalendar = slot.reportCalendar;
  });
  return <ReportHost slot={slot} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  render(<Slot />);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const said = () => screen.queryAllByRole("status").map((el) => el.textContent);
const say = (message: string, options?: Parameters<ToastFn>[1]) => act(() => report(message, options));
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const undoable = (onAction = vi.fn()) => ({ action: "Undo", actionKey: "z", onAction });

describe("the one report slot", () => {
  it("shows the first explicit mail failure while two Calendar reports are queued", () => {
    const calendar = Symbol();
    act(() => {
      reportCalendar(calendar, "Calendar change refused");
      report("Mail action failed");
    });
    expect(said()).toEqual(["Mail action failed"]);
    act(() => {
      reportCalendar(calendar, "Another calendar change refused");
      report("Mail action saved");
    });
    expect(said()).toEqual(["Mail action saved"]);
    wait(PLAIN_MS);
    expect(said()).toEqual(["Calendar change refused"]);
    wait(PLAIN_MS);
    expect(said()).toEqual(["Another calendar change refused"]);
  });

  it("shows an explicit mail result waiting behind Undo before the Calendar queue", () => {
    const calendar = Symbol();
    say("Archived", undoable());
    say("Mail action failed");
    act(() => {
      reportCalendar(calendar, "Calendar change refused");
      reportCalendar(calendar, "Another calendar change refused");
    });
    expect(said()).toEqual(["ArchivedUndoz"]);
    wait(UNDO_MS);
    expect(said()).toEqual(["Mail action failed"]);
    wait(PLAIN_MS);
    expect(said()).toEqual(["Calendar change refused"]);
    wait(PLAIN_MS);
    expect(said()).toEqual(["Another calendar change refused"]);
  });

  it("a report replaces the report that stands", () => {
    say("Parked");
    say("Moved to Later");
    expect(said()).toEqual(["Moved to Later"]);
  });

  it("a plain report stands 2600 ms, or the caller's own time", () => {
    say("Parked");
    wait(PLAIN_MS - 1);
    expect(said()).toEqual(["Parked"]);
    wait(1);
    expect(said()).toEqual([]);
    say("Copied", { duration: 500 });
    wait(500);
    expect(said()).toEqual([]);
  });

  it("an Undo stands for the whole window, whatever time the caller asks for", () => {
    say("Archived", { ...undoable(), duration: 1000 });
    wait(UNDO_MS - 1);
    expect(said()).toEqual(["ArchivedUndoz"]);
    wait(1);
    expect(said()).toEqual([]);
  });

  it("removes Undo while the expired report is still fading", () => {
    const animation = Object.assign(new EventTarget(), { cancel() {} }) as unknown as Animation;
    const animate = vi.spyOn(Element.prototype, "animate").mockReturnValue(animation);
    try {
      say("Deleted", { ...undoable(), duration: 4000, actionDeadline: Date.now() + 4000 });
      screen.getByRole("status").style.setProperty("--d-hush", "250ms");
      wait(4000);
      expect(screen.getByRole("status").textContent).toBe("Deleted");
      expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
      act(() => animation.dispatchEvent(new Event("finish")));
      expect(said()).toEqual([]);
    } finally {
      animate.mockRestore();
    }
  });

  it("a plain report inside the Undo window waits, a newer one replaces it, and it is drawn when the window ends", () => {
    say("Archived", undoable());
    wait(1000);
    say("Saved");
    say("Saved again");
    expect(said()).toEqual(["ArchivedUndoz"]);
    wait(UNDO_MS - 1000);
    expect(said()).toEqual(["Saved again"]);
    wait(PLAIN_MS);
    expect(said()).toEqual([]);
  });

  it("an Undo gives way to another Undo and to a why", () => {
    say("Archived", undoable());
    say("Deleted", undoable());
    expect(said()).toEqual(["DeletedUndoz"]);
    say("Not sent. The server refused it.", { dismiss: "Dismiss" });
    expect(said()).toEqual(["Not sent. The server refused it. Dismiss"]);
  });

  it("a why stands until it is pressed", () => {
    say("Not sent.", { dismiss: "Dismiss" });
    wait(60_000);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(said()).toEqual([]);
  });

  it("a report nobody pressed for waits behind any report a press raised", () => {
    say("Parked");
    say("12 filed overnight", { yields: true });
    expect(said()).toEqual(["Parked"]);
    wait(PLAIN_MS);
    expect(said()).toEqual(["12 filed overnight"]);
  });

  it("Undo goes back once, and the capsule leaves with the press", () => {
    const back = vi.fn();
    say("Archived", undoable(back));
    const button = screen.getByRole("button", { name: /Undo/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(back).toHaveBeenCalledOnce();
    expect(said()).toEqual([]);
  });

  it("withdraws an Undo at once when its window closes early, and a waiting report follows", () => {
    const early = new AbortController();
    say("Screened in", { ...undoable(), signal: early.signal });
    say("Saved");
    act(() => early.abort());
    expect(said()).toEqual(["Saved"]);
  });

  it("shows the Undo's key while it stands", () => {
    say("Archived", undoable());
    expect(screen.getByRole("button", { name: /Undo/ }).textContent).toContain("z");
  });
});
