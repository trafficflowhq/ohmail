/**
 * THE WEB SHELL'S ANSWER TO THE HOST CONTRACT. A pure reading of what the page knows before it
 * mounts: its build, and what the server said. Nothing mounts through it yet; the old shell is
 * still handed its inputs one by one (`CloudShell.tsx`), and this is the same decisions, said
 * once, in the record the next shell takes.
 */
import {
  CANNOT, NONE,
  type DeviceNotifications, type Entries, type FrameSupplies, type HostConnectionState, type HostContract, type HostDevice, type HostReads, type HostSession,
  type LinkedDraft, type MayBeNone, type Transports,
} from "@ohmail/app/host";
import type { OlderBodyWire } from "@ohmail/client-engine";
import type { AwayTransport, mailboxes } from "../../api-client";
import type { ComposePrefill } from "@ohmail/app-logic/writing/compose";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import type { DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import type { OwnerResolver } from "../../shell/engine";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { HostConnection } from "@ohmail/app-logic/doors/host-connection";
import type { JunkWire } from "@ohmail/app-logic/screener/junk-window";
import type { LiveBodyWire } from "@ohmail/app-logic/reading/live-body";
import type { FreshnessProbe, MailboxProbe } from "@ohmail/app-logic/mail-state/mail-state-binding";
import type { NotificationHost } from "../../shell/notification-settings";
import type { ProfileImportTransport } from "@ohmail/app/profile-import";
import type { ImageDoor } from "../../shell/remote-images";
import type { SuggestWire } from "@ohmail/app-logic/screener/screener-suggest";
import type { TrashWire } from "../../shell/trash-window";

type Engine = HostContract["engine"];
type Supplied<T> = Exclude<T, typeof NONE>;

/** The web offers the latest release. The desktop build has no use for this address. */
export const DESKTOP_DOWNLOAD_URL =
  process.env.NEXT_PUBLIC_DESKTOP === "1" ? null : "https://github.com/trafficflowhq/ohmail/releases/latest";

/** What the page knows before it mounts. */
export interface WebFacts {
  /** The build serves a server its operator runs (`SELF_HOST_BUILD`). */
  readonly selfHost: boolean;
  /** The server pairs devices and fetches a letter's pictures (its handshake's words). */
  readonly server: { readonly pairing: boolean; readonly remoteImages: boolean; readonly searchPeople: boolean; readonly calendar?: boolean | null };
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
  readonly isolatedScope?: string;
  /** The account the server confirmed, or null until it has. */
  readonly account: string | null;
  readonly accountAddress?: string | null;
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
  readonly searchMailboxTotal?: () => Promise<number | null>;
  /**
   * Every wire but the switch for a person's own model, which only a desktop on its own has. A browser's pictures
   * come through its own origin's proxy, handed where this page has a client; the four calls today's views still make
   * themselves are `none` until their first caller. The review of who you write to is handed where this page has a
   * client and has confirmed the account that owns its mirror.
   */
  readonly wires: Transports<
    | "organizerNotice" | "gapLetters" | "liveBody" | "junk" | "trash" | "draftReply"
  > & MayBeNone<
    "consent" | "suggest" | "images" | "away" | "olderBody" | "firstRun" | "screening" | "autoFiled" | "seedReview" | "folderSummary" | "profileImport" | "connect" | "mailboxes" | "calendar"
  >;
  /** The account's features. Never the desktop's. */
  readonly features: Entries<
    | "account" | "mailboxes" | "ai" | "subscription" | "storage" | "storageCard" | "accountStrip" | "invites"
    | "security" | "about" | "devices" | "screener" | "help"
  >;
  /** The browser's own notification reader. */
  readonly notifications: DeviceNotifications;
  /** The language's controls the page wraps around the frame (the account's locale context), or none. */
  readonly language: HostDevice["language"];
  /** The way to an address the app itself makes: a new tab of this browser. */
  readonly openLink: Supplied<HostDevice["openLink"]>;
  /** The places, the address bar, the window, the look and the way back. */
  readonly frame: FrameSupplies;
}

export function webHost(engine: Engine, facts: WebFacts, has: WebSupplies): HostContract {
  const { selfHost, server } = facts;
  const calendar = server.calendar === true && facts.scope !== null && facts.scope === facts.account
    ? has.wires.calendar : NONE;
  return {
    engine,
    session: {
      resolve: has.session.resolve,
      confirmed: has.session.confirmed,
      state: "live",
      scope: facts.isolatedScope ?? facts.scope,
      mirrorAccount: facts.scope,
      account: facts.account,
      accountAddress: facts.account && facts.account === facts.scope ? facts.accountAddress ?? null : null,
      signOut: has.session.signOut,
      recover: has.frame.recover,
      today: NONE,
    },
    reads: { mailboxes: has.reads.mailboxes, copyAge: NONE, access: has.reads.access },
    wires: {
      ...has.wires,
      profileImport: facts.scope !== null && facts.scope === facts.account ? has.wires.profileImport : NONE,
      // "Load it now" is the managed service's: a self-hosted server keeps every body.
      liveBody: selfHost ? NONE : has.wires.liveBody,
      images: server.remoteImages ? has.wires.images : NONE,
      ownModelAutoSuggest: NONE,
      calendar,
    },
    capabilities: {
      service: selfHost ? "self" : "managed",
      prices: facts.subscriptionPage ? "linkOut" : CANNOT.prices,
      sendCeiling: facts.sendSurface === undefined ? CANNOT.sendCeiling : facts.sendSurface === null ? "mailbox" : facts.sendSurface,
      awayRunsOn: has.wires.away === NONE ? CANNOT.awayRunsOn : "service",
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
      searchBy: has.searchMailboxTotal
        ? { by: server.searchPeople ? "people" : "words", mailboxTotal: has.searchMailboxTotal }
        : server.searchPeople ? "people" : "words",
      products: calendar === NONE ? CANNOT.products : "both",
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
      places: has.frame.places,
      stages: has.frame.stages,
      overs: has.frame.overs,
      reader: has.frame.reader,
      above: has.frame.above,
      calendar: has.frame.calendar,
    },
    device: {
      build: {
        surface: "web",
        version: facts.build.version,
        commit: facts.build.commit,
        mailtoLeaves: true,
        desktopDownload: DESKTOP_DOWNLOAD_URL,
      },
      notifications: has.notifications,
      badge: NONE,
      language: has.language,
      openLink: has.openLink,
      pickFile: NONE,
      // A browser saves a file from the address it fetched: no shell saves by id.
      saveFile: NONE,
      defaultMail: NONE,
      address: has.frame.address,
      window: has.frame.window,
      appearance: has.frame.appearance,
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
      // A page in a browser: the browser owns the window's edges, its keyboard and its back.
      posture: NONE,
      insets: NONE,
      keyboard: NONE,
      back: NONE,
      wake: NONE,
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
  Fits<typeof mailboxes.dismissOrganizerNotice, Transports["organizerNotice"]>,
  Fits<typeof mailboxes.answerGapLetters, Transports["gapLetters"]>,
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
