package app.ohmail.organizer

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ONLY BACKGROUND SURFACE — a foreground service whose notification IS the permission
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A standalone phone is the organizer of its own mailbox, and Android freezes an app it has put in
 * the background. This service is what keeps this process running so the engine's poll timer goes
 * on firing, and the notification is what makes that a thing a person can see and end.
 *
 * ── DISMISSING THE NOTIFICATION IS STOPPING, AND THAT IS NOT A COURTESY ────────────────────
 *
 * From Android 14 a person may swipe a foreground-service notification away for most service
 * types. The fourth door says *"It organizes while its notification is shown. Dismiss the
 * notification to stop."* — so a service that kept running after the swipe would make that
 * sentence false, and there would be no surface left anywhere saying a mailbox was being
 * organized. So {@link #ACTION_STOP} is BOTH the action button's intent and the notification's
 * `deleteIntent`: one constant, one handler, and the two cannot drift apart.
 *
 * The body is never "tap to stop". A tap opens the app, which is the platform's convention for
 * every notification a person has ever touched, and promising that it stops the organizer would
 * fire the stop from the open-the-app reflex.
 *
 * ── `START_NOT_STICKY`, BECAUSE THE ENGINE IS IN JAVASCRIPT ───────────────────────────────
 *
 * The engine this service holds up lives in the React runtime, and the notification's text —
 * including the mail ADDRESS — is composed there and handed in. A service the system re-created
 * on its own would come back with neither: a notification saying "Organizing" with no engine
 * behind it, which is the false-state class this whole design exists to prevent. So it does not
 * come back, and the app starts it again the next time it is backgrounded.
 *
 * ── NOTHING HERE IS LOGGED ─────────────────────────────────────────────────────────────────
 *
 * The body carries somebody's mail address. It goes from the deck to the notification and nowhere
 * else — no `Log`, no crash breadcrumb, no analytics. There is no diagnostic in this file at all,
 * which is the only way to be sure.
 */
class OrganizerService : Service() {

  companion object {
    /** The channel a person sees in system settings. Its NAME comes from the deck, per start. */
    const val CHANNEL_ID = "organizing"

    /** One id: the service posts one notification and replaces it rather than stacking. */
    const val NOTIFICATION_ID = 4201

    /**
     * THE USER'S STOP — the action button and the swipe-dismiss, one constant.
     *
     * See the class header: the `deleteIntent` and the action carry this same string, so a swipe
     * and a press reach one handler. Two constants here would be two behaviours a test could pass
     * one of.
     */
    const val ACTION_STOP = "app.ohmail.organizer.STOP"

    /** Start it with the three strings the deck composed. */
    const val EXTRA_CHANNEL_NAME = "channelName"
    const val EXTRA_BODY = "body"
    const val EXTRA_STOP_LABEL = "stopLabel"

    /**
     * WHAT THE JS ASKED FOR, and the module's own bridge to the stop.
     *
     * `@Volatile` because `onStartCommand` runs on the main thread and the module's `isRunning`
     * read can come from another. A service object cannot be reached from a module directly —
     * Android owns its lifecycle — so the pair of facts the module needs lives here.
     */
    @Volatile
    var running: Boolean = false
      private set

    /**
     * A STOP HAS BEEN ASKED FOR AND A START MAY STILL BE IN FLIGHT.
     *
     * `startForegroundService` is asynchronous, so a start and a stop issued in quick succession
     * arrive in either order. Without this the service could go foreground AFTER the stop, posting
     * "Organizing …" over a mailbox whose claim JS had already released. Cleared by the next
     * `start`, which is the only thing that means a caller wants the notification.
     */
    @Volatile
    var stopping: Boolean = false

    /** Counted down when the notification is actually posted — see {@link awaitRunning}. */
    @Volatile
    private var up: CountDownLatch = CountDownLatch(1)

    /**
     * WAIT, BOUNDED, FOR THE SERVICE TO SAY IT IS UP — and answer whether it is.
     *
     * `running` read straight after `startForegroundService` is `false` for a start that is merely
     * queued, and JS reads `false` as "the notification is not showing" and hands the mailbox back.
     * So the module waits, inside the platform's own five-second window, and reports the fact.
     *
     * Called from an `AsyncFunction`, which expo runs off the main thread, so blocking here blocks
     * nothing the service needs to come up.
     */
    fun awaitRunning(timeoutMs: Long): Boolean {
      if (running) return true
      up.await(timeoutMs, TimeUnit.MILLISECONDS)
      return running
    }

    /** Set by the module while it is alive; invoked for the action and for a swipe-dismiss. */
    @Volatile
    var onStopRequested: (() -> Unit)? = null

    /**
     * ══ THE JAVASCRIPT HAS TO BE RUNNING, AND A FOREGROUND SERVICE ALONE DOES NOT DO THAT ══
     *
     * Measured in review and true of every React Native app: `JavaTimerManager` REMOVES timer
     * callbacks when the host pauses, unless a headless JS task is active. A foreground service
     * keeps the PROCESS alive and unfrozen — which is necessary — but the engine's poll timer and
     * the claim watch are JavaScript timers, so on their own they stop the moment the Activity
     * pauses. The notification would go on saying "Organizing …" over an engine that had stopped
     * running, which is the exact false state this design exists to prevent.
     *
     * So the JS side keeps a headless task alive and beats here while it does
     * (`OrganizerHeadlessService` + `background.ts`'s heartbeat). This field is the last beat's
     * time, and {@link jsAlive} is the question the service asks before it keeps standing.
     *
     * NAMED RATHER THAN ASSUMED: this half is not yet driven on a device, and the gap row
     * `PHONE-FGS-NOT-DRIVEN-ON-A-DEVICE` carries the cell that must confirm it.
     */
    @Volatile
    var lastBeatMs: Long = 0L

    /** Two beats' grace. A single missed beat is a busy device; two is a runtime that has stopped. */
    const val BEAT_INTERVAL_MS = 20_000L

    /**
     * Is the JavaScript that this notification speaks for still running? `false` means the
     * notification is a false statement and the service must come down.
     */
    fun jsAlive(nowMs: Long): Boolean =
      lastBeatMs != 0L && nowMs - lastBeatMs <= BEAT_INTERVAL_MS * 2

    /**
     * WILL THE SYSTEM LET THIS APP WORK IN THE BACKGROUND AT ALL?
     *
     * Two facts, both of which end in a service the system may kill at any moment with nothing
     * anywhere saying why:
     *
     *  · **battery saver** — `isPowerSaveMode`, which defers background work app-wide;
     *  · **a per-app background restriction** a person set in app settings —
     *    `isBackgroundRestricted`, which forbids starting a foreground service from the background
     *    outright.
     *
     * Asked BEFORE the service is started rather than discovered by its death, because the
     * alternative is an app that says it organizes over a mailbox that is not being organized.
     */
    fun isRestricted(context: Context): Boolean {
      val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (power != null && power.isPowerSaveMode) return true
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val activity = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        if (activity != null && activity.isBackgroundRestricted) return true
      }
      return false
    }

    /**
     * CAN THE NOTIFICATION BE SEEN? A refused `POST_NOTIFICATIONS` (API 33+) leaves the service
     * running behind nothing, and "behind a notification you can see" would be false. The caller
     * answers `false` to JS and the mailbox is handed back.
     */
    fun canPostNotification(context: Context): Boolean =
      NotificationManagerCompat.from(context).areNotificationsEnabled()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    /* THE STOP, WHICHEVER WAY IT ARRIVED. The action button and the `deleteIntent` are the same
       string, so this is the one place either lands. `stopSelf` first: the JS listener releases
       the claim, and the notification must not outlive the decision to end it. */
    if (intent?.action == ACTION_STOP) {
      running = false
      up = CountDownLatch(1)
      watchdog.removeCallbacksAndMessages(null)
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      onStopRequested?.invoke()
      return START_NOT_STICKY
    }

    /* A STOP THAT ARRIVED FIRST WINS. See {@link stopping}: the two calls race, and a service that
       went foreground after the stop would post a notification over a released claim. */
    if (stopping) return stopBecauseUnaddressed()

    val channelName = intent?.getStringExtra(EXTRA_CHANNEL_NAME) ?: return stopBecauseUnaddressed()
    val body = intent.getStringExtra(EXTRA_BODY) ?: return stopBecauseUnaddressed()
    val stopLabel = intent.getStringExtra(EXTRA_STOP_LABEL) ?: return stopBecauseUnaddressed()

    ensureChannel(channelName)
    startForeground(NOTIFICATION_ID, build(body, stopLabel))
    running = true
    /* THE FIRST BEAT IS THE START ITSELF: JS is demonstrably running at this instant, since it is
       what asked. Without it `jsAlive` would be false for the first twenty seconds of every
       service and the watchdog would take down a notification that had just gone up. */
    lastBeatMs = System.currentTimeMillis()
    up.countDown()
    /* THE TIMERS, which the foreground service does not keep running on its own — see
       `OrganizerHeadlessService`. Started after `startForeground` so the notification is already
       up if this throws on a platform that refuses it. */
    try {
      startService(Intent(this, OrganizerHeadlessService::class.java))
    } catch (e: IllegalStateException) {
      /* The task could not be started, so the timers will stop and the watchdog below will take
         the notification down within two beats. Safe rather than silent: nothing claims to be
         organizing for longer than the runtime actually is. */
    }
    armWatchdog()
    /* NOT `START_STICKY` — see the class header. A service the system re-created would have no
       engine and no address, and would show "Organizing" over nothing. */
    return START_NOT_STICKY
  }

  /**
   * ══ NO BEAT, NO NOTIFICATION — the one guard that makes the door's sentence safe to make ══
   *
   * The notification says a mailbox is being organized. That is only true while the JavaScript
   * doing it is running, and whether the headless task actually keeps React Native's timers alive
   * is a platform fact this build has not yet driven on a device. So the service asks rather than
   * assumes: two beats' silence and it stops itself, and the notification goes with it.
   *
   * It fails SAFE by construction. If the task works, beats arrive and nothing happens. If it does
   * not, the person sees the notification disappear — which is true ("it is not organizing any
   * more") — instead of a notification standing for hours over a frozen runtime. The claim then
   * lapses out of the mailbox on its own, which is the same outcome as a phone that was switched
   * off, and another machine can take the mailbox.
   *
   * Main-thread `Handler` and not a JS timer, for the reason this whole guard exists.
   */
  private val watchdog = Handler(Looper.getMainLooper())

  private fun armWatchdog() {
    watchdog.removeCallbacksAndMessages(null)
    watchdog.postDelayed(object : Runnable {
      override fun run() {
        if (!running) return
        if (!jsAlive(System.currentTimeMillis())) {
          running = false
          stopForeground(STOP_FOREGROUND_REMOVE)
          stopSelf()
          return
        }
        watchdog.postDelayed(this, BEAT_INTERVAL_MS)
      }
    }, BEAT_INTERVAL_MS)
  }

  /**
   * A START WITH NO TEXT IS NOT A START. It could only come from the system re-creating this
   * service (which `START_NOT_STICKY` already refuses) or from a component nobody wrote; either
   * way there is no notification to show and therefore nothing that may organize.
   */
  private fun stopBecauseUnaddressed(): Int {
    running = false
    stopSelf()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    up = CountDownLatch(1)
    watchdog.removeCallbacksAndMessages(null)
    /* THE TASK GOES WITH THE NOTIFICATION. A headless task outliving the service it was started
       for would hold React Native awake with nothing saying why. */
    try {
      stopService(Intent(this, OrganizerHeadlessService::class.java))
    } catch (e: IllegalStateException) {
      /* Already gone, which is the state this wanted. */
    }
    /* And the beat is forgotten, so a NEXT start cannot read this run's last beat as its own. */
    lastBeatMs = 0L
    super.onDestroy()
  }

  /**
   * LOW IMPORTANCE, SILENT, NO BADGE. This notification is a statement of fact a person needs to
   * be able to find, not an interruption: it is showing for as long as their mailbox is being
   * organized, and anything that made a sound or a dot would be a nuisance by the hour.
   */
  private fun ensureChannel(name: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW)
    channel.setShowBadge(false)
    channel.setSound(null, null)
    channel.enableVibration(false)
    /* Created rather than checked-then-created: `createNotificationChannel` is idempotent and
       updates the name, which is what a language change needs. */
    manager.createNotificationChannel(channel)
  }

  private fun stopIntent(): PendingIntent {
    val intent = Intent(this, OrganizerService::class.java).setAction(ACTION_STOP)
    return PendingIntent.getService(
      this,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun build(body: String, stopLabel: String): Notification {
    /* THE TAP OPENS THE APP. The platform's convention, and the reason the body does not say
       "tap to stop": a person who taps a notification expects the app. `null` where there is no
       launch intent (which cannot happen for an app with an activity) leaves the notification
       without a content intent rather than routing a tap to the stop. */
    val open = packageManager.getLaunchIntentForPackage(packageName)
    val content = if (open == null) null else PendingIntent.getActivity(
      this,
      1,
      open,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val stop = stopIntent()
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(applicationInfo.loadLabel(packageManager))
      .setContentText(body)
      .setOngoing(true)
      .setShowWhen(false)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      /* THE ACTION AND THE SWIPE ARE ONE — see the class header. Both carry `stop`. */
      .addAction(0, stopLabel, stop)
      .setDeleteIntent(stop)
    if (content != null) builder.setContentIntent(content)
    return builder.build()
  }
}
