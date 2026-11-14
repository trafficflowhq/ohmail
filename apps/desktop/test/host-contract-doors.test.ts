/**
 * THE DESKTOP'S ANSWERS, PER DOOR, AND THE PAIRED PAGE'S. What `desktopHost` and `pairedHost` say
 * for each of the four doors and for the page a desktop serves, held to what the running app
 * showed in each: the sections its Settings menu listed, and the control each capability decides.
 * Nothing mounts through them yet, so this is what keeps them true until something does.
 */
import { describe, expect, it } from "vitest";
import { FEATURE_NAMES, NONE, panesOf, type FeatureName, type HostContract } from "@ohmail/app/host";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { DESKTOP_SELFHOST_SEND_MAX_TOTAL_BYTES, desktopSendSurface } from "../src/desktop-send-surface.js";
import { isPreview, linksOutToBilling } from "../src/distribution.js";
import { CLOUD_URL } from "../src/doors.js";
import { pairedHost, type PairedSupplies } from "../src/host-client/host.js";
import { desktopHost, type DesktopFacts, type DesktopSupplies } from "../src/host-contract.js";

const WIRES = [
  "organizerNotice", "gapLetters", "liveBody", "away", "profileImport", "images", "olderBody", "junk", "trash",
  "suggest", "draftReply", "firstRun", "screening", "autoFiled", "ownModelAutoSuggest", "mailboxes",
] as const;
/** A stand-in that is only ever compared: which thing was handed on, not what it does. */
const named = <T,>(name: string) => ({ named: name }) as unknown as T;
const engine = named<HostContract["engine"]>("engine");

const has: DesktopSupplies = {
  signOut: named("signOut"),
  reads: { mailboxes: named("mailboxes"), copyAge: named("copyAge"), access: named("access") },
  wires: {
    ...(Object.fromEntries(WIRES.map((wire) => [wire, named(wire)])) as Omit<DesktopSupplies["wires"], "consent">),
    consent: { account: named("consent of the account"), standalone: named("consent of an install on its own") },
  },
  features: Object.fromEntries(FEATURE_NAMES.map((feature) => [feature, named(feature)])) as DesktopSupplies["features"],
  notifications: named("notifications"),
  badge: named("badge"),
  hostConnection: named("hostConnection"),
  linkIn: named("linkIn"),
};

/** Each door as the engine's status names it; behind every signed-in or paired door a live session. */
const door = (status: Partial<EngineStatus>, over: Partial<DesktopFacts> = {}): DesktopFacts => ({
  status: { state: "serving", ...status },
  session: "live",
  sessionRefused: false,
  hostLabel: null,
  subscriptionPage: false,
  storageBlock: false,
  linksOutToBilling: true,
  takesMailLinks: true,
  scope: "a-mailbox",
  build: { version: "1.0.11", commit: "abc" },
  ...over,
});
const onItsOwn = door({ mode: "local" });
const managed = door({ mode: "cloud", cloudUrl: CLOUD_URL });
const selfHosted = door({ mode: "cloud", cloudUrl: "https://mail.lichtgrat.example" });
const paired = door({ mode: "cloud", flavor: "desktop-host", cloudUrl: "https://kestrel.example:8443" }, { hostLabel: "kestrel" });

const listed = (host: HostContract) => Object.entries(panesOf(host)).filter(([, shown]) => shown).map(([pane]) => pane).sort();
const withheld = (host: HostContract) => Object.entries(host.wires).filter(([, wire]) => wire === NONE).map(([wire]) => wire).sort();
const without = (panes: string[], ...gone: string[]) => panes.filter((pane) => !gone.includes(pane));
/** The whole record of features: the entry supplied under each name handed on, `none` under every other. */
const entries = (from: object, ...handedOn: FeatureName[]) =>
  Object.fromEntries(FEATURE_NAMES.map((feature) => [feature, handedOn.includes(feature) ? (from as Record<string, unknown>)[feature] : NONE]));
