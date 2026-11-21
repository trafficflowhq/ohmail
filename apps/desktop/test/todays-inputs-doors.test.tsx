/** @vitest-environment jsdom */
/**
 * THE DESKTOP'S REAL HOST, READ DOOR BY DOOR AT THE CONTRACT: what the window hands the mail frame on each door, as
 * `DesktopGate` handed the old shell on that door. The frame itself is not drawn here: `MailFrame`, the one
 * component every browser host mounts, records the host it is handed and draws nothing.
 *
 * Each line reads the contract member the old shell's input was read from (the adapter `todaysInputs` that mapped
 * one onto the other is gone with today's shell; its mapping, kept here line by line): a wire handed or `none`, a
 * reading or `none`, `capabilities.service === "managed"` for the managed service, `capabilities.awayRunsOn` for
 * where the away replies leave from, `capabilities.unsubscribeFrom` for "from this computer", `!rulesMarked` for a
 * rule that is not marked, `features.*` handed or `none` for a Settings section, `features.help` with the build and
 * the session's account for Help's support line.
 */
import { createElement as h } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OhmailEngine } from "@ohmail/client-engine";
import { useDoors } from "@ohmail/app-logic/reader/doors";
import { createFeed, NONE, type FrameSupplies, type HostConnectionState, type HostContract } from "@ohmail/app/host";
import { Frame } from "@ohmail/app/frame";
import { MailGround } from "@ohmail/app/mail";
import { TextProvider } from "@ohmail/app/text";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { WORDS } from "../../../packages/app/test/reader/support/mail.js";

const seen: { host: HostContract | null; hosts: HostContract[] } = { host: null, hosts: [] };
vi.mock("../../webapp/app/shell/browser-mail", async (load) => ({
  ...(await load<object>()),
  MailFrame: ({ host }: { host: HostContract }) => {
    seen.host = host;
    seen.hosts.push(host);
    return null;
  },
}));

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
import { enableDesktopAttachments } from "../../../test/support/web-mail-fixtures.js";

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
  reuseSweeps: [], recheckSweeps: async () => undefined, ai: null, setAi: () => undefined, onStatus: () => undefined,
  openOverlay: () => undefined, takeOver: () => undefined, firstRunOpen: false, firstRun: undefined, takesMailLinks: true,
  scope: "a-mailbox", onUnread, liveBody: named("liveBody"), links: linkSlot(),
  connection: createFeed<HostConnectionState | null>(null),
  ...over,
});

let root: ReturnType<typeof createRoot> | null = null;
async function draw(p: DesktopFrameProps): Promise<HostContract> {
  const container = document.createElement("div");
  root ??= createRoot(container);
  await act(async () => root!.render(h(DesktopFrame, p)));
  return seen.host!;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  seen.hosts = [];
});

/** Help's support line as the host hands it: `none` where Help is not handed, else the build and the session's account. */
function support(host: HostContract) {
  if (host.features.help === NONE) return undefined;
  const { surface, version, commit, mailtoLeaves } = host.device.build;
  return { surface, version, commit, accountId: host.session.account, mailtoLeaves };
}
/** The other computer the away replies leave from, by its name, or nothing where none is named. */
function awayOnHost(host: HostContract): string | undefined {
  const away = host.capabilities.awayRunsOn;
  return typeof away === "object" ? away.host : undefined;
}

