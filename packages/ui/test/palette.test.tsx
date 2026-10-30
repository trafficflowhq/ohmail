/** @vitest-environment jsdom */
/**
 * CommandPalette + useCommandPalette: opens on ⌘K, filters, runs on
 * Enter, closes on Escape.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette, useCommandPalette, type Command } from "@ohmail/ui";

afterEach(cleanup);

function Harness({ commands }: { commands: Command[] }) {
  const pal = useCommandPalette();
  return (
    <CommandPalette
      open={pal.open}
      onClose={pal.closePalette}
      commands={commands}
      placeholder="Type a command…"
      emptyHint="No command — try “screener”, “tag”, “theme”…"
      ariaLabel="Command palette"
      footNavigate="navigate"
      footRun="run"
      footClose="close"
    />
  );
}

const commands = (run = vi.fn()): Command[] => [
  { id: "ohbox", label: "Go to Ohbox", keys: ["g", "o"], run },
  { id: "screener", label: "Open Screener", keys: ["g", "s"], run: vi.fn() },
  { id: "theme", label: "Toggle light / dark", run: vi.fn() },
];

describe("useCommandPalette + CommandPalette", () => {
  it("opens on meta+k and closes on meta+k again", () => {
    render(<Harness commands={commands()} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on ctrl+k too", () => {
    render(<Harness commands={commands()} />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("filters, runs the selected command on Enter and closes", () => {
    const run = vi.fn();
    render(<Harness commands={commands(run)} />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });

    const input = screen.getByPlaceholderText("Type a command…");
    fireEvent.change(input, { target: { value: "ohbox" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("matches a phrase word by word, so 'go to ohbox' finds 'Go to the Ohbox'", () => {
    const run = vi.fn();
    render(<Harness commands={[{ id: "o", label: "Go to the Ohbox", run }, { id: "n", label: "Go to News", run: vi.fn() }]} />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = screen.getByPlaceholderText("Type a command…");
    fireEvent.change(input, { target: { value: "go to ohbox" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Go to the Ohbox"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("matches every typed word, in any order, and nothing when one word is missing", () => {
    render(<Harness commands={commands()} />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = screen.getByPlaceholderText("Type a command…");
    fireEvent.change(input, { target: { value: "  go  ohbox " } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Go to Ohbox")]);
    fireEvent.change(input, { target: { value: "go screener" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("lists a disabled command, refuses to run it, and does not close on it", () => {
    // A command whose target is absent stays in the list — a row that vanishes with the
    // cursor is a row nobody learns — and says so, the way the `?` sheet dims a `disabled`
    // binding. Closing would be the one outcome that reads as "that worked", so ↵ and a
    // click both leave the palette exactly where it is.
    const run = vi.fn();
    render(<Harness commands={[{ id: "b", label: "Resurface selection", disabled: true, run }]} />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });

    const row = screen.getByRole("option");
    expect(row.getAttribute("aria-disabled")).toBe("true");

    fireEvent.keyDown(screen.getByPlaceholderText("Type a command…"), { key: "Enter" });
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(row);
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("the Enter that runs a command is consumed, so it cannot press the control focus returns to", () => {
    // with a rail item as the opener, the close handed focus back to it and the same
    // Enter activated it — "Go to News" ran and the rail's Ohbox button undid it. A cancelled
    // keydown is the one signal the browser and the shell's keymap both read as "handled".
    const run = vi.fn();
    render(<Harness commands={commands(run)} />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const live = fireEvent.keyDown(screen.getByPlaceholderText("Type a command…"), { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(live, "the Enter was left to act a second time").toBe(false);
  });

  it("closes on Escape from the input", () => {
    render(<Harness commands={commands()} />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    fireEvent.keyDown(screen.getByPlaceholderText("Type a command…"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
