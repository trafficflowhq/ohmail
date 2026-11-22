/**
 * THE FAKE HOST: a whole host contract, every key answered, for the frame's tests. A shell that cannot do a
 * thing says `none`; the fake says `none` everywhere a test does not hand an answer in. The engine and the
 * service have no default: a test names both, so that no case runs on a guessed branch. It moves to
 * `packages/testing` when that package lands.
 */
import type { OhmailEngine } from "@ohmail/client-engine";
import {
  OVER_IDS,
  PLACE_IDS,
  STAGE_IDS,
  type Appearance,
  type CalendarEntry,
  type FrameHost,
  type FrameOvers,
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
  type HostReads,
  type HostSession,
  type HostWires,
  type None,
  type ReaderEntry,
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
  "connect",
  "mailboxes",
  "calendar",
] as const satisfies readonly (keyof HostWires)[];

export const NO_PLACES: FramePlaces = Object.fromEntries(PLACE_IDS.map((id) => [id, NONE])) as FramePlaces;
export const NO_STAGES: FrameStages = Object.fromEntries(STAGE_IDS.map((id) => [id, NONE])) as FrameStages;
export const NO_OVERS: FrameOvers = Object.fromEntries(OVER_IDS.map((id) => [id, NONE])) as FrameOvers;

export interface FakeHostInput {
  readonly engine: OhmailEngine;
  readonly service: HostCapabilities["service"];
  readonly scope: string | null;
  readonly account?: string | null;
  readonly state?: HostSession["state"];
  readonly recover?: Recover;
  readonly places?: Partial<FramePlaces>;
  readonly stages?: Partial<FrameStages>;
  readonly overs?: Partial<FrameOvers>;
  /** The calendar's entry; `none` unless given. The switch also needs `capabilities.products`. */
  readonly calendar?: CalendarEntry | None;
  readonly products?: HostCapabilities["products"];
  /** Wires a test hands in; every other is `none`. */
  readonly wires?: Partial<HostWires>;
  readonly window?: FakeWindow;
  readonly address?: FakeAddress;
  readonly appearance?: MovableSignal<Appearance>;
  readonly hostConnection?: Signal<HostConnectionState | null>;
  readonly features?: Partial<Record<FeatureName, FeatureEntry | None>>;
  /** The reading column; absent, `none`. */
  readonly reader?: ReaderEntry | None;
  /** What the host stands above every pane; absent, `none`. */
  readonly above?: FrameHost["features"]["above"];
  /** The account's mailbox facts; absent, `none`. */
  readonly mailboxes?: HostReads["mailboxes"];
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
      mirrorAccount: null,
      account: input.account ?? null,
      accountAddress: null,
      accountDisplayName: null,
      signOut: NONE,
      recover: input.recover ?? NONE,
      today: NONE,
    },
    reads: { mailboxes: input.mailboxes ?? NONE, copyAge: NONE, access: NONE },
    wires: {
      ...(Object.fromEntries(WIRES.map((key) => [key, NONE])) as unknown as HostWires),
      ...input.wires,
    },
    capabilities: { service: input.service, ...CANNOT, products: input.products ?? CANNOT.products },
    features: {
      ...(Object.fromEntries(FEATURE_NAMES.map((name) => [name, NONE])) as Record<FeatureName, None>),
      ...input.features,
      places: { ...NO_PLACES, ...input.places },
      stages: { ...NO_STAGES, ...input.stages },
      overs: { ...NO_OVERS, ...input.overs },
      reader: input.reader ?? NONE,
      above: input.above ?? NONE,
      calendar: input.calendar ?? NONE,
    },
    device: {
      build: { surface: "web", version: null, commit: null, mailtoLeaves: false, desktopDownload: null },
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
      posture: NONE,
      insets: NONE,
      keyboard: NONE,
      back: NONE,
      wake: NONE,
    },
  };
  return { host, window, address, appearance };
}

/**
 * What the frame's room reads of an engine when it mounts its press seam with nothing pressed and nothing left in the
 * journal: it listens for changes, reads the mirror's version and asks whether there is a trash (and, where a ground
 * stands, the rail's foot asks whether there is a ring to the worker). A test whose engine
 * is a stand-in of its own spreads these under it where its host hands a ground above the panes or a reader: there the
 * room's own seam stands for the frame's life. A host that hands neither has no seam, and its engine is read never.
 */
export const SEAM_AT_REST: Readonly<Record<string, unknown>> = {
  subscribe: () => () => undefined,
  read: () =>
    new Proxy(
      {},
      {
        get(_, key) {
          if (key === "version") return () => 0;
          throw new Error(`the frame read the mirror's ${String(key)}`);
        },
      },
    ),
  trashAvailable: () => false,
  /* The rail's foot, which the ground feeds, asks whether there is a ring to the worker: none. */
  pullAvailable: () => false,
};

/** Nothing queued, in flight or kept as new, and no late answer: one object each, as an engine at rest hands back. */
const NOTHING_QUEUED: readonly never[] = [];
const NO_LATE_KEYS: ReadonlySet<string> = new Set();

/**
 * What the one composer reads of an engine when the mail ground mounts it with nothing being written and nothing on
 * its way: no send queued or in flight, the outbox read and empty, no draft kept as new, no late answer, and a
 * listener for letters that left. A test whose engine is a stand-in of its own spreads these under it where its host
 * hands `MailGround`: the composer stands there for the frame's life, above every place.
 */
export const COMPOSER_AT_REST: Readonly<Record<string, unknown>> = {
  onMessagesRemoved: () => () => undefined,
  pendingMutations: () => NOTHING_QUEUED,
  inFlightMutations: () => NOTHING_QUEUED,
  keptAsNewDrafts: () => NOTHING_QUEUED,
  outboxKnown: () => true,
  lateResultKeys: () => NO_LATE_KEYS,
  hasLateResults: () => false,
};

/**
 * An engine with nothing in it, of which the frame takes nothing of its own: any read throws, but the three the
 * room's press seam makes at rest. The seam stands for the frame's life wherever a test hands a ground above the panes
 * or a reader, so it stands over this engine too.
 */
export const NO_ENGINE = new Proxy({} as OhmailEngine, {
  get(_, key) {
    if (key === "then") return undefined;
    if (typeof key === "string" && key in SEAM_AT_REST) return SEAM_AT_REST[key];
    throw new Error(`the frame read the engine's ${String(key)}`);
  },
});
