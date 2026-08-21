import type { UnifiedPushDistributor, WakeRegistration } from "./push";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE DISTRIBUTOR CONNECTOR — the one file that talks to the native UnifiedPush module
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `push.ts` owns the SERVER half of the wake handshake and knows nothing about how an endpoint is
 * obtained. This is the other half: it asks the device for one. The split is deliberate and it is
 * what keeps `push.ts` testable without a native module — every test there hands it a
 * {@link UnifiedPushDistributor} double, and this is the real implementation of that port.
 *
 * ── ANDROID ONLY, AND SAID OUT LOUD RATHER THAN CRASHED ───────────────────────────────────────
 *
 * UnifiedPush is an Android ecosystem: it works by one app (the distributor) holding a connection
 * and handing messages to others, which iOS does not permit. `expo-unified-push` declares
 * `"platforms": ["android"]`, and its entry point calls `requireNativeModule("ExpoUnifiedPush")` at
 * MODULE SCOPE — so on iOS merely importing the package throws.
 *
 * Hence the lazy `require` in {@link native} rather than a top-level import: on iOS this module
 * loads, answers "no distributor", and the app shows the sentence it already had for a phone without
 * one. A top-level import would take the whole Settings screen down on every iPhone.
 *
 * There is deliberately no `Platform.OS` check in front of it. Two reasons, and the second is the
 * one that decided it: the throw is caught and CACHED, so a platform test would save one exception
 * for the life of the process; and importing `react-native` here would pull its Flow-typed source
 * into every test that touches this file, which the test runner cannot parse — measured, not
 * guessed. The try/catch is the platform check, and it is one the tests can actually execute.
 *
 * ── WHAT THE CONNECTOR'S API ACTUALLY LOOKS LIKE, BECAUSE IT IS NOT THE OBVIOUS SHAPE ─────────
 *
 * `registerDevice(vapid)` does NOT return the endpoint. It returns `Promise<void>` and the endpoint
 * arrives LATER, on an event: `subscribeDistributorMessages` fires with
 * `{ action: "registered", data: { url, pubKey, auth } }` once the distributor has minted one. So
 * this adapter bridges an event to a promise, with a timeout, because `registerWake` needs a value
 * it can send to a server.
 *
 * Two more things that are easy to get wrong and are handled here:
 *
 *  · `registerDevice` REJECTS unless `saveDistributor` was called first. Choosing a distributor is a
 *    user decision (there may be several installed), so {@link listDistributors} and
 *    {@link chooseDistributor} exist and Settings drives them. `available()` answers whether one has
 *    been chosen AND is installed — not whether any exist.
 *  · `registerDevice` REJECTS on an emulator, by design. Nothing to work around; it means a wake
 *    cannot be smoke-tested without a physical device, which is why the acceptance for this is a
 *    phone and is named as such.
 *
 * ── THE MESSAGE ARM IS WHERE THE WAKE BECOMES A SYNC ──────────────────────────────────────────
 *
 * A delivered wake surfaces as `{ action: "message", data: { message, decrypted } }`. The payload is
 * the fifteen-byte constant, so there is nothing to read out of it — {@link onWake} does not even
 * parse it beyond confirming it is the constant, and calls back so the caller can do the one thing a
 * wake means: pull from `/sync`. Deliberately NOT a notification: the payload carries no `id`, which
 * is what makes the connector's own renderer draw nothing, so a wake is silent by construction
 * rather than by us suppressing something.
 *
 * **This only runs while the app's process is alive.** The connector's service drops the event when
 * the JS bridge is not bound, so a wake to an app the user swiped away does nothing at all. That is
 * a real limitation, it is why the copy says "while ohmail is running", and closing it needs native
 * code that is not in this slice.
 */

/** The shape of the native module this file uses. Declared locally so nothing else imports it. */
interface NativeModule {
  getDistributors(): { id: string; name?: string; isInternal?: boolean; isSaved?: boolean }[];
  getSavedDistributor(): string | null;
  saveDistributor(id: string | null): void;
  registerDevice(vapid: string, instance?: string): Promise<void>;
  unregisterDevice(instance?: string): void;
}

interface NativeApi {
  module: NativeModule;
  subscribe(fn: (e: { action: string; data: Record<string, unknown> }) => void): () => void;
}

