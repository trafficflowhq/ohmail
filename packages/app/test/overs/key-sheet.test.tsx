/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useKeyBindings, useOptionalKeyBindings } from "@ohmail/app-logic/keys";
import { mountOvers, press } from "./over-world.js";

/**
 * THE KEY SHEET, mounted alone over the fake host: `?` opens it with every key live where the person was, read once
 * as it opens; a binding declared appears and one unmounted is gone; a key pressed over it closes it and does
 * nothing else.
 */
const filed: string[] = [];

/** A reading column whose `j` is live only while focus is inside it, as the zone model's keys are. */
function ReadingColumn() {
  const inside = () =>
    document.activeElement?.closest("[data-column]") !== null && document.activeElement !== null;
  useOptionalKeyBindings(
    () => [
      { chord: "j", group: "navigate", label: "Next letter", disabled: !inside(), run: () => undefined },
    ],
    "view",
    (changed) => {
      document.addEventListener("focusin", changed);
      return () => document.removeEventListener("focusin", changed);
    },
  );
  return (
    <section data-column="">
      <button type="button">in the letter</button>
    </section>
  );
}

function Archive() {
  useKeyBindings([{ chord: "e", group: "message", label: "Archive it", run: () => filed.push("e") }]);
  return null;
}

function Place() {
  const [archive, setArchive] = useState(true);
  return (
    <>
      <ReadingColumn />
      {archive ? <Archive /> : null}
      <button type="button" onClick={() => setArchive(false)}>
        drop archive
      </button>
    </>
  );
}

const openSheet = () => act(() => press("?"));
const sheet = () => screen.queryByRole("dialog", { name: /Keyboard shortcuts/ });

beforeEach(() => {
  filed.length = 0;
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => cleanup());

describe("the key sheet", () => {
  it("lists a binding declared, and not one whose part has gone", () => {
    mountOvers(() => <Place />);
    openSheet();
    expect(sheet()).not.toBeNull();
    expect(screen.getByText("Archive it")).toBeTruthy();
    act(() => press("Escape", {}, document.activeElement!));
    expect(sheet()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "drop archive" }));
    openSheet();
    expect(screen.queryByText("Archive it")).toBeNull();
  });

  it("opened from the reading column, lists that column's keys while focus is in the sheet", () => {
    mountOvers(() => <Place />);
    act(() => screen.getByRole("button", { name: "in the letter" }).focus());
    act(() => press("?", {}, screen.getByRole("button", { name: "in the letter" })));
    expect(sheet()).not.toBeNull();
    expect(sheet()!.contains(document.activeElement)).toBe(true);
    expect(screen.getByText("Next letter")).toBeTruthy();
  });

  it("closes on a letter typed over it, which files nothing", () => {
    mountOvers(() => <Place />);
    openSheet();
    act(() => press("e", {}, document.activeElement!));
    expect(sheet()).toBeNull();
    expect(filed).toEqual([]);
  });

  it("stays for Tab and a bare modifier", () => {
    mountOvers(() => <Place />);
    openSheet();
    act(() => press("Shift", {}, document.activeElement!));
    act(() => press("Tab", {}, document.activeElement!));
    expect(sheet()).not.toBeNull();
  });
});
