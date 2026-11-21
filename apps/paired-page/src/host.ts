/**
 * THE PAIRED PAGE'S ANSWER TO THE HOST CONTRACT: the page a desktop serves to a phone's browser.
 * It is fixed: another computer of the person's own, reached with a pairing. Nothing mounts
 * through it yet; the old shell is still handed its inputs one by one (`HostGate.tsx`), and this
 * is the same decisions, said once, in the record the next shell takes.
 */
import { createElement } from "react";
import { PairedScreenerSettings } from "@ohmail/app/settings/browser";
import { NO_PANE_PARTS, type MailPaneParts } from "@ohmail/app/mail";
import {
  CANNOT,
  NONE,
  type DeviceNotifications,
  type Entries,
  type FrameSupplies,
  type HostContract,
  type HostDevice,
  type HostLanguage,
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
  readonly mirrorAccount: string | null;
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
    MayBeNone<"autoFiled"> &
    Partial<MayBeNone<"screening">>;
  /** Account, as sign-out alone; the strip that says a change will not be kept; the Screener's section. */
  readonly features: Entries<"account" | "accountStrip" | "screener">;
  readonly notifications: DeviceNotifications;
  /** The language's controls the page's own provider stands (the window's, `DesktopLocale`). */
  readonly language: HostDevice["language"];
  /** The way to an address the app itself makes: a new tab of the phone's browser. */
  readonly openLink: Supplied<HostDevice["openLink"]>;
  /** The places, the address bar, the window, the look and the way back. */
  readonly frame: FrameSupplies;
}

/** The window's language controls as the contract takes them: the language drawn and the adoption, nothing else. */
export function languageOf(controls: HostLanguage | null): HostDevice["language"] {
  return controls === null ? NONE : { locale: controls.locale, adoptLocale: controls.adoptLocale };
}

/**
 * THE PAGE'S DOOR OF SETTINGS' ACCOUNT SECTION: the sign-out alone, over the pairing's own sign-out (its death sweeps
 * this browser, and its landing says what the computer heard), so the door answers "left" and the page shows the
 * landing. The sign-out alone asks nobody who is signed in, and leads nowhere to erase or to sign in.
 */
export function pairedAccountDoor(signOut: () => Promise<void>) {
  return {
    who: async () => ({ ok: false, word: "signed_out" }) as const,
    signOut: async () => {
      await signOut();
      return "left" as const;
    },
    toErase: () => undefined,
    toSignIn: () => undefined,
  };
}

/** The paired browser uses its device settings and the consent row served by the computer. */
export function pairedPaneParts(
  useDoor: () => ReturnType<typeof pairedAccountDoor>,
  general: MailPaneParts["general"],
  screener: MailPaneParts["screener"] = () => createElement(PairedScreenerSettings),
) {
  return {
    ...NO_PANE_PARTS,
    account: { useDoor, password: NONE },
    general,
    screener,
  } as const;
}

export function pairedHost(engine: Engine, facts: PairedFacts, has: PairedSupplies): HostContract {
  return {
    engine,
    session: {
      resolve: NONE,
      confirmed: NONE,
      state: NONE,
      scope: facts.scope,
      mirrorAccount: facts.mirrorAccount,
      account: null,
      accountAddress: null,
      signOut: has.signOut,
      recover: has.frame.recover,
      today: NONE,
    },
    reads: { mailboxes: has.mailboxes, copyAge: NONE, access: NONE },
    wires: {
      ...has.wires,
      screening: has.wires.screening ?? NONE,
      organizerNotice: NONE,
      liveBody: NONE,
      away: NONE,
      images: NONE,
      suggest: NONE,
      firstRun: NONE,
      seedReview: NONE,
      folderSummary: NONE,
      ownModelAutoSuggest: NONE,
      connect: NONE,
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
      reader: has.frame.reader,
      above: has.frame.above,
      calendar: has.frame.calendar,
    },
    device: {
      build: {
        surface: "pairedPage",
        version: facts.build.version,
        commit: facts.build.commit,
        mailtoLeaves: true,
        desktopDownload: null,
      },
      notifications: has.notifications,
      badge: NONE,
      language: has.language,
      openLink: has.openLink,
      pickFile: NONE,
      // A phone's browser saves a file from the address it fetched: no shell saves by id.
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
