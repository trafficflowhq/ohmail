/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopGate } from "../src/DesktopGate.js";
import { DesktopLocale } from "../src/DesktopLocale.js";
import { DOORS, plantShell, type Pipe } from "./_doors-harness.js";

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const shell = globalThis as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } };
const mailbox = { id: "settings-mailbox", address: ["settings", "example.invalid"].join("@") };
const webOpen = "Open in browser";
const webNoBrowser = /this computer would not open a browser/i;

let pipe: Pipe | undefined;

afterEach(() => {
  cleanup();
  pipe?.unplant();
  pipe = undefined;
  vi.unstubAllGlobals();
  window.location.hash = "";
  localStorage.clear();
});

function engine(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health") return Promise.resolve(Response.json({ signedIn: true }));
  if (path === "/mailboxes") return Promise.resolve(Response.json({ items: [mailbox] }));
  if (path === "/sync/snapshot") {
    return Promise.resolve(Response.json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } }));
  }
  if (path === "/sync") {
    return Promise.resolve(Response.json({
      changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MA", hasMore: false,
      serverTime: "2026-01-01T00:00:00.000Z",
    }));
  }
  return Promise.resolve(Response.json({}, { status: 404 }));
}

function mount(door: keyof typeof DOORS, hash: string) {
  window.location.hash = hash;
  pipe = plantShell(DOORS[door](mailbox), engine, "fixture");
  const nativeOpen = vi.fn(async (_payload: Record<string, unknown> | undefined) => undefined);
  const { invoke } = shell.__TAURI_INTERNALS__;
  shell.__TAURI_INTERNALS__.invoke = (command, payload) =>
    command === "open_link" ? nativeOpen(payload) : invoke(command, payload);
  const fetch = vi.fn(async () => { throw new Error("The desktop must ask its own engine"); });
  vi.stubGlobal("fetch", fetch);
  render(<DesktopLocale><DesktopGate /></DesktopLocale>);
  return { nativeOpen, fetch };
}

describe("Account in the desktop's Settings", () => {
  it("opens the managed account in the browser only when asked, and reports a browser refusal", async () => {
    const { nativeOpen, fetch } = mount("D-m", "#/settings/account");
    expect(await screen.findByRole("heading", { name: "Your ohmail account" })).toBeTruthy();
    expect(window.location.hash).toBe("#/settings/account");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(nativeOpen).not.toHaveBeenCalled();

    const open = screen.getByRole("button", { name: webOpen });
    nativeOpen.mockRejectedValueOnce(new Error("Browser refused"));
    fireEvent.click(open);
    expect(await screen.findByText(webNoBrowser)).toBeTruthy();
    expect(nativeOpen.mock.calls).toEqual([[{ key: "account" }]]);

    fireEvent.click(open);
    await waitFor(() => expect(screen.queryByText(webNoBrowser)).toBeNull());
    expect(nativeOpen.mock.calls).toEqual([[{ key: "account" }], [{ key: "account" }]]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists Account when Settings opens from the rail", async () => {
    const { nativeOpen, fetch } = mount("D-m", "#/ohbox");
    const rail = await screen.findByRole("navigation", { name: "Places" });
    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    expect(window.location.hash).toBe("#/settings");

    const menu = await screen.findByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(menu).getByRole("button", { name: "Account" }));
    expect(window.location.hash).toBe("#/settings/account");
    const open = await screen.findByRole("button", { name: webOpen });
    await act(async () => { fireEvent.click(open); });
    expect(nativeOpen.mock.calls).toEqual([[{ key: "account" }]]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["on its own", "D-l"],
    ["paired to another computer", "D-p"],
    ["signed in to a self-hosted server", "D-s"],
  ] as const)("withholds the managed Account action when the desktop is %s", async (_, door) => {
    const { nativeOpen, fetch } = mount(door, "#/settings/account");
    await screen.findByRole("navigation", { name: "Places" });
    expect(screen.queryByRole("button", { name: webOpen })).toBeNull();
    expect(nativeOpen).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
