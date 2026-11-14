/**
 * THE FAKE HOST: a whole host contract, every key answered, for the frame's tests. A shell that cannot do a
 * thing says `none`; the fake says `none` everywhere a test does not hand an answer in. The engine and the
 * service have no default: a test names both, so that no case runs on a guessed branch. It moves to
 * `packages/testing` when that package lands.
 */
import type { OhmailEngine } from "@ohmail/client-engine";
import {
  PLACE_IDS,
  STAGE_IDS,
  type Appearance,
  type FrameHost,
  type FramePlaces,
  type FrameStages,
  type Recover,
} from "../../src/frame/contract.js";
import {
  CANNOT,
  FEATURE_NAMES,
  NONE,
  type HostCapabilities,
  type HostConnectionState,
  type FeatureEntry,
  type FeatureName,
  type HostSession,
  type HostWires,
  type None,
  type Signal,
} from "../../src/host/index.js";
import {
  fakeAddress,
  fakeAppearance,
  fakeWindow,
  type FakeAddress,
  type FakeWindow,
  type MovableSignal,
} from "./fake-window.js";

const WIRES = [
  "organizerNotice",
  "gapLetters",
  "liveBody",
  "away",
  "profileImport",
  "consent",
  "images",
  "olderBody",
  "junk",
  "trash",
  "suggest",
  "draftReply",
  "firstRun",
  "screening",
  "autoFiled",
  "seedReview",
  "folderSummary",
  "ownModelAutoSuggest",
  "mailboxes",
] as const satisfies readonly (keyof HostWires)[];

export const NO_PLACES: FramePlaces = Object.fromEntries(PLACE_IDS.map((id) => [id, NONE])) as FramePlaces;
export const NO_STAGES: FrameStages = Object.fromEntries(STAGE_IDS.map((id) => [id, NONE])) as FrameStages;

export interface FakeHostInput {
  readonly engine: OhmailEngine;
  readonly service: HostCapabilities["service"];
  readonly scope: string | null;
  readonly account?: string | null;
  readonly state?: HostSession["state"];
  readonly recover?: Recover;
  readonly places?: Partial<FramePlaces>;
  readonly stages?: Partial<FrameStages>;
  readonly window?: FakeWindow;
  readonly address?: FakeAddress;
  readonly appearance?: MovableSignal<Appearance>;
  readonly hostConnection?: Signal<HostConnectionState | null>;
  readonly features?: Partial<Record<FeatureName, FeatureEntry | None>>;
}

/** What the test holds besides the host: the window, the address and the look it can move. */
export interface FakeHost {
  readonly host: FrameHost;
  readonly window: FakeWindow;
  readonly address: FakeAddress;
  readonly appearance: MovableSignal<Appearance>;
}

export function fakeHost(input: FakeHostInput): FakeHost {
  const window = input.window ?? fakeWindow("desktop");
  const address = input.address ?? fakeAddress();
  const appearance = input.appearance ?? fakeAppearance();
  const host: FrameHost = {
    engine: input.engine,
    session: {
      resolve: NONE,
      confirmed: NONE,
      state: input.state ?? NONE,
      scope: input.scope,
      account: input.account ?? null,
      signOut: NONE,
      recover: input.recover ?? NONE,
    },
    reads: { mailboxes: NONE, copyAge: NONE, access: NONE },
    wires: Object.fromEntries(WIRES.map((key) => [key, NONE])) as unknown as HostWires,
    capabilities: { service: input.service, ...CANNOT },
    features: {
      ...(Object.fromEntries(FEATURE_NAMES.map((name) => [name, NONE])) as Record<FeatureName, None>),
      ...input.features,
      places: { ...NO_PLACES, ...input.places },
      stages: { ...NO_STAGES, ...input.stages },
    },
    device: {
      build: { surface: "web", version: null, commit: null, mailtoLeaves: false },
      notifications: NONE,
      badge: NONE,
      language: NONE,
      openLink: NONE,
      pickFile: NONE,
      saveFile: NONE,
      defaultMail: NONE,
      textSize: NONE,
      fold: NONE,
      liveTheme: NONE,
      address,
      window,
      appearance,
    },
    signals: {
      hostConnection: input.hostConnection ?? NONE,
      linkIn: NONE,
      sessionState: NONE,
      copyAge: NONE,
      access: NONE,
      updateOffer: NONE,
      droppedFiles: NONE,
    },
  };
  return { host, window, address, appearance };
}

/** An engine the frame never calls: the frame takes nothing of its own from it. */
export const NO_ENGINE = new Proxy({} as OhmailEngine, {
  get(_, key) {
    if (key === "then") return undefined;
    throw new Error(`the frame read the engine's ${String(key)}`);
  },
});