/** What the computer is, and what no door hands on yet: a device's verbs and a host's signals. */
const UNWIRED_VERBS = {
  language: NONE, openLink: NONE, pickFile: NONE, saveFile: NONE, defaultMail: NONE, appearance: NONE, textSize: NONE,
  fold: NONE, liveTheme: NONE,
};
const NO_SIGNAL = {
  hostConnection: NONE, linkIn: NONE, sessionState: NONE, copyAge: NONE, access: NONE, updateOffer: NONE, droppedFiles: NONE,
};
const DESKTOP_DEVICE = {
  ...UNWIRED_VERBS,
  build: { surface: "desktop", version: "1.0.11", commit: "abc", mailtoLeaves: false },
  notifications: has.notifications,
  badge: has.badge,
};
/** What every door hands on: its mailboxes, the two panes about the computer, the mail-program row and ask, the Screener, Help. */
const EVERY_DOOR = ["mailboxes", "about", "desktop", "defaultMail", "stageCard", "screener", "help"] as const;
/** What an account behind the door adds, before its subscription page and storage block. */
const AN_ACCOUNT = [...EVERY_DOOR, "account", "security", "ai", "accountStrip", "devices"] as const;

describe("the desktop on its own", () => {
  const host = desktopHost(engine, onItsOwn, has);

  it("lists the sections its Settings menu showed", () => {
    expect(listed(host)).toEqual(["about", "away", "desktop", "devices", "help", "mailboxes", "rules", "screener", "signatures"]);
  });

  it("answers each capability as its control showed it", () => {
    expect(host.capabilities).toEqual({
      service: "ownComputer", prices: "none", sendCeiling: desktopSendSurface(onItsOwn.status), awayRunsOn: "thisComputer",
      rulesMarked: true, imagesFrom: "computer", unsubscribeFrom: "computer", foldersStorable: false, suggest: "ownModel",
      pairing: "hostMode", account: "none", firstRunDoor: "local", mailboxes: "here", language: "install",
    });
    expect(typeof host.capabilities.sendCeiling).toBe("number");
  });

  it("has no account behind it: no live body, no spend, no access answer, no copy to age", () => {
    expect(withheld(host)).toEqual(["folderSummary", "liveBody", "seedReview", "suggest"]);
    expect(host.wires.consent).toBe(has.wires.consent.standalone);
    expect(host.reads).toEqual({ mailboxes: has.reads.mailboxes, copyAge: NONE, access: NONE });
    expect(host.session).toEqual({ resolve: NONE, confirmed: NONE, state: NONE, scope: "a-mailbox", signOut: has.signOut });
    expect(host.signals).toEqual({ ...NO_SIGNAL, linkIn: has.linkIn });
  });

  it("hands on what every door has and host mode's devices, and nothing an account gives", () => {
    expect(host.features).toEqual(entries(has.features, ...EVERY_DOOR, "devices"));
  });

  it("is a desktop: its own notifications and badge, and a mailto that stays in the window", () => {
    expect(host.device).toEqual(DESKTOP_DEVICE);
    expect(host.engine).toBe(engine);
  });
});

