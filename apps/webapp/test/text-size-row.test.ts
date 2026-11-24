/** @vitest-environment jsdom */
/**
 * SETTINGS → TEXT SIZE, THE ROW's PRESS: it stores the size first, then applies it through the host's door.
 * The browser's registered General pane calls its text-size applier after persisting the preference.
 */
import { act, installShellEnv, mountShell, teardownShellEnv } from "./fixtures/live-walk-shell";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getByRole } from "@testing-library/react";
import { TEXT_SIZE_KEY, installTextSizeApplier } from "../app/shell/text-size";
import { WEB_PANE_PARTS } from "../app/(product)/mailbox/pane-parts";

beforeEach(() => {
  installShellEnv();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  installTextSizeApplier(null);
});
afterEach(async () => {
  installTextSizeApplier(null);
  await teardownShellEnv();
});

describe("the host's door", () => {
  it("the row's press stores the size, then applies it through the door", async () => {
    const order: string[] = [];
    installTextSizeApplier((n) => order.push(`apply ${n} stored=${localStorage.getItem(TEXT_SIZE_KEY)}`));
    window.location.hash = "#/settings/general";
    const host = await mountShell([], { general: WEB_PANE_PARTS.general });
    await act(async () => { getByRole(host, "button", { name: "125%" }).click(); });
    expect(localStorage.getItem(TEXT_SIZE_KEY)).toBe("125");
    expect(order).toEqual(["apply 125 stored=125"]);
  });
});
