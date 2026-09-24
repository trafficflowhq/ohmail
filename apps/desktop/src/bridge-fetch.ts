/**
 * THE BRIDGE: the client engine's `fetch`, pointed at the local mail engine. The window
 * renders the same client app.ohmail.app renders, and that app talks through one function —
 * `HttpAdapterOptions.fetch`. Here it opens no socket: the request goes to the shell over
 * Tauri's command channel, the shell writes it as a frame down the engine's stdin, and the
 * answer returns the same way — nothing listens on a port, in either process. A localhost
 * port would be reachable by every program on the machine and need a token the page can read;
 * the pipe is a private file descriptor, the credential is added shell-side
 * (`encode_request`), and the UNMODIFIED Cloud client authenticates with nothing.
 */

/*
 * The wire is the shell's: `engine_request(method, url, headers, body)` answers one byte
 * string — [4 bytes BE: metadata length][metadata JSON][body bytes], metadata
 * `{ status, statusText, h: [[name, value], …] }`. Bytes rather than JSON because a mail body
 * is not a JSON string: re-encoding costs a copy and a UTF-8 assumption attachments break.
 * The window still cannot address anything else: CSP `connect-src 'none'`, `offline-guard.ts`
 * replaces every leaving API, and the shell grants exactly two commands. A forgotten wire is
 * loud — `HttpAdapter` falls back to global `fetch`, which the guard replaced with a thrower.
 */

import { HttpAdapter, OhmailEngine, retryingRead, type WindowSyncFailure } from "@ohmail/client-engine";
import { DESKTOP_WINDOW } from "../../webapp/app/shell/store-windows.js";

/**
 * The shape `HttpAdapterOptions.fetch` is satisfied by.
 *
 * `init` is `unknown` rather than `RequestInit` ON PURPOSE, and it is not laziness. This file is
 * published beside two different declarations of that option — the real adapter's, which types the
 * second parameter as `RequestInit`, and the stub the preview build compiles against, which types
 * it as `unknown`. A function that accepts `unknown` satisfies both; one that accepts `RequestInit`
 * satisfies only the first, and the other tree fails to compile. The narrowing happens below,
 * where the fields are actually read.
 */
export type BridgeFetch = (url: string, init?: unknown) => Promise<Response>;

/** The commands the shell registers. Named here so a typo is one place rather than three. */
const REQUEST_COMMAND = "engine_request";
const STATUS_COMMAND = "engine_status";
const CONFIGURE_COMMAND = "engine_configure";
const LOGOUT_COMMAND = "engine_logout";
const UNLOCK_COMMAND = "engine_unlock_retry";

const NO_SHELL =
  "ohmail Desktop: this window is not running inside the ohmail shell, so there is no local engine " +
  "to talk to.";

/**
 * The statuses the Fetch standard forbids a body on.
 *
 * `new Response(bytes, { status: 204 })` throws — even for zero bytes, because an empty
 * `Uint8Array` is still a body. The engine answers 204 to several mutations, so without this the
 * bridge would turn every successful delete into a transport failure.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * WHAT THE ACCOUNT DOOR SAYS ABOUT THIS ACCOUNT — the read, and the refusal.
 *
 * The path lives here rather than beside either of its two callers because both name it and two
 * spellings of one route drift: the Subscription pane re-exports this, and the suggest transport
 * asks it to take a stale refusal down. It is already in the relay's allowlist, so nothing about
 * the route or the bridge command changes.
 */
export const ACCOUNT_ACCESS_PATH = "/account/access";

/** What the entitlements lock answers, and the one code that means this account, not this request. */
export const ACCESS_REFUSED_STATUS = 402;
export const ACCESS_REFUSED_CODE = "subscription_required";