describe("the desktop signed in to the managed service", () => {
  const host = desktopHost(engine, managed, has);

  it("lists the sections its Settings menu showed, and Folders, which the account's own state took away there", () => {
    const menu = ["about", "account", "ai", "away", "desktop", "devices", "help", "mailboxes", "rules", "screener", "security", "signatures"];
    expect(without(listed(host), "folders")).toEqual(menu);
    expect(listed(host)).toContain("folders");
  });

  it("answers each capability as its control showed it", () => {
    expect(host.capabilities).toEqual({
      service: "managed", prices: "none", sendCeiling: desktopSendSurface(managed.status), awayRunsOn: "service",
      rulesMarked: false, imagesFrom: "service", unsubscribeFrom: "service", foldersStorable: true, suggest: "priced",
      pairing: "inBrowser", account: "inBrowser", firstRunDoor: "none", mailboxes: "resyncAndOut", language: "install",
    });
    expect(typeof host.capabilities.sendCeiling).toBe("number");
  });

  it("carries the account's wires over the pipe, and no first run", () => {
    expect(withheld(host)).toEqual(["firstRun", "folderSummary", "ownModelAutoSuggest", "seedReview"]);
    expect(host.wires.consent).toBe(has.wires.consent.account);
    expect(host.reads).toEqual(has.reads);
    expect(host.session).toEqual({ resolve: NONE, confirmed: NONE, state: "live", scope: "a-mailbox", signOut: has.signOut });
    expect(host.signals).toEqual({ ...NO_SIGNAL, hostConnection: has.hostConnection, linkIn: has.linkIn });
    expect(host.device).toEqual(DESKTOP_DEVICE);
  });

  it("hands on the account's features, and neither Subscription nor Storage before the service offers them", () => {
    expect(host.features).toEqual(entries(has.features, ...AN_ACCOUNT));
  });

  it("says the session was refused once the window has said so", () => {
    expect(desktopHost(engine, { ...managed, sessionRefused: true }, has).session.state).toBe("refused");
  });

  it("links out to the subscription where a page is served, and shows numbers alone in a store's build", () => {
    const served = { ...managed, subscriptionPage: true, storageBlock: true };
    expect(desktopHost(engine, served, has).capabilities.prices).toBe("linkOut");
    expect(listed(desktopHost(engine, served, has))).toEqual(expect.arrayContaining(["billing", "storage"]));
    expect(desktopHost(engine, served, has).features).toEqual(entries(has.features, ...AN_ACCOUNT, "subscription", "storage", "storageCard"));
    const store = desktopHost(engine, { ...served, linksOutToBilling: false }, has);
    expect(store.capabilities.prices).toBe("data");
    expect(listed(store)).toContain("storage");
    expect(listed(store)).not.toContain("billing");
    expect(store.features).toEqual(entries(has.features, ...AN_ACCOUNT, "storage", "storageCard"));
  });

  it("is the door on its own in everything an account gives, once the session is out", () => {
    const out = desktopHost(engine, { ...managed, session: "out" }, has);
    expect(listed(out)).toEqual(["about", "desktop", "help", "mailboxes", "rules", "screener"]);
    expect(out.features).toEqual(entries(has.features, ...EVERY_DOOR));
    expect(out.capabilities).toMatchObject({ account: "none", pairing: "none", suggest: "none", awayRunsOn: "none", foldersStorable: false });
  });
});

describe("the desktop signed in to a self-hosted server", () => {
  const host = desktopHost(engine, selfHosted, has);

  it("lists what the managed door lists, and hands on what it hands on", () => {
    expect(listed(host)).toEqual(listed(desktopHost(engine, managed, has)));
    expect(host.features).toEqual(entries(has.features, ...AN_ACCOUNT));
    expect(host.device).toEqual(DESKTOP_DEVICE);
    expect(host.signals).toEqual({ ...NO_SIGNAL, hostConnection: has.hostConnection, linkIn: has.linkIn });
  });

  it("answers each capability as its control showed it", () => {
    expect(host.capabilities).toEqual({
      service: "self", prices: "none", sendCeiling: DESKTOP_SELFHOST_SEND_MAX_TOTAL_BYTES, awayRunsOn: "service",
      rulesMarked: false, imagesFrom: "service", unsubscribeFrom: "service", foldersStorable: true, suggest: "priced",
      pairing: "inBrowser", account: "inBrowser", firstRunDoor: "none", mailboxes: "resyncAndOut", language: "install",
    });
  });
});

describe("the desktop paired to another computer", () => {
  const host = desktopHost(engine, paired, has);

  it("lists the sections its Settings menu showed", () => {
    expect(listed(host)).toEqual(["about", "away", "desktop", "help", "mailboxes", "rules", "screener", "signatures"]);
  });

  it("answers each capability as its control showed it", () => {
    expect(host.capabilities).toEqual({
      service: "ownComputer", prices: "none", sendCeiling: "strict", awayRunsOn: { host: "kestrel" }, rulesMarked: false,
      imagesFrom: "computer", unsubscribeFrom: "computer", foldersStorable: false, suggest: "none", pairing: "none",
      account: "none", firstRunDoor: "none", mailboxes: "resyncOnly", language: "install",
    });
  });

  it("has no account behind it, and answers consent as an install on its own does", () => {
    expect(withheld(host)).toEqual(["firstRun", "folderSummary", "liveBody", "ownModelAutoSuggest", "seedReview", "suggest"]);
    expect(host.wires.consent).toBe(has.wires.consent.standalone);
    expect(host.reads).toEqual({ mailboxes: has.reads.mailboxes, copyAge: has.reads.copyAge, access: NONE });
  });

  it("hands on what every door has and no more, and reports the other computer's connection", () => {
    expect(host.features).toEqual(entries(has.features, ...EVERY_DOOR));
    expect(host.device).toEqual(DESKTOP_DEVICE);
    expect(host.signals).toEqual({ ...NO_SIGNAL, hostConnection: has.hostConnection, linkIn: has.linkIn });
  });

  it("claims no place for away replies while the other computer has no name", () => {
    expect(desktopHost(engine, { ...paired, hostLabel: null }, has).capabilities.awayRunsOn).toBe("none");
  });
});

