import { describe, expect, it } from "vitest";
import { CANNOT, FEATURE_NAMES, NONE, type HostCapabilities, type HostContract } from "@ohmail/app/host";
import { NO_TODAYS, todaysInputs, type TodaysNodes } from "../../app/shell/todays-inputs";

/**
 * TODAY'S VIEWS READ THE HOST CONTRACT UNDER THEIR OLD NAMES, and nothing else: a sentinel handed in under a key
 * comes out under its old name, `none` comes out `undefined`, nothing is defaulted, and two answers that contradict
 * each other stop the mount.
 */
const named = <T,>(name: string) => ({ named: name }) as unknown as T;
const WIRES = [
  "organizerNotice", "gapLetters", "liveBody", "away", "profileImport", "consent", "images", "olderBody", "junk",
  "trash", "suggest", "draftReply", "firstRun", "screening", "autoFiled", "seedReview", "folderSummary",
  "ownModelAutoSuggest", "mailboxes",
] as const;
const CONSENT = { named: "consent", foldersStorable: true };
const FIRST_RUN = { named: "firstRun", door: "cloud" };
const entryOf = (name: string) => ({ name, render: () => `node:${name}` });

function host(over: { capabilities?: Partial<HostCapabilities>; wires?: Record<string, unknown>; features?: Record<string, unknown>; surface?: "web" | "desktop" | "pairedPage" } = {}): HostContract {
  return {
    engine: named("engine"),
    session: { resolve: NONE, confirmed: NONE, state: "live", scope: "acct-1", account: "acct-1", recover: NONE, signOut: NONE },
    reads: { mailboxes: named("mailboxes"), copyAge: named("copyAge"), access: named("access") },
    wires: { ...Object.fromEntries(WIRES.map((w) => [w, named(w)])), consent: CONSENT, firstRun: FIRST_RUN, ...over.wires } as never,
    capabilities: { ...CANNOT, service: "managed", firstRunDoor: "cloud", ...over.capabilities } as HostCapabilities,
    features: {
      ...Object.fromEntries(FEATURE_NAMES.map((f) => [f, entryOf(f)])),
      places: named("places"), stages: named("stages"), ...over.features,
    } as never,
    device: {
      build: { surface: over.surface ?? "web", version: "1.0.11", commit: "abc", mailtoLeaves: true },
      notifications: named("notifications"), badge: named("badge"), language: NONE, openLink: NONE, pickFile: NONE,
      saveFile: NONE, defaultMail: NONE, textSize: NONE, fold: NONE, liveTheme: NONE,
      address: named("address"), window: named("window"), appearance: named("appearance"),
    },
    signals: { hostConnection: NONE, linkIn: NONE, sessionState: NONE, copyAge: NONE, access: NONE, updateOffer: NONE, droppedFiles: NONE },
  } as HostContract;
}
const DESKTOP_PANE: TodaysNodes = { screenerSuggest: NONE, desktopPane: { label: "Desktop" } };

