/**
 * THE WEB SHELL'S ANSWERS, PER SETTING. What `webHost` says for the managed build and for a
 * self-hosted server, held to what the running app showed in each: the sections its Settings
 * menu listed, and the control each capability decides. Nothing mounts through `webHost` yet, so
 * this is what keeps it true until something does.
 */
import { describe, expect, it } from "vitest";
import { FEATURE_NAMES, NONE, panesOf, type FeatureName, type HostContract } from "@ohmail/app/host";
import { webHost, type WebFacts, type WebSupplies } from "../app/(product)/mailbox/host";

const WIRES = [
  "organizerNotice", "gapLetters", "liveBody", "away", "profileImport", "consent", "images", "olderBody", "junk",
  "trash", "suggest", "draftReply", "firstRun", "screening", "autoFiled", "seedReview", "folderSummary", "mailboxes",
] as const;
/** A stand-in that is only ever compared: which thing was handed on, not what it does. */
const named = <T,>(name: string) => ({ named: name }) as unknown as T;

const has: WebSupplies = {
  session: { resolve: named("resolve"), confirmed: named("confirmed"), signOut: named("signOut") },
  reads: { mailboxes: named("mailboxes"), access: named("access") },
  wires: Object.fromEntries(WIRES.map((wire) => [wire, named(wire)])) as WebSupplies["wires"],
  features: Object.fromEntries(FEATURE_NAMES.map((feature) => [feature, named(feature)])) as WebSupplies["features"],
  notifications: named("notifications"),
};
const engine = named<HostContract["engine"]>("engine");

/** The managed build, as it was read: the server pairs devices and fetches pictures, and meters nothing. */
const managed: WebFacts = {
  selfHost: false,
  server: { pairing: true, remoteImages: true },
  invites: false,
  subscriptionPage: false,
  storageBlock: false,
  sendSurface: undefined,
  foldersStorable: true,
  scope: "an-account",
  build: { version: "1.0.11", commit: "abc" },
};
/** A self-hosted server, as it was read: the same server words, invitations, and a staged send. */
const selfHosted: WebFacts = { ...managed, selfHost: true, invites: true, sendSurface: 20 * 1024 * 1024 };

const listed = (host: HostContract) => Object.entries(panesOf(host)).filter(([, shown]) => shown).map(([pane]) => pane).sort();
const withheld = (host: HostContract) => Object.entries(host.wires).filter(([, wire]) => wire === NONE).map(([wire]) => wire).sort();
/** The whole record of features: the entry supplied under each name handed on, `none` under every other. */
const entries = (...handedOn: FeatureName[]) =>
  Object.fromEntries(FEATURE_NAMES.map((feature) => [feature, handedOn.includes(feature) ? (has.features as Record<string, unknown>)[feature] : NONE]));
/** A page in a browser: its own notification reader, a mailto that leaves, no badge, and no verb or signal wired yet. */
const BROWSER_DEVICE = {
  build: { surface: "web", version: "1.0.11", commit: "abc", mailtoLeaves: true },
  notifications: has.notifications,
  badge: NONE, language: NONE, openLink: NONE, pickFile: NONE, saveFile: NONE, defaultMail: NONE, appearance: NONE,
  textSize: NONE, fold: NONE, liveTheme: NONE,
};
const NO_SIGNAL = {
  hostConnection: NONE, linkIn: NONE, sessionState: NONE, copyAge: NONE, access: NONE, updateOffer: NONE, droppedFiles: NONE,
};
/** What the account's page hands on in every setting, before what the server's words and the build add. */
const THE_ACCOUNT = ["account", "mailboxes", "ai", "storageCard", "accountStrip", "security", "about", "screener"] as const;

