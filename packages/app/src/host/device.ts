import type { NoticeChoices, NoticePermission } from "@ohmail/client-engine";
import type { HostNoticeEmitter } from "@ohmail/app-logic/notices/use-notices";
import type { FileShell } from "@ohmail/app-logic/reader/attachments";
import type { DroppedFile } from "@ohmail/app-logic/write/files";
import type { AppLocale } from "@ohmail/app-logic/text/locale";
import type { None } from "./contract.js";
import type { Signal } from "./signals.js";

/**
 * Which build this is. Replaces `support`, which today says both "this is the build" and "a Help
 * pane exists"; whether the pane exists is the feature `help`. Every shell knows its build.
 */
export interface DeviceBuild {
  readonly surface: "web" | "desktop" | "pairedPage" | "phone";
  readonly version: string | null;
  readonly commit: string | null;
  /** Whether a `mailto:` link leaves the app. */
  readonly mailtoLeaves: boolean;
  /** The desktop download address offered by the signed-in web host, where available. */
  readonly desktopDownload: string | null;
}

/** What syncing this device's push registration answers. */
export type PushSyncOutcome =
  | "subscribed"
  | "unsubscribed"
  | "unchanged"
  | "no_server_key"
  | "unsupported"
  | "row_remains"
  | "not_registered";

/** The permission, the ask, and the wake registration. The shell's `NotificationHost`. */
export interface DeviceNotifications {
  /** The scope the host serves at the moment a scheduled notification wakes. */
  liveNoticeScope?: () => string | null;
  permission: () => NoticePermission;
  request: () => Promise<NoticePermission>;
  syncSubscription?: (
    wanted: boolean,
    opts?: { forceAnnounce?: boolean; signingOutOf?: string },
  ) => Promise<PushSyncOutcome | null>;
  osHoldsPermission?: boolean;
  /**
   * What draws this surface's notices: the kinds it carries, and the drawing. `none` where the surface
   * draws none; the Notifications pane then offers no switch for a kind.
   */
  readonly emitter: HostNoticeEmitter | None;
  /**
   * THE PERSON'S CHOICES ON THIS DEVICE, as the notices' gate reads them: the switches this surface stores, read
   * by the shell from its own store at each settle of the copy, so a switch pressed a moment ago counts. Never held
   * by the caller. Absent: this surface stores no switch, and its emitter is handed nothing to draw.
   */
  choices?: (scope: string | null) => NoticeChoices;
  /** Moves when this device's choices change, even while the mail copy stands still. */
  choicesVersion?: Signal<number>;
  /**
   * THE WAKE REGISTRATION'S BOOT DOOR, where this shell registers one: bring it back to what the stored switches
   * ask for, once per sign-in, with the words the worker may draw where it keeps none (`body`). Sign-out drops this
   * device's registration and keeps the switches; without this door a person who signs back in sees every switch
   * on over no registration. Never throws; bounded by the shell. Absent: nothing is registered here to put back.
   */
  reconcile?: (body: string, scope: string | null) => Promise<PushSyncOutcome | null>;
  /**
   * THE WORKER'S WORDS ALONE, in the account's language once it is adopted. A RELABEL, NEVER A RECONCILE: what is
   * stored of "may draw" is kept byte for byte and never worked out again from the switches, or a previous person's
   * surviving registration would be armed again on a shared device. Absent exactly where `reconcile` is.
   */
  relabel?: (title: string, body: string, scope: string | null) => Promise<void>;
}

/**
 * THE LANGUAGE'S CONTROLS, as the shell wraps them around the frame: the language being drawn, and the adoption of
 * the account's language at start. An adoption moves what is drawn and NEVER writes the account back (a write there
 * would PATCH the value it just read, on every boot); what an adoption may move is the shell's to decide.
 */
export interface HostLanguage {
  readonly locale: AppLocale;
  readonly adoptLocale: (next: AppLocale) => Promise<void>;
}

export type Pointer = "fine" | "coarse";
/**
 * How the window stands. `book`: a fold upright across its middle, as an unfolded phone holds it, each side wide
 * enough for a column (`postureWindow` composes it from the host's fold). Every other pose is laid `flat`, by width.
 * The layout plan's switch is exhaustive, so a new member is a compile error.
 */
