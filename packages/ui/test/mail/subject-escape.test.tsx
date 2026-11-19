/** @vitest-environment jsdom */
/**
 * ESCAPE IN A SUBJECT LINE HANDS THE KEYS ON (the switch's point 66, PART B): where the head is handed a way out of
 * its subject (`subject.onEscape`: a reply's, back to its text), Escape there takes it and goes no further; where none
 * is handed, Escape is left to whatever listens above, as before.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Recipients } from "../../src/mail/index.js";

afterEach(cleanup);

const head = (subject: { onEscape?: () => void }, reply = true) =>
  render(
    <Recipients
      reply={reply}
      lines={[{ id: "to", label: "To", people: [], typed: "" }]}
      subject={{
        label: "Subject",
        placeholder: "Subject",
        value: "Re: Friday",
        onChange: () => undefined,
        ...subject,
      }}
    />,
  );

describe("Escape in the subject line", () => {
  it("calls the way out it is handed, once, and goes no further", () => {
    const onEscape = vi.fn();
    const above = vi.fn();
    head({ onEscape });
    document.addEventListener("keydown", above);
    const subject = screen.getByRole("textbox", { name: "Subject" });
    fireEvent.keyDown(subject, { key: "Escape" });
    document.removeEventListener("keydown", above);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(above, "the Escape went on to what listens above").not.toHaveBeenCalled();
  });

  it("CONTROL: with no way out handed, Escape goes on as before; another key calls nothing", () => {
    const onEscape = vi.fn();
    const above = vi.fn();
    head({});
    document.addEventListener("keydown", above);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Subject" }), { key: "Escape" });
    document.removeEventListener("keydown", above);
    expect(above).toHaveBeenCalledTimes(1);
    cleanup();
    head({ onEscape });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Subject" }), { key: "a" });
    expect(onEscape).not.toHaveBeenCalled();
  });
});
