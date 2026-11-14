import type { NoticePermission } from "@ohmail/client-engine";
import type { HostNoticeEmitter } from "@ohmail/app-logic/notices/use-notices";
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
}

/** What syncing this device's push registration answers. */
export type PushSyncOutcome =
  | "subscribed" | "unsubscribed" | "unchanged" | "no_server_key" | "unsupported" | "row_remains" | "not_registered";

/** The permission, the ask, and the wake registration. The shell's `NotificationHost`. */
export interface DeviceNotifications {
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
}

export type Pointer = "fine" | "coarse";
/** One member today. `phone-touch` widens it; the layout plan's switch is exhaustive, so a new member is a compile error. */
export type Posture = "flat";
/** The window the app stands in, as the frame lays itself out by it. */
export interface WindowFacts {
  readonly width: number;
  readonly height: number;
  readonly pointer: Pointer;
  readonly posture: Posture;
  readonly reducedMotion: boolean;
}
/** The look a shell stands under: the face and the scheme it already chose. */
export interface Appearance {
  readonly face: "paper" | "ohmarchy";
  readonly scheme: "light" | "dark";
}
/** The address bar, owned by the shell. The frame reads and writes the fragment through it, never `location`. */
export interface HostAddress {
  read(): string;
  write(next: string, how: "push" | "replace"): void;
  subscribe(changed: () => void): () => void;
}

/**
 * The platform's verbs and facts.
 *
 * Eight keys are `none` in every shell for now: no mount hands them in today, each does the thing
 * by hand beside the shell or inside a pane of its own. A key gets its verb's type in the change
 * that wires it, and every shell answers it then.
 */
export interface HostDevice {
  readonly build: DeviceBuild;
  /** Replaces `notificationHost`. A browser hands in the browser's own reader, by name. */
  readonly notifications: DeviceNotifications | None;
  /** The unread count on the app's icon. Replaces `onUnread`. */
  readonly badge: ((unread: number) => void) | None;
  /** Setting the language, and taking the account's at start. Today a context each mount wraps around the shell. */
  readonly language: None;
  /** Opening a link outside the app. */
  readonly openLink: None;
  /** Picking a file to attach. */
  readonly pickFile: None;
  /** Saving a file out of the app. */
  readonly saveFile: None;
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
