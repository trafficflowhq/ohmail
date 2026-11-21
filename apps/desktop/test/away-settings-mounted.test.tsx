/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { OhmailEngine } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { en } from "../../../test/support/web-catalogues.js";
import {
  act, installConfirmEnv, ISO, teardownConfirmEnv, tick,
} from "../../../test/support/web-mail-fixtures.js";
import { ROSTER, storeWith } from "../../../test/support/web-mail-fixtures.js";
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame";
import { DesktopLocale } from "../src/DesktopLocale";
import { linkSlot } from "../src/link-in";

vi.mock("../src/local-mailbox-facts", async () => ({
  ...await vi.importActual<typeof import("../src/local-mailbox-facts")>("../src/local-mailbox-facts"),
  readMailboxFacts: async () => ROSTER,
}));

const noChange = () => undefined;
const row = {
  enabled: true, body: "Back Monday.", startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day", piles: ["INBOX"],
};
const answer = { ...row, updatedAt: ISO };

function reply(status: number, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const header = encoder.encode(JSON.stringify({ status, statusText: "", h: [] }));
  const body = encoder.encode(JSON.stringify(data));
  const result = new Uint8Array(4 + header.length + body.length);
  new DataView(result.buffer).setUint32(0, header.length, false);
  result.set(header, 4);
  result.set(body, 4 + header.length);
  return result;
}

beforeEach(() => {
  installConfirmEnv();
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await teardownConfirmEnv();
});

async function mount(
  refused: boolean,
  hash = "#/settings/away",
  host: Partial<Pick<DesktopFrameProps, "status" | "session" | "paired" | "hostLabel">> = {},
) {
  const calls: { method: string; body?: unknown }[] = [];
  vi.stubGlobal("__TAURI_INTERNALS__", {
    invoke: async (command: string, p: { method: string; url: string; body?: number[] }) => {
      if (command !== "engine_request" || p.url !== "/away-responder") return reply(404, {});
      const body = p.body?.length ? JSON.parse(new TextDecoder().decode(Uint8Array.from(p.body))) : undefined;
      calls.push({ method: p.method, body });
      if (refused) return reply(503, {});
      return reply(200, p.method === "PUT" ? { ...answer, ...body } : answer);
    },
  });
  window.location.hash = hash;
  const engine = new OhmailEngine({
    store: await storeWith([], []),
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: ISO,
      }),
      fetchBody: async () => ({
        text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unreachable" }),
    },
  });
  const props: DesktopFrameProps = {
    engine, status: { state: "serving", mode: "cloud" }, session: "live", sessionRefused: false,
    sealFailed: false, paired: false, hostLabel: null, freshness: null, account: "account", storage: null,
    mayLinkOut: false, manageOffered: false, withdrawManage: noChange, rereadAccess: noChange,
    reuseSweeps: [], recheckSweeps: async () => undefined, ai: null, setAi: noChange, onStatus: noChange,
    openOverlay: noChange, takeOver: noChange, firstRunOpen: false, firstRun: undefined, takesMailLinks: true,
    scope: "account", onUnread: noChange, liveBody: async () => ({ kind: "refused", reason: "gone" }),
    links: linkSlot(), connection: { read: () => null, subscribe: () => noChange },
    ...host,
  };
  await act(async () => {
    render(<DesktopLocale><ThemeProvider><ToastHost><DesktopFrame {...props} /></ToastHost></ThemeProvider></DesktopLocale>);
  });
  await tick(3000);
  return calls;
}

function openPane() {
  const section = screen.queryByRole("region", { name: en.settings.away });
  expect(section, "Away is reachable in the desktop frame").not.toBeNull();
  return within(section!);
}

function settingsMenu() {
  return within(screen.getByRole("navigation", { name: en.settings.navAria }));
}

async function go(hash: string) {
  await act(async () => { window.location.hash = hash; });
  await tick(250);
}

it("loads the stored reply over the desktop bridge and saves one complete row", async () => {
  const calls = await mount(false);
  const pane = openPane();
  const message = pane.getByRole<HTMLTextAreaElement>("textbox", { name: en.away.bodyLabel });
  expect(message.value).toBe(row.body);
  await act(async () => { fireEvent.change(message, { target: { value: "Back Tuesday." } }); });
  await act(async () => { fireEvent.click(pane.getAllByRole("button", { name: en.away.save })[0]!); });
  await tick(0);
  expect(calls).toEqual([
    { method: "GET", body: undefined },
    { method: "PUT", body: { ...row, body: "Back Tuesday." } },
  ]);
});

it("says when the desktop bridge cannot read the Away responder", async () => {
  const calls = await mount(true);
  const pane = openPane();
  expect(pane.queryByText(en.away.unreachable)).not.toBeNull();
  expect(calls).toEqual([{ method: "GET", body: undefined }]);
});

