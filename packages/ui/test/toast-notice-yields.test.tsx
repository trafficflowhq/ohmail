/** @vitest-environment jsdom */
/**
 * A NOTICE NOBODY PRESSED FOR WAITS. Measured on 0.23.1: Undo pressed 549 ms after a Screener
 * decision, "Undone" drawn, and at 1558 ms the automatic suggestion batch's summary replaced it,
 * because a notice replaced a notice. A `yields` notice now waits for the standing one's window
 * and draws after its fade; every other notice still replaces whatever stands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ToastHost, useToast, type ToastFn } from "@ohmail/ui";

let say: ToastFn = () => undefined;
function Grab(): null {
  say = useToast();
  return null;
}

const UNDO_MS = 8000;
const NOTICE_MS = 2600;
const FADE_MS = 300;
const held = (): HTMLElement | null => document.querySelector(".toast-held");
const notice = (): HTMLElement => document.querySelectorAll<HTMLElement>('[role="status"]')[1]!;
const undoButton = (): HTMLButtonElement | null => document.querySelector(".toast-held .toast-act");
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const shows = (): string => (notice().className.includes("on") ? notice().textContent ?? "" : "");

beforeEach(() => {
  vi.useFakeTimers();
  render(<ToastHost><Grab /></ToastHost>);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the recorded sequence: decision, Undo, then the batch's summary", () => {
  it("'Undone' stays for its whole window and the summary draws after it", () => {
    act(() => say("Screened out.", { action: "Undo", onAction: () => say("Undone."), duration: UNDO_MS }));
    tick(549);
    fireEvent.click(undoButton()!);
    expect(shows()).toBe("Undone.");
    tick(1558 - 549);
    act(() => say("1 suggestion · 1 credit used.", { yields: true }));
    tick(2000 - 1558);
    expect(shows(), "the confirmation is not replaced by the summary").toBe("Undone.");
    tick(549 + NOTICE_MS - 2000 - 1);
    expect(shows(), "to the end of its own window").toBe("Undone.");
    tick(1);
    expect(shows(), "then it fades").toBe("");
    tick(FADE_MS - 1);
    expect(shows(), "for the whole fade").toBe("");
    tick(1);
    expect(shows(), "and the summary follows, never dropped").toBe("1 suggestion · 1 credit used.");
    tick(NOTICE_MS);
    expect(shows(), "on its own timer").toBe("");
  });

  it("beside a standing Undo capsule the summary shows beneath at once and the Undo stays pressable", () => {
    const onAction = vi.fn();
    act(() => say("Ohbox — filed.", { action: "Undo", onAction, duration: UNDO_MS }));
    tick(300);
    act(() => say("1 suggestion · 1 credit used.", { yields: true }));
    expect(shows(), "no notice stands, so nothing to wait for").toBe("1 suggestion · 1 credit used.");
    tick(1700);
    expect(held()?.className).toContain("on");
    fireEvent.click(undoButton()!);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe("what a yielding notice may and may not replace", () => {
  it("a newer yielding notice supersedes the one waiting; the older is never drawn", () => {
    act(() => say("Deleted."));
    act(() => say("First summary.", { yields: true }));
    tick(500);
    act(() => say("Second summary.", { yields: true }));
    tick(NOTICE_MS - 500 + FADE_MS);
    expect(shows()).toBe("Second summary.");
    tick(NOTICE_MS + FADE_MS);
    expect(shows(), "nothing else was waiting").toBe("");
  });

  it("a newer one arriving in the fade draws at once, and the one that waited is dropped", () => {
    act(() => say("Undone."));
    act(() => say("First summary.", { yields: true }));
    tick(NOTICE_MS + 100);
    act(() => say("Second summary.", { yields: true }));
    expect(shows()).toBe("Second summary.");
    tick(NOTICE_MS + FADE_MS + 100);
    expect(shows(), "the superseded summary never follows").toBe("");
  });

  it("a yielding notice replaces a standing notice of its own class", () => {
    act(() => say("First summary.", { yields: true }));
    tick(1000);
    act(() => say("Second summary.", { yields: true }));
    expect(shows()).toBe("Second summary.");
  });

  it("with nothing standing it draws at once", () => {
    act(() => say("1 suggestion · 1 credit used.", { yields: true }));
    expect(shows()).toBe("1 suggestion · 1 credit used.");
  });

  it("after a notice has faded it draws at once", () => {
    act(() => say("Saved."));
    tick(NOTICE_MS);
    act(() => say("1 suggestion · 1 credit used.", { yields: true }));
    expect(shows()).toBe("1 suggestion · 1 credit used.");
  });
});

describe("interrupting notices still pre-empt", () => {
  it("a refusal replaces a standing yielding notice at once", () => {
    act(() => say("1 suggestion · 1 credit used.", { yields: true }));
    tick(500);
    act(() => say("Could not be saved."));
    expect(shows()).toBe("Could not be saved.");
  });

  it("a refusal arriving while a summary waits takes the slot, and the summary waits behind it too", () => {
    act(() => say("Undone."));
    act(() => say("1 suggestion · 1 credit used.", { yields: true }));
    tick(1000);
    act(() => say("Could not be saved."));
    expect(shows(), "the refusal is not held back").toBe("Could not be saved.");
    tick(NOTICE_MS - 1);
    expect(shows(), "on its own window").toBe("Could not be saved.");
    tick(1 + FADE_MS);
    expect(shows()).toBe("1 suggestion · 1 credit used.");
  });

  it("a notice replaces a notice when neither yields, as before", () => {
    act(() => say("Undone."));
    tick(500);
    act(() => say("Saved."));
    expect(shows()).toBe("Saved.");
    tick(NOTICE_MS + FADE_MS);
    expect(shows(), "the replaced notice never comes back").toBe("");
  });
});

describe("a notice with a dismiss button stands until it is pressed", () => {
  it("is a status named by its sentence, stays past any window, and leaves on its button", () => {
    act(() => say("The window was reloaded.", { dismiss: "Dismiss" }));
    expect(screen.getByRole("status", { name: "The window was reloaded." })).toBe(notice());
    tick(60_000);
    expect(shows(), "no timer takes it").toBe("The window was reloaded.Dismiss");
    const button = within(notice()).getByRole("button", { name: "Dismiss" });
    button.focus();
    expect(document.activeElement, "reachable from the keyboard").toBe(button);
    fireEvent.click(button);
    expect(shows()).toBe("");
    tick(FADE_MS);
    expect(screen.queryByRole("status", { name: "The window was reloaded." })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("a yielding notice waits behind it and draws after the dismiss", () => {
    act(() => say("The window was reloaded.", { dismiss: "Dismiss" }));
    act(() => say("1 suggestion · 1 credit used.", { yields: true }));
    tick(10_000);
    expect(shows()).toBe("The window was reloaded.Dismiss");
    fireEvent.click(within(notice()).getByRole("button", { name: "Dismiss" }));
    tick(FADE_MS);
    expect(shows()).toBe("1 suggestion · 1 credit used.");
    expect(within(notice()).queryByRole("button")).toBeNull();
    tick(NOTICE_MS);
    expect(shows(), "on its own timer").toBe("");
  });

  it("the Undo capsule is a status named by its sentence too", () => {
    act(() => say("Archived.", { action: "Undo", onAction: () => undefined, duration: UNDO_MS }));
    expect(screen.getByRole("status", { name: "Archived." })).toBe(held());
  });
});
