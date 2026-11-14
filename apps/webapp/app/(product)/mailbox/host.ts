/**
 * THE WEB SHELL'S ANSWER TO THE HOST CONTRACT. A pure reading of what the page knows before it
 * mounts: its build, and what the server said. Nothing mounts through it yet; the old shell is
 * still handed its inputs one by one (`CloudShell.tsx`), and this is the same decisions, said
 * once, in the record the next shell takes.
 */
import {
  CANNOT, NONE,
  type DeviceNotifications, type Entries, type HostConnectionState, type HostContract, type HostReads, type HostSession,
  type LinkedDraft, type Transports,
} from "@ohmail/app/host";
import type { OlderBodyWire } from "@ohmail/client-engine";
import type { AwayTransport } from "../../shell/AwayResponderRow";
import type { ComposePrefill } from "../../shell/compose";
import type { ConsentTransport } from "../../shell/consent-state";
import type { DraftReplyWire } from "../../shell/draft-reply";
import type { OwnerResolver } from "../../shell/engine";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { GapLettersTransport } from "../../shell/GapLettersNotice";
import type { HostConnection } from "@ohmail/app-logic/doors/host-connection";
import type { JunkWire } from "../../shell/junk-window";
import type { LiveBodyWire } from "@ohmail/app-logic/reading/live-body";
import type { FreshnessProbe, MailboxProbe } from "../../shell/MailStateProvider";
import type { NotificationHost } from "../../shell/notification-settings";
import type { OrganizerNoticeTransport } from "../../shell/OrganizerNotice";
import type { ProfileImportTransport } from "../../shell/ProfileImportCard";
import type { ImageDoor } from "../../shell/remote-images";
import type { SuggestWire } from "../../shell/screener-suggest";
import type { TrashWire } from "../../shell/trash-window";

type Engine = HostContract["engine"];
type Supplied<T> = Exclude<T, typeof NONE>;

/** What the page knows before it mounts. */
export interface WebFacts {
  /** The build serves a server its operator runs (`SELF_HOST_BUILD`). */
  readonly selfHost: boolean;
  /** The server pairs devices and fetches a letter's pictures (its handshake's words). */
  readonly server: { readonly pairing: boolean; readonly remoteImages: boolean };
  /** People may be invited here: a self-host build, and the server's word. */
  readonly invites: boolean;
  /** The service serves a page for the subscription. */
  readonly subscriptionPage: boolean;
  /** The access answer carries a storage block. */
  readonly storageBlock: boolean;
  /**
   * What one send may carry where this page can put files to staging: a number of bytes, null
   * for the mailbox's own limit, undefined where it cannot stage.
   */
  readonly sendSurface: number | null | undefined;
  /** The consent wire can store the choice to use folders. */
  readonly foldersStorable: boolean;
  /** The account the page has believed, or null before it has. */
  readonly scope: string | null;
  readonly build: { readonly version: string | null; readonly commit: string | null };
}

/** What the page has to hand in: its calls over the API, the entries it imports, the browser's own verbs. */
export interface WebSupplies {
  readonly session: {
    readonly resolve: Supplied<HostSession["resolve"]>;
    readonly confirmed: Supplied<HostSession["confirmed"]>;
    readonly signOut: Supplied<HostSession["signOut"]>;
  };
  readonly reads: { readonly mailboxes: Supplied<HostReads["mailboxes"]>; readonly access: Supplied<HostReads["access"]> };
  /** Every wire but the switch for a person's own model, which only a desktop on its own has. */
  readonly wires: Transports<Exclude<keyof HostContract["wires"], "ownModelAutoSuggest">>;
  /** The account's features. Never the desktop's. */
  readonly features: Entries<
    | "account" | "mailboxes" | "ai" | "subscription" | "storage" | "storageCard" | "accountStrip" | "invites"
    | "security" | "about" | "devices" | "screener" | "help"
  >;
  /** The browser's own notification reader. */
  readonly notifications: DeviceNotifications;
}

