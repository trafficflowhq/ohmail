import type { NoticePermission } from "@ohmail/client-engine";
import type { None } from "./contract.js";

/**
 * Which build this is. Replaces `support`, which today says both "this is the build" and "a Help
 * pane exists"; whether the pane exists is the feature `help`. Every shell knows its build.
 */
export interface DeviceBuild {
  readonly surface: "web" | "desktop" | "pairedPage";
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
}

/**
 * The platform's verbs and facts.
 *
 * Nine keys are `none` in every shell for now: no mount hands them in today, each does the thing
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
  /** Where the look is stored, and who answers "light or dark". */
  readonly appearance: None;
  /** How a text size is applied. */
  readonly textSize: None;
  /** The fold, the insets and the keyboard's height. */
  readonly fold: None;
  /** The live theme of the desktop it runs on. */
  readonly liveTheme: None;
}