describe("today's inputs, read off the host contract", () => {
  it("hands every answer on under its old name", () => {
    const h = host();
    const got = todaysInputs(h, DESKTOP_PANE);
    expect(got).toMatchObject({
      mailboxFacts: h.reads.mailboxes, mirrorFreshness: h.reads.copyAge,
      organizerNoticeTransport: h.wires.organizerNotice, gapLettersTransport: h.wires.gapLetters,
      liveBodyWire: h.wires.liveBody, awayTransport: h.wires.away, profileImportTransport: h.wires.profileImport,
      consentTransport: CONSENT, imageWire: h.wires.images, olderBodyWire: h.wires.olderBody, junkWire: h.wires.junk,
      trashWire: h.wires.trash, suggestWire: h.wires.suggest, draftReplyWire: h.wires.draftReply, firstRun: FIRST_RUN,
      notificationHost: h.device.notifications, onUnread: h.device.badge,
      accountSection: "node:account", mailboxSection: "node:mailboxes", aiSection: "node:ai",
      billingSection: "node:subscription", storageSection: "node:storage", storageCard: "node:storageCard",
      invitesSection: "node:invites", securitySection: "node:security", aboutSection: "node:about",
      devicesSection: "node:devices", defaultMailSection: "node:defaultMail", stageCard: "node:stageCard",
      screeningSection: "node:screener", desktopSection: { label: "Desktop", node: "node:desktop" },
      support: { surface: "web", version: "1.0.11", commit: "abc", accountId: "acct-1", mailtoLeaves: true },
    });
    expect(got.consentTransport).toBe(CONSENT);
  });

  it("reads every none as undefined, never as a hosted client", () => {
    const h = host({
      wires: Object.fromEntries(WIRES.map((w) => [w, NONE])),
      features: Object.fromEntries(FEATURE_NAMES.map((f) => [f, NONE])),
    });
    const bare = { ...h, reads: { mailboxes: NONE, copyAge: NONE, access: NONE }, device: { ...h.device, notifications: NONE, badge: NONE } } as HostContract;
    const got = todaysInputs(bare, NO_TODAYS);
    const absent = Object.entries(got).filter(([, v]) => v !== undefined).map(([k]) => k).sort();
    expect(absent).toEqual(["actRulesUnmarked", "awayIsLocal", "imagesFromComputer", "managedService"]);
  });

  it("says the three send ceilings as the old input did: strict absent, the mailbox's null, a number itself", () => {
    expect(todaysInputs(host({ capabilities: { sendCeiling: "strict" } }), DESKTOP_PANE).sendSurfaceMaxTotalBytes).toBeUndefined();
    expect(todaysInputs(host({ capabilities: { sendCeiling: "mailbox" } }), DESKTOP_PANE).sendSurfaceMaxTotalBytes).toBeNull();
    expect(todaysInputs(host({ capabilities: { sendCeiling: 1024 } }), DESKTOP_PANE).sendSurfaceMaxTotalBytes).toBe(1024);
  });

  it.each([
    ["service", false, undefined],
    ["thisComputer", true, undefined],
    [{ host: "kestrel" }, false, "kestrel"],
    ["none", false, undefined],
  ] as const)("away on %j is local %s, on another computer %s", (awayRunsOn, local, onHost) => {
    const got = todaysInputs(host({ capabilities: { awayRunsOn } }), DESKTOP_PANE);
    expect([got.awayIsLocal, got.awayOnHost]).toEqual([local, onHost]);
  });

  it.each([["managed", true], ["self", false], ["ownComputer", false]] as const)("the %s service is managed: %s", (service, managed) => {
    expect(todaysInputs(host({ capabilities: { service } }), DESKTOP_PANE).managedService).toBe(managed);
  });

  it("marks rules and unsubscribes as the capabilities say", () => {
    expect(todaysInputs(host({ capabilities: { rulesMarked: false, unsubscribeFrom: "computer" } }), DESKTOP_PANE))
      .toMatchObject({ actRulesUnmarked: true, imagesFromComputer: true });
    expect(todaysInputs(host({ capabilities: { rulesMarked: true, unsubscribeFrom: "service" } }), DESKTOP_PANE))
      .toMatchObject({ actRulesUnmarked: false, imagesFromComputer: false });
  });

  it("stops the mount on two answers that contradict each other, naming both keys", () => {
    expect(() => todaysInputs(host(), NO_TODAYS)).toThrow(/features\.desktop and todays\.desktopPane/);
    expect(() => todaysInputs(host({ wires: { consent: { named: "consent" } } }), DESKTOP_PANE)).toThrow(/wires\.consent/);
    expect(() => todaysInputs(host({ wires: { firstRun: { named: "firstRun" } } }), DESKTOP_PANE)).toThrow(/wires\.firstRun/);
    expect(() => todaysInputs(host({ capabilities: { firstRunDoor: "selfhost" } }), DESKTOP_PANE)).toThrow(/capabilities\.firstRunDoor/);
    expect(() => todaysInputs(host({ surface: "pairedPage" }), DESKTOP_PANE)).toThrow(/features\.help/);
  });

  it("hands the Screener's own control on where the shell brings one", () => {
    const control = () => "control";
    expect(todaysInputs(host(), { ...DESKTOP_PANE, screenerSuggest: control }).screenerSuggest).toBe(control);
    expect(todaysInputs(host(), DESKTOP_PANE).screenerSuggest).toBeUndefined();
  });
});
