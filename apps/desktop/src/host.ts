/**
 * HOST MODE, from the window's side of it.
 *
 * The shell can publish this install's mail engine to the user's OWN tailnet — a listener on
 * `127.0.0.1` that Tailscale serves as `https://<machine>.<tailnet>.ts.net`, reachable only from
 * the user's other devices, mail never touching anyone's servers. Everything about that lives in
 * the shell (`src-tauri/src/host.rs`): the setting, the `tailscale` invocations (serve, never
 * funnel — pinned by its tests), the tray, start-at-login. This file is the whole of what the
 * window may say about it, over the same runtime global `native.ts` uses and for the same
 * reasons.
 *
 * ── EVERY ANSWER IS A CLOSED UNION, PARSED AND NEVER CAST ───────────────────────────────────
 *
 * The payloads cross a process boundary, and a shell one version ahead of this bundle can name a
 * state this bundle has never heard of. The rule is `native.ts`'s: refuse what is not
 * recognised. One deliberate asymmetry — an unknown PROBLEM inside an otherwise readable state
 * degrades to `null` (the screens show their generic guidance) rather than discarding the whole
 * answer, because "host mode is degraded for a reason this build cannot name" is still the truth
 * and strictly more useful than pretending the shell said nothing.
 */

/** The tri-state the tray and the screens render. */
export type HostTriState = "serving" | "degraded" | "off";

const TRI_STATES = ["serving", "degraded", "off"] as const;

/**
 * Why host mode is off or degraded — the shell's closed vocabulary, mirrored. Typed guided
 * states, never stderr: the shell logs the raw words and hands the window only these names.
 */
export type HostProblem = (typeof HOST_PROBLEMS)[number];

export const HOST_PROBLEMS = [
  // The tailnet's side: install it, start it, sign in, turn MagicDNS on.
  "no-cli",
  "not-running",
  "not-logged-in",
  "no-dns-name",
  // Installed, running, and `tailscale serve` still said no — its own guided state, because the
  // fix ("serve may be disabled on this tailnet") differs from every state above.
  "serve-refused",
  // This install's side.
  "local-door-required",
  "engine-not-serving",
  "listener-pending",
  "listener-skipped",
  "listener-failed",
  "host-config-invalid",
] as const;

/**
 * The same-network half's own state — the engine's LAN door as the shell reads it off the
 * engine's `host_lan_*` signals. `null` on the wire means "no LAN address is chosen".
 *
 * `blocked` is bound-but-unreachable: the door holds its socket and this computer's own firewall
 * is not admitting the port. It is a distinct state from `failed` on purpose — nothing about the
 * app went wrong, and the fix is one command the operator runs, not a retry.
 */
export type LanState = (typeof LAN_STATES)[number];

export const LAN_STATES = ["serving", "blocked", "pending", "failed", "invalid"] as const;

/** Host mode as the shell reports it. */
export interface HostState {
  /** Armed — the user turned it on and this install is on the local door. */
  enabled: boolean;
  /** The loopback port the engine's host door binds. */
  port: number | null;
  /** The served origin, `https://<machine>.<tailnet>.ts.net`, when one was derived. */
  origin: string | null;
  /** The chosen same-network address, or null when the LAN option is off. */
  lan: string | null;
  /** The LAN door's live state; null when no LAN address is chosen or host mode is off. */
  lanState: LanState | null;
  state: HostTriState;
  problem: HostProblem | null;
  /** Whether this install starts at login; null when the platform would not say. */
  autostart: boolean | null;
}

/** The tailnet as `tailscale_status` reports it. */
export type TailscaleStatus =
  | { state: "running"; dnsName: string; version: string }
  | { state: "no-cli" | "not-running" | "not-logged-in" | "no-dns-name" };

/** The commands the shell registers for this file. Named once so a typo is one place. */
const HOST_STATE_COMMAND = "host_state";
const TAILSCALE_STATUS_COMMAND = "tailscale_status";
const ARM_COMMAND = "tailscale_serve_arm";
const DISARM_COMMAND = "tailscale_serve_disarm";
const AUTOSTART_GET_COMMAND = "autostart_get";
const AUTOSTART_SET_COMMAND = "autostart_set";
const OPEN_DOWNLOAD_COMMAND = "open_tailscale_download";

interface TauriInternals {
  invoke(command: string, payload?: Record<string, unknown>, options?: unknown): Promise<unknown>;
}

function internals(): TauriInternals | null {
  const host = globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> };
  const found = host.__TAURI_INTERNALS__;
  if (typeof found?.invoke !== "function") return null;
  return found as TauriInternals;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** A port as the shell reports one, or null. Refuses everything a port is not. */
function portOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : null;
}

/**
 * The host state a payload carries, or null when it is not one. Null is "this window does not
 * know what the shell said", and the caller renders its not-available state.
 */
