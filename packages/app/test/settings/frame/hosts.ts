/**
 * The eight settings of the host contract's section 4 as host records: what each one hands in that decides its
 * Settings menu. A conditional cell ("flag", "tick", "sess", "pair", "page", "stor") is answered the way that lists
 * the section; the menu test turns each one the other way.
 */
import {
  CANNOT,
  FEATURE_NAMES,
  NONE,
  type FeatureEntry,
  type FeatureName,
  type HostCapabilities,
  type HostContract,
  type HostWires,
} from "../../../src/host/index.js";
import { fakeHost, NO_ENGINE, type FakeHost, type FakeHostInput } from "../../support/fake-host.js";

const entry = { name: "help", render: () => null } as unknown as FeatureEntry;
const wire = {} as never;

export interface Setting {
  readonly features: readonly FeatureName[];
  readonly wires: readonly (keyof HostWires)[];
  readonly capabilities: Partial<HostCapabilities> & Pick<HostCapabilities, "service">;
}

/**
 * The setting's host, over the fake host's window, address and places. It hands an account's scope, as every host
 * hands one where Settings stands: under no scope the frame mounts nothing.
 */
export function madeOf(setting: Setting, more: Partial<FakeHostInput> = {}): FakeHost {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: setting.capabilities.service,
    scope: "acct-1",
    ...more,
  });
  const { host } = made;
  const features = { ...host.features };
  for (const name of FEATURE_NAMES)
    (features as Record<string, unknown>)[name] = setting.features.includes(name) ? entry : NONE;
  const wires = { ...host.wires };
  for (const name of setting.wires) (wires as Record<string, unknown>)[name] = wire;
  return {
    ...made,
    host: { ...host, features, wires, capabilities: { ...CANNOT, ...setting.capabilities } },
  };
}

export const hostOf = (setting: Setting): HostContract => madeOf(setting).host;

const MANAGED_WIRES = ["consent", "screening", "autoFiled", "away"] as const;

/** Managed web, self-hosted web, the demo, the desktop's four doors (local, managed, self-hosted, paired), the paired page. */
export const SETTINGS: Readonly<Record<string, Setting>> = {
  "W-m": {
    features: [
      "mailboxes",
      "screener",
      "ai",
      "subscription",
      "storage",
      "devices",
      "security",
      "account",
      "about",
      "help",
    ],
    wires: MANAGED_WIRES,
    capabilities: { service: "managed", awayRunsOn: "service", foldersStorable: true },
  },
  "W-s": {
    features: [
      "mailboxes",
      "screener",
      "ai",
      "storage",
      "devices",
      "invites",
      "security",
      "account",
      "about",
    ],
    wires: MANAGED_WIRES,
    capabilities: { service: "self", awayRunsOn: "service", foldersStorable: true },
  },
  "W-d": { features: ["screener", "about"], wires: [], capabilities: { service: "ownComputer" } },
  "D-l": {
    features: ["mailboxes", "screener", "desktop", "devices", "about", "help"],
    wires: ["consent", "screening", "away"],
    capabilities: { service: "ownComputer", awayRunsOn: "thisComputer" },
  },
  "D-m": {
    features: [
      "mailboxes",
      "screener",
      "ai",
      "desktop",
      "devices",
      "subscription",
      "storage",
      "security",
      "account",
      "about",
      "help",
    ],
    wires: MANAGED_WIRES,
    capabilities: { service: "managed", awayRunsOn: "service", foldersStorable: true },
  },
  "D-s": {
    features: [
      "mailboxes",
      "screener",
      "ai",
      "desktop",
      "devices",
      "subscription",
      "storage",
      "security",
      "account",
      "about",
      "help",
    ],
    wires: MANAGED_WIRES,
    capabilities: { service: "self", awayRunsOn: "service", foldersStorable: true },
  },
  "D-p": {
    features: ["mailboxes", "screener", "desktop", "about", "help"],
    wires: ["consent", "screening", "away"],
    capabilities: { service: "ownComputer", awayRunsOn: { host: "kestrel" } },
  },
  H: {
    features: ["mailboxes", "screener", "account"],
    wires: ["consent"],
    capabilities: { service: "ownComputer" },
  },
};

/** Section 4's rows, Y and the listing answer of each conditional cell, in the menu's order. */
export const MENUS: Readonly<Record<keyof typeof SETTINGS, readonly string[]>> = {
  "W-m": [
    "general",
    "notifications",
    "mailboxes",
    "screener",
    "ai",
    "away",
    "rules",
    "tags",
    "folders",
    "signatures",
    "devices",
    "billing",
    "storage",
    "security",
    "account",
    "about",
    "help",
  ],
  "W-s": [
    "general",
    "notifications",
    "mailboxes",
    "screener",
    "ai",
    "away",
    "rules",
    "tags",
    "folders",
    "signatures",
    "devices",
    "storage",
    "invites",
    "security",
    "account",
    "about",
  ],
  "W-d": ["general", "notifications", "rules", "tags", "about"],
  "D-l": [
    "general",
    "notifications",
    "mailboxes",
    "screener",
    "away",
    "rules",
    "tags",
    "signatures",
    "desktop",
    "devices",
    "about",
    "help",
  ],
  "D-m": [
    "general",
    "notifications",
    "mailboxes",
    "screener",
    "ai",
    "away",
    "rules",
    "tags",
    "folders",
    "signatures",
    "desktop",
    "devices",
    "billing",
    "storage",
    "security",
    "account",
    "about",
    "help",
  ],
  "D-s": [
    "general",
    "notifications",
    "mailboxes",
    "screener",
    "ai",
    "away",
    "rules",
    "tags",
    "folders",
    "signatures",
    "desktop",
    "devices",
    "billing",
    "storage",
    "security",
    "account",
    "about",
    "help",
  ],
  "D-p": [
    "general",
    "notifications",
    "mailboxes",
    "screener",
    "away",
    "rules",
    "tags",
    "signatures",
    "desktop",
    "about",
    "help",
  ],
  H: ["general", "notifications", "mailboxes", "screener", "rules", "tags", "signatures", "account"],
};
