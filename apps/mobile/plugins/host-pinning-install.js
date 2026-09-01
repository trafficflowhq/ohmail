const { withMainApplication, createRunOncePlugin } = require("expo/config-plugins");

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  INSTALL THE TLS PINNING BEFORE REACT NATIVE STARTS — the ordering is the whole feature
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `modules/host-pinning` decides which certificates this app accepts for a desktop on the local
 * network. It does that by giving React Native's networking an `OkHttpClientFactory` that builds
 * clients with a pinning trust manager. This plugin is the line that installs it, in
 * `MainApplication.onCreate`.
 *
 * ── WHY NOT THE MODULE'S OWN LIFECYCLE HOOK, WHICH IS WHERE IT STARTED ────────────────────────
 *
 * `OkHttpClientProvider` caches the client it built, and `setOkHttpClientFactory` does not clear
 * that cache — deliberately, and the field is `internal` to React Native so nothing outside can.
 * So the factory has to be in place before ANYTHING asks for a client.
 *
 * The module's `OnCreate` is not early enough. That is measured, not predicted: a release build
 * whose factory was set from `OnCreate` never had it consulted once — the networking module's
 * client already existed — and every pairing with a real desktop door failed its handshake in the
 * ordinary way. Which is SAFE (an unverified certificate is refused, not accepted) and completely
 * illegible: the app reported the desktop's identity as changed, which is the sentence that means
 * somebody is impersonating your computer.
 *
 * `MainApplication.onCreate` runs before React Native is created at all, so there is no client to
 * be too late for. The module still calls `installInto` from its own hook; that path is idempotent
 * and exists so a build that somehow lost this plugin pins late rather than not at all.
 *
 * ── AND IT FAILS LOUD ────────────────────────────────────────────────────────────────────────
 *
 * If Expo's template ever changes shape enough that the anchor below is not found, this throws
 * rather than applying nothing. A plugin that silently no-ops here produces an app that cannot
 * pair on the local network and says the wrong reason — the exact failure this file exists to fix,
 * reintroduced by a template bump nobody would connect to it.
 */

/** The marker that makes this idempotent AND greppable in the generated project. */
const MARKER = "// ohmail: TLS pinning is installed before React Native starts";

const CALL = `    ${MARKER} — see plugins/host-pinning-install.js
    app.ohmail.hostpinning.PinnedHosts.installInto(this)`;

const withHostPinningInstall = (config) =>
  withMainApplication(config, (cfg) => {
    const file = cfg.modResults;
    if (file.language !== "kt") {
      throw new Error(
        "host-pinning-install: MainApplication is not Kotlin any more. The install call must be " +
          "placed by hand in whatever language it is, or same-network pairing silently stops " +
          "working and reports the wrong reason.",
      );
    }
    if (file.contents.includes(MARKER)) return cfg;

    // Anchored on `super.onCreate()` inside MainApplication's own onCreate. Placed AFTER it,
    // because SoLoader and the app context are set up there and the factory install needs
    // neither — but a call before `super` is the kind of thing that works until it does not.
    const anchor = /(override fun onCreate\(\) \{\s*\n\s*super\.onCreate\(\)\n)/;
    if (!anchor.test(file.contents)) {
      throw new Error(
        "host-pinning-install: could not find `override fun onCreate() { super.onCreate()` in " +
          "MainApplication.kt. Expo's template changed shape; place the installInto call by hand " +
          "rather than shipping an app whose pinning never installs.",
      );
    }
    file.contents = file.contents.replace(anchor, `$1${CALL}\n`);
    return cfg;
  });

module.exports = createRunOncePlugin(withHostPinningInstall, "ohmail-host-pinning-install", "1.0.0");
