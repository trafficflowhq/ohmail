/**
 * THE DESKTOP WINDOW'S ANSWER TO THE HOST CONTRACT, by door. A pure reading of the engine's
 * status and the hosted session, through the door rules the gate already reads (`doors.ts`).
 * Nothing mounts through it yet; the old shell is still handed its inputs one by one
 * (`DesktopGate.tsx`), and this is the same decisions, said once, in the record the next shell
 * takes.
 */
import {
  CANNOT, NONE,
  type DeviceNotifications, type Entries, type HostContract, type HostDevice, type HostReads, type HostSession,
  type FrameSupplies, type HostSignals, type MayBeNone, type Transports,
} from "@ohmail/app/host";
import type { EngineStatus } from "./bridge-fetch.js";
import { desktopSendSurface } from "./desktop-send-surface.js";
import {
  accountDoorFor, awayDoorFor, consentDoorFor, firstRunDoorFor, hostDoorFor, imagesFromComputer, isDesktopHost,
  isManagedDoor, profileImportDoorFor, suggestDoorFor, type HostedSession,
} from "./doors.js";

type Engine = HostContract["engine"];
type Supplied<T> = Exclude<T, typeof NONE>;

/** What the window knows before it mounts the shell. */
export interface DesktopFacts {
  /** The engine's own status: which door this is. */
  readonly status: EngineStatus;
  /** The hosted session behind a signed-in or paired door. */
  readonly session: HostedSession;
  /** The hosted session was refused, and the window has said so. */
  readonly sessionRefused: boolean;
  /** The other computer's name on the paired door. */
  readonly hostLabel: string | null;
  /** The service serves a page for the subscription. */
  readonly subscriptionPage: boolean;
  /** The access answer carries a storage block. */
  readonly storageBlock: boolean;
  /** This build may send a person out to a page that sells (a store's build may not). */
  readonly linksOutToBilling: boolean;
  /** This build may become the computer's mail program (a preview may not: the installed ohmail keeps the mail links). */
  readonly takesMailLinks: boolean;
  /** The mounted mailbox, account or pairing: the partition of what the window keeps. */
  readonly scope: string | null;
  /** The hosted account behind a signed-in door, or null. */
  readonly account: string | null;
  readonly build: { readonly version: string | null; readonly commit: string | null };
}

/** What the window has to hand in: its calls over the pipe, the entries it imports, its shell's verbs. */
export interface DesktopSupplies {
  /** No caller today: the window signs out in its own Settings pane. `none` until the first caller arrives. */
  readonly signOut: HostSession["signOut"];
  /** The account's access answer is read by the window's own panes today; `none` until its first caller. */
  readonly reads: { readonly mailboxes: Supplied<HostReads["mailboxes"]>; readonly copyAge: Supplied<HostReads["copyAge"]>; readonly access: HostReads["access"] };
  /**
   * The wires the pipe carries. Two for consent: the account's, and the one an install on its
   * own answers, which stores no choice of folders. Nothing is behind the review of who you
   * write to or a folder's count on any door.
   */
  readonly wires: Transports<
    | "organizerNotice" | "gapLetters" | "liveBody" | "away" | "profileImport" | "images" | "olderBody" | "junk" | "trash"
    | "suggest" | "draftReply"
  > & MayBeNone<"firstRun" | "screening" | "autoFiled" | "ownModelAutoSuggest" | "mailboxes"> & {
    readonly consent: { readonly account: Transports["consent"]; readonly standalone: Transports["consent"] };
  };
  /** The desktop's own feature, Mailboxes, and the ways out to the browser. Never Invites. The reader is no entry. */
  readonly features: Entries<Exclude<keyof HostContract["features"], "invites" | "places" | "stages" | "reader" | "calendar">>;
  readonly notifications: DeviceNotifications;
  /** The places, the address bar, the window, the look and the way back. */
  readonly frame: FrameSupplies;
  readonly badge: Supplied<HostDevice["badge"]>;
  readonly hostConnection: Supplied<HostSignals["hostConnection"]>;
  readonly linkIn: Supplied<HostSignals["linkIn"]>;
}