export function hostStateOfPayload(payload: unknown): HostState | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = payload as Record<string, unknown>;
  const state = oneOf(raw.state, TRI_STATES);
  if (state === null || typeof raw.enabled !== "boolean") return null;
  return {
    enabled: raw.enabled,
    port: portOf(raw.port),
    origin: typeof raw.origin === "string" && raw.origin.length > 0 ? raw.origin : null,
    lan: typeof raw.lan === "string" && raw.lan.length > 0 ? raw.lan : null,
    // The same asymmetry as `problem`: an unknown LAN state name degrades to null (the row
    // renders its generic line) rather than voiding the whole answer.
    lanState: oneOf(raw.lanState, LAN_STATES),
    state,
    // The deliberate asymmetry — see the header: an unknown problem name degrades to null
    // rather than voiding the answer.
    problem: oneOf(raw.problem, HOST_PROBLEMS),
    autostart: typeof raw.autostart === "boolean" ? raw.autostart : null,
  };
}

/** The tailscale status a payload carries, or null when it is not one. */
export function tailscaleStatusOfPayload(payload: unknown): TailscaleStatus | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = payload as Record<string, unknown>;
  if (raw.state === "running") {
    if (typeof raw.dnsName !== "string" || raw.dnsName.length === 0) return null;
    return {
      state: "running",
      dnsName: raw.dnsName,
      version: typeof raw.version === "string" ? raw.version : "",
    };
  }
  const guided = oneOf(raw.state, ["no-cli", "not-running", "not-logged-in", "no-dns-name"] as const);
  return guided === null ? null : { state: guided };
}

/** Host mode as it stands. Null without a shell — this bundle also loads outside the app. */
export async function hostState(): Promise<HostState | null> {
  const shell = internals();
  if (!shell) return null;
  return hostStateOfPayload(await shell.invoke(HOST_STATE_COMMAND));
}

/** The tailnet as it stands — the detect-and-guide screen's probe. */
export async function tailscaleStatus(): Promise<TailscaleStatus | null> {
  const shell = internals();
  if (!shell) return null;
  return tailscaleStatusOfPayload(await shell.invoke(TAILSCALE_STATUS_COMMAND));
}

/**
 * Arm host mode on `port`, with the enable ceremony's start-at-login choice and — when the
 * operator picked one — the same-network interface address. The shell probes the tailnet
 * first; WITHOUT a LAN choice a probe refusal changes nothing and answers with the CURRENT
 * state plus this attempt's `problem`, exactly as before. WITH one, the refusal no longer
 * refuses: the shell arms the LAN-only spawn (the no-Tailscale path), publishes nothing, and
 * answers armed + degraded with the tailnet problem beside a live `lanState`. The safe order
 * stands either way: setting persisted, engine respawned, the tailnet route published LAST and
 * only once the engine's own listener holds the loopback port.
 *
 * The port is checked HERE as well as in the shell, because 1–65535 is the contract and a caller
 * passing 0 is a bug worth an exception rather than a guided state.
 */
export async function armHostMode(
  port: number,
  autostart: boolean,
  lan?: string | null,
): Promise<HostState | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("host mode needs a fixed port between 1 and 65535");
  }
  const shell = internals();
  if (!shell) return null;
  return hostStateOfPayload(
    await shell.invoke(ARM_COMMAND, { port, autostart, lan: lan ?? null }),
  );
}

/** Disarm host mode. The registration is withdrawn, start-at-login removed, the setting kept
 * (disabled, port remembered) so re-arming offers the same port back. */
export async function disarmHostMode(): Promise<HostState | null> {
  const shell = internals();
  if (!shell) return null;
  return hostStateOfPayload(await shell.invoke(DISARM_COMMAND));
}

/** Whether this install starts at login. Null without a shell. */
export async function getAutostart(): Promise<boolean | null> {
  const shell = internals();
  if (!shell) return null;
  const answer = await shell.invoke(AUTOSTART_GET_COMMAND);
  return typeof answer === "boolean" ? answer : null;
}

/**
 * Set start-at-login. Returns the state as the platform then reports it.
 *
 * Enabling REQUIRES host mode armed — the shell rejects it otherwise, because start-at-login
 * exists only in service of the always-on role and a disarmed install must never gain a login
 * registration. Disabling is unconditional.
 */
export async function setAutostart(enabled: boolean): Promise<boolean | null> {
  const shell = internals();
  if (!shell) return null;
  const answer = await shell.invoke(AUTOSTART_SET_COMMAND, { enabled });
  return typeof answer === "boolean" ? answer : null;
}

/**
 * Open Tailscale's download page in the user's own browser — the way out of `no-cli`. The
 * address is a constant in the SHELL; this window names an intent and never a URL, the same rule
 * `openWeb` keeps.
 */
export async function openTailscaleDownload(): Promise<void> {
  const shell = internals();
  if (!shell) return;
  await shell.invoke(OPEN_DOWNLOAD_COMMAND);
}
