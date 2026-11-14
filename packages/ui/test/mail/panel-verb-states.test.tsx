/** @vitest-environment jsdom */
/**
 * TWO STATES OF A PANEL'S VERB THAT A PERSON HEARS (the switch's point 66): a verb REFUSED
 * for now (Send with nothing written) stays pressable, is said to be off, and its hint is the reason, so the press can
 * say why; a verb BUSY while its act runs (Send while the letter goes) says so. Neither changes how the verb looks: a
 * refused verb is drawn as an off one, as a resting one is.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActionPanel } from "../../src/mail/Reading/ActionPanel.js";

afterEach(cleanup);

describe("ActionPanel: a verb refused for now, and a verb at work", () => {
  it("a refused verb takes the press, is said off, and its hint is why", () => {
    const pressed: string[] = [];
    render(
      <ActionPanel
        label="Actions"
        items={[
          {
            id: "send",
            label: "Send",
            kind: "ink",
            refused: "Write something or attach a file.",
            onPress: () => void pressed.push("send"),
          },
        ]}
      />,
    );
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect({ disabled: send.disabled, said: send.getAttribute("aria-disabled"), hint: send.title }).toEqual({
      disabled: false,
      said: "true",
      hint: "Write something or attach a file.",
    });
    send.click();
    expect(pressed).toEqual(["send"]);
  });

  it("off wins: a verb refused and disabled takes no press", () => {
    const pressed: string[] = [];
    render(
      <ActionPanel
        label="Actions"
        items={[
          {
            id: "send",
            label: "Send",
            refused: "Not now.",
            disabled: true,
            onPress: () => void pressed.push("x"),
          },
        ]}
      />,
    );
    const send = screen.getByRole("button", { name: "Send" });
    send.click();
    expect(pressed).toEqual([]);
    expect(send.getAttribute("aria-disabled")).toBeNull();
  });

  it("a busy verb says it is at work; at rest it says nothing of it", () => {
    const { rerender } = render(
      <ActionPanel label="Actions" items={[{ id: "send", label: "Send", busy: true, disabled: true }]} />,
    );
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-busy")).toBe("true");
    rerender(<ActionPanel label="Actions" items={[{ id: "send", label: "Send" }]} />);
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-busy")).toBeNull();
  });
});
