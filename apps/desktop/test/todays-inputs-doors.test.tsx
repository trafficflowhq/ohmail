/** @vitest-environment jsdom */
/**
 * THE DESKTOP'S REAL HOST, READ BACK BY THE ADAPTER, door by door: what today's views are handed through the frame
 * equals what `DesktopGate` handed the old shell on that door. The frame itself is not drawn here; its host and the
 * two nodes beside it are captured as the window builds them.
 */
import { createElement as h } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeed, NONE, type FrameSupplies, type HostConnectionState, type HostContract } from "@ohmail/app/host";
import type { TodaysNodes } from "../../webapp/app/shell/todays-inputs";

const seen: { host: HostContract | null; todays: TodaysNodes | null; hosts: HostContract[] } = { host: null, todays: null, hosts: [] };
vi.mock("../../webapp/app/shell/TodaysFrame", async () => {
  const real = await vi.importActual<object>("../../webapp/app/shell/TodaysFrame");
  return {
    ...real,
    TodaysFrame: ({ host, todays }: { host: HostContract; todays: TodaysNodes }) => {
      seen.host = host;
      seen.todays = todays;
      seen.hosts.push(host);
      return null;
    },
  };
});

import type { EngineStatus } from "../src/bridge-fetch.js";
import { CLOUD_URL } from "../src/doors.js";
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame.js";
import { linkSlot } from "../src/link-in.js";
import { localImageDoor } from "../src/local-images.js";
import { consentOverBridge, consentOverBridgeStandalone } from "../src/local-consent.js";
import { cloudSuggestWire } from "../src/cloud-suggest.js";
import { desktopNotificationHost } from "../src/notify-host.js";
import { readMailboxFacts } from "../src/local-mailbox-facts.js";
import { readMirrorFreshness } from "../src/DesktopMailboxes.js";
import { BUILD_SHA, BUILD_VERSION } from "../src/build-id.js";

const named = <T,>(name: string) => ({ named: name }) as unknown as T;
const frame = {
  places: named("places"), stages: named("stages"), overs: named("overs"), address: named("address"), window: named("window"),
  appearance: named("appearance"), recover: NONE,
} as FrameSupplies;

const status = (s: Partial<EngineStatus>): EngineStatus => ({ state: "serving", ...s }) as EngineStatus;
const onItsOwn = status({ mode: "local" });
const managed = status({ mode: "cloud", cloudUrl: CLOUD_URL });
const selfHosted = status({ mode: "cloud", cloudUrl: "https://mail.lichtgrat.example" });
const paired = status({ mode: "cloud", flavor: "desktop-host", cloudUrl: "https://kestrel.example:8443" } as Partial<EngineStatus>);

const onUnread = () => undefined;
const props = (s: EngineStatus, over: Partial<DesktopFrameProps> = {}): DesktopFrameProps => ({
  engine: named("engine"), status: s, session: "live", sessionRefused: false, sealFailed: false,
  paired: s === paired, hostLabel: s === paired ? "kestrel" : null, freshness: null, account: s === onItsOwn ? null : "acct-1",
  storage: null, mayLinkOut: true, manageOffered: false, withdrawManage: () => undefined, rereadAccess: () => undefined,
  reuseSweeps: [], ai: null, setAi: () => undefined, onStatus: () => undefined, openOverlay: () => undefined,
  takeOver: () => undefined, firstRunOpen: false, firstRun: undefined, takesMailLinks: true, scope: "a-mailbox",
  onUnread, liveBody: named("liveBody"), links: linkSlot(), connection: createFeed<HostConnectionState | null>(null),
  ...over,
});

let root: ReturnType<typeof createRoot> | null = null;
async function draw(p: DesktopFrameProps) {
  const container = document.createElement("div");
  root ??= createRoot(container);
  await act(async () => root!.render(h(DesktopFrame, p)));
  const { todaysInputs } = await import("../../webapp/app/shell/todays-inputs");
  return todaysInputs(seen.host!, seen.todays!);
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  seen.hosts = [];
});