export function desktopHost(engine: Engine, facts: DesktopFacts, has: DesktopSupplies): HostContract {
  const { status, session } = facts;
  const local = status.mode === "local";
  const cloud = status.mode === "cloud";
  const paired = isDesktopHost(status);
  const account = accountDoorFor(status, session) !== null;
  const away = awayDoorFor(status, session);
  const consent = consentDoorFor(status, session);
  const suggest = suggestDoorFor(status, session);
  const hostMode = hostDoorFor(status) === "local";
  const firstRun = firstRunDoorFor(status) === "local";
  const fromComputer = imagesFromComputer(status);
  // A store's build shows the numbers it has and sells nothing; any other links out where a page is served.
  const prices = !account ? CANNOT.prices
    : !facts.linksOutToBilling ? (facts.subscriptionPage || facts.storageBlock ? "data" : CANNOT.prices)
      : facts.subscriptionPage ? "linkOut" : CANNOT.prices;
  return {
    engine,
    session: {
      resolve: NONE,
      confirmed: NONE,
      state: !cloud ? NONE : facts.sessionRefused ? "refused" : "live",
      scope: facts.scope,
      account: facts.account,
      signOut: has.signOut,
      recover: has.frame.recover,
    },
    reads: {
      mailboxes: has.reads.mailboxes,
      copyAge: cloud ? has.reads.copyAge : NONE,
      access: account ? has.reads.access : NONE,
    },
    wires: {
      organizerNotice: has.wires.organizerNotice,
      gapLetters: has.wires.gapLetters,
      liveBody: account ? has.wires.liveBody : NONE,
      away: away !== null ? has.wires.away : NONE,
      profileImport: profileImportDoorFor(status, session) !== null ? has.wires.profileImport : NONE,
      consent: consent === "cloud" ? has.wires.consent.account : consent === "standalone" ? has.wires.consent.standalone : NONE,
      images: has.wires.images,
      olderBody: has.wires.olderBody,
      junk: has.wires.junk,
      trash: has.wires.trash,
      suggest: account ? has.wires.suggest : NONE,
      draftReply: has.wires.draftReply,
      firstRun: firstRun ? has.wires.firstRun : NONE,
      screening: has.wires.screening,
      autoFiled: has.wires.autoFiled,
      seedReview: NONE,
      folderSummary: NONE,
      ownModelAutoSuggest: suggest === "local" ? has.wires.ownModelAutoSuggest : NONE,
      connect: NONE,
      mailboxes: has.wires.mailboxes,
      // A desktop signed in to a server answers its calendar at the seating; one on its own has none.
      calendar: NONE,
    },
    capabilities: {
      service: isManagedDoor(status) ? "managed" : local || paired ? "ownComputer" : "self",
      prices,
      sendCeiling: desktopSendSurface(status) ?? CANNOT.sendCeiling,
      awayRunsOn: away === "local" ? "thisComputer" : away === "cloud" ? "service"
        : away === "host" && facts.hostLabel ? { host: facts.hostLabel } : CANNOT.awayRunsOn,
      // Read through a copy of the account's rules, a rule that came from a suggestion is not marked.
      rulesMarked: !cloud,
      imagesFrom: fromComputer ? "computer" : "service",
      unsubscribeFrom: fromComputer ? "computer" : "service",
      foldersStorable: consent === "cloud",
      suggest: suggest === "local" ? "ownModel" : suggest === "cloud" ? "priced" : CANNOT.suggest,
      pairing: hostMode ? "hostMode" : account ? "inBrowser" : CANNOT.pairing,
      account: account ? "inBrowser" : CANNOT.account,
      firstRunDoor: firstRun ? "local" : CANNOT.firstRunDoor,
      // On its own it changes everything; signed in, a re-sync and a way out; paired, a re-sync alone.
      mailboxes: local ? "here" : paired ? "resyncOnly" : cloud ? "resyncAndOut" : CANNOT.mailboxes,
      language: "install",
      products: CANNOT.products,
    },
    features: {
      ...has.features,
      account: account ? has.features.account : NONE,
      security: account ? has.features.security : NONE,
      ai: account ? has.features.ai : NONE,
      accountStrip: account ? has.features.accountStrip : NONE,
      subscription: account && facts.subscriptionPage && facts.linksOutToBilling ? has.features.subscription : NONE,
      storage: account && facts.storageBlock ? has.features.storage : NONE,
      storageCard: account && facts.storageBlock ? has.features.storageCard : NONE,
      devices: hostMode || account ? has.features.devices : NONE,
      defaultMail: facts.takesMailLinks ? has.features.defaultMail : NONE,
      invites: NONE,
      places: has.frame.places,
      stages: has.frame.stages,
      reader: NONE,
      calendar: has.frame.calendar,
    },
    device: {
      build: { surface: "desktop", version: facts.build.version, commit: facts.build.commit, mailtoLeaves: false },
      notifications: has.notifications,
      badge: has.badge,
      language: NONE,
      openLink: NONE,
      pickFile: NONE,
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
      hostConnection: cloud ? has.hostConnection : NONE,
      linkIn: has.linkIn,
      sessionState: NONE,
      copyAge: NONE,
      access: NONE,
      updateOffer: NONE,
      droppedFiles: NONE,
      // A computer's window: no fold, no edge the system draws over, no keyboard over it, no back.
      posture: NONE,
      insets: NONE,
      keyboard: NONE,
      back: NONE,
      wake: NONE,
    },
  };
}