/**
 * Load the native module, or answer `null` on any platform or build that has none.
 *
 * Cached including the FAILURE, because `requireNativeModule` throwing is a permanent fact about
 * this binary rather than a transient error — retrying it on every Settings render would throw and
 * be caught dozens of times for an answer that cannot change.
 */
let cached: NativeApi | null | undefined;
function native(): NativeApi | null {
  if (cached !== undefined) return cached;
  cached = null;
  // Metro gives every module a `require`; a plain node/test context may not. Checking rather than
  // assuming is what makes the "no native module" branch the one every test executes, instead of a
  // ReferenceError dressed as a missing module.
  if (typeof require !== "function") return cached;
  try {
    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment */
    // A lazy require, for the reason in the header: on a platform without the native module this
    // import is a throw, and it must not be one that happens at module load.
    const mod = require("expo-unified-push") as {
      default: NativeModule;
      subscribeDistributorMessages: (
        fn: (e: { action: string; data: Record<string, unknown> }) => void,
      ) => () => void;
    };
    /* eslint-enable */
    cached = { module: mod.default, subscribe: mod.subscribeDistributorMessages };
  } catch {
    // No native module in this binary (iOS, or a JS-only test run). Not an error to report.
    cached = null;
  }
  return cached;
}

/** A distributor the user could choose. `internal` ones are refused — see {@link listDistributors}. */
export interface DistributorChoice {
  id: string;
  name: string;
  /** Already the saved choice. */
  saved: boolean;
}

/**
 * The distributors installed on this device, minus any INTERNAL one.
 *
 * ── THE FILTER IS NOT COSMETIC ────────────────────────────────────────────────────────────────
 *
 * `getDistributors()` includes an "internal" entry when the app itself embeds one — which for
 * `expo-unified-push` means its Firebase Cloud Messaging fallback. This build EXCLUDES that
 * artifact from the APK at the Gradle level (`plugins/without-embedded-fcm.js`), so there should be
 * no internal entry to filter. The filter is here anyway, and the reason is worth stating rather
 * than leaving as belt-and-braces: if the exclusion ever stops applying — a template change, a
 * dependency bump — the honest failure is "no distributor available", not "silently registered with
 * Google". One of those is a sentence the user reads; the other is the product's central claim
 * quietly becoming false.
 *
 * The build-level check is still the real guard; this is the runtime half that refuses to USE what
 * should not be there.
 */
export function listDistributors(): DistributorChoice[] {
  const api = native();
  if (!api) return [];
  let raw: ReturnType<NativeModule["getDistributors"]>;
  try {
    raw = api.module.getDistributors();
  } catch {
    return [];
  }
  const saved = savedDistributor();
  return (Array.isArray(raw) ? raw : [])
    .filter((d) => d && typeof d.id === "string" && d.isInternal !== true)
    .map((d) => ({ id: d.id, name: d.name && d.name !== "" ? d.name : d.id, saved: d.id === saved }));
}

/** The chosen distributor's id, or null. Reads the device, not our own state. */
export function savedDistributor(): string | null {
  const api = native();
  if (!api) return null;
  try {
    return api.module.getSavedDistributor();
  } catch {
    return null;
  }
}

/** Remember a choice. `null` forgets it, which also drops every registration with it. */
export function chooseDistributor(id: string | null): void {
  const api = native();
  if (!api) return;
  try {
    api.module.saveDistributor(id);
  } catch {
    /* the device refused to store the choice; `available()` will keep answering false */
  }
}

/** How long to wait for the distributor to mint an endpoint before giving up. */
const REGISTER_TIMEOUT_MS = 15_000;

/**
 * The real {@link UnifiedPushDistributor}.
 *
 * A factory rather than a module-level constant so that nothing is constructed at import time on a
 * platform where the native module cannot load — the `native()` call inside each method is what
 * decides, and it caches.
 *
 * The VAPID key is NOT held here; it arrives as an argument to `register`. See the port's own
 * docblock: the key belongs to whichever server profile is active, and a distributor object holding
 * one could outlive a switch to another.
 */