describe("the web shell's answers on the managed service", () => {
  const host = webHost(engine, managed, has);

  it("lists the sections its Settings menu showed", () => {
    expect(listed(host)).toEqual([
      "about", "account", "ai", "away", "devices", "folders", "help", "mailboxes", "rules", "screener", "security", "signatures",
    ]);
  });

  it("answers each capability as its control showed it", () => {
    expect(host.capabilities).toEqual({
      service: "managed", prices: "none", sendCeiling: "strict", awayRunsOn: "service", rulesMarked: true,
      imagesFrom: "service", unsubscribeFrom: "service", foldersStorable: true, suggest: "priced", pairing: "account",
      account: "here", firstRunDoor: "cloud", mailboxes: "here", language: "account",
    });
  });

  it("hands on every wire it has but the switch for a person's own model", () => {
    expect(withheld(host)).toEqual(["ownModelAutoSuggest"]);
    expect(host.wires.liveBody).toBe(has.wires.liveBody);
    expect(host.reads).toEqual({ mailboxes: has.reads.mailboxes, copyAge: NONE, access: has.reads.access });
  });

  it("is the account's own page: a live session under the account's scope, and a browser's device", () => {
    expect(host.session).toEqual({ ...has.session, state: "live", scope: "an-account" });
    expect(host.device).toEqual(BROWSER_DEVICE);
    expect(host.signals).toEqual(NO_SIGNAL);
    expect(host.engine).toBe(engine);
  });

  it("hands on the account's features with Devices and Help, and nothing of a desktop's", () => {
    expect(host.features).toEqual(entries(...THE_ACCOUNT, "devices", "help"));
  });

  it("lists Subscription and Storage only where the service serves the page and the answer carries the block", () => {
    const served = webHost(engine, { ...managed, subscriptionPage: true, storageBlock: true }, has);
    expect(listed(served)).toEqual(expect.arrayContaining(["billing", "storage"]));
    expect(served.features).toEqual(entries(...THE_ACCOUNT, "devices", "help", "subscription", "storage"));
    expect(webHost(engine, { ...managed, subscriptionPage: true }, has).capabilities.prices).toBe("linkOut");
  });

  it("says what a send may carry: strict where it cannot stage, the mailbox's own, or the bytes", () => {
    expect(webHost(engine, { ...managed, sendSurface: null }, has).capabilities.sendCeiling).toBe("mailbox");
    expect(webHost(engine, { ...managed, sendSurface: 1024 }, has).capabilities.sendCeiling).toBe(1024);
  });

  it("draws no pictures and pairs nothing where the server does not say it will", () => {
    const quiet = webHost(engine, { ...managed, server: { pairing: false, remoteImages: false } }, has);
    expect(quiet.capabilities).toMatchObject({ imagesFrom: "none", pairing: "none" });
    expect(quiet.wires.images).toBe(NONE);
    expect(listed(quiet)).not.toContain("devices");
    expect(quiet.features).toEqual(entries(...THE_ACCOUNT, "help"));
  });
});

describe("the web shell's answers on a self-hosted server", () => {
  const host = webHost(engine, selfHosted, has);

  it("lists the sections its Settings menu showed: Invites, and no Help", () => {
    expect(listed(host)).toEqual([
      "about", "account", "ai", "away", "devices", "folders", "invites", "mailboxes", "rules", "screener", "security", "signatures",
    ]);
  });

  it("answers each capability as its control showed it", () => {
    expect(host.capabilities).toEqual({
      service: "self", prices: "none", sendCeiling: 20 * 1024 * 1024, awayRunsOn: "service", rulesMarked: true,
      imagesFrom: "service", unsubscribeFrom: "service", foldersStorable: true, suggest: "priced", pairing: "account",
      account: "here", firstRunDoor: "selfhost", mailboxes: "here", language: "account",
    });
  });

  it("has no Load it now: a server its operator runs keeps every body", () => {
    expect(withheld(host)).toEqual(["liveBody", "ownModelAutoSuggest"]);
  });

  it("hands on the account's features with Devices and Invites, and is the same page in a browser", () => {
    expect(host.features).toEqual(entries(...THE_ACCOUNT, "devices", "invites"));
    expect(host.device).toEqual(BROWSER_DEVICE);
    expect(host.signals).toEqual(NO_SIGNAL);
    expect(host.session).toEqual({ ...has.session, state: "live", scope: "an-account" });
    expect(host.reads).toEqual({ mailboxes: has.reads.mailboxes, copyAge: NONE, access: has.reads.access });
  });

  it("lists no Folders where the server drops the choice", () => {
    expect(listed(webHost(engine, { ...selfHosted, foldersStorable: false }, has))).not.toContain("folders");
  });
});
