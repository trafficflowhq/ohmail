/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { en } from "../../../test/support/web-catalogues.js";
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
  if (path === "/auth/session") return Promise.resolve(Response.json({ user: { accountId: "fixture-account" } }));
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

function mount(door: keyof typeof DOORS, hash: string, {
  respond = () => undefined,
  native = () => undefined,
}: {
  respond?: (request: Request) => Response | undefined;
  native?: (command: string) => unknown;
} = {}) {
  window.location.hash = hash;
  pipe = plantShell(DOORS[door](mailbox), async (request) => respond(request) ?? engine(request), "fixture");
  const nativeOpen = vi.fn(async (_payload: Record<string, unknown> | undefined) => undefined);
  const { invoke } = shell.__TAURI_INTERNALS__;
  shell.__TAURI_INTERNALS__.invoke = async (command, payload) =>
    command === "open_link" ? nativeOpen(payload) : native(command) ?? invoke(command, payload);
  const fetch = vi.fn(async () => { throw new Error("The desktop must ask its own engine"); });
  vi.stubGlobal("fetch", fetch);
  render(<DesktopLocale><ThemeProvider storageKey={null}><ToastHost><DesktopGate /></ToastHost></ThemeProvider></DesktopLocale>);
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

describe("The desktop's native Settings panes", () => {
  it("shows the hosted connection read, engine summary and signed-in account", async () => {
    const address = ["signed-in", "example.test"].join("@");
    mount("D-m", "#/settings/desktop", { respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/auth/session") return Response.json({ user: { accountId: "fixture-account", email: address } });
      if (path === "/health") return Response.json({ signedIn: true, session: {
        state: "live", code: null, since: "2026-11-22T09:00:00Z",
      } });
    } });
    const pane = within(await screen.findByRole("region", { name: en.desktopDoor.paneLabel }));
    expect(pane.getByRole("group", { name: en.desktopDoor.connLabel }).textContent).toMatch(/Reachable · \d{1,2}:\d{2}/);
    const signOut = await pane.findByRole("group", { name: address });
    expect(within(signOut).getByRole("button", { name: en.desktopDoor.signOut })).toBeTruthy();
    expect(screen.getByText("ohmail Cloud · Running")).toBeTruthy();
  });

  it("opens the install switch and keeps the install when sign-out is cancelled", async () => {
    mount("D-m", "#/settings/desktop");
    const pane = within(await screen.findByRole("region", { name: en.desktopDoor.paneLabel }));
    expect(pane.getByRole("heading", { name: en.desktopDoor.installChangingHead })).toBeTruthy();
    fireEvent.click(pane.getByRole("button", { name: en.desktopDoor.signOut }));
    expect(pane.getByRole("group", { name: en.desktopDoor.installSignOutConfirm })).toBeTruthy();
    fireEvent.click(pane.getByRole("button", { name: en.desktopDoor.cancel }));
    expect(pane.queryByRole("group", { name: en.desktopDoor.installSignOutConfirm })).toBeNull();
    expect(pipe?.commands).not.toContain("engine_logout");
    expect(pipe?.asked).not.toContain("DELETE /cloud/session");
    fireEvent.click(pane.getByRole("button", { name: en.desktopDoor.installSwitchAction }));
    expect(await screen.findByRole("group", { name: en.desktopDoor.chooserGroupAria })).toBeTruthy();
    expect(pipe?.commands).not.toContain("engine_logout");
  });

  it("opens the account's Devices in the browser without enabling pairing", async () => {
    const { nativeOpen } = mount("D-m", "#/settings/devices");
    const pane = await screen.findByRole("region", { name: en.settings.devices });
    expect(within(pane).queryByRole("heading", { name: en.settings.webDevicesTitle })).not.toBeNull();
    expect(nativeOpen).not.toHaveBeenCalled();
    fireEvent.click(within(pane).getByRole("button", { name: webOpen }));
    expect(nativeOpen.mock.calls).toEqual([[{ key: "devices" }]]);
    expect(pipe?.commands).not.toContain("host_state");
  });

  it("removes a paired device only after confirmation in the local Devices pane", async () => {
    const device = { id: "phone", label: "Test phone", kind: "web", current: false };
    let removed = false;
    mount("D-l", "#/settings/devices", {
      native: (command) => command === "host_state"
        ? { enabled: true, port: 47800, origin: "https://computer.example.invalid", state: "serving", autostart: true }
        : undefined,
      respond: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/pair") return Response.json({ items: [] });
        if (path === "/devices") return Response.json({ items: removed ? [] : [
          { id: "current", label: "This session", kind: "web", current: true }, device,
        ] });
        if (request.method === "DELETE" && path === "/devices/phone") {
          removed = true;
          return new Response(null, { status: 204 });
        }
      },
    });
    const pane = within(await screen.findByRole("region", { name: en.settings.devices }));
    const deviceRow = await pane.findByRole("group", { name: device.label });
    expect(pane.queryByRole("heading", { name: en.host.devicesTitle })).not.toBeNull();
    expect(pane.queryByRole("group", { name: "This session" })).toBeNull();
    fireEvent.click(within(deviceRow).getByRole("button", { name: en.host.remove }));
    expect(removed).toBe(false);
    const confirm = pane.getByRole("group", { name: en.host.removeAsk.replace("{name}", device.label) });
    fireEvent.click(within(confirm).getByRole("button", { name: en.host.remove }));
    await waitFor(() => expect(removed).toBe(true));
    await waitFor(() => expect(pane.queryByText(device.label)).toBeNull());
  });

  it.each([
    ["account", en.settings.account],
    ["security", en.settings.security],
    ["devices", en.settings.devices],
  ])("opens %s on the configured self-hosted server", async (section, label) => {
    const { nativeOpen } = mount("D-s", `#/settings/${section}`);
    const pane = within(await screen.findByRole("region", { name: label }));
    const open = pane.queryByRole("button", { name: "Open on your server" });
    expect(open).not.toBeNull();
    nativeOpen.mockRejectedValueOnce(new Error("Browser refused"));
    fireEvent.click(open!);
    expect(await pane.findByText(en.settings.webNoBrowserServer)).toBeTruthy();
    expect(nativeOpen.mock.calls).toEqual([[{
      key: `server-${section}`,
      expectedServer: DOORS["D-s"](mailbox).cloudUrl,
      expectedAccount: "fixture-account",
    }]]);
  });

  it("writes a diagnostic file only when asked from About", async () => {
    const path = "/tmp/diagnostic.json";
    const write = vi.fn(() => path);
    mount("D-l", "#/settings/about", {
      native: (command) => command === "diagnostic_save" ? write() : undefined,
    });
    const pane = within(await screen.findByRole("region", { name: en.settings.about }));
    expect(pane.getByRole("heading", { name: en.desktopDoor.aboutInstallHead })).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(pane.getByRole("button", { name: en.desktopDoor.diagnosticAction }));
    expect(await pane.findByText(en.desktopDoor.diagnosticWritten.replace("{path}", path))).toBeTruthy();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("opens the dedicated add-mailbox flow from the standalone Mailboxes pane", async () => {
    mount("D-l", "#/settings/mailboxes");
    const pane = within(await screen.findByRole("region", { name: en.settings.mailboxes }));
    fireEvent.click(await pane.findByRole("button", { name: en.mailboxes.desktopAddAction }));
    await waitFor(() => expect(window.location.hash).toBe("#/first-run/add"));
  });

  it("writes the hosted AI setting through the desktop engine", async () => {
    const save = vi.fn(() => Response.json({ aiEnabled: true }));
    const { fetch } = mount("D-m", "#/settings/ai", {
      respond: (request) => {
        if (new URL(request.url).pathname === "/account/ai") {
          return request.method === "PATCH" ? save() : Response.json({ aiEnabled: false });
        }
      },
    });
    const pane = within(await screen.findByRole("region", { name: en.settings.ai }));
    const control = await pane.findByRole("switch", { name: en.settings.aiLabel });
    await waitFor(() => expect(control.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(control);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("draws the hosted AI allowance over the bridge with no browser request", async () => {
    const { fetch } = mount("D-m", "#/settings/ai", {
      respond: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/account/ai") return Response.json({ aiEnabled: true });
        if (path === "/account/access") return Response.json({
          metered: true, access: "open", aiCredits: { remaining: 120, total: 150 },
        });
      },
    });
    const pane = within(await screen.findByRole("region", { name: en.settings.ai }));
    await pane.findByText("120 of 150 this month");
    expect(screen.getByRole("region", { name: en.settings.ai }).querySelector("progress")?.max).toBe(150);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says the AI budget in the Settings list the way the panes say it", async () => {
    mount("D-m", "#/settings", {
      respond: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/account/ai") return Response.json({ aiEnabled: true });
        if (path === "/account/access") return Response.json({
          metered: true, access: "open", aiCredits: { remaining: 18_885, total: 4_000 },
        });
      },
    });
    expect(await screen.findByText("4,000 of 4,000 this month")).toBeTruthy();
    expect(document.body.textContent).not.toContain("18,885");
  });

  it("changes the signed-in account's storage mail preference in Storage", async () => {
    const save = vi.fn();
    mount("D-m", "#/settings/storage", {
      respond: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/account/access") return Response.json({
          metered: true,
          storage: { usedBytes: 1000, limitBytes: 2000, emptiedForSpace: 0, mail: false },
        });
        if (path === "/account/storage" && request.method === "PATCH") {
          save();
          return Response.json({});
        }
      },
    });
    const pane = within(await screen.findByRole("region", { name: en.settings.storage }));
    expect(pane.queryByRole("heading", { level: 2, name: en.settings.storageWhatCountsHead })).not.toBeNull();
    fireEvent.click(pane.getByRole("switch", { name: en.settings.storageMail }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it("mints the Subscription link only after Manage", async () => {
    mount("D-m", "#/settings/billing", {
      respond: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/account/access") return Response.json({ metered: true });
        if (path === "/account/manage-link" && request.method === "POST") {
          return Response.json({ url: "https://billing.example.invalid/manage" });
        }
      },
    });
    const pane = within(await screen.findByRole("region", { name: en.settings.billing }));
    expect(pane.queryByRole("heading", { name: en.settings.webBillingTitle })).not.toBeNull();
    expect(pipe?.asked).not.toContain("POST /account/manage-link");
    fireEvent.click(pane.getByRole("button", { name: en.settings.subscriptionManage }));
    expect(await pane.findByRole("link", { name: en.settings.subscriptionOpen })).toBeTruthy();
    expect(pipe?.asked.filter((request) => request === "POST /account/manage-link")).toHaveLength(1);
  });
});
