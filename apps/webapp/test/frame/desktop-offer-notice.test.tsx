/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import {
  act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh,
  scriptSession, sessionCalls, sessionFull, teardownConfirmEnv, tick,
} from "../fixtures/cloud-confirm-shell";
import { ROSTER } from "../_draft-shell";

beforeEach(() => {
  installConfirmEnv();
  localStorage.clear();
  window.location.hash = "#/ohbox";
});

afterEach(async () => {
  await teardownConfirmEnv();
  window.history.replaceState(null, "", "/");
});

describe("the desktop download in the mail frame", () => {
  it("offers the desktop app in a signed-in browser, and a dismissal keeps it away", async () => {
    scriptSession(sessionFull);
    scriptRefresh(refresh204);
    rememberOwner();
    const wire = globalThis.fetch;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path.endsWith("/mailboxes")) return Promise.resolve(Response.json({ items: ROSTER }));
      return wire(input, init);
    }) as typeof fetch;
    const view = within(await mountCloudShell());
    await tick(2500);
    expect(view.getByRole("navigation", { name: "Places" })).toBeTruthy();

    expect(view.queryByRole("button", { name: en.rail.getDesktopOpen })).toBeNull();
    await act(async () => {
      window.location.hash = "#/settings/general";
      window.dispatchEvent(new Event("hashchange"));
    });
    const download = view.getByRole("button", { name: en.rail.getDesktopOpen });
    expect(view.getByText(en.rail.getDesktop, { exact: true })).toBeTruthy();
    expect(download.closest('[role="status"]')).toBeNull();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await act(async () => void fireEvent.click(download));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://github.com/trafficflowhq/ohmail/releases/latest", "_blank", "noopener,noreferrer",
    );
    await act(async () => {
      window.location.hash = "#/ohbox";
      window.dispatchEvent(new Event("hashchange"));
    });
    const sameBrowser = within(await mountCloudShell());
    await tick(2500);
    expect(sameBrowser.getByRole("navigation", { name: "Places" })).toBeTruthy();
    expect(sameBrowser.queryByRole("button", { name: en.rail.getDesktopOpen })).toBeNull();
  });

  it("withholds the offer in the demo", async () => {
    window.history.replaceState(null, "", "/?demo=1#/ohbox");
    const view = within(await mountCloudShell());
    await tick(2500);
    expect(view.getByRole("navigation", { name: "Places" })).toBeTruthy();
    expect(sessionCalls()).toBe(0);
    expect(view.queryByRole("button", { name: en.rail.getDesktopOpen })).toBeNull();
  });
});
