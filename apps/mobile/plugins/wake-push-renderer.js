const path = require("node:path");
const fs = require("node:fs");
const {
  withDangerousMod, withAndroidManifest, createRunOncePlugin,
} = require("expo/config-plugins");

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE WAKE RENDERER — draws ONE fixed notice, and ONLY when there is no JS to do it instead
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `expo-unified-push`'s native service renders a notification from ANY decrypted payload that
 * carries an `id`, using that payload's own `title`, `body`, `imageUrl` and `url` — and the `url`
 * becomes an `ACTION_VIEW` PendingIntent, so tapping the notification opens whatever address the
 * payload named. On a product whose whole point is that you can pair with a self-host or a
 * friend's desktop — a server that HOLDS this device's push keys by design — that default renderer
 * is a phishing primitive: the paired server, not the distributor, could draw a notice in ohmail's
 * name with text and a tap target it chose.
 *
 * The connector lets an app REPLACE that default with its own `PushPayloadRenderer`, resolved by
 * class name from an AndroidManifest meta-data entry. This is that class. Its predecessor rendered
 * NOTHING for every payload (it was `SilentPushPayloadRenderer`); this one is narrower on the axis
 * that matters and wider on the axis the product needs.
 *
 * ── WHY THIS EXISTS, AND WHAT CHANGED FROM "RENDER NOTHING" ────────────────────────────────────
 *
 * A wake to a LIVE app is handled by the JS side: `state/wake.tsx` subscribes `onWake` and calls
 * `/sync`, silently, because a wake is not a notification while you are looking at your inbox. But
 * that path only runs while the React context is alive. A wake to an app the user swiped away
 * spawns a fresh process for the connector's broadcast receiver, the React/JS engine never boots,
 * and the wake used to die in `ExpoUPService` with no JS bound to hand it to. Closing that was the
 * one thing the copy could not promise ("waking a closed app needs native code that is not written
 * yet"). This is that native code.
 *
 * ── HOW IT STAYS SAFE: IT NEVER READS A FIELD OUT OF THE PAYLOAD ──────────────────────────────
 *
 * The only thing this renderer checks about `decrypted` is whether it is BYTE-FOR-BYTE our own
 * closed wake constant, `{"type":"wake"}` — the fifteen bytes the server's sender emits and nothing
 * else. It never parses it, never reads a `title`/`body`/`url`/`imageUrl`, never derives a tap
 * target from it. So:
 *
 *  · anything that is not exactly the constant renders NOTHING — the phishing surface the old
 *    renderer closed stays closed, because attacker-chosen content is a non-constant payload;
 *  · the constant renders a FIXED, app-owned notice ("New mail") whose tap opens the app and whose
 *    text reveals only what the mere existence of a notification already reveals — no subject, no
 *    sender, no count. That is the most a content-free wake can honestly say, and it is exactly
 *    what the privacy invariant wants said.
 *
 * A paired server can, at most, send the constant to cause a spurious "New mail" — but it already
 * decides whether to wake at all, so that is inside its existing power (a spurious silent sync),
 * not a new capability, and it is not a phishing vector: fixed text, no payload-supplied URL.
 *
 * ── AND ONLY WHEN THERE IS NO MOUNTED SURFACE TO HANDLE IT — WITHOUT READING THE HOST ─────────
 *
 * `ExpoUPService.onMessage` runs the renderer on EVERY delivered wake, alive or dead — the
 * connector gives us no "is the app running" flag. Two tempting probes are both wrong, and both
 * were reasoned/measured out:
 *
 *  · reading `ReactApplication.reactHost.currentReactContext` in the broadcast process is a TRAP —
 *    `reactHost` is a `by lazy`, so reading it CREATES and starts the host and makes a killed
 *    process look alive (proven on an emulator: the notice's channel was never even created);
 *  · and even where the host already exists, `currentReactContext` is the WRONG question: when the
 *    task is swiped away, React tears down the SURFACE (`onHostDestroy`) — unmounting the tree and
 *    with it `state/wake.tsx`'s `onWake` listener — but leaves the ReactHost, so the context stays
 *    non-null and a context read would wrongly suppress the notice in exactly the case this exists
 *    for.
 *
 * The right question is "is the React SURFACE mounted", and the answer is a plain count. A tiny
 * auto-start `ContentProvider` (`WakeInteractiveInitializer`) registers `ActivityLifecycleCallbacks`
 * in `onCreate`, which runs in EVERY process start — including the one the connector's broadcast
 * spawns — before any other component, and keeps a count of activities CREATED minus DESTROYED.
 * The renderer reads only that count (`WakeAppState.interactive` = count > 0), never the host:
 *
 *  · a broadcast-only process never creates an Activity → 0 → draw (the killed-app case);
 *  · foreground, and backgrounded-after-opening (home STOPS the Activity but does not destroy it, so
 *    the surface stays mounted and `onWake` still fires) → >= 1 → suppress;
 *  · task swiped away → the Activity is DESTROYED and the surface torn down → 0 → draw, instead of
 *    losing the wake.
 *
 * Process death resets the count, the clean "alive → killed" transition. It counts create/destroy
 * rather than start/stop precisely so a backgrounded app (surface mounted, `onWake` live) keeps
 * suppressing.
 *
 * ── NO NETWORK, NO LOGGING, RETURNS null ──────────────────────────────────────────────────────
 *
 * The base render opens no connection and loads no remote image, by construction. It logs
 * nothing at all — not the payload, not the instance, not a diagnostic — so there is no path by
 * which push content could reach logcat, and `assert-log-hygiene.sh`'s canaries need no extension.
 * It posts the notification itself and returns null, which tells the connector to draw nothing of
 * its own — so there is never a second notification and the default renderer never runs.
 *
 * ── WHY THE CLASSES ARE WRITTEN INTO THE GENERATED PROJECT ────────────────────────────────────
 *
 * The connector resolves the renderer by CLASS NAME (`Class.forName(name) as? PushPayloadRenderer`)
 * from a manifest meta-data entry. The class has to genuinely exist and genuinely implement the
 * interface, or the reflective lookup returns null and the service falls back to the default
 * renderer — a silent no-op that looks configured. `android/` is build output, regenerated on every
 * `expo prebuild`, so a file committed there would be deleted; writing it here, in source, at
 * prebuild time is what keeps the whole mechanism reproducible from a clone. Same mechanism as the
 * R8 keep rule in `release-minification.js`, which protects this exact class name from being renamed
 * or dropped — without it, R8 sees a class referenced only by a manifest string and the default
 * renderer quietly returns.
 *
 * It fails LOUD if the layout it writes into is not there, rather than skipping and leaving the
 * default renderer armed.
 */

/** Kept in sync with `app.json`'s `expo-unified-push` plugin config. Both are asserted by a test. */
const PACKAGE = "app.ohmail.push";
const CLASS = "WakePayloadRenderer";
const FQCN = `${PACKAGE}.${CLASS}`;

/** The auto-start ContentProvider that flips the interactive flag on Activity lifecycle. */
const INITIALIZER_CLASS = "WakeInteractiveInitializer";
const INITIALIZER_FQCN = `${PACKAGE}.${INITIALIZER_CLASS}`;

/**
 * The wake payload, byte for byte, as the server's own sender defines it. Duplicated here (the
 * server constant lives in a package this app does not depend on) and it fails CLOSED: a wrong
 * value means "not the constant", which renders nothing — drift makes wakes stop drawing, never
 * makes the app draw something unexpected. A test pins it against `src/net/unified-push.ts`.
 */
const WAKE_PAYLOAD = '{"type":"wake"}';

/**
 * The notice's title. Fixed, app-owned, never from the payload. Pinned against `copy.ts`'s `wake`
 * string by a test so the notification and the in-app label cannot drift.
 */
const NOTIFICATION_TITLE = "New mail";

/** The process-static interactive flag, its own tiny file so both classes reference one source. */
const APP_STATE_SOURCE = `package ${PACKAGE}

/**
 * GENERATED at prebuild by apps/mobile/plugins/wake-push-renderer.js. Do not edit here.
 *
 * {@link liveActivities} counts activities that have been CREATED and not yet DESTROYED in this
 * process — which is exactly "is the React surface (and with it state/wake.tsx's onWake
 * listener) currently mounted". {@link interactive} is that count being non-zero, and it is the
 * wake renderer's whole "is there live JS to handle this wake" signal:
 *
 *  · a process spawned only for the connector's broadcast never creates an Activity → 0 → the
 *    renderer draws the notice (the killed-app case);
 *  · foreground, and backgrounded-after-opening (home pressed → the Activity is STOPPED, not
 *    destroyed, and the React tree stays mounted so onWake still fires) → >= 1 → suppress;
 *  · the task swiped away → the Activity is DESTROYED and the surface torn down, so onWake is
 *    gone → 0 → draw, instead of losing the wake. This is why it counts CREATED/DESTROYED and NOT
 *    started/stopped, and why it is NOT a read of ReactHost.currentReactContext — the host outlives
 *    the surface on a task removal, so a context read would stay non-null and wrongly suppress
 *    (and reading the lazy host in a broadcast process would create it and defeat the killed case).
 *
 * All writes happen on the main thread (lifecycle callbacks), so the non-atomic ++/-- are
 * safe; @Volatile is for the cross-thread READ from the connector's service. Process death
 * resets it, which is the clean "alive → killed" transition. A configuration change (rotation)
 * destroys then recreates, so the count dips to 0 and back within a frame; a wake in that sub-frame
 * window would draw a correct notice over a foreground app, which is rare and harmless.
 */
object WakeAppState {
  @Volatile
  @JvmStatic
  var liveActivities: Int = 0

  @JvmStatic
  val interactive: Boolean
    get() = liveActivities > 0
}
`;

/** The auto-start ContentProvider that registers the lifecycle callbacks. */
const INITIALIZER_SOURCE = `package ${PACKAGE}

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle

/**
 * GENERATED at prebuild by apps/mobile/plugins/wake-push-renderer.js. Do not edit here.
 *
 * A no-op ContentProvider whose ONLY job is to run before any other component in EVERY process
 * start and register Activity-lifecycle callbacks that flip {@link WakeAppState.interactive}. This
 * is the standard dependency-free way to run code at process init without editing MainApplication.
 * It stores nothing and answers nothing.
 */
class ${INITIALIZER_CLASS} : ContentProvider() {
  override fun onCreate(): Boolean {
    val app = context?.applicationContext as? Application ?: return false
    app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      // Count CREATED minus DESTROYED — the number of activities that exist, i.e. whether the React
      // surface (and its onWake listener) is mounted. Background STOP does not destroy, so it stays
      // counted; a task removal destroys, so it drops to zero and the killed-app notice takes over.
      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        WakeAppState.liveActivities++
      }
      override fun onActivityDestroyed(activity: Activity) {
        if (WakeAppState.liveActivities > 0) WakeAppState.liveActivities--
      }
      override fun onActivityStarted(activity: Activity) {}
      override fun onActivityResumed(activity: Activity) {}
      override fun onActivityPaused(activity: Activity) {}
      override fun onActivityStopped(activity: Activity) {}
      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    })
    return true
  }

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
`;

const RENDERER_SOURCE = `package ${PACKAGE}

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import dev.djara.expounifiedpush.NotificationContent
import dev.djara.expounifiedpush.PushPayloadRenderer

/**
 * Draws a single fixed "New mail" notice for a wake delivered to a KILLED app, and nothing at all
 * otherwise.
 *
 * GENERATED at prebuild by apps/mobile/plugins/wake-push-renderer.js. Do not edit here; the
 * android/ tree is build output and is regenerated on every prebuild.
 *
 * This is the connector's custom PushPayloadRenderer. It runs, by the interface's own contract,
 * even when the app process was spawned only for the connector's broadcast — which is exactly the
 * killed-app case this class exists for, and exactly why it must not depend on the JS bridge.
 *
 * Two refusals make it safe, and both are load-bearing:
 *
 *  1. It NEVER reads a field out of the decrypted payload. The only check is whether the payload is
 *     byte-for-byte the closed wake constant; a rich payload from a paired server (with its own
 *     title, body, image and tap URL) is not the constant, so it renders nothing. That is what
 *     keeps a server the phone paired with from drawing a notification in ohmail's name.
 *  2. It draws only when the React surface is not mounted — i.e. no Activity is alive to keep
 *     state/wake.tsx's onWake listener running. The signal is {@link WakeAppState.interactive},
 *     a plain count of created-minus-destroyed activities, NEVER a read of ReactHost: reading the
 *     lazy host in a broadcast process would create it (killed case defeated), and on a task removal
 *     the host outlives the torn-down surface, so a context read would suppress the very notice this
 *     exists to draw. The count is 0 in a broadcast-only process (draw), >= 1 foreground and
 *     backgrounded (suppress; the surface is mounted and onWake syncs), and back to 0 once the
 *     task is swiped away and the Activity destroyed (draw).
 *
 * It posts the notification itself and returns null, so the connector draws nothing of its own and
 * there is never a second notice. It logs nothing.
 */
class ${CLASS} : PushPayloadRenderer {
  override fun render(context: Context, instance: String, decrypted: String): NotificationContent? {
    // Only our own closed constant is ever acted on. No field is read out of the payload.
    if (decrypted != WAKE_PAYLOAD) return null
    // A mounted React surface means state/wake.tsx's onWake will sync this silently; only when no
    // Activity is alive (killed app, or a task swiped away in a lingering process) is there no JS to
    // hand the wake to, and only then does this draw the notice. WakeAppState.interactive is a plain
    // count of live activities — never a read of ReactHost, which would create the lazy host in a
    // killed process AND, on a task removal, outlive the surface and wrongly report JS as alive.
    if (WakeAppState.interactive) return null
    postWakeNotification(context)
    // We drew it (or tried). null tells the connector to draw nothing itself.
    return null
  }

  private fun postWakeNotification(context: Context) {
    try {
      val ctx = context.applicationContext
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = NotificationChannel(
          CHANNEL_ID,
          CHANNEL_NAME,
          NotificationManager.IMPORTANCE_DEFAULT,
        )
        NotificationManagerCompat.from(ctx).createNotificationChannel(channel)
      }

      val builder = NotificationCompat.Builder(ctx, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.sym_action_email)
        .setContentTitle(NOTIFICATION_TITLE)
        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        .setAutoCancel(true)

      // Tapping opens the app, which then syncs the way it always does on a foreground open. No tap
      // target is ever derived from the payload — the launch intent is the app's own.
      val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      if (launch != null) {
        launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        builder.setContentIntent(
          PendingIntent.getActivity(
            ctx,
            0,
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
          ),
        )
      }

      NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, builder.build())
    } catch (t: Throwable) {
      // A denied POST_NOTIFICATIONS permission (API 33+) or any post failure is swallowed: there is
      // nothing to recover and nothing to log that would not risk leaking. The wake still synced the
      // next time the app is opened, which is the floor underneath all of this.
    }
  }

  private companion object {
    const val WAKE_PAYLOAD = ${JSON.stringify(WAKE_PAYLOAD)}
    const val NOTIFICATION_TITLE = ${JSON.stringify(NOTIFICATION_TITLE)}
    const val CHANNEL_ID = "app.ohmail.push.new_mail"
    const val CHANNEL_NAME = "New mail"
    const val NOTIFICATION_ID = 1
  }
}
`;

/** Write the three Kotlin sources into the generated project. */
function withWakeRendererSources(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const javaRoot = path.join(root, "app", "src", "main", "java");
      if (!fs.existsSync(javaRoot)) {
        throw new Error(
          `wake-push-renderer: ${javaRoot} does not exist, so the wake renderer was NOT written. `
          + "Refusing rather than shipping an APK whose connector will render server-supplied "
          + "notification text and tap URLs. The Android template's source layout has changed; "
          + "point this plugin at the new one.",
        );
      }
      const dir = path.join(javaRoot, ...PACKAGE.split("."));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${CLASS}.kt`), RENDERER_SOURCE);
      fs.writeFileSync(path.join(dir, "WakeAppState.kt"), APP_STATE_SOURCE);
      fs.writeFileSync(path.join(dir, `${INITIALIZER_CLASS}.kt`), INITIALIZER_SOURCE);
      return cfg;
    },
  ]);
}

/** The provider's authority — unique per app, derived from the applicationId. */
function initializerAuthority(config) {
  const pkg = (config.android && config.android.package) || "app.ohmail.push";
  return `${pkg}.wakepush.init`;
}

/** Register the auto-start ContentProvider, exported=false, in the generated manifest. */
function withInitializerProvider(config) {
  const authority = initializerAuthority(config);
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (!app) {
      throw new Error(
        "wake-push-renderer: no <application> in the AndroidManifest, so the interactive-state "
        + "provider was NOT registered. Without it the wake renderer cannot tell a killed app from "
        + "a running one and would draw a redundant notice while the app is open.",
      );
    }
    app.provider = (app.provider || []).filter(
      (p) => p?.$?.["android:name"] !== INITIALIZER_FQCN,
    );
    app.provider.push({
      $: {
        "android:name": INITIALIZER_FQCN,
        "android:authorities": authority,
        "android:exported": "false",
      },
    });
    return cfg;
  });
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
function withWakePushRenderer(config) {
  return withInitializerProvider(withWakeRendererSources(config));
}

module.exports = createRunOncePlugin(withWakePushRenderer, "ohmail-wake-push-renderer", "1.0.0");
module.exports.FQCN = FQCN;
module.exports.INITIALIZER_FQCN = INITIALIZER_FQCN;
module.exports.WAKE_PAYLOAD = WAKE_PAYLOAD;
module.exports.NOTIFICATION_TITLE = NOTIFICATION_TITLE;
module.exports.RENDERER_SOURCE = RENDERER_SOURCE;
module.exports.APP_STATE_SOURCE = APP_STATE_SOURCE;
module.exports.INITIALIZER_SOURCE = INITIALIZER_SOURCE;
/** Back-compat alias: the census reads the emitted renderer Kotlin as `SOURCE`. */
module.exports.SOURCE = RENDERER_SOURCE;