/**
 * WHERE THE ACCOUNT STANDS WITH THE SERVICE, as the API's own gate states it.
 *
 * A MIRROR of `apps/webapp/app/api-client.ts`'s type of the same name, not an import: this build
 * aliases that module to a refusing stub, and a window cannot import the door it does not have.
 * The field list is the 402's `details`, and the two copies drift only if somebody edits one.
 */
export interface AccountLifecycle {
  state: "trialing" | "grace" | "past_due" | "active" | "closed" | "erased";
  closedReason: null | "trial_ended" | "canceled" | "unpaid" | "suspended";
  closedAt?: string | null;
  erasureAt?: string | null;
}

/** The states this window knows. An unknown one is dropped — see {@link lifecycleOf}. */
const LIFECYCLE_STATES = [
  "trialing", "grace", "past_due", "active", "closed", "erased",
] as const;

const CLOSED_REASONS = ["trial_ended", "canceled", "unpaid", "suspended"] as const;

const isoOrNull = (v: unknown): string | null =>
  (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Narrow a lifecycle block, or answer `undefined` — which is both "an older server said nothing"
 * and "this build does not know that word". Both land in the same place: the screen says the
 * undated thing it has always said rather than a date it made up.
 */
export function lifecycleOf(value: unknown): AccountLifecycle | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const state = raw.state;
  if (typeof state !== "string") return undefined;
  if (!(LIFECYCLE_STATES as readonly string[]).includes(state)) return undefined;
  const reason = raw.closedReason;
  return {
    state: state as AccountLifecycle["state"],
    closedReason:
      typeof reason === "string" && (CLOSED_REASONS as readonly string[]).includes(reason)
        ? (reason as AccountLifecycle["closedReason"])
        : null,
    closedAt: isoOrNull(raw.closedAt),
    erasureAt: isoOrNull(raw.erasureAt),
  };
}

/** Why access was refused, and where the customer can put it right. The API's words, narrowed. */
export interface AccessRefusedFacts {
  reason: "payment_required" | "suspended";
  manageUrl?: string;
  /** What happened and when. Absent from a server that predates the wall — see {@link lifecycleOf}. */
  lifecycle?: AccountLifecycle;
}

type AccessRefusedSink = (facts: AccessRefusedFacts) => void;
let accessRefusedSink: AccessRefusedSink | null = null;

/**
 * THE ACCESS REFUSAL, RAISED ONCE FOR THE WHOLE WINDOW — the browser tab's rule, on this door.
 *
 * Every hosted door may answer `402 subscription_required`, so handling it where it lands means
 * meeting the refusal one failed write at a time, each pane saying its own thing. The gate
 * subscribes instead and swaps the surface for one screen. LAST WRITER WINS: there is one gate
 * per window, and two subscribers would be two surfaces disagreeing about one account. A
 * notifier, not a throw — the `Response` is returned unchanged, so nothing that already handles
 * a refusal changes behaviour.
 */
export function onAccessRefused(sink: AccessRefusedSink): () => void {
  accessRefusedSink = sink;
  return () => { if (accessRefusedSink === sink) accessRefusedSink = null; };
}

/**
 * Narrow the envelope's `details` and tell the gate. An unrecognised reason is `payment_required`
 * — the arm whose remedy is a link the customer can act on, rather than one reading as our fault.
 * The body is decoded ONLY on the refusal status, so no ordinary answer pays for this.
 */
