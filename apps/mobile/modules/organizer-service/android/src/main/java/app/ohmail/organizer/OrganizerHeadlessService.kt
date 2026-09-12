package app.ohmail.organizer

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT KEEPS THE JAVASCRIPT RUNNING — because a foreground service does not
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A foreground service keeps the PROCESS alive and unfrozen. It does NOT keep React Native's
 * timers running: `JavaTimerManager` removes its timer callbacks when the host pauses, and the
 * only thing that stops it is an ACTIVE HEADLESS TASK. The engine's poll timer and the claim
 * watch are ordinary JavaScript timers, so without this the notification would say
 * "Organizing …" over a runtime that had stopped the moment the Activity paused — the false
 * state the whole design exists to prevent.
 *
 * So `OrganizerService` starts this alongside itself, and it holds the task for as long as the
 * organizing lasts.
 *
 * ── THE TIMEOUT IS ZERO, WHICH MEANS "DO NOT TIME IT OUT" ─────────────────────────────────
 *
 * `HeadlessJsTaskConfig`'s timeout exists for tasks with an end — a push handled, a sync
 * finished. Organizing a mailbox has no end but the person's: the notification is what ends it.
 * A timeout here would silently retire the task and take the timers with it, leaving exactly the
 * state above, and nothing would say why.
 *
 * `allowedInForeground = true` because the app can come back to the foreground while the service
 * is still up (the Settings row's "background" state is that pair), and a task that refused then
 * would end at the very moment the person looked at it.
 *
 * ── IT CARRIES NO DATA, DELIBERATELY ──────────────────────────────────────────────────────
 *
 * The JS task's whole job is to exist, so the timers keep running, and to beat
 * (`OrganizerService.lastBeatMs`) so the service can tell whether they do. The address is in the
 * notification and nowhere else; nothing about a person's mail crosses this seam.
 *
 * ── NOT DRIVEN ON A DEVICE IN THE SLICE THAT WROTE IT ─────────────────────────────────────
 *
 * It compiles and it is registered, and the watchdog in `OrganizerService` fails SAFE if this is
 * wrong: no beat for two intervals and the notification comes down rather than standing over a
 * stopped runtime. The cell that must confirm it is the gap row
 * `PHONE-FGS-NOT-DRIVEN-ON-A-DEVICE`.
 */
class OrganizerHeadlessService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(
      TASK_NAME,
      com.facebook.react.bridge.Arguments.createMap(),
      /* timeout */ 0L,
      /* allowedInForeground */ true,
    )

  companion object {
    /**
     * The name `AppRegistry.registerHeadlessTask` is called with in JS. One literal, asserted
     * against the JS side by the suite — a task started under a name nothing registered fails at
     * runtime with a message about a task, and the timers stop.
     */
    const val TASK_NAME = "ohmail-organizer"
  }
}
