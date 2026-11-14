import { describe, expect, it } from "vitest";
import {
  CANNOT, FEATURE_NAMES, NONE, panesOf,
  type FeatureEntry, type HostContract, type HostFeatures, type HostWires,
} from "../src/host/index.js";

const entry = {} as FeatureEntry;
const noFeature = Object.fromEntries(FEATURE_NAMES.map((name) => [name, NONE])) as HostFeatures;
const noWire: HostWires = {
  organizerNotice: NONE, gapLetters: NONE, liveBody: NONE, away: NONE, profileImport: NONE, consent: NONE,
  images: NONE, olderBody: NONE, junk: NONE, trash: NONE, suggest: NONE, draftReply: NONE, firstRun: NONE,
  screening: NONE, autoFiled: NONE, seedReview: NONE, folderSummary: NONE, ownModelAutoSuggest: NONE, mailboxes: NONE,
};

/** A host that cannot do anything: every wire, read, feature, device verb and signal `none`. */
function hostThatCannot(over: Partial<Pick<HostContract, "wires" | "features" | "capabilities">> = {}): HostContract {
  return {
    engine: {} as HostContract["engine"],
    session: { resolve: NONE, confirmed: NONE, state: NONE, scope: null, signOut: NONE },
    reads: { mailboxes: NONE, copyAge: NONE, access: NONE },
    wires: noWire,
    capabilities: { service: "ownComputer", ...CANNOT },
    features: noFeature,
    device: {
      build: { surface: "web", version: null, commit: null, mailtoLeaves: true },
      notifications: NONE, badge: NONE, language: NONE, openLink: NONE, pickFile: NONE, saveFile: NONE,
      defaultMail: NONE, appearance: NONE, textSize: NONE, fold: NONE, liveTheme: NONE,
    },
    signals: {
      hostConnection: NONE, linkIn: NONE, sessionState: NONE, copyAge: NONE, access: NONE, updateOffer: NONE,
      droppedFiles: NONE,
    },
    ...over,
  };
}

const listed = (host: HostContract) =>
  Object.entries(panesOf(host)).filter(([, shown]) => shown).map(([pane]) => pane).sort();

describe("the sections a host's answers list", () => {
  it("a host that cannot do anything lists Rules alone, beside the three that are always there", () => {
    expect(listed(hostThatCannot())).toEqual(["rules"]);
  });

  it("each feature a host hands in lists its own section", () => {
    const section: Record<string, string> = {
      mailboxes: "mailboxes", ai: "ai", subscription: "billing", storage: "storage", invites: "invites",
      security: "security", account: "account", about: "about", desktop: "desktop", devices: "devices", help: "help",
    };
    for (const [feature, pane] of Object.entries(section)) {
      expect(listed(hostThatCannot({ features: { ...noFeature, [feature]: entry } })), feature).toEqual([pane, "rules"].sort());
    }
  });

  it("a card or a strip lists no section", () => {
    for (const feature of ["storageCard", "accountStrip", "defaultMail", "stageCard"] as const) {
      expect(listed(hostThatCannot({ features: { ...noFeature, [feature]: entry } })), feature).toEqual(["rules"]);
    }
  });

  it("the Screener's section needs its entry and one wire a control of it rides", () => {
    const features = { ...noFeature, screener: entry };
    expect(listed(hostThatCannot({ features }))).toEqual(["rules"]);
    const consent = {} as Exclude<HostWires["consent"], typeof NONE>;
    expect(listed(hostThatCannot({ wires: { ...noWire, consent } }))).toEqual(["rules", "signatures"]);
    expect(listed(hostThatCannot({ features, wires: { ...noWire, consent } }))).toEqual(["rules", "screener", "signatures"]);
    const screening = {} as Exclude<HostWires["screening"], typeof NONE>;
    expect(listed(hostThatCannot({ features, wires: { ...noWire, screening } }))).toEqual(["rules", "screener"]);
  });

  it("Away needs its wire and a place the replies leave from", () => {
    const away = {} as Exclude<HostWires["away"], typeof NONE>;
    const capabilities = { service: "self" as const, ...CANNOT };
    expect(listed(hostThatCannot({ wires: { ...noWire, away } }))).toEqual(["rules"]);
    expect(listed(hostThatCannot({ capabilities: { ...capabilities, awayRunsOn: "service" } }))).toEqual(["rules"]);
    expect(listed(hostThatCannot({ wires: { ...noWire, away }, capabilities: { ...capabilities, awayRunsOn: { host: "kestrel" } } })))
      .toEqual(["away", "rules"]);
  });

  it("Folders is listed where the choice can be stored, over the consent wire", () => {
    const consent = {} as Exclude<HostWires["consent"], typeof NONE>;
    const capabilities = { service: "managed" as const, ...CANNOT, foldersStorable: true };
    expect(listed(hostThatCannot({ capabilities }))).toEqual(["rules"]);
    expect(listed(hostThatCannot({ capabilities, wires: { ...noWire, consent } }))).toEqual(["folders", "rules", "signatures"]);
  });
});

describe("what a host that cannot answers", () => {
  it("is none wherever the set has it, and the member that claims the least where it has not", () => {
    expect(CANNOT).toEqual({
      prices: "none", sendCeiling: "strict", awayRunsOn: "none", rulesMarked: false, imagesFrom: "none",
      unsubscribeFrom: "none", foldersStorable: false, suggest: "none", pairing: "none", account: "none",
      firstRunDoor: "none", mailboxes: "none", language: "none",
    });
    expect("service" in CANNOT).toBe(false);
  });
});
