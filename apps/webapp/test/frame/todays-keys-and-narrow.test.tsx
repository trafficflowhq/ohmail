/** @vitest-environment jsdom */
/**
 * WHAT THE OLD CHROME CARRIED THAT TODAY'S VIEWS STILL NEED IN THE FRAME. Today's keys step into the rail (`h`, and
 * ArrowLeft from a row): the frame's fed rail stands where today's zone model looks for it. A settings section on a
 * narrow window has its way back to the section list, which the old top bar carried.
 */
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, engineOver, msg, S, setup, shell, storeWith, teardown, waitFor } from "../_view-shell";

beforeEach(setup);
afterEach(teardown);

const inRail = (): boolean => document.activeElement?.closest("nav[aria-label='Main']") != null;

describe("today's keys and the frame's rail", () => {
  for (const [what, init] of [["h", { key: "h" }], ["ArrowLeft", { key: "ArrowLeft" }]] as const) {
    it(`${what} from a row steps into the rail`, async () => {
      const store = await storeWith([msg("m1")]);
      const el = await shell(store, engineOver(store));
      await waitFor(() => el.querySelector(".row[data-id='m1']") != null, "the row");
      const row = el.querySelector<HTMLElement>(".row[data-id='m1']")!;
      await act(async () => { row.focus(); });
      expect(inRail()).toBe(false);
      await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, init); });
      await waitFor(inRail, "focus in the rail");
    });
  }
});

describe("a settings section on a narrow window", () => {
  it("has its way back to the section list", async () => {
    S.mobile = true;
    const store = await storeWith([]);
    const el = await shell(store, engineOver(store), "#/settings/general");
    const back = await (async () => {
      await waitFor(() => el.querySelector("button[aria-label='Back to Settings']") != null, "the way back");
      return el.querySelector<HTMLButtonElement>("button[aria-label='Back to Settings']")!;
    })();
    await act(async () => { back.click(); });
    expect(window.location.hash).toBe("#/settings");
  });
});