export function webHost(engine: Engine, facts: WebFacts, has: WebSupplies): HostContract {
  const { selfHost, server } = facts;
  return {
    engine,
    session: {
      resolve: has.session.resolve,
      confirmed: has.session.confirmed,
      state: "live",
      scope: facts.scope,
      signOut: has.session.signOut,
    },
    reads: { mailboxes: has.reads.mailboxes, copyAge: NONE, access: has.reads.access },
    wires: {
      ...has.wires,
      // "Load it now" is the managed service's: a self-hosted server keeps every body.
      liveBody: selfHost ? NONE : has.wires.liveBody,
      images: server.remoteImages ? has.wires.images : NONE,
      ownModelAutoSuggest: NONE,
    },
    capabilities: {
      service: selfHost ? "self" : "managed",
      prices: facts.subscriptionPage ? "linkOut" : CANNOT.prices,
      sendCeiling: facts.sendSurface === undefined ? CANNOT.sendCeiling : facts.sendSurface === null ? "mailbox" : facts.sendSurface,
      awayRunsOn: "service",
      rulesMarked: true,
      imagesFrom: server.remoteImages ? "service" : CANNOT.imagesFrom,
      unsubscribeFrom: "service",
      foldersStorable: facts.foldersStorable,
      suggest: "priced",
      pairing: server.pairing ? "account" : CANNOT.pairing,
      account: "here",
      firstRunDoor: selfHost ? "selfhost" : "cloud",
      mailboxes: "here",
      language: "account",
    },
    features: {
      ...has.features,
      subscription: facts.subscriptionPage ? has.features.subscription : NONE,
      storage: facts.storageBlock ? has.features.storage : NONE,
      invites: facts.invites ? has.features.invites : NONE,
      devices: server.pairing ? has.features.devices : NONE,
      // Help names ohmail's own support, which a server its operator runs does not have.
      help: selfHost ? NONE : has.features.help,
      desktop: NONE,
      defaultMail: NONE,
      stageCard: NONE,
    },
    device: {
      build: { surface: "web", version: facts.build.version, commit: facts.build.commit, mailtoLeaves: true },
      notifications: has.notifications,
      badge: NONE,
      language: NONE,
      openLink: NONE,
      pickFile: NONE,
      saveFile: NONE,
      defaultMail: NONE,
      appearance: NONE,
      textSize: NONE,
      fold: NONE,
      liveTheme: NONE,
    },
    signals: {
      hostConnection: NONE,
      linkIn: NONE,
      sessionState: NONE,
      copyAge: NONE,
      access: NONE,
      updateOffer: NONE,
      droppedFiles: NONE,
    },
  };
}

/*
 * TODAY'S INPUTS ARE WIRES AS THEY STAND. Each type the old shell takes an input by is held to
 * the contract's type for the same thing, here, where both are in reach: a transport a mount
 * hands the old shell today can be handed to the contract unchanged, on every shell, because
 * the desktop and the paired page pass the old shell these same types.
 */
type Fits<Todays extends Contracts, Contracts> = Todays;
export type TodaysInputsFit = [
  Fits<OwnerResolver, Supplied<HostSession["resolve"]>>,
  Fits<MailboxProbe, Supplied<HostReads["mailboxes"]>>,
  Fits<FreshnessProbe, Supplied<HostReads["copyAge"]>>,
  Fits<OrganizerNoticeTransport, Transports["organizerNotice"]>,
  Fits<GapLettersTransport, Transports["gapLetters"]>,
  Fits<LiveBodyWire, Transports["liveBody"]>,
  Fits<AwayTransport, Transports["away"]>,
  Fits<ProfileImportTransport, Transports["profileImport"]>,
  Fits<ConsentTransport, Transports["consent"]>,
  Fits<ImageDoor, Transports["images"]>,
  Fits<OlderBodyWire, Transports["olderBody"]>,
  Fits<JunkWire, Transports["junk"]>,
  Fits<TrashWire, Transports["trash"]>,
  Fits<SuggestWire, Transports["suggest"]>,
  Fits<DraftReplyWire, Transports["draftReply"]>,
  Fits<FirstRunHost, Transports["firstRun"]>,
  Fits<NotificationHost, DeviceNotifications>,
  Fits<HostConnection, HostConnectionState>,
  Fits<ComposePrefill, LinkedDraft>,
];
