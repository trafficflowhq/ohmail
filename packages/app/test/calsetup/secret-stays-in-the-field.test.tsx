/** @vitest-environment jsdom */
/**
 * WHAT A PERSON TYPES TO CONNECT A CALENDAR REACHES THE PORT ONCE AND NOTHING ELSE: a password and a subscription's
 * address typed into the sign-in are found afterwards in no address the frame wrote, no stored key, no report or
 * notice on the page, no line of the console and no record of the mirror, and the field is empty after the press.
 * Nor in the page's markup: the plant, a controlled field (each blank kept in state and handed `value`), turns the
 * markup case red, as React writes every keystroke into the field's `value` attribute.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ConnectAsk } from "@ohmail/app-logic/calendar/setup";
import { mirror, mountFrame, setupPort } from "./world.js";

const TYPED = "MARKER-typed-7f3a9c";
const ADDRESS = "https://feeds.studio.test/cal/MARKER-token-51be";
const USER = "MARKER-user@studio.test";

const CONSOLE = ["log", "info", "warn", "error", "debug"] as const;
let spies: MockInstance[] = [];

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  spies = CONSOLE.map((name) => vi.spyOn(console, name));
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  cleanup();
});

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
const fields = () => [...document.querySelectorAll("input")] as HTMLInputElement[];

/** Every place a typed value must not be found in, read as text. */
function everywhere(world: ReturnType<typeof mirror>, address: { writes: { next: string }[] }): string {
  const stored = [localStorage, sessionStorage]
    .flatMap((s) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`))
    .join("\n");
  const said = spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" "))).join("\n");
  return [
    address.writes.map((w) => decodeURIComponent(w.next)).join("\n"),
    stored,
    said,
    document.body.textContent ?? "",
    world.dump(),
  ].join("\n");
}

describe("a typed secret", () => {
  for (const answer of ["taken", "refused", "unsent"] as const) {
    it(`is handed to the port once and left nowhere else (iCloud, ${answer})`, async () => {
      const world = mirror();
      const connect = vi.fn(async (_ask: ConnectAsk) => {
        if (answer === "unsent") throw new Error("offline");
        return answer === "taken"
          ? ({ kind: "taken" } as const)
          : ({ kind: "refused", fault: "sign_in_refused" } as const);
      });
      const port = setupPort(async () => ["icloud"], { connect });
      const { address } = mountFrame("#/cal/cal-setup?step=signin&way=icloud", world, port);
      await act(async () => undefined);
      type("Apple Account email address", USER);
      type("App-specific password", TYPED);
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
      expect(fields().every((input) => input.value === "")).toBe(true);
      await act(async () => undefined);

      expect(connect).toHaveBeenCalledTimes(1);
      expect(connect.mock.calls[0]![0]).toMatchObject({ way: "icloud", user: USER, password: TYPED });
      const found = everywhere(world, address);
      expect(found).not.toContain(TYPED);
      expect(found).not.toContain(USER);
      expect(found).not.toContain("MARKER");
    });
  }

  it("is in no attribute of the page while typed, nor after the press", async () => {
    mountFrame(
      "#/cal/cal-setup?step=signin&way=icloud",
      mirror(),
      setupPort(async () => ["icloud"]),
    );
    await act(async () => undefined);
    type("Apple Account email address", USER);
    type("App-specific password", TYPED);
    const typed = document.documentElement.outerHTML;
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    await act(async () => undefined);
    expect(typed.includes("MARKER")).toBe(false);
    expect(document.documentElement.outerHTML.includes("MARKER")).toBe(false);
  });

  it("keeps a subscription's address out of the frame's address and the stage's words", async () => {
    const world = mirror();
    const port = setupPort(async () => ["ics"]);
    const { address } = mountFrame("#/cal/cal-setup?step=signin&way=ics", world, port);
    await act(async () => undefined);
    type("The calendar’s address", ADDRESS);
    fireEvent.keyDown(screen.getByLabelText("The calendar’s address"), { key: "Enter" });
    expect(fields().every((input) => input.value === "")).toBe(true);
    await act(async () => undefined);

    expect(port.connect).toHaveBeenCalledTimes(1);
    expect(address.writes.at(-1)?.next).toMatch(/step=calendars/);
    expect(everywhere(world, address)).not.toContain("MARKER");
  });

  it("empties a field that leaves with the step, and sends nothing for an empty blank", async () => {
    const world = mirror();
    const port = setupPort(async () => ["caldav"]);
    const { address } = mountFrame("#/cal/cal-setup?step=signin&way=caldav", world, port);
    await act(async () => undefined);
    type("Password", TYPED);
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    expect(port.connect).not.toHaveBeenCalled();
    expect(screen.getByText("Every blank needs filling. Nothing was sent.")).toBeTruthy();
    type("Password", TYPED);
    const held = screen.getByLabelText("Password") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await act(async () => undefined);
    expect(held.value).toBe("");
    expect(everywhere(world, address)).not.toContain("MARKER");
  });
});
