import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyProvider, KekEnvIdentity } from "@trafficflow/core";
import { buildVersionOf, loadSettings, type Settings, type SettingsDoorInput } from "@ohmail/server/settings";

/**
 * THE FUNCTION DOOR'S SETTINGS: what this platform knows, handed to the one settings module
 * (`@ohmail/server/settings`), and the names this door's own modules and tests read.
 *
 * Nothing is read from `process.env` at module scope: {@link loadHostConfig} is a pure function of
 * an environment object and of one constant the build writes in ({@link functionDoor}, the
 * release), and {@link hostState} resolves it exactly once per cold instance. This
 * file and `deps.ts` are the only two that name the platform: its build id, its environment
 * label and its function limits reach the program from here, as inputs.
 */

export {
  PROD_SSE_LIFETIME_MS, PROD_SSE_POLL_MS, DEFAULT_SSE_ENABLED, DEFAULT_RP_ID, DEFAULT_ORIGINS,
  DEFAULT_COOKIE_HOSTS, PERMITTED_COOKIE_HOSTS, DEFAULT_APP_URL, APP_URL_ALLOWED_DOMAINS,
  assertCookieHosts, assertPooledUrl, assertAppUrl, appOriginOf, assertNoStaleStripeEnv,
  assertBootstrapInvites, publicSignupCap, assertNoAiProviderChoice, loadAnthropicKey,
  loadSseListenUrl, loadStaffDbConfig, loadAdminConfig,
  allowCookieAuthFor, allowCookieAuthForRequest, assertedHosts,
  type AdminHostConfig, type AdminLoad, type StaffDbConfig, type StaffDbLoad,
} from "@ohmail/server/settings";

/**
 * Whether this host holds an `/events` stream open. No: on Fluid compute an instance bills its whole
 * memory for every wall-clock second an invocation is in flight, parked on `await` or not, so a held
 * stream is the most expensive answer it can give. `TF_SSE=1` answers 204 and clients poll `/sync`.
 */
export const MANAGED_SSE_HOLDS = false;

/** `maxDuration` of `app/events/route.ts`, in seconds. Named here so the settings can respect it. */
export const EVENTS_MAX_DURATION_S = 300;
/**
 * The most a configured `/events` lifetime may be: the route's duration minus a margin for the
 * close. The server must end the stream, not the platform: a platform kill is a dropped socket the
 * client reads as an error, a clean close is an ordinary reconnect.
 */
export const MAX_SSE_LIFETIME_MS = (EVENTS_MAX_DURATION_S - 10) * 1_000;

/**
 * A `BUILD_VERSION` file at this app's project root, written into the
 * deployed tree at deploy time (as `apps/worker/src/build-version.ts` reads
 * the worker's). `process.cwd()`, not `__dirname` and not `import.meta.url`:
 * this package is CommonJS, so `tsc -b tsconfig.check.json` refuses
 * `import.meta` (TS1470), and `__dirname` inside a webpack chunk is the
 * chunk's own directory, not this source file's. `process.cwd()` is the
 * platform's documented pattern; this app's Vercel Root Directory is
 * `apps/api-vercel`, the directory the deploy step writes the file into.
 */
const buildVersionFile = (): string => {
  try {
    return readFileSync(join(process.cwd(), "BUILD_VERSION"), "utf8").trim();
  } catch {
    return "";
  }
};

/**
 * What this door hands the settings. The platform's own variables are read HERE and reach the
 * program as plain inputs: `VERCEL_GIT_COMMIT_SHA` is its id for the build (it cannot disagree with
 * what runs; absent on a `git archive` deploy) and `VERCEL_ENV` its label for the deployment (`""`
 * when the platform gave none, which a local run is).
 *
 * The release is the build's, not the environment's: `next.config.mjs` has the build replace the
 * expression `process.env.OHMAIL_RELEASE` with the root manifest's version, and no deployment's
 * environment holds that name. So it is written out whole here and never read off `env`, which the
 * build would leave alone. Absent only where no build ran (a test); `/hello` then answers `0.0.0`.
 */
export function functionDoor(env: NodeJS.ProcessEnv): SettingsDoorInput {
  return {
    door: "function",
    buildVersionFile,
    platformBuildId: env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
    release: process.env.OHMAIL_RELEASE ?? null,
    environmentFallback: (env.VERCEL_ENV ?? "").trim(),
    sseHolds: MANAGED_SSE_HOLDS,
    sseLifetimeMaxMs: MAX_SSE_LIFETIME_MS,
  };
}

/**
 * The settings under the flat names this door's tests read. `settings` is what the program is
 * built from; the other members are views of it.
 */
export interface HostConfig {
  settings: Settings;
  keyProvider: KeyProvider;
  kek: KekEnvIdentity | null;
  kekError: string | null;
  kekRetiredThrough: number;
  connectReminder: "log" | "send";
  connectReminderSince: string | null;
  connectAttempts: "off" | "record";
  version: string;
  environment: string;
}

export type HostState =
  | { ok: true; cfg: HostConfig }
  | { ok: false; error: string; version: string };

/** Build the host configuration from an environment, or throw naming the variable at fault. */
export function loadHostConfig(env: NodeJS.ProcessEnv): HostConfig {
  const settings = loadSettings(env, functionDoor(env));
  return {
    settings,
    keyProvider: settings.keyRing.provider,
    kek: settings.keyRing.identity,
    kekError: settings.keyRing.error,
    kekRetiredThrough: settings.keyRing.retiredThrough,
    connectReminder: settings.lifecycle.connectReminder,
    connectReminderSince: settings.lifecycle.connectReminderSince,
    connectAttempts: settings.lifecycle.connectAttempts,
    version: settings.build.version,
    environment: settings.environment,
  };
}

/** {@link loadHostConfig} with its throw captured, so the request path can answer 503. */
export function loadHostState(env: NodeJS.ProcessEnv): HostState {
  try {
    return { ok: true, cfg: loadHostConfig(env) };
  } catch (err) {
    return {
      ok: false, error: err instanceof Error ? err.message : String(err),
      version: buildVersionOf(env, functionDoor(env)),
    };
  }
}

// ── one resolved state per cold instance ──────────────────────────────────────
let cached: HostState | null = null;

/** The host state for this instance, resolved once and reused by every warm request. */
export function hostState(env: NodeJS.ProcessEnv = process.env): HostState {
  if (!cached) cached = loadHostState(env);
  return cached;
}

/** Test seam: forget the cached state so a test can load a different environment. */
export function resetHostState(): void {
  cached = null;
}