it("announces the enabled responder above the desktop mail and opens its settings", async () => {
  const calls = await mount(false, "#/ohbox");
  const sentence = /people you've let in whose mail lands in Ohbox get a reply at most once a day/;
  const read = () => screen.queryByRole("button", { name: en.away.noticeSettings });
  const more = screen.queryByRole("button", { name: /more notices?$/ });
  if (!read() && more) {
    await act(async () => { fireEvent.click(more); });
    const result = screen.queryByRole("menuitem", { name: sentence });
    if (result) await act(async () => { fireEvent.click(result); });
  }
  expect(read()).not.toBeNull();
  expect(calls).toEqual([{ method: "GET", body: undefined }]);
  await act(async () => { fireEvent.click(read()!); });
  await tick(0);
  expect(window.location.hash).toBe("#/settings/away");
});

it.each(["out", "live"] as const)("Settings offers one Away control only on a supported host (%s)", async (session) => {
  const calls = await mount(false, "#/ohbox", { session });
  if (session === "out") {
    expect(screen.getByRole("heading", { name: "Ohbox" })).toBeTruthy();
    const more = screen.queryByRole("button", { name: /more notices?$/ });
    if (more) await act(async () => { fireEvent.click(more); });
    expect(screen.queryByRole("menuitem", { name: /^Away responder is on/ })).toBeNull();
    expect(screen.queryByRole("button", { name: en.away.noticeSettings })).toBeNull();
  }

  await go("#/settings/away");
  const entries = settingsMenu().queryAllByRole("button", { name: en.settings.away });
  if (session === "out") {
    expect(entries).toHaveLength(0);
    expect(screen.queryByRole("region", { name: en.settings.away })).toBeNull();
    expect(screen.queryByRole("switch", { name: en.away.title })).toBeNull();
    expect(calls).toEqual([]);
  } else {
    expect(entries).toHaveLength(1);
    expect(openPane().getByRole("switch", { name: en.away.title })).toBeTruthy();
    expect(screen.getAllByRole("switch", { name: en.away.title })).toHaveLength(1);
    await act(async () => { fireEvent.click(settingsMenu().getByRole("button", { name: en.settings.screener })); });
    await tick(250);
    expect(screen.getByRole("region", { name: en.settings.screener })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: en.away.title })).toBeNull();
    expect(calls).toEqual([{ method: "GET", body: undefined }, { method: "GET", body: undefined }]);
  }
});

it("the paired Away pane names its host and its complete save updates the notice without a refetch", async () => {
  const calls = await mount(false, "#/settings/away", {
    status: { state: "serving", mode: "cloud", flavor: "desktop-host" },
    paired: true,
    hostLabel: "Studio Mac",
  });
  const pane = openPane();
  expect(pane.getByText("Replies are sent while ohmail is open on Studio Mac.")).toBeTruthy();
  expect(pane.queryByText(en.away.localNote)).toBeNull();
  const message = pane.getByRole<HTMLTextAreaElement>("textbox", { name: en.away.bodyLabel });
  expect(message.value).toBe(row.body);
  await act(async () => {
    fireEvent.change(message, { target: { value: "Back Tuesday." } });
    fireEvent.click(pane.getByRole("button", { name: en.away.everyone }));
    fireEvent.click(pane.getByRole("button", { name: en.away.pileReceipts }));
  });
  await act(async () => { fireEvent.click(pane.getByRole("button", { name: en.away.throttleLabel })); });
  await act(async () => { fireEvent.click(screen.getByRole("menuitemradio", { name: en.away.per_week })); });
  await act(async () => { fireEvent.click(pane.getAllByRole("button", { name: en.away.save })[0]!); });
  await tick(0);
  expect(pane.getByText(en.away.saved)).toBeTruthy();

  await go("#/ohbox");
  expect(screen.getByRole("heading", { name: "Ohbox" })).toBeTruthy();
  const sentence = "everyone who writes whose mail lands in Ohbox or in Receipts gets a reply at most once a week";
  const more = screen.queryByRole("button", { name: /more notices?$/ });
  if (!screen.queryByRole("button", { name: en.away.noticeSettings }) && more) {
    await act(async () => { fireEvent.click(more); });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: (name) => name.includes(sentence) }));
    });
  }
  expect(screen.queryAllByRole("status").filter((status) => status.textContent?.includes(sentence))).toHaveLength(1);
  expect(calls).toEqual([
    { method: "GET", body: undefined },
    { method: "PUT", body: {
      ...row, body: "Back Tuesday.", audience: "everyone", throttle: "per_week", piles: ["INBOX", "ohmail/Receipts"],
    } },
  ]);
});
