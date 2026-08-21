const path = require("node:path");
const fs = require("node:fs");
const { withDangerousMod, createRunOncePlugin } = require("expo/config-plugins");

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A WAKE MUST WAKE, NEVER RENDER — the notification surface is closed at the source
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `expo-unified-push`'s native service renders a notification from ANY decrypted payload that
 * carries an `id`, using that payload's own `title`, `body`, `imageUrl` and `url` — and the `url`
 * becomes an `ACTION_VIEW` PendingIntent, so tapping the notification opens whatever address the
 * payload named.
 *
 * ── WHO COULD ACTUALLY DO THAT, MEASURED RATHER THAN ASSUMED ──────────────────────────────────
 *
 * Not the distributor. A distributor relays bytes; it holds neither the device's `p256dh`/`auth`
 * nor the server's VAPID private key, so it cannot produce a body the connector will decrypt and
 * accept. The actor is **the server the phone paired with** — it is handed those keys at
 * registration by design. On the managed service that is us; on a self-host or a desktop-host
 * pairing it is whoever runs that machine, which is exactly the case this product invites people
 * into.
 *
 * So without this, pairing with somebody's server grants them the ability to draw a notification
 * that looks like it came from ohmail, with text they chose and a tap target they chose. That is a
 * phishing primitive, and it is worth closing even though our own sender only ever emits a
 * fifteen-byte constant with no `id` in it.
 *
 * ── WHY A RENDERER AND NOT A PAYLOAD PROPERTY ─────────────────────────────────────────────────
 *
 * The payload's lack of an `id` already makes OUR wakes silent, and there is a test pinning that.
 * But that is a fact about what we send, not about what the app will act on — the renderer runs on
 * whatever arrives. This makes the app incapable of rendering a push-delivered notification at
 * all, which turns the `id` census from the only defence into defence in depth.
 *
 * ── WHY THE CLASS IS WRITTEN INTO THE GENERATED PROJECT ───────────────────────────────────────
 *
 * The connector resolves the renderer by CLASS NAME, read from an `AndroidManifest` meta-data entry
 * and instantiated reflectively (`Class.forName(...) as? PushPayloadRenderer`). Two consequences
 * worth stating because both are traps:
 *
 *  · the class has to genuinely EXIST and genuinely implement the interface. Naming a class that is
 *    absent, or one that does not implement it, makes `resolvePayloadRenderer` return null and the
 *    service falls straight back to the default renderer — a silent no-op that looks configured.
 *  · so the meta-data alone is not enough; something must compile a class into the app.
 *
 * A local Expo module would also work and is heavier than this deserves: one file, one method,
 * returning null. Writing it into the generated `android/` tree at prebuild time keeps the whole
 * mechanism in this directory and reproducible from source — `android/` is build output, regenerated
 * every prebuild, so this is the only place the file can live without being committed as generated
 * code. The publish payload carries this plugin, so a clone produces the same APK.
 *
 * It fails LOUD if the layout it writes into is not there, rather than skipping and leaving the
 * default renderer armed.
 */

/** Kept in sync with `app.json`'s `expo-unified-push` plugin config. Both are asserted by a test. */
const PACKAGE = "app.ohmail.push";
const CLASS = "SilentPushPayloadRenderer";
const FQCN = `${PACKAGE}.${CLASS}`;

const SOURCE = `package ${PACKAGE}

import android.content.Context
import dev.djara.expounifiedpush.NotificationContent
import dev.djara.expounifiedpush.PushPayloadRenderer

/**
 * Renders NOTHING, for every push payload, always.
 *
 * GENERATED at prebuild by apps/mobile/plugins/silent-push-renderer.js. Do not edit here; the
 * android/ tree is build output and is regenerated on every prebuild.
 *
 * A wake is not a notification. Its whole job is to tell this app that something changed so it can
 * pull from /sync over its own authenticated connection, exactly as it does when opened by hand.
 * The payload is a closed fifteen-byte constant with nothing in it to display.
 *
 * Returning null unconditionally also removes a real attack surface rather than merely declining a
 * feature. The server a phone pairs with holds that device's push keys, so it — not the distributor,
 * which cannot decrypt anything — could otherwise send a payload carrying its own title, body,
 * image and a tap URL, and the connector's default renderer would draw it as a notification from
 * ohmail with an arbitrary ACTION_VIEW target. On a product whose point is that you can pair with
 * anybody's server, that is a phishing primitive. This class makes it unrepresentable.
 */
class ${CLASS} : PushPayloadRenderer {
  override fun render(context: Context, instance: String, decrypted: String): NotificationContent? = null
}
`;

/** @type {import('expo/config-plugins').ConfigPlugin} */
function withSilentPushRenderer(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const javaRoot = path.join(root, "app", "src", "main", "java");
      if (!fs.existsSync(javaRoot)) {
        throw new Error(
          `silent-push-renderer: ${javaRoot} does not exist, so the no-op renderer was NOT written. `
          + "Refusing rather than shipping an APK whose connector will render server-supplied "
          + "notification text and tap URLs. The Android template's source layout has changed; "
          + "point this plugin at the new one.",
        );
      }
      const dir = path.join(javaRoot, ...PACKAGE.split("."));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${CLASS}.kt`), SOURCE);
      return cfg;
    },
  ]);
}

module.exports = createRunOncePlugin(withSilentPushRenderer, "ohmail-silent-push-renderer", "1.0.0");
module.exports.FQCN = FQCN;
