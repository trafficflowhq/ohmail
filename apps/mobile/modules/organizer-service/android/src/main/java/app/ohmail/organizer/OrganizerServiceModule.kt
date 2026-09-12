package app.ohmail.organizer

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE JS SURFACE OF THE ORGANIZER SERVICE — start, stop, and the one event that is a stop
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `src/engine/background.ts` owns the decisions; this module owns the platform calls and nothing
 * else. The split is the `host-pinning` one and for the same reason: every rule about WHEN the
 * mailbox is handed back is driven by the node suite through a seam, and only what cannot be
 * driven there — a real service, a real notification — is in Kotlin.
 *
 * ── `start` ANSWERS WHETHER THE NOTIFICATION IS SHOWING, NOT WHETHER A CALL SUCCEEDED ──────
 *
 * Three ordinary refusals answer `false` rather than throwing, because the caller's reply to all
 * of them is the same and it is not an error report: hand the mailbox back and organize only while
 * open.
 *
 *  · `POST_NOTIFICATIONS` refused (API 33+) — the service would run behind nothing;
 *  · a background start refused (`ForegroundServiceStartNotAllowedException`, API 31+);
 *  · the system restricting background work at all (battery saver, per-app restriction).
 *
 * A `throw` here would reach JS as a fault and the arm that reads it as "then do not organize in
 * the background" would be one `catch` away from being skipped.
 */
class OrganizerServiceModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext?.applicationContext)

  override fun definition() = ModuleDefinition {
    Name("OhmailOrganizerService")

    /**
     * THE STOP, AS ONE EVENT. The notification's action button and a swipe-dismiss both reach
     * `OrganizerService.ACTION_STOP`, which invokes the callback registered below — so JS has one
     * listener for one act and cannot handle the press while missing the swipe.
     */
    Events("onStopRequested")

    OnCreate {
      OrganizerService.onStopRequested = { sendEvent("onStopRequested", mapOf<String, Any>()) }
    }

    OnDestroy {
      /* The React context is going away, so the listener that would fire into it must too. The
         service is NOT stopped here: a JS reload is not a person's decision to stop organizing,
         and `background.ts` re-subscribes on the way back up. */
      OrganizerService.onStopRequested = null
    }

    AsyncFunction("start") { channelName: String, body: String, stopLabel: String ->
      if (OrganizerService.isRestricted(context)) return@AsyncFunction false
      if (!OrganizerService.canPostNotification(context)) return@AsyncFunction false
      val intent = Intent(context, OrganizerService::class.java)
        .putExtra(OrganizerService.EXTRA_CHANNEL_NAME, channelName)
        .putExtra(OrganizerService.EXTRA_BODY, body)
        .putExtra(OrganizerService.EXTRA_STOP_LABEL, stopLabel)
      OrganizerService.stopping = false
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (e: IllegalStateException) {
        /* `ForegroundServiceStartNotAllowedException` is an `IllegalStateException` subclass
           (API 31+) and the base class is what an older platform throws for the same situation.
           Caught by the base so both are one arm; `false` is the answer either way. */
        return@AsyncFunction false
      } catch (e: SecurityException) {
        /* A missing `FOREGROUND_SERVICE_DATA_SYNC` grant. A build whose manifest lost the
           permission fails here rather than organizing behind nothing. */
        return@AsyncFunction false
      }
      /* AND IT IS WAITED FOR, NOT ASSUMED. `startForegroundService` is asynchronous — the system
         has five seconds to bring the service up — so reading `running` straight after the call
         reports `false` for a start that is merely in flight. JS treats `false` as "the
         notification is not showing" and hands the mailbox back, which would make every ordinary
         background a decline. Bounded at three seconds, well inside the platform's own window;
         the latch is counted down by `onStartCommand` once the notification is posted. */
      OrganizerService.awaitRunning(3_000L)
    }

    /**
     * THE APP'S OWN STOP, and deliberately NOT the person's path.
     *
     * `stopService` rather than an `ACTION_STOP` intent: that action's handler fires the
     * `onStopRequested` event, whose one job is to make JS release the claim — and JS reaching
     * this function has ALREADY released it (`background.ts` hands the mailbox back before it
     * drops the notification). Routing the app's stop through the person's path would run the
     * hand-back twice and log a release of a claim that was no longer there.
     *
     * ── UNCONDITIONAL, AND THE GUARD IT USED TO HAVE WAS THE DEFECT ─────────────────────────
     *
     * `if (OrganizerService.running)` stood here, and `startForegroundService` is ASYNCHRONOUS:
     * the system has five seconds to bring the service up. So JS could start it, get `false`
     * (nothing was up yet), hand the mailbox back and call this — and the guard skipped, because
     * `running` was still false. Android then started the service and posted "Organizing …" over
     * a mailbox whose claim had just been released, with no watch armed to take it down.
     *
     * `stopService` on a service that is not running is a no-op, and on one that is still starting
     * it cancels the start. Destroying a foreground service removes its notification, so the
     * surface goes with it either way. The guard bought nothing and cost exactly that state.
     */
    AsyncFunction("stop") {
      context.stopService(Intent(context, OrganizerService::class.java))
      /* `stopping` closes the other half of the same race: a start intent already queued behind
         this stop would otherwise post a notification after it. The service refuses to go
         foreground while this is set, and a later `start` clears it. */
      OrganizerService.stopping = true
    }

    /**
     * THE HEARTBEAT — JavaScript saying it is still running, which is what the notification means.
     *
     * `OrganizerService`'s watchdog takes the notification down after two silent intervals. A
     * foreground service keeps the process unfrozen but not React Native's timers, so this is the
     * only thing that can tell a live runtime from a frozen one — and a guard that assumed instead
     * of asking would be a notification standing over an engine that had stopped.
     */
    Function("beat") {
      OrganizerService.lastBeatMs = System.currentTimeMillis()
      OrganizerService.running
    }

    /** How long JS may be silent before the notification comes down, so the JS side can pace. */
    Function("beatIntervalMs") { OrganizerService.BEAT_INTERVAL_MS.toDouble() }

    Function("isRunning") { OrganizerService.running }

    Function("isRestricted") { OrganizerService.isRestricted(context) }
  }
}
