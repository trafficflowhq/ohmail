/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { message, mountShell, press, stubDom, unmountAll, waitFor } from "./_draft-shell.js";

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  stubDom();
  localStorage.clear();
});
afterEach(unmountAll);

describe("releasing a held sender", () => {
  it.each([
    ["screened", "ohmail/Screened"],
    ["spam", "ohmail/Quarantine"],
  ] as const)("%s: releasing to the Ohbox moves all twelve letters", async (segment, folder) => {
    const ids = Array.from({ length: 12 }, (_, index) => `m${String(index + 1).padStart(2, "0")}`);
    const letters = ids.map((id, index) => message(id, {
      folder,
      threadId: null,
      subject: `Subject ${id}`,
      date: new Date(Date.UTC(2026, 8, 24, index)).toISOString(),
    }));
    const shell = await mountShell(`#/screener/${segment}`, letters);
    const reading = await screen.findByRole("region", { name: "Reading" });
    await press(await within(reading).findByRole("button", { name: "Ohbox" }), "release to the Ohbox");

    const moved = () => shell.sent.flatMap((mutation) => mutation.kind === "move" ? [mutation.messageId] : []);
    await waitFor(() => moved().length >= letters.length, "all held moves to reach the server");
    expect(moved().sort()).toEqual(ids);
  });
});
