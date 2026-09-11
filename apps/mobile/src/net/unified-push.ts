import { Platform } from "react-native";
import type { UnifiedPushDistributor, WakeRegistration } from "./push";

/**
 * The distributor connector — the one file that talks to the native UnifiedPush module;
 * `push.ts` owns the server half and its tests use a {@link UnifiedPushDistributor} double.
 * Android only, said rather than crashed: `expo-unified-push` calls `requireNativeModule` at
 * module scope, so importing it on iOS throws — and the try/catch is NOT the platform check
 * (Metro's `require` hands a module-init throw to `ErrorUtils.reportFatalError` without
 * re-throwing), so the platform test comes before the require, in {@link native}.
 * `registerDevice(vapid)` returns void; the endpoint arrives later on an event, bridged here
 * to a promise with a timeout. The payload is the fifteen-byte constant; wakes arrive only while the process is alive.
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
  /**
   * Ask the OS for the notification permission the killed-app wake notice needs. Present only on a
   * build with the native module; the connector answers `"denied"` on an emulator by design.
   */
  requestPermissions?: () => Promise<string>;
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
  // UnifiedPush is an Android ecosystem, and `expo-unified-push` is correctly absent from Apple
  // autolinking — so on iOS the require below is a module-init throw that metro turns into a fatal
  // error before this function's `catch` can see it (see the header). Answering "no native module"
  // here is the same answer the catch was meant to give, arrived at without throwing.
  if (Platform.OS !== "android") return cached;
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
      requestPermissions?: () => Promise<string>;
    };
    /* eslint-enable */
    cached = {
      module: mod.default,
      subscribe: mod.subscribeDistributorMessages,
      requestPermissions: mod.requestPermissions,
    };
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
 * The distributors installed on this device, minus any internal one. `getDistributors()`
 * includes an "internal" entry when the app embeds one — for `expo-unified-push`, its
 * Firebase Cloud Messaging fallback. This build excludes that artifact at the Gradle level
 * (`plugins/without-embedded-fcm.js`), so there should be none to filter; the filter stays
 * because if the exclusion ever stops applying, the honest failure is "no distributor
 * available", not "silently registered with Google" — one is a sentence the user reads, the
 * other is the product's central claim quietly becoming false. The build-level check is the
 * real guard; this is the runtime half that refuses to use what should not be there.
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
 * The real {@link UnifiedPushDistributor}. A factory rather than a module-level constant so
 * nothing is constructed at import time on a platform where the native module cannot load —
 * the `native()` call inside each method decides, and caches. The VAPID key is not held here;
 * it arrives as an argument to `register`: the key belongs to whichever server profile is
 * active, and a distributor object holding one could outlive a switch to another.
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

    async register(vapidPublicKey: string, instance: string): Promise<WakeRegistration | null> {
      const api = native();
      // An empty key would be handed to `registerDevice`, which rejects — answering `null` here
      // makes it the caller's "no registration" branch instead of an exception in a promise.
      if (!api || vapidPublicKey === "" || instance === "") return null;
      dropLegacyDefaultRegistration(api);

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
            /**
             * ── EVERY EVENT NAMES ITS INSTANCE, AND THIS PROMISE ANSWERS FOR ONE ─────────────
             *
             * The subscription is process-wide: it sees the events of every instance this app has
             * registered. Without this line a second profile's `registered` — or its FAILURE —
             * would settle this promise, and the endpoint that reached the server would be the
             * wrong pairing's. That is not hypothetical: `wake.tsx` serializes its mutations
             * precisely because two registrations can be in the air across a profile switch.
             */
            const named = (e.data as { instance?: unknown }).instance;
            if (typeof named === "string" && named !== instance) return;
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
        api.module.registerDevice(vapidPublicKey, instance).catch(() => { finish(null); });
      });
    },

    async unregister(instance: string): Promise<void> {
      const api = native();
      if (!api || instance === "") return;
      try {
        api.module.unregisterDevice(instance);
      } catch {
        /* best-effort by contract — see `forgetWake` */
      }
    },
  };
}

/**
 * Call `onWakeReceived` whenever a wake for `instance` arrives while this process is alive.
 * The payload is checked against the constant and discarded — not defensive parsing, a
 * refusal to treat the body as data: if a server ever sent something else, this ignores it
 * rather than acting on push-delivered content. The wake is scoped: with one endpoint per
 * pairing a wake names a pairing, and a wake for the profile not on screen must not start a
 * drain on the one that is — any other instance is dropped here. A payload with no instance
 * is still honoured: an install upgrading from the shared-endpoint build can have a legacy
 * wake in flight. Returns an unsubscribe; does nothing with no native module.
 */
export function onWake(instance: string, onWakeReceived: () => void): () => void {
  const api = native();
  if (!api) return () => { /* nothing was subscribed */ };
  try {
    return api.subscribe((e) => {
      if (e.action !== "message") return;
      const d = e.data as { message?: unknown; decrypted?: unknown; instance?: unknown };
      if (typeof d.instance === "string" && d.instance !== "" && d.instance !== instance) return;
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
 * The upgrade this change owes: drop the shared registration, once. A phone on the previous
 * build holds a registration under the connector's default instance, and every paired server
 * stores a row against that one endpoint; per-profile registration mints new endpoints and
 * would leave the old rows pointing at an endpoint this phone still answers — permanent, and
 * nothing left on the phone can name them. So the default instance is unregistered the first
 * time this build registers anything: the phone stops answering the old endpoint and every
 * server prunes its stale row on the first delivery attempt (the documented prune path). Once
 * per process, no persisted flag: `unregisterDevice()` on a missing instance is a no-op.
 */
let legacyDropped = false;
function dropLegacyDefaultRegistration(api: NativeApi): void {
  if (legacyDropped) return;
  legacyDropped = true;
  try {
    api.module.unregisterDevice();
  } catch {
    /* best-effort: a connector that refuses leaves the stale rows to age out server-side */
  }
}

/** Tests only — the once-per-process latch above is module state. */
export function resetLegacyDropForTests(): void {
  legacyDropped = false;
}

/**
 * Ask the OS for the notification permission the killed-app wake notice needs. On Android 13+
 * `POST_NOTIFICATIONS` starts denied and the native renderer's `notify` is dropped without
 * it, so a wake to a closed app would render nothing. Requested at the moment the user opts
 * into wakes (choosing a distributor) — the one place an Activity is in the foreground to
 * show the prompt. Best-effort and swallowing by contract: a denial is a supported outcome
 * (the copy says so, and mail still syncs on open), so this never throws and never surfaces a
 * result; it does nothing with no native module, and answers "denied" on an emulator by design.
 */
export async function requestNotificationPermission(): Promise<void> {
  const api = native();
  if (!api || !api.requestPermissions) return;
  try {
    await api.requestPermissions();
  } catch {
    /* the OS refused to even ask; the copy already tells the user what happens without it */
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
