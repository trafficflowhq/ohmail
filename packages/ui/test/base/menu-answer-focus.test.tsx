/** @vitest-environment jsdom */
/**
 * AN ANSWERED MENU DOES NOT TAKE THE KEYBOARD BACK: where a menu's answer moved
 * the keys on (to the next letter, to a field it opened), closing the menu leaves them there; it gives them back to
 * the control that opened it only where they would otherwise be lost: Escape, Tab, an answer that moved nothing.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, Menu, MenuItem } from "../../src/base/index.js";

afterEach(cleanup);

function Asked() {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const next = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button ref={anchor} opens="menu" expanded={open} onPress={() => setOpen(true)}>
        Resurface
      </Button>
      <button ref={next} type="button">
        The next letter
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label="Resurface">
        <MenuItem
          onPress={() => {
            setOpen(false);
            next.current?.focus();
          }}
        >
          Tomorrow
        </MenuItem>
        <MenuItem onPress={() => setOpen(false)}>Now</MenuItem>
      </Menu>
    </>
  );
}

const opened = () => {
  render(<Asked />);
  const button = screen.getByRole("button", { name: "Resurface" });
  button.focus();
  fireEvent.click(button);
  return button;
};

describe("a menu closing after its answer", () => {
  it("leaves the keys where the answer moved them", () => {
    opened();
    act(() => screen.getByRole("menuitem", { name: "Tomorrow" }).click());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "The next letter" }));
  });

  it("gives them back to its control where the answer moved nothing: they would be lost", () => {
    const button = opened();
    act(() => screen.getByRole("menuitem", { name: "Now" }).click());
    expect(document.activeElement).toBe(button);
  });

  it("gives them back to its control on Escape, as ever", () => {
    const button = opened();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Tomorrow" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
