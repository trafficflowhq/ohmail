/** @vitest-environment jsdom */
/**
 * A SIGN-IN STARTS EMPTY EVERY TIME: a mount at the sign-in, after a reload or a way back, has empty blanks, and the
 * blanks ask the browser and the phone to keep, correct and capitalise nothing.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mirror, mountFrame, setupPort } from "./world.js";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

const inputs = () => [...document.querySelectorAll("input")] as HTMLInputElement[];

describe("the sign-in after a reload", () => {
  it("starts with empty blanks, whatever was typed before", async () => {
    const world = mirror();
    const port = setupPort(async () => ["caldav"]);
    const first = mountFrame("#/cal/cal-setup?step=signin&way=caldav", world, port);
    await act(async () => undefined);
    fireEvent.change(screen.getByLabelText("The server’s address"), { target: { value: "dav.studio.test" } });
    fireEvent.change(screen.getByLabelText("User name"), { target: { value: "mila" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "typed-before" } });
    const before = inputs();
    first.unmount();
    expect(before.every((input) => input.value === "")).toBe(true);

    mountFrame("#/cal/cal-setup?step=signin&way=caldav", world, port);
    await act(async () => undefined);
    expect(inputs()).toHaveLength(3);
    expect(inputs().every((input) => input.value === "")).toBe(true);
  });

  it("keeps what is being typed while the step draws again, and empties it at the press", async () => {
    const world = mirror();
    const port = setupPort(async () => ["icloud"]);
    mountFrame("#/cal/cal-setup?step=signin&way=icloud", world, port);
    await act(async () => undefined);
    fireEvent.change(screen.getByLabelText("Apple Account email address"), {
      target: { value: "mila@studio.test" },
    });
    act(() => world.put("calendar_connection", "conn-9", { id: "conn-9" }));
    expect((screen.getByLabelText("Apple Account email address") as HTMLInputElement).value).toBe(
      "mila@studio.test",
    );
    fireEvent.change(screen.getByLabelText("App-specific password"), { target: { value: "typed" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    expect(inputs().every((input) => input.value === "")).toBe(true);
  });

  it("asks for nothing to be kept, corrected or capitalised", async () => {
    mountFrame(
      "#/cal/cal-setup?step=signin&way=icloud",
      mirror(),
      setupPort(async () => ["icloud"]),
    );
    await act(async () => undefined);
    for (const input of inputs()) {
      expect(input.getAttribute("autocomplete")).toBe(input.type === "password" ? "new-password" : "off");
      expect(input.getAttribute("spellcheck")).toBe("false");
      expect(input.getAttribute("autocapitalize")).toBe("off");
      expect(input.getAttribute("name")).toBeNull();
    }
  });
});