function noticeAccessRefusal(status: number, body: Uint8Array): void {
  const sink = accessRefusedSink;
  if (sink === null || status !== ACCESS_REFUSED_STATUS) return;
  let env: { code?: unknown; details?: unknown } | undefined;
  try {
    env = (JSON.parse(new TextDecoder().decode(body)) as { error?: typeof env })?.error;
  } catch {
    return; /* Not JSON. A 402 this client cannot read is not one it may act on. */
  }
  if (env?.code !== ACCESS_REFUSED_CODE) return;
  const d = (env.details ?? {}) as { reason?: unknown; manageUrl?: unknown; lifecycle?: unknown };
  const url = typeof d.manageUrl === "string" && d.manageUrl.length > 0 ? d.manageUrl : undefined;
  const lifecycle = lifecycleOf(d.lifecycle);
  try {
    sink({
      reason: d.reason === "suspended" ? "suspended" : "payment_required",
      ...(url ? { manageUrl: url } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    });
  } catch { /* A sink that throws must not replace the refusal with its own failure. */ }
}

interface TauriInternals {
  invoke(command: string, payload?: Record<string, unknown>, options?: unknown): Promise<unknown>;
}

/**
 * Tauri's own command channel.
 *
 * Reached through the global the runtime injects rather than through `@tauri-apps/api`, which is a
 * wrapper around this exact property — one dependency, in the bundle and in the published manifest,
 * for a line that would read the same either way. `withGlobalTauri` is false in this app, so the
 * friendlier `window.__TAURI__` does not exist; this one always does, because the runtime's own
 * bootstrap defines it before any bundle script runs.
 */
function shell(): TauriInternals {
  const host = globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> };
  const internals = host.__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== "function") throw new Error(NO_SHELL);
  return internals as TauriInternals;
}

/**
 * Call one of the shell's own commands by name.
 *
 * This module owns `shell()` and the one sentence for "there is no shell", so a caller that needs
 * a command rather than a request asks here instead of composing a third answer to the same
 * question. It names no command: the caller does, and `build.rs` decides which exist.
 */
export async function invokeShell(
  command: string,
  payload?: Record<string, unknown>,
): Promise<unknown> {
  return shell().invoke(command, payload);
}

/** Whether this page is running inside the shell at all. */
export function bridgeAvailable(): boolean {
  const host = globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> };
  return typeof host.__TAURI_INTERNALS__?.invoke === "function";
}

/** Whatever the command channel handed back, as bytes. */
function asBytes(answer: unknown): Uint8Array {
  if (answer instanceof ArrayBuffer) return new Uint8Array(answer);
  if (ArrayBuffer.isView(answer)) {
    return new Uint8Array(answer.buffer, answer.byteOffset, answer.byteLength);
  }
  /* The command channel has two transports and they hand back different things: the custom
     protocol answers with an ArrayBuffer, and the message channel it falls back to under a strict
     CSP answers with a plain array of byte values, because that path returns through a JSON
     callback. Both are the same bytes; only the container differs. */
  if (Array.isArray(answer)) return Uint8Array.from(answer as number[]);
  throw new Error(
    `ohmail Desktop: the shell answered ${REQUEST_COMMAND} with something that is not bytes.`,
  );
}

/** A request body, as the bytes the command takes. */
function bodyBytes(body: unknown): number[] {
  if (body === undefined || body === null || body === "") return [];
  if (typeof body === "string") return Array.from(new TextEncoder().encode(body));
  if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  /* Deliberately a refusal rather than a `String(body)`. A `FormData` or a `ReadableStream`
     stringified into a request body is a corrupt request that reaches the engine and is answered
     with a puzzling 4xx; refusing here names the caller instead. Nothing in the client sends
     either — every body it composes is `JSON.stringify`'d first. */
  throw new Error("ohmail Desktop: the local engine bridge takes a string or bytes as a body.");
}

/** Request headers, in the pairs the command takes, from any of the three shapes `fetch` allows. */
function headerPairs(headers: unknown): [string, string][] {
  if (!headers) return [];
  if (typeof (headers as Headers).forEach === "function" && !Array.isArray(headers)) {
    const out: [string, string][] = [];
    (headers as Headers).forEach((value, name) => out.push([name, value]));
    return out;
  }
  if (Array.isArray(headers)) {
    return (headers as [string, string][]).map(([name, value]) => [String(name), String(value)]);
  }
  return Object.entries(headers as Record<string, string>).map(([name, value]) => [
    name,
    String(value),
  ]);
}

