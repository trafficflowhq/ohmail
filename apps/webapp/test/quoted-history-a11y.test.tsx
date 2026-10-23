/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { BodyText } from "../app/shell/BodyText";
import { MessageBody } from "../app/components/MessageBody";
import { qhFixtures } from "../../../packages/client-engine/test/quoted-history-fixtures.js";

/**
 * THE HISTORY TOGGLE IS A REAL CONTROL — on the text path and over a frame alike: Tab reaches it,
 * Enter and Space toggle it, focus stays on it, `aria-expanded` says the state and `aria-controls`
 * names a region that exists while it is open.
 */
afterEach(cleanup);
const fx = (id: string) => qhFixtures().find((f) => f.id === id)!;

async function operate(container: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  const toggle = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>("button.msg-history-toggle")!;
  await user.tab();
  // The first focusable control in a text body is the toggle; over a frame it may follow the frame.
  for (let i = 0; i < 4 && document.activeElement !== toggle(); i++) await user.tab();
  expect(document.activeElement, "Tab reaches the toggle").toBe(toggle());
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  const controls = toggle().getAttribute("aria-controls");
  expect(controls, "it names what it controls").toBeTruthy();
  await user.keyboard("{Enter}");
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(controls!), "the controlled region exists while open").not.toBeNull();
  expect(document.activeElement, "focus stays on the toggle").toBe(toggle());
  await user.keyboard(" ");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(toggle());
}

describe("the toggle by keyboard", () => {
  it("the text part (Exchange plain)", async () => {
    const { container } = render(<BodyText text={fx("37").text} />);
    await operate(container);
    expect(container.querySelector(".msg-history")).toBeNull();
  });

  it("a prose html body (Outlook)", async () => {
    const { container } = render(<MessageBody messageId="m1" text={fx("01").text} html={fx("01").html} />);
    await operate(container);
  });

  it("a framed body: the toggle stands outside the frame and controls its sheet", async () => {
    const { container } = render(<MessageBody messageId="m1" text="" html={fx("13").html} />);
    expect(container.querySelector("iframe")).not.toBeNull();
    await operate(container);
    const id = container.querySelector("button.msg-history-toggle")!.getAttribute("aria-controls")!;
    expect(document.getElementById(id)?.classList.contains("mb-sheet")).toBe(true);
  });
});
