/**
 * WHO ANSWERS "MAY OHMAIL DRAW A NOTICE" IN THIS WINDOW — the shell, not the page. Measured on
 * the released 0.13.7 under WebKitGTK: Settings → Notifications' master switch could not be
 * turned on and nothing said why — `browserNotificationHost` reads `Notification.permission`,
 * and in this webview `requestPermission()` resolves without granting, so `pressMaster` wrote
 * nothing. Sharper: the build WAS posting an OS notice on every unread rise (`DEFAULT_CHANNELS`
 * is `master: true`, and `DesktopGate`'s emitter passes a literal `"granted"`) while the pane
 * drew the master OFF — stuck reporting the opposite of the truth, with no control that could
 * stop the notices. The prop's docblock said the desktop asks its shell; this host is it.
 */

/*
 * `permission()` on this door means "this window may ask the shell to post a notice" — the
 * same value the emitter passes to `decideNotices`; the shell holds the OS permission, and its
 * `notify` command asks the platform on first use, reporting a refusal as a rejection. The
 * switch governs the thing it can govern — whether ohmail asks at all; `readChannels()` is
 * read before every notice — and `osHoldsPermission` is set because the pane owes a sentence
 * saying the OS has the last word and where that is changed. `syncSubscription` is omitted,
 * not stubbed: no push subscription, no server to hold one — this shell is woken by its own
 * engine; a do-nothing stub would be a promise the type makes and the surface breaks.
 */
import type { NotificationHost } from "../../webapp/app/shell/notification-settings";

export const desktopNotificationHost: NotificationHost = {
  permission: () => "granted",
  /**
   * NOTHING TO ASK, so this is not an ask. The page holds no permission to request; the shell
   * asks the platform on first use (`notify`, which reports a refusal as a rejection the
   * emitter swallows). Returning `granted` keeps `pressMaster` on its writing path, which is
   * the whole of the fix — the press has to be allowed to store the intent it expresses.
   */
  request: async () => "granted",
  /** See the header: the OS has the last word and this window cannot read it. */
  osHoldsPermission: true,
};