/** Response headers, skipping any pair the platform will not accept rather than losing the lot. */
function toHeaders(pairs: unknown): Headers {
  const headers = new Headers();
  if (!Array.isArray(pairs)) return headers;
  for (const pair of pairs as unknown[]) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    try {
      headers.append(String(pair[0]), String(pair[1]));
    } catch {
      /* A malformed header name must not sink an otherwise good answer. */
    }
  }
  return headers;
}

interface Meta {
  status?: number;
  statusText?: string;
  h?: unknown;
}

/** Take the shell's answer apart: the length-prefixed metadata, then the body. */
function toResponse(bytes: Uint8Array): Response {
  if (bytes.byteLength < 4) {
    throw new Error("ohmail Desktop: the shell's answer was too short to be one.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLength = view.getUint32(0, false);
  if (4 + metaLength > bytes.byteLength) {
    throw new Error("ohmail Desktop: the shell's answer declared more metadata than it carried.");
  }
  const meta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + metaLength)),
  ) as Meta;

  const status = typeof meta.status === "number" ? meta.status : 0;
  /* Out of range for `new Response`, which accepts 200..599. A status this shell could not produce
     means the frame stream disagreed with itself, and a transport error is the honest shape for
     that — `HttpAdapter` turns a thrown fetch into a retryable failure, where a fabricated 500
     would look like the engine's own answer. */
  if (status < 200 || status > 599) {
    throw new Error(`ohmail Desktop: the local engine answered with status ${status}.`);
  }

  /* A view, not a copy: this is the whole mail body or attachment, and duplicating every one of
     them on its way through the bridge would double the peak memory of opening a message. The
     assertion is a type-level one only — a `Uint8Array` has always been a valid `BodyInit`, but
     recent DOM libraries parameterise the typed arrays by their backing buffer and accept only the
     `ArrayBuffer` instantiation, while a view taken from an existing buffer is typed against
     `ArrayBufferLike`. */
  const payload = bytes.subarray(4 + metaLength);
  /* The one place the window can see a refusal of the ACCOUNT rather than of the request. Read
     from the bytes before they become a body: a `Response` body may be consumed once, and the
     caller owns that read. */
  noticeAccessRefusal(status, payload);

  const body = payload as unknown as BodyInit;
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
    status,
    statusText: typeof meta.statusText === "string" ? meta.statusText : "",
    headers: toHeaders(meta.h),
  });
}

