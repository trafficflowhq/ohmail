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

import { HttpAdapter, OhmailEngine, retryingRead } from "@ohmail/client-engine";

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
  const body = bytes.subarray(4 + metaLength) as unknown as BodyInit;
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
 * One request to the local engine, and the answer as a `Response`. ABORT IS HONOURED FOR THE
 * CALLER AND NOT FOR THE ENGINE: the client bounds exactly one call with an `AbortSignal` —
 * the attachment list — and races the abort against the answer, so an aborted request has to
 * REJECT here or that race never settles. It does. What it cannot do is cancel the work: the
 * frame protocol carries no cancellation, so the engine finishes and the shell drops the
 * answer — one wasted read on a GET, and saying so beats implying a cancellation that does
 * not happen.
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

  const bytes = signal
    ? await Promise.race([
        answer,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        }),
      ])
    : await answer;

  return toResponse(asBytes(bytes));
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
  mailboxId?: string;
  accountId?: string;
  userId?: string;
  baseUrl?: string;
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
export type EngineConfig = LocalDoorConfig | CloudDoorConfig | HostDoorConfig;

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
  return (await shell().invoke(CONFIGURE_COMMAND, { config })) as EngineStatus;
}

/**
 * Sign out of this install: clear the engine's sealed credential, stop it, and forget the door.
 *
 * What stays: the mirror (frozen, see {@link engineConfigure}) and this install's key in the
 * operating system's keystore, which is per-install rather than per-account and is what the next
 * account's credential will be sealed under.
 */
export async function engineLogout(): Promise<EngineStatus> {
  return (await shell().invoke(LOGOUT_COMMAND)) as EngineStatus;
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
  return new HttpAdapter({ baseUrl: "", fetch: bridgeFetch });
}

/**
 * THE CLIENT ENGINE THIS WINDOW RUNS ON — the same `OhmailEngine` the hosted client builds,
 * over the bridge instead of a socket. Deliberately NOT passed: no `storePolicy` — the absent
 * branch is `full`, the only correct answer on a tier whose promise is that the mail is on
 * the machine (the browser's ninety-day window exists because a browser mirror is a cache in
 * front of a server that still holds everything). And no `store` — the mirror is in memory,
 * rebuilt each launch: the disk already holds exactly one copy of this mailbox, the engine's,
 * and refilling over local IPC costs seconds, not a bootstrap over somebody's connection.
 */

/*
 * THE BOOTSTRAP IS THE SNAPSHOT: `OhmailEngine` takes `GET /sync/snapshot` — newest first —
 * instead of replaying the change log when the mirror is cold. This window used to withhold
 * that method, and cold starts painted the OLDEST mail first. The withholding was not
 * arbitrary: a snapshot's `asOfSeq` becomes the `/sync` cursor, and the hosted door once
 * relayed the route onward, returning a cursor from the hosted account's sequence while the
 * next `/sync` answered from the mirror's own — a mailbox that bootstraps once and never
 * receives another change. Both doors now answer the route from the database the deltas come
 * from (`cloud-engine.ts` serves it out of the mirror), so the capability is passed through.
 */
export function createLocalEngine(): OhmailEngine {
  /**
   * `eagerBodies: true` — the desktop window opts in to the eager recent-window hydration
   * (ruling 2026-08-21). The bodies live in the sidecar's store on this same machine, so the
   * pass costs local IPC rather than network; what it buys is that every recent message's body
   * is already in the window's in-memory mirror before anyone opens it — the same "open is
   * instant" the hosted client gets, without even a loopback round trip at the moment of intent.
   */
  return new OhmailEngine({ adapter: createEngineAdapter(), eagerBodies: true });
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
