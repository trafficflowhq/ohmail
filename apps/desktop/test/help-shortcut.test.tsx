/** @vitest-environment jsdom */
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountOvers } from "../../../packages/app/test/overs/over-world.js";
import { runMenuCommand } from "../src/DesktopGate.js";

afterEach(cleanup);

it("opens the registered key sheet from the native Help command", () => {
  mountOvers(() => null);
  expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  act(() => runMenuCommand("shortcuts"));
  expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
});
