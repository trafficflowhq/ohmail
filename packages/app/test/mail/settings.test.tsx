/** @vitest-environment jsdom */
/**
 * THE WAY OUT: the mail's Settings at the switch (`mailSettings` of the mail entry), over the frame and a host that
 * hands the Account section's doors. Settings stands in the rail and behind its chord; its menu lists the Account
 * section alone; that section signs this browser out through the HOST'S door: the whole pane where the host answers
 * for the account here, the sign-out alone (which asks first) on a browser signed in to somebody's own computer.
 * A section these parts cannot draw is not listed, and a host that hands no section's door has no Settings at all.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDoor } from "../../src/account/index.js";
import type { AccountPaneParts } from "../../src/account/account/pane.js";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { NONE, type HostCapabilities, type None } from "../../src/host/index.js";
import { mailPanes, mailSettings } from "../../src/mail/index.js";
import { PANE_IDS } from "../../src/settings/contract.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import accountEn from "../../messages/account.en.json" with { type: "json" };
import accountOwnEn from "../../messages/account-account.en.json" with { type: "json" };
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };
import menuEn from "../../messages/settings-menu.en.json" with { type: "json" };
import { madeOf, SETTINGS, type Setting } from "../settings/frame/hosts.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";

const WORDS: Messages = {
  ...FRAME_WORDS.en,
  ...accountEn,
  ...accountOwnEn,
  ...menuEn,
  settings: settingsEn.settings,
  pairLanding: doorsEn.pairLanding,
  ohbox: { title: "Ohbox" },
};

const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "wide", Wide: ({ route }: PaneProps) => <p>at {route.place}</p> },
};

/** The host's session door as a double: an invented address, and a sign-out that is counted. */
function doorOf() {
  const signOut = vi.fn(async () => "left" as const);
  const door: AccountDoor = {
    who: async () => ({ ok: true, value: { address: "mila@lichtgrat.example" } }),
    signOut,
    toErase: () => undefined,
    toSignIn: () => undefined,
  };
  return { door, signOut };
}
const withAccount = (setting: Setting, account: HostCapabilities["account"]): Setting => ({
  ...setting,
  capabilities: { ...setting.capabilities, account },
});
/** The managed web, a browser signed in to somebody's own computer, and a desktop that sends the account to the browser. */
const WEB = withAccount(SETTINGS["W-m"]!, "here");
const PAIRED = withAccount(SETTINGS.H!, "signOutOnly");
const IN_BROWSER = withAccount(SETTINGS["D-m"]!, "inBrowser");

function mount(o: {
  at: string;
  setting: Setting;
  parts: AccountPaneParts | None;
  room?: "desktop" | "phone";
}) {
  const address = fakeAddress(o.at);
  const settings = mailSettings({ mailboxes: NONE, account: o.parts });
  const made = madeOf(o.setting, {
    address,
    window: fakeWindow(o.room ?? "desktop"),
    places: { ohbox, settings },
  });
  render(
    <TextProvider locale="en" messages={WORDS} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>,
  );
  return { address };
}
const whole = (door: AccountDoor): AccountPaneParts => ({
  useDoor: () => door,
  password: {
    useDoor: () => ({ change: async () => ({ ok: true, value: { ended: 0 } }) }),
    factor: () => null,
  },
});
const alone = (door: AccountDoor): AccountPaneParts => ({ useDoor: () => door, password: NONE });
const menu = () => within(screen.getByRole("navigation", { name: settingsEn.settings.navAria }));
const sections = () =>
  menu()
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label"));
const settled = () => act(async () => {});

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the mail's Settings at the switch: the way out", () => {
  it("the record of panes is total, and every section is none but the account's", () => {
    const panes = mailPanes({ mailboxes: NONE, account: whole(doorOf().door) });
    expect(Object.keys(panes)).toEqual([...PANE_IDS]);
    expect(PANE_IDS.filter((id) => panes[id] !== NONE)).toEqual(["account"]);
    expect(PANE_IDS.filter((id) => mailPanes({ mailboxes: NONE, account: NONE })[id] !== NONE)).toEqual([]);
  });

  it("a host that hands no section's door has no Settings: no place, so no rail entry and no page", () => {
    expect(mailSettings({ mailboxes: NONE, account: NONE })).toBe(NONE);
  });

  it("the rail leads to Settings, whose menu lists the Account section alone, with who is signed in", async () => {
    const { address } = mount({ at: "#/ohbox", setting: WEB, parts: whole(doorOf().door) });
    const places = within(screen.getByRole("navigation", { name: "Places" }));
    fireEvent.click(places.getByRole("button", { name: "Settings" }));
    expect(address.read()).toBe("#/settings");
    await settled();
    expect(sections()).toEqual(["Account"]);
    /* Beside the menu the one section stands: the account that door named, and its way out. */
    expect(screen.getAllByText("mila@lichtgrat.example").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("g then , goes to Settings from another place", () => {
    const { address } = mount({ at: "#/ohbox", setting: WEB, parts: whole(doorOf().door) });
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "," });
    expect(address.read()).toBe("#/settings");
  });

  it("Sign out signs this browser out through the host's door, once, with no question before it", async () => {
    const { door, signOut } = doorOf();
    mount({ at: "#/settings/account", setting: WEB, parts: whole(door) });
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await settled();
    expect(signOut).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("on a browser signed in to somebody's computer it is the sign-out alone, which asks first", async () => {
    const { door, signOut } = doorOf();
    mount({ at: "#/settings/account", setting: PAIRED, parts: alone(door) });
    await settled();
    expect(sections()).toEqual(["Account"]);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).not.toHaveBeenCalled();
    const question = within(screen.getByRole("dialog"));
    expect(question.getByText(doorsEn.pairLanding.signOutConfirm)).toBeTruthy();
    fireEvent.click(question.getByRole("button", { name: "Sign out" }));
    await settled();
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("on one column the menu stands alone, the section over it with the way back", async () => {
    const { address } = mount({
      at: "#/settings",
      setting: WEB,
      parts: whole(doorOf().door),
      room: "phone",
    });
    expect(sections()).toEqual(["Account"]);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    fireEvent.click(menu().getByRole("button", { name: "Account" }));
    expect(address.read()).toBe("#/settings/account");
    await settled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: settingsEn.settings.back }));
    expect(address.read()).toBe("#/settings");
  });

  it("a section the handed doors cannot draw is not listed: no half pane, no empty page", () => {
    /* The host says the account is handled in the browser: these doors have no body for that answer. */
    mount({ at: "#/settings", setting: IN_BROWSER, parts: whole(doorOf().door) });
    expect(menu().queryByRole("button", { name: "Account" })).toBeNull();
    cleanup();
    /* The host answers for the whole pane and hands no password's door: the whole pane cannot be drawn. */
    mount({ at: "#/settings", setting: WEB, parts: alone(doorOf().door) });
    expect(menu().queryByRole("button", { name: "Account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
