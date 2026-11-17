/**
 * WHICH BODY EACH OF THE SIX ACCOUNT PANES ASKS FOR, over the eight settings of the host contract. Each setting's
 * features are the Settings frame's (`../settings/frame/hosts.ts`); its three capabilities are what that host's own
 * function answers today (the web's `host.ts`, the desktop's `host-contract.ts`, the paired page's `host.ts`).
 *
 * Two rows of that file are the contract's draft, and the code answers otherwise: a self-hosted web has no storage
 * block, and a desktop signed in to a self-hosted server is served no subscription page and no block. They are
 * corrected here, by name, and the file itself is left as it stands.
 */
import { describe, expect, it } from "vitest";
import { ACCOUNT_PANES, type AccountPaneId } from "../../src/account/contract.js";
import { accountBodies, type AccountBodies } from "../../src/account/bodies.js";
import { NONE, type HostCapabilities, type HostContract } from "../../src/host/index.js";
import { PANE_IDS, type SettingsPanes } from "../../src/settings/contract.js";
import { PANE_FACTS, paneOf } from "../../src/settings/facts.js";
import { menuOf } from "../../src/settings/menu.js";
import { hostOf, SETTINGS, type Setting } from "../settings/frame/hosts.js";

type Answers = Pick<HostCapabilities, "pairing" | "account" | "prices">;
type Name = "W-m" | "W-s" | "W-d" | "D-l" | "D-m" | "D-s" | "D-p" | "H";

const without = <T extends string>(list: readonly T[], ...gone: string[]): readonly T[] =>
  list.filter((item) => !gone.includes(item));

/** What each host's function answers for the three capabilities the bodies read. */
const ANSWERS: Readonly<Record<Name, Answers>> = {
  "W-m": { pairing: "account", account: "here", prices: "linkOut" },
  "W-s": { pairing: "account", account: "here", prices: NONE },
  "W-d": { pairing: NONE, account: NONE, prices: NONE },
  "D-l": { pairing: "hostMode", account: NONE, prices: NONE },
  "D-m": { pairing: "inBrowser", account: "inBrowser", prices: "linkOut" },
  "D-s": { pairing: "inBrowser", account: "inBrowser", prices: NONE },
  "D-p": { pairing: NONE, account: NONE, prices: NONE },
  H: { pairing: NONE, account: "signOutOnly", prices: NONE },
};

/** The draft's cells the code answers otherwise. */
const AS_THE_CODE_ANSWERS: Partial<Record<Name, readonly string[]>> = {
  "W-s": ["storage"],
  "D-s": ["subscription", "storage"],
};

function settingOf(name: Name, more: Partial<Answers> = {}): Setting {
  const drafted = SETTINGS[name]!;
  return {
    ...drafted,
    features: without(drafted.features, ...(AS_THE_CODE_ANSWERS[name] ?? [])),
    capabilities: { ...drafted.capabilities, ...ANSWERS[name], ...more },
  };
}
const host = (name: Name, more: Partial<Answers> = {}): HostContract => hostOf(settingOf(name, more));

const NO_BODY: AccountBodies = {
  devices: NONE,
  billing: NONE,
  storage: NONE,
  invites: NONE,
  security: NONE,
  account: NONE,
};

/** Which host lists which pane, and with what body: the eight rows. */
const BODIES: Readonly<Record<Name, AccountBodies>> = {
  "W-m": { ...NO_BODY, devices: "pane", billing: "pane", storage: "pane", security: "pane", account: "pane" },
  "W-s": { ...NO_BODY, devices: "pane", invites: "pane", security: "pane", account: "pane" },
  "W-d": NO_BODY,
  "D-l": { ...NO_BODY, devices: "hostPane" },
  "D-m": { ...NO_BODY, devices: "card", billing: "pane", storage: "pane", security: "card", account: "card" },
  "D-s": { ...NO_BODY, devices: "card", security: "card", account: "card" },
  "D-p": NO_BODY,
  H: { ...NO_BODY, account: "signOutOnly" },
};

const Body = () => null;
const EVERY_PANE = Object.fromEntries(PANE_IDS.map((id) => [id, paneOf(id, { Body })])) as SettingsPanes;
const listed = (of: HostContract, panes: SettingsPanes = EVERY_PANE): readonly string[] =>
  menuOf(of, panes)
    .map((pane) => pane.id)
    .filter((id) => (ACCOUNT_PANES as readonly string[]).includes(id));
const withBody = (bodies: AccountBodies): readonly AccountPaneId[] =>
  ACCOUNT_PANES.filter((id) => bodies[id] !== NONE);