export function unifiedPushDistributor(): UnifiedPushDistributor {
  return {
    available(): boolean {
      const api = native();
      if (!api) return false;
      // A SAVED distributor, not merely an installed one: `registerDevice` rejects outright when
      // nothing has been chosen, so "available" has to mean "chosen", or the Settings pane would
      // offer a switch whose first use fails.
      const saved = savedDistributor();
      if (saved === null) return false;
      return listDistributors().some((d) => d.id === saved);
    },

    async register(vapidPublicKey: string): Promise<WakeRegistration | null> {
      const api = native();
      // An empty key would be handed to `registerDevice`, which rejects — answering `null` here
      // makes it the caller's "no registration" branch instead of an exception in a promise.
      if (!api || vapidPublicKey === "") return null;

      /**
       * EVENT TO PROMISE. The subscription goes on BEFORE `registerDevice` is called — the
       * distributor can answer fast enough to fire `registered` before an await resumes, and a
       * subscription set up afterwards would miss it and time out on a registration that worked.
       */
      return await new Promise<WakeRegistration | null>((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        const finish = (value: WakeRegistration | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            unsubscribe?.();
          } catch { /* nothing to do about a failed teardown */ }
          resolve(value);
        };
        const timer = setTimeout(() => { finish(null); }, REGISTER_TIMEOUT_MS);

        try {
          unsubscribe = api.subscribe((e) => {
            if (e.action === "registered") {
              const d = e.data as { url?: unknown; pubKey?: unknown; auth?: unknown };
              if (typeof d.url !== "string" || d.url === "") return finish(null);
              // The keys arrive together or not at all. Both present ⇒ the server can seal to this
              // device; either missing ⇒ send the endpoint alone and let the server use the
              // plaintext arm, which is what a distributor without the encrypted profile wants.
              const keys = typeof d.pubKey === "string" && d.pubKey !== ""
                && typeof d.auth === "string" && d.auth !== ""
                ? { p256dh: d.pubKey, auth: d.auth }
                : undefined;
              return finish(keys ? { endpoint: d.url, keys } : { endpoint: d.url });
            }
            if (e.action === "registrationFailed") return finish(null);
          });
        } catch {
          return finish(null);
        }

        // `registerDevice` rejects on an emulator and when no distributor is saved. Both are
        // "no registration", not errors to surface — the caller turns `null` into a sentence.
        api.module.registerDevice(vapidPublicKey).catch(() => { finish(null); });
      });
    },

    async unregister(): Promise<void> {
      const api = native();
      if (!api) return;
      try {
        api.module.unregisterDevice();
      } catch {
        /* best-effort by contract — see `forgetWake` */
      }
    },
  };
}

/**
 * Call `onWake` whenever a wake arrives while this process is alive.
 *
 * The payload is checked against the constant and then DISCARDED — there is nothing in it. The
 * check is not defensive parsing, it is a refusal to treat the body as data: if a future server
 * ever sent something else, this would ignore it rather than start acting on push-delivered
 * content, which is a property worth having on the client side of a channel that runs through a
 * third party.
 *
 * Returns an unsubscribe. Does nothing at all on a platform with no native module.
 */
export function onWake(onWakeReceived: () => void): () => void {
  const api = native();
  if (!api) return () => { /* nothing was subscribed */ };
  try {
    return api.subscribe((e) => {
      if (e.action !== "message") return;
      const d = e.data as { message?: unknown; decrypted?: unknown };
      // An UNDECRYPTED message means the server sent something this device's keys cannot open —
      // most likely a server with no VAPID keypair talking to a connector that requires one. There
      // is nothing to act on and nothing to show; a sync would be guessing.
      if (d.decrypted !== true || typeof d.message !== "string") return;
      if (d.message !== WAKE_PAYLOAD) return;
      onWakeReceived();
    });
  } catch {
    return () => { /* nothing was subscribed */ };
  }
}

/**
 * The payload a wake carries, byte for byte, as the server's own sender defines it.
 *
 * Duplicated here rather than imported because the server constant lives in a package this app does
 * not depend on, and a wrong value fails closed: an unrecognised payload is ignored, so the failure
 * mode of drift is "wakes stop working", never "the app acts on something unexpected". The absence
 * of an `id` key is the reason the connector renders no notification for it.
 */
export const WAKE_PAYLOAD = '{"type":"wake"}';