describe("the desktop's host, read door by door at the contract", () => {
  it("on its own: the window's own model, its own consent, no account, pictures and unsubscribes from this computer", async () => {
    const liveNoticeScope = vi.fn(() => "a-mailbox");
    const host = await draw(props(onItsOwn, { liveNoticeScope }));
    expect(host.capabilities.service === "managed").toBe(false);
    expect(host.wires.consent).toBe(consentOverBridgeStandalone);
    expect(host.wires.images).toBe(localImageDoor);
    expect(host.capabilities.unsubscribeFrom === "computer").toBe(true);
    expect(host.wires.suggest).toBe(NONE);
    expect(host.wires.liveBody).toBe(NONE);
    expect(host.capabilities.awayRunsOn === "thisComputer").toBe(true);
    expect(host.reads.mailboxes).toBe(readMailboxFacts);
    expect(host.reads.copyAge).toBe(NONE);
    expect(host.device.notifications).toEqual({
      ...desktopNotificationHost,
      liveNoticeScope,
      emitter: {
        carries: ["ohbox", "screener", "pairing", "cal_alert"],
        acts: [],
        ahead: expect.any(Function),
        post: expect.any(Function),
        takeBack: expect.any(Function),
      },
    });
    expect(host.device.badge).toBe(onUnread);
    expect(support(host)).toEqual({ surface: "desktop", version: BUILD_VERSION ?? null, commit: BUILD_SHA || null, accountId: null, mailtoLeaves: false });
    expect(host.features.account).toBe(NONE);
    /* The Desktop section stands in Settings under its own name (the frame's Settings names a section by its entry). */
    expect(host.features.desktop === NONE ? undefined : host.features.desktop.name).toBe("desktop");
    expect(host.features.devices).not.toBe(NONE);
    expect(host.wires.away, "no away on this computer's own door").not.toBe(NONE);
    expect(awayOnHost(host)).toBeUndefined();
  });

  it("on the managed door: the account's consent, Load it now, the copy's age", async () => {
    const host = await draw(props(managed));
    expect(host.capabilities.service === "managed").toBe(true);
    expect(host.wires.consent).toBe(consentOverBridge);
    expect(host.wires.liveBody).not.toBe(NONE);
    expect(host.reads.copyAge).toBe(readMirrorFreshness);
    expect(!host.capabilities.rulesMarked).toBe(true);
    expect(support(host)?.accountId).toBe("acct-1");
    expect(host.features.account).not.toBe(NONE);
    expect(host.wires.away, "no away on the account's door").not.toBe(NONE);
    expect(host.capabilities.awayRunsOn === "thisComputer", "the account's away said it leaves from this computer").toBe(false);
    expect(awayOnHost(host)).toBeUndefined();
  });

  it("on a self-hosted door: not the managed service, with the same account panes", async () => {
    const host = await draw(props(selfHosted));
    expect(host.capabilities.service === "managed").toBe(false);
    expect(host.features.account).not.toBe(NONE);
  });

  it("on a paired door: the other computer's away and nothing priced", async () => {
    const host = await draw(props(paired));
    // Devices: host mode's pane on its own door, the account's on an account door, and none on a paired one.
    expect(host.features.devices).toBe(NONE);
    expect(host.capabilities.service === "managed").toBe(false);
    expect(host.wires.suggest).toBe(NONE);
    expect(host.capabilities.suggest).toBe(NONE);
    // The away pane is the other computer's: its replies leave from there, and it is named, or nothing is said.
    expect(host.wires.away, "no away on a paired door").not.toBe(NONE);
    expect(host.capabilities.awayRunsOn === "thisComputer").toBe(false);
    expect(awayOnHost(host)).toBe("kestrel");
    expect(awayOnHost(await draw(props(paired, { hostLabel: null })))).toBeUndefined();
  });

  it("hands the first run's object on the door it was written for, and on no other", async () => {
    const firstRun = { door: "local" } as unknown as DesktopFrameProps["firstRun"];
    expect((await draw(props(onItsOwn, { firstRun }))).wires.firstRun).toBe(firstRun);
    expect((await draw(props(managed, { firstRun }))).wires.firstRun).toBe(NONE);
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
    const host = await draw(props(managed));
    /* The window hands the shell's consent object, which carries the flag beside its verbs; the contract's type does not. */
    const consent = host.wires.consent as { foldersStorable?: unknown } | typeof NONE;
    expect(host.capabilities.foldersStorable).toBe(consent !== NONE && consent.foldersStorable === true);
    expect(host.capabilities.imagesFrom === "service" || host.capabilities.imagesFrom === host.capabilities.unsubscribeFrom).toBe(true);
  });
});

describe("opening and saving files through the desktop host's mail ground", () => {
  const parts = [
    { id: "file", messageId: "m1", filename: "notes.pdf", contentType: "application/pdf", sizeBytes: 4, inline: false, contentId: null },
    { id: "image", messageId: "m1", filename: "photo.png", contentType: "image/png", sizeBytes: 4, inline: false, contentId: null },
  ];

  function FilePresses() {
    const { files } = useDoors();
    const hold = files?.hold;
    useEffect(() => hold?.("m1"), [hold]);
    if (files?.itemsOf("m1").state !== "ready") return null;
    return h("div", null,
      h("button", { type: "button", onClick: () => files.open("m1", "file") }, "Save notes"),
      h("button", { type: "button", onClick: () => files.ensure("m1", "image") }, "Preview photo"),
    );
  }

  async function fileGround() {
    const fetchBytes = vi.fn(async (_attachmentId: string) => new Blob(["test"]));
    const listAttachments = vi.fn(async (_messageId: string) => parts);
    const unexpectedCall = async () => { throw new Error("the file fixture only serves attachments"); };
    const engine = new OhmailEngine({ adapter: {
      listAttachments,
      fetchAttachment: fetchBytes,
      sync: unexpectedCall,
      mutate: unexpectedCall,
      fetchBody: unexpectedCall,
      withdrawSend: unexpectedCall,
    } });
    const desktop = await draw(props(onItsOwn, { engine }));
    // Supply a small letter pane and keep the account's unrelated wires disconnected.
    const { host } = fakeHost({ engine, service: "self", scope: "file-test", above: MailGround, places: {
      ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: FilePresses } },
    } });
    const mounted = render(h(TextProvider, { locale: "en", messages: WORDS.en, timeZone: "UTC",
      children: h(Frame, { host: { ...host, device: { ...host.device, saveFile: desktop.device.saveFile } } }),
    }));
    await screen.findByRole("button", { name: "Save notes" });
    expect(listAttachments.mock.calls).toEqual([["m1"]]);
    return { mounted, fetchBytes };
  }

  it("uses browser downloads until the desktop arms its native file commands", async () => {
    const invoke = vi.fn(async (command: string, _payload: unknown) => command === "stage_attachment_preview"
      ? { url: "blob:staged-image", token: "fixture-preview" }
      : null);
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return "blob:browser-file"; }
      static revokeObjectURL() { /* the fixture owns no bytes outside this tab */ }
    });
    try {
      const browser = await fileGround();
      fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
      await waitFor(() => expect(downloads).toEqual(["notes.pdf"]));
      fireEvent.click(screen.getByRole("button", { name: "Preview photo" }));
      await waitFor(() => expect(browser.fetchBytes.mock.calls.map(([id]) => id)).toEqual(["file", "image"]));
      expect(invoke).not.toHaveBeenCalled();
      browser.mounted.unmount();

      enableDesktopAttachments();
      const desktop = await fileGround();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
        fireEvent.click(screen.getByRole("button", { name: "Preview photo" }));
      });
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenCalledWith("save_attachment", { attachmentId: "file", filename: "notes.pdf" });
      expect(invoke).toHaveBeenCalledWith("stage_attachment_preview", { attachmentId: "image", mimeType: "image/png" });
      expect(downloads).toEqual(["notes.pdf"]);
      expect(desktop.fetchBytes).not.toHaveBeenCalled();
      desktop.mounted.unmount();
      expect(invoke).toHaveBeenLastCalledWith("release_attachment_preview", { token: "fixture-preview" });
    } finally {
      vi.unstubAllGlobals();
      click.mockRestore();
    }
  });
});

