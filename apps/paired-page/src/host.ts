/**
 * THE PAIRED PAGE'S ANSWER TO THE HOST CONTRACT: the page a desktop serves to a phone's browser.
 * It is fixed: another computer of the person's own, reached with a pairing. Nothing mounts
 * through it yet; the old shell is still handed its inputs one by one (`HostGate.tsx`), and this
 * is the same decisions, said once, in the record the next shell takes.
 */
import {
  CANNOT,
  NONE,
  type DeviceNotifications,
  type Entries,
  type FrameSupplies,
  type HostContract,
  type HostReads,
  type HostSession,
  type MayBeNone,
  type Transports,
} from "@ohmail/app/host";

type Engine = HostContract["engine"];
type Supplied<T> = Exclude<T, typeof NONE>;

export interface PairedFacts {
  /** The pairing: the partition of what the page keeps. Null until it is paired. */
  readonly scope: string | null;
  /** What one send from this page may carry, in bytes. */
  readonly sendCeiling: number;
  readonly build: { readonly version: string | null; readonly commit: string | null };
}

/** What the page has to hand in: the calls its host serves, sign-out, and the browser's own verbs. */
export interface PairedSupplies {
  readonly signOut: Supplied<HostSession["signOut"]>;
  readonly mailboxes: Supplied<HostReads["mailboxes"]>;
  readonly wires: Transports<
    "gapLetters" | "profileImport" | "consent" | "olderBody" | "junk" | "trash" | "draftReply"
  > &
    MayBeNone<"autoFiled">;
  /** Account, as sign-out alone; the strip that says a change will not be kept; the Screener's section. */
  readonly features: Entries<"account" | "accountStrip" | "screener">;
  readonly notifications: DeviceNotifications;
  /** The places, the address bar, the window, the look and the way back. */
  readonly frame: FrameSupplies;
}

export function pairedHost(engine: Engine, facts: PairedFacts, has: PairedSupplies): HostContract {
  return {
    engine,
    session: {
      resolve: NONE,
      confirmed: NONE,
      state: NONE,
      scope: facts.scope,
      account: null,
      signOut: has.signOut,
      recover: has.frame.recover,
    },
    reads: { mailboxes: has.mailboxes, copyAge: NONE, access: NONE },
    wires: {
      ...has.wires,
      organizerNotice: NONE,
      liveBody: NONE,
      away: NONE,
      images: NONE,
      suggest: NONE,
      firstRun: NONE,
      screening: NONE,
      seedReview: NONE,
      folderSummary: NONE,
      ownModelAutoSuggest: NONE,
      mailboxes: NONE,
      calendar: NONE,
    },
    capabilities: {
      service: "ownComputer",
      prices: CANNOT.prices,
      sendCeiling: facts.sendCeiling,
      awayRunsOn: CANNOT.awayRunsOn,
      rulesMarked: true,
      // It draws no pictures. The unsubscribe a screen-out asks for is still sent by the computer behind it.
      imagesFrom: CANNOT.imagesFrom,
      unsubscribeFrom: "computer",
      foldersStorable: CANNOT.foldersStorable,
      suggest: CANNOT.suggest,
      pairing: CANNOT.pairing,
      account: "signOutOnly",
      firstRunDoor: CANNOT.firstRunDoor,
      mailboxes: CANNOT.mailboxes,
      language: "install",
      // No hello is held where this is built: no person on the wire until one is.
      searchBy: CANNOT.searchBy,
      products: CANNOT.products,
    },
    features: {
      ...has.features,
      mailboxes: NONE,
      ai: NONE,
      subscription: NONE,
      storage: NONE,
      storageCard: NONE,
      invites: NONE,
      security: NONE,
      about: NONE,
      desktop: NONE,
      devices: NONE,
      defaultMail: NONE,
      stageCard: NONE,
      help: NONE,
      places: has.frame.places,
      stages: has.frame.stages,
      overs: has.frame.overs,
      reader: NONE,
      calendar: has.frame.calendar,
    },
    device: {
      build: {
        surface: "pairedPage",
        version: facts.build.version,
        commit: facts.build.commit,
        mailtoLeaves: true,
      },
      notifications: has.notifications,
      badge: NONE,
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
      hostConnection: NONE,
      linkIn: NONE,
      sessionState: NONE,
      copyAge: NONE,
      access: NONE,
      updateOffer: NONE,
      droppedFiles: NONE,
      // A page in a phone's browser: the browser owns the window's edges, its keyboard and its back.
      posture: NONE,
      insets: NONE,
      keyboard: NONE,
      back: NONE,
      wake: NONE,
    },
  };
}
