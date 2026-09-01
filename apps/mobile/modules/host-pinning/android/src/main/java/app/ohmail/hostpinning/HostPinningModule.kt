package app.ohmail.hostpinning

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PINNING MODULE — installs the trust decision, and lets the pairing seam record pins
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The JS side (`src/net/host-pinning.ts`) records a pin the moment a pairing link is read and
 * before the first request to that host, and drops it when the pairing is forgotten. This module
 * is that surface, plus the one-time installation that makes it take effect.
 *
 * ── WHY THE FACTORY IS INSTALLED IN `OnCreate`, AND WHAT WOULD BREAK LATER ──────────────────
 *
 * `OkHttpClientProvider` caches the client it built (`internal var client`) and
 * `setOkHttpClientFactory` does not clear it — by design, and not reachable from outside React
 * Native's own compilation unit. So the factory has to be in place before ANYTHING asks for a
 * client. A module's `OnCreate` runs while the module registry is built, which is part of
 * creating the React context and therefore strictly before the JS bundle evaluates, let alone
 * makes a request. That ordering is the whole reason this is a module lifecycle hook and not
 * something the JS calls on first use.
 *
 * The failure mode of getting the ORDERING wrong is at least safe: a client built before the
 * factory carries the PLATFORM trust manager, so a paired-desktop request fails its handshake
 * rather than succeeding unpinned.
 *
 * **Safe is not the same as legible, and that distinction was learned the expensive way** — see
 * `installed` below. A handshake that fails because the pinning is missing is indistinguishable,
 * from JS, from a handshake that fails because somebody swapped the key; and this app has a
 * sentence for the second one that must never be shown for the first.
 *
 * ── THE FUNCTIONS ARE SYNCHRONOUS, DELIBERATELY ─────────────────────────────────────────────
 *
 * `Function` rather than `AsyncFunction`: recording a pin is a map write, and the caller needs it
 * to have happened before it issues the request the pin protects. An async surface would make
 * "pinned before the first byte" a thing the caller has to remember to await, which is the shape
 * of a defect that only appears under load.
 */
class HostPinningModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OhmailHostPinning")

    // A SECOND CHANCE, NOT THE PRIMARY ONE. `MainApplication.onCreate` installs first (the
    // `host-pinning-install` config plugin), because a module lifecycle hook is too late — see
    // `PinnedHosts.installInto`. This call is idempotent and exists so a composition that loses
    // the plugin still pins rather than silently not pinning.
    OnCreate { PinnedHosts.installInto(appContext.reactContext?.applicationContext) }

    /**
     * Did the trust decision get installed into the networking stack? The pairing seam refuses
     * to pin — and therefore refuses a same-network pairing — when this is false, rather than
     * recording a pin nothing will honour.
     */
    Function("isInstalled") { PinnedHosts.installed }

    /**
     * How many clients the pinning factory has actually built. Zero with `isInstalled` true is
     * the state that cost a field run: the decision existed and React Native's networking never
     * asked for it. Exposed so that condition is a number rather than a guess.
     */
    Function("factoryUses") { PinnedHosts.factoryUses }

    /**
     * Record the key this phone will accept for one host and port. Idempotent, and a second call
     * for the same host REPLACES the pin — which is what a re-pair means, and the only way a
     * changed desktop key is ever accepted.
     */
    Function("setPin") { host: String, port: Int, spki: String ->
      PinnedHosts.set(host, port, spki)
      PinnedHosts.count()
    }

    Function("clearPin") { host: String, port: Int ->
      PinnedHosts.clear(host, port)
      PinnedHosts.count()
    }

    Function("clearAllPins") {
      PinnedHosts.clearAll()
      PinnedHosts.count()
    }

    /** How many pins are held. The JS census reads it to prove a forget really dropped one. */
    Function("pinnedCount") { PinnedHosts.count() }
  }
}