describe("the desktop's host, read back as today's inputs", () => {
  it("on its own: the window's own model, its own consent, no account, pictures and unsubscribes from this computer", async () => {
    const inputs = await draw(props(onItsOwn));
    expect(inputs.managedService).toBe(false);
    expect(inputs.consentTransport).toBe(consentOverBridgeStandalone);
    expect(inputs.imageWire).toBe(localImageDoor);
    expect(inputs.imagesFromComputer).toBe(true);
    expect(inputs.suggestWire).toBeUndefined();
    expect(inputs.liveBodyWire).toBeUndefined();
    expect(inputs.awayIsLocal).toBe(true);
    expect(inputs.mailboxFacts).toBe(readMailboxFacts);
    expect(inputs.mirrorFreshness).toBeUndefined();
    expect(inputs.notificationHost).toBe(desktopNotificationHost);
    expect(inputs.onUnread).toBe(onUnread);
    expect(inputs.support).toEqual({ surface: "desktop", version: BUILD_VERSION ?? null, commit: BUILD_SHA || null, accountId: null, mailtoLeaves: false });
    expect(inputs.accountSection).toBeUndefined();
    expect(inputs.desktopSection?.label).toBeTruthy();
    expect(typeof inputs.screenerSuggest).toBe("function");
    expect(inputs.devicesSection).toBeDefined();
    expect(inputs.awayTransport, "no away on this computer's own door").toBeDefined();
    expect(inputs.awayOnHost).toBeUndefined();
  });

  it("on the managed door: the account's consent, the priced suggest, Load it now, the copy's age", async () => {
    const inputs = await draw(props(managed));
    expect(inputs.managedService).toBe(true);
    expect(inputs.consentTransport).toBe(consentOverBridge);
    expect(inputs.suggestWire).toBe(cloudSuggestWire);
    expect(inputs.liveBodyWire).toBeDefined();
    expect(inputs.mirrorFreshness).toBe(readMirrorFreshness);
    expect(inputs.actRulesUnmarked).toBe(true);
    expect(inputs.support?.accountId).toBe("acct-1");
    expect(inputs.accountSection).toBeDefined();
    expect(typeof inputs.screenerSuggest).toBe("function");
    expect(inputs.awayTransport, "no away on the account's door").toBeDefined();
    expect(inputs.awayIsLocal, "the account's away said it leaves from this computer").toBe(false);
    expect(inputs.awayOnHost).toBeUndefined();
  });

  it("on a self-hosted door: not the managed service, with the same account panes", async () => {
    const inputs = await draw(props(selfHosted));
    expect(inputs.managedService).toBe(false);
    expect(inputs.accountSection).toBeDefined();
  });

  it("on a paired door: the other computer's away and nothing priced", async () => {
    const inputs = await draw(props(paired));
    // Devices: host mode's pane on its own door, the account's on an account door, and none on a paired one.
    expect(inputs.devicesSection).toBeUndefined();
    expect(inputs.managedService).toBe(false);
    expect(inputs.suggestWire).toBeUndefined();
    expect(inputs.screenerSuggest).toBeUndefined();
    // The away pane is the other computer's: its replies leave from there, and it is named, or nothing is said.
    expect(inputs.awayTransport, "no away on a paired door").toBeDefined();
    expect(inputs.awayIsLocal).toBe(false);
    expect(inputs.awayOnHost).toBe("kestrel");
    expect((await draw(props(paired, { hostLabel: null }))).awayOnHost).toBeUndefined();
  });

  it("hands the first run's object on the door it was written for, and on no other", async () => {
    const firstRun = { door: "local" } as unknown as DesktopFrameProps["firstRun"];
    expect((await draw(props(onItsOwn, { firstRun }))).firstRun).toBe(firstRun);
    expect((await draw(props(managed, { firstRun }))).firstRun).toBeUndefined();
  });

  it("a refused session reaches the frame as the session's state, not as an input", async () => {
    await draw(props(managed, { sessionRefused: true }));
    expect(seen.host!.session.state).toBe("refused");
  });

  it("hands the frame one host while nothing changed, and a new one when the door changes", async () => {
    const p = props(managed);
    await draw(p);
    await draw({ ...p, setAi: () => undefined, onStatus: () => undefined });
    expect(new Set(seen.hosts).size).toBe(1);
    await draw({ ...p, sessionRefused: true });
    expect(new Set(seen.hosts).size).toBe(2);
  });

  it("holds the first run's door to the capability and the folders flag to the consent object", async () => {
    const inputs = await draw(props(managed));
    expect(seen.host!.capabilities.foldersStorable).toBe(inputs.consentTransport?.foldersStorable === true);
    expect(seen.host!.capabilities.imagesFrom === "service" || seen.host!.capabilities.imagesFrom === seen.host!.capabilities.unsubscribeFrom).toBe(true);
  });
});

/* THE PAIRED PAGE, read back the same way: the page a desktop serves to a phone's browser hands today's views the
   calls its host serves over the bearer, and none of the Cloud's. */
describe("the paired page's host, read back as today's inputs", () => {
  it("hands the bearer's wires, says pictures and unsubscribes come from the computer, and nothing of the Cloud", async () => {
    const { pairedHost } = await import("../../paired-page/src/host.js");
    const { todaysInputs, NO_TODAYS } = await import("../../webapp/app/shell/todays-inputs");
    const { HOST_CLIENT_SEND_MAX_TOTAL_BYTES } = await import("../../paired-page/src/HostGate.js");
    const wire = <T,>(name: string) => named<T>(name);
    const consent = { foldersStorable: false } as never;
    const host = pairedHost(named("engine"), { scope: "pair-1", sendCeiling: HOST_CLIENT_SEND_MAX_TOTAL_BYTES, build: { version: null, commit: null } }, {
      signOut: async () => undefined, mailboxes: wire("mailboxes"),
      wires: { gapLetters: wire("gap"), profileImport: wire("profile"), consent, olderBody: wire("older"), junk: wire("junk"), trash: wire("trash"), draftReply: wire("draft"), autoFiled: NONE },
      features: { account: { name: "account", render: () => null }, accountStrip: { name: "accountStrip", render: () => null }, screener: { name: "screener", render: () => null } },
      notifications: named("notifications"), frame,
    });
    const inputs = todaysInputs(host, NO_TODAYS);
    expect(inputs.managedService).toBe(false);
    expect(inputs.sendSurfaceMaxTotalBytes).toBe(HOST_CLIENT_SEND_MAX_TOTAL_BYTES);
    expect(inputs.imagesFromComputer).toBe(true);
    expect(inputs.imageWire).toBeUndefined();
    expect(inputs.consentTransport).toBe(consent);
    expect([inputs.gapLettersTransport, inputs.profileImportTransport, inputs.olderBodyWire, inputs.junkWire, inputs.trashWire, inputs.draftReplyWire])
      .toEqual([named("gap"), named("profile"), named("older"), named("junk"), named("trash"), named("draft")]);
    expect([inputs.liveBodyWire, inputs.suggestWire, inputs.awayTransport, inputs.organizerNoticeTransport, inputs.support])
      .toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(inputs.accountSection).toBeDefined();
  });
});