interface BridgeInit {
  method?: string;
  headers?: unknown;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * THE TRANSPORT DEADLINE — one bound, every caller, generous on purpose. The engine bounds
 * its own slow work (an IMAP dial that stalls answers 504 from inside it), so a bridge answer
 * slower than this means a wedged-but-alive engine — and before the bound, every press awaiting
 * one stayed pending for ever with no sentence (35+ call sites in `Desktop*.tsx`). The engine's
 * liveness monitor covers the crash; this covers the process that lives and never answers. The
 * rejection is NAMED and its message is the sentence a press site's catch renders.
 */
export const BRIDGE_DEADLINE_MS = 60_000;

function deadlineError(): Error {
  const err = new Error(
    "ohmail Desktop: the local engine did not answer within a minute, so this request was given up.",
  );
  err.name = "BridgeDeadlineError";
  return err;
}

/**
 * One request to the local engine, and the answer as a `Response`. ABORT IS HONOURED FOR THE
 * CALLER AND NOT FOR THE ENGINE: the client bounds exactly one call with an `AbortSignal` —
 * the attachment list — and races the abort against the answer, so an aborted request has to
 * REJECT here or that race never settles. It does. What it cannot do is cancel the work: the
 * frame protocol carries no cancellation, so the engine finishes and the shell drops the
 * answer — one wasted read on a GET, and saying so beats implying a cancellation that does
 * not happen. The deadline above rides the same race; every racer is handed to `Promise.race`,
 * which keeps a handler on each, so a late loser rejecting is never an unhandled rejection.
 */
export const bridgeFetch: BridgeFetch = async (url, init) => {
  const options = (init ?? {}) as BridgeInit;
  const signal = options.signal;
  if (signal?.aborted) throw abortError();

  const answer = shell().invoke(REQUEST_COMMAND, {
    method: (options.method ?? "GET").toUpperCase(),
    url,
    headers: headerPairs(options.headers),
    body: bodyBytes(options.body),
  });

  let expire: ReturnType<typeof setTimeout> | undefined;
  const racers: Promise<unknown>[] = [
    answer,
    new Promise<never>((_resolve, reject) => {
      expire = setTimeout(() => reject(deadlineError()), BRIDGE_DEADLINE_MS);
    }),
  ];
  if (signal) {
    racers.push(
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
    );
  }
  try {
    const bytes = await Promise.race(racers);
    return toResponse(asBytes(bytes));
  } finally {
    clearTimeout(expire);
  }
};

/**
 * {@link bridgeFetch} FOR THE WINDOW'S OWN POLLS — the same request, asked again when the engine
 * answers `503` and names a `Retry-After`.
 *
 * The shell refuses a bridge request while 32 are already waiting, and a bare single-shot poll
 * reads one refusal as its whole answer: the roster reads render "can't check" for a machine that
 * would have answered a moment later. GET only — the wrapper throws on anything else.
 */
export const retryingBridgeFetch: BridgeFetch = retryingRead(bridgeFetch);

function abortError(): Error {
  const err = new Error("ohmail Desktop: the request was aborted.");
  err.name = "AbortError";
  return err;
}

/** Which door this install came in by. `null` means none has been chosen yet. */
export type EngineMode = "local" | "cloud";

/**
 * WHAT IS ON THE FAR SIDE OF A CLOUD DOOR, as the engine spells it on the wire. Three things,
 * one `mode: "cloud"` until a desktop could be the far side: `managed` (a hosted ohmail
 * account, api.ohmail.app), `selfhost` (a server the person runs — already a distinct door in
 * `self-host.ts`), and `desktop-host` (ohmail on another computer of the person's own, over
 * their network or Tailscale: no account, no ledger, no second factor, no subscription, no
 * browser tab to send anybody to). The union is OPEN on the read side: `flavorOf` refuses a
 * non-member rather than passing it through, so a fourth flavor from a newer engine lands in
 * `"unknown"` and every surface keeps its engine-said-nothing behaviour.
 */
export type DoorFlavorWire = "managed" | "selfhost" | "desktop-host";

/** What the shell says about the engine. A tagged object; `state` is always there. */
export interface EngineStatus {
  state:
    | "absent"
    | "not_configured"
    | "no_key"
    | "starting"
    | "serving"
    | "restarting"
    | "stopped"
    | "failed";
  /**
   * The configured door, or `null` when there is none.
   *
   * ALWAYS PRESENT, and null rather than missing on a fresh install — a surface that read an absent
   * field as "still loading" would spin for ever in exactly the state that most needs to reach the
   * door picker.
   */
  mode?: EngineMode | null;
  /**
   * WHICH KIND OF CLOUD DOOR — what tells a hosted account, a self-run server and another
   * computer apart. `mode` answers "local or not", and every sentence the window writes about
   * a cloud door — "The organizing happens on our servers", the Subscription and Security
   * panes, the price quote — is true of exactly one of the three; on a paired desktop four
   * panes would be about an account that does not exist. ABSENT IS NOT `"managed"` and not
   * `"desktop-host"`: it is an engine that predates the field. The window reads this through
   * `flavorOf` in `doors.ts`, which names absent `"unknown"`; the changed surfaces test
   * POSITIVELY for `"desktop-host"`, and no engine old enough to omit the field has a paired door.
   */
  flavor?: DoorFlavorWire | null;
  /** The mailbox this install is for, as a person would recognise it. */
  address?: string;
  /**
   * THE ENGINE RUNNING NOW IS THE PENDING DOOR'S — the first-run browser approval, booted with no
   * address. With an `address` beside it, that engine's claim has written the door and the window
   * owes the relaunch behind it (`relaunchAdoptedDoor`). Absent on every other engine.
   */
  identityPending?: boolean;
  mailboxId?: string;
  accountId?: string;
  userId?: string;
  /** The ENGINE's own stdio address, the same on every door — never the door's host. */
  baseUrl?: string;
  /**
   * WHERE THE DOOR POINTS, from the shell's configuration: the hosted API, a server the person
   * runs, or on a paired door the other computer — the one fact a paired sentence names.
   */
  cloudUrl?: string;
  /**
   * Whether the engine holds the credential it needs: the mailbox password on the LOCAL door,
   * the hosted session on the CLOUD door (`absent` there means "signed out"; sign-in is
   * `POST /cloud/signin` over the bridge — the password and code never pass the shell).
   * `foreign-host` is the BOOT CONTRACT: a stored password proved against a different server
   * than the engine is configured for, withheld from both transports
   * (`apps/sidecar/src/credential-host.ts`). A state about the CONFIGURATION — folding it
   * into `unreadable` sends somebody to re-enter a password when what moved is the server —
   * and it takes PRECEDENCE over `unreadable` (servers are compared before decrypting).
   */
  credentialState?: "ready" | "absent" | "unreadable" | "unknown" | "foreign-host";
  /**
   * What a still-starting engine last said it was doing — `starting`/`restarting` only, and only
   * once the engine has said anything. An identifier the boot surface maps to a sentence
   * (`BootStatus.tsx`), never prose to render as-is; absent on engines built before it existed,
   * which is why every consumer needs a wording for "no phase yet".
   */
  bootPhase?: string;
  /**
   * How far a countable boot phase has got — the schema upgrade's `applied` of `pending`, as the
   * engine announced it. Absent on every other phase, on an engine built before it existed, and
   * on a shell that could not read the numbers; the boot line then says what it always said.
   */
  bootApplied?: number;
  bootPending?: number;
  reason?: string;
  missing?: string[];
  lookedFor?: string;
}

/** The local door: the user's own mail server, opened from this machine. */
export interface LocalDoorConfig {
  mode: "local";
  imap: { host: string; user: string; port?: number; secure?: boolean };
  smtp?: { host: string; port?: number; secure?: boolean };
  /** The address the mailbox is known by, when it differs from the IMAP login. */
  address?: string;
}

/** The cloud door: a hosted ohmail account, mirrored. */
export interface CloudDoorConfig {
  mode: "cloud";
  /**
   * The hosted service's base address.
   *
   * A VALUE, never a default written here. This file names no host — that is asserted over its
   * source, because a URL in it would be the first thing in either artifact capable of naming one,
   * and the whole claim about the preview build is that nothing in it can.
   */
  cloudUrl: string;
  address: string;
}

/**
 * The paired door: ohmail on another computer of the person's own, over their network or
 * Tailscale — its OWN config, not a flag on the hosted one: `hostPin` is a key this install
 * will accept and nothing else (a self-signed leaf on a DHCP address no authority vouches
 * for), and `address` is genuinely ABSENT, not empty — a pairing link names a computer, and
 * which mailbox this install reads is the host's answer to the redeem; optional on the shared
 * shape would be optional for the hosted door too, where an absent address is a mirror of
 * nobody's. The pairing TOKEN is never here — a credential is never a shell-command argument;
 * it goes to the engine at `POST /cloud/pair-redeem`, and the shell keeps only origin, pin, account.
 */
export interface HostDoorConfig {
  mode: "cloud";
  /** `desktop-host`, and the field that keeps this door's sentences off the hosted door. */
  flavor: "desktop-host";
  /** The host's own origin, verbatim from the pairing link. Never widened with a path. */
  cloudUrl: string;
  /**
   * base64url `SHA-256(SubjectPublicKeyInfo)` of the host's key, from the pairing link's `k1`
   * fragment — or `null` for an origin whose certificate the platform can check on its own (a
   * Tailscale MagicDNS name). Never a fingerprint this window computed: the pin is a fact the
   * person carried across from the other computer, and inventing one here would authenticate
   * whatever answered.
   */
  hostPin: string | null;
}

/**
 * What `engineConfigure` takes — SETTINGS ONLY.
 *
 * There is deliberately no password field and no token field on either door, and the shell refuses
 * a payload carrying one rather than storing it. The mailbox password goes to the engine through
 * `PATCH /mailboxes/:id` and the hosted sign-in through `POST /cloud/signin`, both over
 * {@link bridgeFetch} — so a credential is never an argument to a shell command, never held in the
 * shell's memory, and never written to the shell's settings file. The engine seals it under this
 * install's key, which is the one thing the shell does hold.
 */
/**
 * The hosted door before its account is known — the first-run browser approval. No address: the
 * engine is told "identity pending" and its first claim writes the door with the account it read.
 * The shell refuses it on an install that already has a door.
 */
export interface PendingCloudDoorConfig {
  mode: "cloud";
  cloudUrl: string;
  identityPending: true;
}

export type EngineConfig = LocalDoorConfig | CloudDoorConfig | HostDoorConfig | PendingCloudDoorConfig;

/**
 * ONE DOOR GESTURE AT A TIME — the window's half of the sign-out fence.
 *
 * `Shell::logout` reads the door configuration ONCE and acts on that snapshot. A door switch
 * landing inside that window replaces the engine underneath it, so the clear reaches the NEW
 * door and the old door's sealed password stays on disk under a sign-out the person was told
 * had happened. Both gestures are invoked from this module and nowhere else, which is what
 * makes a latch here a fence: while one is out the other is refused, with a sentence.
 */
let doorGesture: "none" | "signing out" | "changing the door" = "none";

/** Run a door gesture alone, or refuse and name the one already out. */
async function alone<T>(
  gesture: "signing out" | "changing the door", run: () => Promise<T>,
): Promise<T> {
  if (doorGesture !== "none") {
    throw new Error(
      `ohmail Desktop: ${doorGesture} is not finished yet, so ${gesture} was not started. ` +
      "Wait for it to finish and try again.",
    );
  }
  doorGesture = gesture;
  try {
    return await run();
  } finally {
    doorGesture = "none";
  }
}

/** Ask the shell what the engine is doing. Carries no credential — see the Rust `status_json`. */
export async function engineStatus(): Promise<EngineStatus> {
  return (await shell().invoke(STATUS_COMMAND)) as EngineStatus;
}

/**
 * Choose a door, or change the one already chosen, and restart the engine behind it.
 *
 * Answers the status AFTER the change. A caller that re-read `engineStatus()` instead would race
 * the swap and could be told about the engine that was being replaced.
 *
 * The two doors keep separate mirrors, and switching FREEZES the one being left rather than
 * deleting it: coming back does not cost a full re-sync, and no mail is lost either way — the
 * master is the user's own server or the hosted account, never this machine.
 */
export async function engineConfigure(config: EngineConfig): Promise<EngineStatus> {
  return alone(
    "changing the door",
    async () => (await shell().invoke(CONFIGURE_COMMAND, { config })) as EngineStatus,
  );
}

/**
 * The failure card's one recovery press: remove a data-directory lock the person has judged
 * stale, and start the engine again. The shell resolves the lock's path from its own plan — the
 * window names no file — and it refuses unless it has already given up on the engine, so a press
 * can never unlink a live engine's lock. Answers the status AFTER the restart has begun.
 */
export async function engineUnlockRetry(): Promise<EngineStatus> {
  return (await shell().invoke(UNLOCK_COMMAND)) as EngineStatus;
}

/**
 * Sign out of this install: clear the engine's sealed credential, stop it, and forget the door.
 *
 * What stays: the mirror (frozen, see {@link engineConfigure}) and this install's key in the
 * operating system's keystore, which is per-install rather than per-account and is what the next
 * account's credential will be sealed under.
 */
export async function engineLogout(): Promise<EngineStatus> {
  return alone(
    "signing out",
    async () => (await shell().invoke(LOGOUT_COMMAND)) as EngineStatus,
  );
}

/**
 * The client engine's adapter, wired to the bridge. `baseUrl` is empty, so every path stays
 * root-relative (`/sync`, `/messages/…`) — what the shell's request encoder expects, and what
 * keeps the engine's own base URL a fact the page does not need to know (nothing here reads
 * `EngineStatus.baseUrl`). The class is the REAL one: in the preview build `vite.config.ts`
 * aliases the module to a stub whose constructor throws, and nothing in the preview calls
 * this — a preview reaching for the Cloud protocol fails loudly instead of opening a socket.
 */
export function createEngineAdapter(): HttpAdapter {
  return new HttpAdapter({ baseUrl: "", fetch: bridgeFetch, syncFailureSink: reportWindowSyncFailure });
}

/** The local engine's door for a window's failed pull — see {@link reportWindowSyncFailure}. */
export const WINDOW_SYNC_FAILED_PATH = "/local/window/sync-failed";

/**
 * Carry the window's own pull failure to the engine, whose log is the one a support read or a
 * guest cell can see. The record is closed and content-free (`@ohmail/client-engine`'s
 * `WindowSyncFailure`); the shell adds the launch bearer as it does for every bridge request.
 * A refused or failed report is dropped here: the retry is the scheduler's, the log a courtesy.
 */
export async function reportWindowSyncFailure(record: WindowSyncFailure): Promise<void> {
  await bridgeFetch(WINDOW_SYNC_FAILED_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  });
}

