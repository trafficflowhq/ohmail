/**
 * WHO ANSWERS "MAY OHMAIL DRAW A NOTICE" IN THIS WINDOW — the shell, not the page.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────────────────────
 *
 * MEASURED on the released 0.13.7 under WebKitGTK, on a display with no notification service:
 * Settings → Notifications' master switch **could not be turned on and nothing said why**.
 * Three presses, frames captured at 0.3 s and 3 s, and the switch stayed off with no sentence
 * anywhere on the pane. The web build in the comparable state (permission `denied`) disables the
 * switch and says *"This device is set to refuse notifications from ohmail. That is changed in
 * the system settings, not here."* — the desktop had no equivalent for its own outcome.
 *
 * ── AND THE SWITCH WAS SHOWING THE OPPOSITE OF WHAT THE APP WAS DOING ───────────────────────
 *
 * Found by writing the guard, not by the walk, and it is the sharper half. `DEFAULT_CHANNELS` is
 * `master: true, ohbox: true`, and the emitter in `DesktopGate` passes `readChannels()` to
 * `decideNotices` with a literal `"granted"`. So the released build WAS posting an OS notice on
 * every rise in the unread count — while this pane drew the master OFF, because `checked` is
 * ANDed with `notifyPermission === "granted"` and the browser reader never answered that here.
 *
 * The switch was therefore not merely stuck: it was stuck reporting the opposite of the truth,
 * and a person who wanted the notices to stop had no control that could stop them. That is what
 * makes this a claims defect rather than a dead control.
 *
 * ── WHY, AND IT IS NOT A MISSING SENTENCE ───────────────────────────────────────────────────
 *
 * `SettingsView` defaulted to `browserNotificationHost`, which reads `Notification.permission`
 * and calls `Notification.requestPermission()`. In this webview that request resolves without
 * granting anything — there is no permission provider behind it — so `pressMaster` took its
 * `if (want && state !== "granted") return` arm and wrote nothing. The switch was reporting a
 * refusal that had not happened, for a permission this page does not hold and cannot acquire.
 *
 * The prop's own docblock had already said what to do — *"the desktop webview cannot hold the
 * permission at all and asks its shell, so that host injects its own reader"* — and no such host
 * was ever written or threaded. This is it.
 *
 * ── WHAT `permission()` MEANS ON THIS DOOR ──────────────────────────────────────────────────
 *
 * `"granted"` — and read precisely, because the word is doing different work here than in a
 * browser tab. It means **this window may ask the shell to post a notice**, which is true and is
 * the only question this surface can answer. It is the same value, for the same stated reason,
 * that the emitter in `DesktopGate` already passes to `decideNotices`: *"The shell holds the OS
 * permission, not this window: its `notify` command asks the platform itself on first use and
 * reports a refusal as a rejection."*
 *
 * So the switch on this door governs the thing it can govern — whether ohmail asks at all — and
 * `readChannels()` is what the emitter reads before every notice, so turning it off means
 * nothing is drawn. What the switch CANNOT promise is that the operating system will then show
 * it, and that is exactly why {@link NotificationHost.osHoldsPermission} is set: the pane owes a
 * sentence saying the OS has the last word and where it is changed. A switch that governs the
 * asking, plus a sentence about who answers, is the honest pair; a switch that cannot move and
 * says nothing is what shipped.
 *
 * ── AND NO `syncSubscription` ───────────────────────────────────────────────────────────────
 *
 * Omitted, not stubbed. The method is optional and the interface names this build as the reason:
 * there is no push subscription and no server to hold one — this shell is woken by its own
 * engine. A do-nothing stub would be a promise the type makes and the surface does not keep.
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
