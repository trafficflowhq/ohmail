/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { Frame } from "../../src/frame/Frame.js";
import { paletteOver } from "../../src/palette/index.js";
import { TextProvider } from "../../src/text/index.js";
import searchEn from "../../messages/search.en.json" with { type: "json" };
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { mountOvers, press } from "./over-world.js";

afterEach(cleanup);

it("opens the same shortcut sheet from the palette and the question-mark key", () => {
  mountOvers(() => null);
  act(() => press("k", { ctrlKey: true }));
  const palette = screen.getByRole("dialog", { name: "Command palette" });
  const command = within(palette).getByText("Keyboard shortcuts");
  fireEvent.click(command);
  const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  act(() => press("?", { shiftKey: true }));
  expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
});

it("runs the current question-mark binding when the palette command is clicked", () => {
  const run = vi.fn();
  function Probe() {
    useKeyBindings([{ chord: "?", group: "app", label: "Probe", run }], "view");
    return null;
  }
  mountOvers(() => <Probe />);
  act(() => press("k", { ctrlKey: true }));
  fireEvent.click(screen.getByText("Keyboard shortcuts"));
  expect(run).toHaveBeenCalledTimes(1);
});

it("offers one command with the question-mark keycap", () => {
  mountOvers(() => null);
  act(() => press("k", { ctrlKey: true }));
  const palette = screen.getByRole("dialog", { name: "Command palette" });
  const [command] = within(palette).getAllByRole("option", { name: /Keyboard shortcuts/ });
  expect(within(palette).getAllByRole("option", { name: /Keyboard shortcuts/ })).toHaveLength(1);
  expect(within(command!).getByText("?")).toBeTruthy();
});

it("omits the command on a host without a shortcut binding", () => {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "shortcut-test",
    places: {
      ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: () => null } },
    },
    overs: { palette: paletteOver },
  });
  render(
    <TextProvider
      locale="en"
      timeZone="UTC"
      messages={{ ...FRAME_WORDS.en, palette: searchEn.palette, shortcuts: searchEn.shortcuts }}
    >
      <Frame host={host} />
    </TextProvider>,
  );
  act(() => press("k", { ctrlKey: true }));
  const palette = screen.getByRole("dialog", { name: "Command palette" });
  expect(within(palette).queryByRole("option", { name: /Keyboard shortcuts/ })).toBeNull();
});

it("shows the enabled movement binding in the sheet reached from the palette", () => {
  function Probe() {
    useKeyBindings(
      [
        {
          chord: "ArrowDown",
          group: "navigate",
          label: "Shadowed and disabled",
          disabled: true,
          run: () => {},
        },
        { chord: "ArrowDown", group: "navigate", label: "Next message", run: () => {} },
      ],
      "view",
    );
    return null;
  }
  mountOvers(() => <Probe />);
  act(() => press("k", { ctrlKey: true }));
  fireEvent.click(screen.getByText("Keyboard shortcuts"));
  const sheet = within(screen.getByRole("dialog", { name: "Keyboard shortcuts" }));
  expect(sheet.getByText("Next message")).toBeTruthy();
  expect(sheet.queryByText("Shadowed and disabled")).toBeNull();
});