describe("a preview build of the desktop", () => {
  /** What the build says of itself, by its own rules: a preview sells nothing and takes over no mail links. */
  const preview = { linksOutToBilling: linksOutToBilling("preview"), takesMailLinks: !isPreview("preview") };

  it("hands on no row for becoming the mail program, on any door, and everything else its door has", () => {
    const account = AN_ACCOUNT.filter((feature) => feature !== "defaultMail");
    const noAccount = EVERY_DOOR.filter((feature) => feature !== "defaultMail");
    expect(desktopHost(engine, { ...onItsOwn, ...preview }, has).features).toEqual(entries(has.features, ...noAccount, "devices"));
    expect(desktopHost(engine, { ...managed, ...preview }, has).features).toEqual(entries(has.features, ...account));
    expect(desktopHost(engine, { ...selfHosted, ...preview }, has).features).toEqual(entries(has.features, ...account));
    expect(desktopHost(engine, { ...paired, ...preview }, has).features).toEqual(entries(has.features, ...noAccount));
  });
});

describe("the page a desktop serves to a phone's browser", () => {
  const supplies: PairedSupplies = {
    signOut: named("signOut"),
    mailboxes: named("mailboxes"),
    wires: {
      gapLetters: named("gapLetters"), profileImport: named("profileImport"), consent: named("consent"),
      olderBody: named("olderBody"), junk: named("junk"), trash: named("trash"), draftReply: named("draftReply"),
      autoFiled: named("autoFiled"),
    },
    features: { account: named("account"), accountStrip: named("accountStrip"), screener: named("screener") },
    notifications: named("notifications"),
  };
  const host = pairedHost(engine, { scope: "a-pairing", sendCeiling: 32 * 1024 * 1024, build: { version: "1.0.11", commit: "abc" } }, supplies);

  it("lists the sections its Settings menu showed", () => {
    expect(listed(host)).toEqual(["account", "rules", "screener", "signatures"]);
  });

  it("answers each capability as its control showed it", () => {
    expect(host.capabilities).toEqual({
      service: "ownComputer", prices: "none", sendCeiling: 32 * 1024 * 1024, awayRunsOn: "none", rulesMarked: true,
      imagesFrom: "none", unsubscribeFrom: "computer", foldersStorable: false, suggest: "none", pairing: "none",
      account: "signOutOnly", firstRunDoor: "none", mailboxes: "none", language: "install",
    });
  });

  it("hands on the wires its host serves and nothing else", () => {
    expect(withheld(host)).toEqual([
      "away", "firstRun", "folderSummary", "images", "liveBody", "mailboxes", "organizerNotice", "ownModelAutoSuggest",
      "screening", "seedReview", "suggest",
    ]);
    expect(host.session).toEqual({ resolve: NONE, confirmed: NONE, state: NONE, scope: "a-pairing", signOut: supplies.signOut });
    expect(host.reads).toEqual({ mailboxes: supplies.mailboxes, copyAge: NONE, access: NONE });
  });

  it("hands on Account as sign-out, the strip that says a change will not be kept, and the Screener's section", () => {
    expect(host.features).toEqual(entries(supplies.features, "account", "accountStrip", "screener"));
  });

  it("is a page in a browser: its own notification reader, no badge, a mailto that leaves, and no signal", () => {
    expect(host.device).toEqual({
      ...UNWIRED_VERBS,
      build: { surface: "pairedPage", version: "1.0.11", commit: "abc", mailtoLeaves: true },
      notifications: supplies.notifications,
      badge: NONE,
    });
    expect(host.signals).toEqual(NO_SIGNAL);
    expect(host.engine).toBe(engine);
  });
});
