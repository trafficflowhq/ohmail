/** @vitest-environment jsdom */
/**
 * The frame honours the existing shortcuts into the mail rail and gives a narrow Settings section a way back.
 */
import {
  ISO, act, answerSyncWith, installShellEnv, mailbox, mountShell, page, teardownShellEnv, tick,
} from "../fixtures/live-walk-shell";
import { fireEvent, getByRole } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_PANE_PARTS } from "../../app/(product)/mailbox/pane-parts";
import messages from "../../messages/en.json";

beforeEach(() => {
  installShellEnv();
  localStorage.clear();
});
afterEach(async () => {
  await teardownShellEnv();
  vi.unstubAllGlobals();
});

describe("today's keys and the frame's rail", () => {
  for (const [what, init] of [["h", { key: "h" }], ["ArrowLeft", { key: "ArrowLeft" }]] as const) {
    it(`${what} from a row steps into the rail`, async () => {
      const synced = page(1);
      answerSyncWith(() => synced.clone());
      window.location.hash = "#/ohbox";
      const shell = await mountShell([mailbox({ lastSyncAt: ISO, id: "mb_1" })]);
      await tick(1_000);
      const row = getByRole(shell, "option", { name: /subject of m1/i });
      const rail = getByRole(shell, "navigation", { name: "Places" });
      await act(async () => { row.focus(); });
      expect(rail.contains(document.activeElement)).toBe(false);
      await act(async () => { fireEvent.keyDown(row, init); });
      await tick(0);
      expect(rail.contains(document.activeElement)).toBe(true);
    });
  }
});

describe("a settings section on a narrow window", () => {
  it("has its way back to the section list", async () => {
    vi.stubGlobal("innerWidth", 430);
    window.location.hash = "#/settings/general";
    const shell = await mountShell([], { general: WEB_PANE_PARTS.general });
    await act(async () => { getByRole(shell, "button", { name: messages.settings.back }).click(); });
    await tick(1_000);
    expect(window.location.hash).toBe("#/settings");
    expect(getByRole(shell, "navigation", { name: messages.settings.navAria })).toBeTruthy();
  });
});
