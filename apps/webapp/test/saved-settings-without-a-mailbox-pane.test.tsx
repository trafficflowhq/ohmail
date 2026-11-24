/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import messages from "../messages/en.json";
import { useProfileImport, type ProfileImportTransport } from "@ohmail/app/profile-import";
import { Frame } from "@ohmail/app/frame";
import { MailGround, mailPlaces, mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import { TextProvider } from "@ohmail/app/text";
import { within } from "@testing-library/react";
import { LIST_WORDS } from "../../../packages/app/test/places/list-seat.js";
import { fakeMail } from "../../../packages/app/test/reader/support/mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../packages/app/test/support/fake-window.js";
import settingsMenu from "../../../packages/app/messages/settings-menu.en.json";

/**
 * A DECLINED SETTINGS DOCUMENT HAS A ROW WHERE THERE IS NO MAILBOX PANE (HOST-CLIENT-DECLINED-
 * SETTINGS-HAS-NO-ROW). The desktop's served client hands the shell no `mailboxSection`, and the
 * declined rows rendered only under one, so "Not now" there left nothing to import or replace from.
 * The shell reads the rows (`useSavedProfiles`) and the pane exists while one stands. Mutation
 * watched red: SettingsView's section gated on `mailboxSection` again.
 */
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as never;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const MB = { id: "mbx-1", address: "sam@example.com", status: "connected" };
const found = {
  fingerprint: "f".repeat(64), updatedAt: "2026-08-10T09:00:00.000Z", producer: { kind: "cloud", version: "1" },
  counts: { screener: 1, rules: 2, notifyRules: 0, tags: 1, awayResponder: false },
};
function transport(state: "declined" | "found" | "none"): { via: ProfileImportTransport; asks: () => number } {
  let asks = 0;
  const via = {
    candidate: async () => { asks += 1; return state === "none" ? { state: "none" } : { state, ...found }; },
    apply: async () => ({}), decline: async () => ({}), status: async () => ({}), replace: async () => ({}),
  } as unknown as ProfileImportTransport;
  return { via, asks: () => asks };
}

async function mountPaired(via: ProfileImportTransport) {
  const address = fakeAddress("#/ohbox");
  const settings = mailSettings({ ...NO_PANE_PARTS, general: () => null });
  const { host: paired } = fakeHost({
    address,
    engine: fakeMail([]).engine,
    service: "ownComputer",
    scope: "paired-without-mailboxes",
    places: { ...mailPlaces(), settings },
    above: MailGround,
    wires: { profileImport: via },
    mailboxes: async () => [{ ...MB, errorCode: null, disabledReason: null, syncBlockedReason: null,
      syncBlockedSince: null, lastSyncAt: null }],
  });
  await act(async () => root.render(
    <TextProvider locale="en" timeZone="UTC" messages={{ ...messages, ...LIST_WORDS, ...settingsMenu }}>
      <Frame host={paired} />
    </TextProvider>,
  ));
  return address;
}

describe("the Mailboxes pane on a surface with no mailbox node", () => {
  it("exists, with the declined row, when the shell hands the section in", async () => {
    const address = await mountPaired(transport("declined").via);
    await act(async () => { address.visit("#/settings/mailboxes"); });
    const page = within(host);
    expect(await page.findByRole("heading", { name: /^Settings saved on/ })).toBeTruthy();
    expect(page.getByRole("button", { name: "Import settings" })).toBeTruthy();
    expect(page.getByRole("button", { name: "Save this ohmail's settings to the mailbox" })).toBeTruthy();
  });

  it("CONTROL: neither node is no pane at all", async () => {
    const address = await mountPaired(transport("none").via);
    await act(async () => { address.visit("#/settings"); });
    const panes = await within(host).findByRole("navigation", { name: "Settings sections" });
    expect(within(panes).queryByRole("button", { name: "Mailboxes" })).toBeNull();
    expect(within(host).queryByRole("heading", { name: /^Settings saved on/ })).toBeNull();
  });
});

describe("the shell's declined rows are the card's own answers", () => {
  async function mountShellRead(via: ProfileImportTransport) {
    const seen: { declined: number; notNow: (() => void) | null } = { declined: -1, notNow: null };
    function Probe(): null {
      const state = useProfileImport(true, [MB], via);
      seen.declined = state.declined.length;
      seen.notNow = state.offer ? state.notNow : null;
      return null;
    }
    await act(async () => { root.render(h(Probe)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return seen;
  }

  it("a declined document is a row, read by the card's one ask", async () => {
    const t = transport("declined");
    const seen = await mountShellRead(t.via);
    expect(seen.declined).toBe(1);
    expect(t.asks(), "the declined rows cost a second request per mailbox").toBe(1);
  });

  it("a Not now adds its row at once, with no ask", async () => {
    const t = transport("found");
    const address = await mountPaired(t.via);
    const page = within(host);
    const notNow = await page.findByRole("button", { name: "Not now" });
    await act(async () => { notNow.click(); });
    await act(async () => { address.visit("#/settings"); });
    const panes = await page.findByRole("navigation", { name: "Settings sections" });
    await act(async () => { within(panes).getByRole("button", { name: "Mailboxes" }).click(); });
    expect(await page.findByRole("heading", { name: /^Settings saved on/ })).toBeTruthy();
    expect(page.getByRole("button", { name: "Import settings" })).toBeTruthy();
    expect(t.asks()).toBe(1);
  });

  it("CONTROL: no declined document is no row, so the host client shows no pane", async () => {
    expect((await mountShellRead(transport("none").via)).declined).toBe(0);
  });
});