/* The standalone window offers its own model through the registered Screener feature.
   The managed window uses the account's suggestion wire. The paired host offers neither. */
describe("the Screener's suggestion on each of the desktop's doors", () => {
  it("offers its own model on this computer's own door, the account's suggestion on the managed door, none on a paired one", async () => {
    const own = await draw(props(onItsOwn));
    expect(own.capabilities.suggest).toBe("ownModel");
    expect(own.features.screener === NONE ? undefined : own.features.screener.ownSuggest,
      "the own model's control is handed on this computer's own door").toBeTypeOf("function");
    const account = await draw(props(managed));
    expect(account.wires.suggest).toBe(cloudSuggestWire);
    expect(account.capabilities.suggest).not.toBe(NONE);
    expect(account.features.screener === NONE ? undefined : account.features.screener.ownSuggest).toBeUndefined();
    const other = await draw(props(paired));
    expect(other.wires.suggest).toBe(NONE);
    expect(other.wires.ownModelAutoSuggest).toBe(NONE);
    expect(other.features.screener === NONE ? undefined : other.features.screener.ownSuggest).toBeUndefined();
  });
});

/* THE PAIRED PAGE, read back the same way: the page a desktop serves to a phone's browser hands the mail the calls its
   host serves over the bearer, and none of the Cloud's. */
describe("the paired page's host, read door by door at the contract", () => {
  it("hands the bearer's wires, says pictures and unsubscribes come from the computer, and nothing of the Cloud", async () => {
    const { pairedHost } = await import("../../../test/support/paired-mail-fixtures.js");
    const { HOST_CLIENT_SEND_MAX_TOTAL_BYTES } = await import("../../../test/support/paired-mail-fixtures.js");
    const wire = <T,>(name: string) => named<T>(name);
    const consent = { foldersStorable: false } as never;
    const host = pairedHost(named("engine"), { scope: "pair-1", mirrorAccount: null, sendCeiling: HOST_CLIENT_SEND_MAX_TOTAL_BYTES, build: { version: null, commit: null } }, {
      signOut: async () => undefined, mailboxes: wire("mailboxes"),
      wires: { gapLetters: wire("gap"), profileImport: wire("profile"), consent, olderBody: wire("older"), junk: wire("junk"), trash: wire("trash"), draftReply: wire("draft"), autoFiled: NONE },
      features: { account: { name: "account", render: () => null }, accountStrip: { name: "accountStrip", render: () => null }, screener: { name: "screener", render: () => null } },
      notifications: named("notifications"), frame, language: NONE, openLink: named("openLink"),
    });
    expect(host.capabilities.service === "managed").toBe(false);
    expect(host.capabilities.sendCeiling).toBe(HOST_CLIENT_SEND_MAX_TOTAL_BYTES);
    expect(host.capabilities.unsubscribeFrom === "computer").toBe(true);
    expect(host.wires.images).toBe(NONE);
    expect(host.wires.consent).toBe(consent);
    const { gapLetters, profileImport, olderBody, junk, trash, draftReply } = host.wires;
    expect([gapLetters, profileImport, olderBody, junk, trash, draftReply])
      .toEqual([named("gap"), named("profile"), named("older"), named("junk"), named("trash"), named("draft")]);
    expect([host.wires.liveBody, host.wires.suggest, host.wires.away, host.wires.organizerNotice, support(host)])
      .toEqual([NONE, NONE, NONE, NONE, undefined]);
    expect(host.features.account).not.toBe(NONE);
  });
});