/**
 * The client engine this window runs on — the same `OhmailEngine` the hosted client builds, over
 * the bridge, not a socket. Two things are deliberately withheld. No `storePolicy`: the default
 * `full` kept every message and body in the renderer for the window's life (a core and ~1.5 GB on
 * a large mailbox), so the in-memory projection is bounded while the engine's on-disk store holds
 * the whole mailbox (`OhmailEngine.listOlder`, local `/search`). No `store`: the mirror is rebuilt
 * each launch from a same-machine pipe, so a second on-disk copy would only double the mail. The
 * bootstrap takes `GET /sync/snapshot`, which both doors now answer from the database the deltas
 * come from, so its `asOfSeq` cursor matches the next `/sync` and a cold start paints newest-first.
 */
export function createLocalEngine(): OhmailEngine {
  /**
   * `eagerBodies: true` — the desktop window opts in to the eager recent-window hydration
   * (ruling 2026-08-21). The bodies live in the sidecar's store on this same machine, so the
   * pass costs local IPC rather than network; what it buys is that every recent message's body
   * is already in the window's in-memory mirror before anyone opens it — the same "open is
   * instant" the hosted client gets, without even a loopback round trip at the moment of intent.
   */
  return new OhmailEngine({
    adapter: createEngineAdapter(),
    storePolicy: DESKTOP_WINDOW,
    eagerBodies: true,
  });
}

/**
 * Connect the bridge at boot: ask the shell what the engine is doing, and build the adapter.
 *
 * Both halves are the check. The status call proves the window can reach the shell at all; building
 * the adapter proves this build compiled the real client rather than the preview's stub, because
 * the stub's constructor throws.
 */
export async function connectLocalEngine(): Promise<EngineStatus> {
  const status = await engineStatus();
  createEngineAdapter();
  return status;
}