/** A host that lists all six, so that one capability's answers can be walked alone. */
const listsAll = (more: Partial<Answers>): HostContract =>
  hostOf({
    features: ["devices", "subscription", "storage", "invites", "security", "account"],
    wires: [],
    capabilities: { service: "managed", ...more },
  });

describe("the six account panes' ids", () => {
  it("are Settings' Account group, in the menu's order", () => {
    expect([...ACCOUNT_PANES]).toEqual(PANE_IDS.filter((id) => PANE_FACTS[id].group === "account"));
  });
});

describe("the body each host's answers ask for", () => {
  for (const name of Object.keys(BODIES) as Name[]) {
    it(`${name}: each of the six is the pane, the card, the host's own, sign-out alone, or none`, () => {
      expect(accountBodies(host(name))).toEqual(BODIES[name]);
    });

    it(`${name}: a pane has a body exactly where the menu lists it`, () => {
      const of = host(name);
      expect(withBody(accountBodies(of))).toEqual(listed(of));
      // A shell registers a pane only where a body is asked for: the menu is then the same list.
      const bodies = accountBodies(of);
      const registered = {
        ...EVERY_PANE,
        ...Object.fromEntries(ACCOUNT_PANES.map((id) => [id, bodies[id] === NONE ? NONE : EVERY_PANE[id]])),
      } as SettingsPanes;
      expect(listed(of, registered)).toEqual(listed(of));
    });
  }

  it("a pane the host does not list has no body, whatever its capability answers", () => {
    const of = hostOf({
      features: [],
      wires: [],
      capabilities: { service: "managed", pairing: "account", account: "here", prices: "linkOut" },
    });
    expect(accountBodies(of)).toEqual(NO_BODY);
    // Each conditional cell turned the other way takes its body with it.
    const off = (name: Name, feature: string, id: AccountPaneId) => {
      const drafted = settingOf(name);
      const bodies = accountBodies(hostOf({ ...drafted, features: without(drafted.features, feature) }));
      expect(bodies, `${name} without ${feature}`).toEqual({ ...BODIES[name], [id]: NONE });
    };
    off("W-m", "devices", "devices");
    off("W-m", "subscription", "billing");
    off("W-m", "storage", "storage");
    off("W-s", "invites", "invites");
    off("D-m", "security", "security");
    off("H", "account", "account");
  });
});

describe("the capability's answer chooses the body, and nothing else does", () => {
  it("Devices: the pane only where pairing is the account's; the card in a browser; the host's own in host mode", () => {
    const body = (pairing: HostCapabilities["pairing"]) => accountBodies(listsAll({ pairing })).devices;
    expect(body("account")).toBe("pane");
    expect(body("inBrowser")).toBe("card");
    expect(body("hostMode")).toBe("hostPane");
    expect(body(NONE)).toBe(NONE);
  });

  it("Security and Account: the pane only where the account is here; the card in a browser", () => {
    const bodies = (account: HostCapabilities["account"]) => {
      const { security, account: own } = accountBodies(listsAll({ account }));
      return [security, own];
    };
    expect(bodies("here")).toEqual(["pane", "pane"]);
    expect(bodies("inBrowser")).toEqual(["card", "card"]);
    expect(bodies("signOutOnly")).toEqual([NONE, "signOutOnly"]);
    expect(bodies(NONE)).toEqual([NONE, NONE]);
  });

  it("Subscription and Storage: figures and verbs only where the build links out", () => {
    const bodies = (prices: HostCapabilities["prices"]) => {
      const { billing, storage } = accountBodies(listsAll({ prices }));
      return [billing, storage];
    };
    expect(bodies("linkOut")).toEqual(["pane", "pane"]);
    // A store's build shows the facts it has: no Subscription body at all, Storage with no figure and no verb.
    expect(bodies("data")).toEqual([NONE, "facts"]);
    expect(bodies(NONE)).toEqual([NONE, "facts"]);
  });

  it("Invites: listed means the pane", () => {
    expect(accountBodies(listsAll({})).invites).toBe("pane");
  });

  it("reads no other answer: the service, the surface and the other capabilities move nothing", () => {
    const answers: Answers = { pairing: "inBrowser", account: "signOutOnly", prices: "data" };
    const base = listsAll(answers);
    const moved: HostContract = {
      ...base,
      capabilities: {
        ...base.capabilities,
        service: "self",
        mailboxes: "here",
        firstRunDoor: "cloud",
        language: "account",
        suggest: "priced",
      },
      device: { ...base.device, build: { ...base.device.build, surface: "desktop" } },
    };
    expect(accountBodies(moved)).toEqual(accountBodies(base));
  });
});