export type Posture = "flat" | "book";
/** The window the app stands in, as the frame lays itself out by it. */
export interface WindowFacts {
  readonly width: number;
  readonly height: number;
  readonly pointer: Pointer;
  readonly posture: Posture;
  readonly reducedMotion: boolean;
}
/** The look a shell stands under and the optional mail layout preference. */
export interface Appearance {
  readonly face: "paper" | "ohmarchy";
  readonly scheme: "light" | "dark";
  readonly layout?: "classic" | "zero";
}
export interface PhysicalLeave {
  readonly signal: AbortSignal;
  keep(): void;
}
export type AskLeave = (leave: (drop?: () => void) => void, physical?: PhysicalLeave) => void;

/** The address bar, owned by the shell. The frame reads and writes the fragment through it, never `location`. */
export interface HostAddress {
  /** The current pane holds a leave while a draft differs from its saved value. */
  holdLeave(ask: AskLeave, at: string, leaves?: (next: string) => boolean): () => void;
  /** Ask before a route command changes any state. Discard resumes that same command once. */
  heldBefore(next: string, resume: () => void | Promise<boolean>, physical?: PhysicalLeave): boolean;
  read(): string;
  /** Whether the reader was explicitly closed in this history entry. */
  readerClosed?(): boolean;
  write(next: string, how: "push" | "replace", mark?: "closed" | "open-dialog" | "dismiss-dialog"): void;
  subscribe(changed: () => void): () => void;
}

/**
 * The platform's verbs and facts.
 *
 * Five keys are `none` in every shell for now: no mount hands them in today, each does the thing
 * by hand beside the shell or inside a pane of its own. A key gets its verb's type in the change
 * that wires it, and every shell answers it then.
 */
export interface HostDevice {
  readonly build: DeviceBuild;
  /** Replaces `notificationHost`. A browser hands in the browser's own reader, by name. */
  readonly notifications: DeviceNotifications | None;
  /** The unread count on the app's icon. Replaces `onUnread`. */
  readonly badge: ((unread: number) => void) | None;
  /**
   * Setting the language, and taking the account's at start: the controls each shell wraps around the frame (on the
   * web, the desktop and the paired page, the locale context of their own). `none`: the language is not this shell's
   * to move (the phone's is its own).
   */
  readonly language: HostLanguage | None;
  /**
   * THE WAY TO AN ADDRESS THE APP ITSELF MAKES (the page of an update, the desktop app's download, a help page):
   * called inside the person's own press, it opens that address outside the app and returns. Never a letter's link:
   * those leave through the reader's own door. `none`: this shell cannot lead out, and an act that would is not
   * offered there.
   */
  readonly openLink: ((href: string) => void) | None;
  /** The files a system drop withheld from the browser's File list. */
  readonly pickFile:
    | {
        readonly looksLikeDrag: (transfer: DataTransfer) => boolean;
        readonly matchesDrop: (transfer: DataTransfer) => boolean;
        readonly take: () => Promise<readonly DroppedFile[] | null>;
      }
    | None;
  /**
   * The shell that saves a letter's file by its id and stages it for the look at it, where the window has one (the
   * desktop's, while its window is armed). `none`: a browser, which saves from the address it fetched and looks at
   * the bytes it holds.
   */
  readonly saveFile: FileShell | None;
  /** Asking whether this is the default mail app, and asking to become it. */
  readonly defaultMail: None;
  /** The fragment of the address bar. Never `none`: every shell has one. */
  readonly address: HostAddress;
  /** The window's size, pointer, posture and motion. Never `none`. */
  readonly window: Signal<WindowFacts>;
  /** The look the shell stands under, as it changes. Never `none`. */
  readonly appearance: Signal<Appearance>;
  /** How a text size is applied. */
  readonly textSize: None;
  /** The fold, the insets and the keyboard's height. */
  readonly fold: None;
  /** The live theme of the desktop it runs on. */
  readonly liveTheme: None;
}
