/**
 * THE BRIDGE: the client engine's `fetch`, pointed at the local mail engine.
 *
 * The window renders the same client app.ohmail.app renders, and that app talks to its server
 * through one function — `HttpAdapterOptions.fetch`. Here that function does not open a socket. It
 * hands the request to the shell over Tauri's command channel, the shell writes it as a frame down
 * the engine's stdin, and the answer comes back the same way. Nothing listens on a port, at any
 * point, in either process.
 *
 * ── WHY A COMMAND AND NOT A LOCAL SERVER ────────────────────────────────────────────────────
 *
 * A localhost port is reachable by every other program on the machine, and a token that authorises
 * it has to live somewhere the page can read. The pipe the shell holds is reachable by nothing: it
 * is a private file descriptor, the engine's credential is added shell-side (see the Rust
 * `encode_request`), and this file never sees it. That is what lets the UNMODIFIED Cloud client run
 * against a local engine — it authenticates with nothing, because there is nothing for it to hold.
 *
 * ── THE WIRE, WHICH IS THE SHELL'S AND NOT INVENTED HERE ────────────────────────────────────
 *
 * `engine_request(method, url, headers, body)` answers with one byte string:
 *
 *     [ 4 bytes big-endian: metadata length ][ metadata JSON ][ body bytes ]
 *
 * where the metadata is `{ status, statusText, h: [[name, value], …] }`. Bytes rather than JSON
 * because a mail body is not a JSON string: re-encoding one would cost a copy and a UTF-8
 * assumption that attachments break. This file's job is to put that back together into a `Response`
 * the client cannot tell from a network one.
 *
 * ── WHAT THE WINDOW STILL CANNOT DO ─────────────────────────────────────────────────────────
 *
 * `invoke` is not `fetch`, and the difference is the whole security story. The webview's CSP still
 * says `connect-src 'none'`, `offline-guard.ts` still replaces every browser API that could leave
 * the process, and the shell grants the window exactly two commands — ask about the engine, and
 * send it one request. So the page has no way to address anything but this one bridge, and if
 * somebody ever forgets to inject this function, `HttpAdapter` falls back to the global `fetch`,
 * which the guard has replaced with a thrower. A forgotten wire is loud rather than silent.
 */

import { HttpAdapter, OhmailEngine } from "@ohmail/client-engine";

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
 * One request to the local engine, and the answer as a `Response`.
 *
 * ── ABORT IS HONOURED FOR THE CALLER AND NOT FOR THE ENGINE ────────────────────────────────
 *
 * The client bounds exactly one call with an `AbortSignal` — the attachment list — and races the
 * abort against the answer, so an aborted request has to REJECT here or that race never settles.
 * It does. What it cannot do is cancel the work: the frame protocol carries no cancellation, so the
 * engine finishes the request and the shell drops the answer. That costs one wasted read and no
 * correctness — the bounded call is a GET — and saying so beats implying a cancellation that does
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

function abortError(): Error {
  const err = new Error("ohmail Desktop: the request was aborted.");
  err.name = "AbortError";
  return err;
}

/** Which door this install came in by. `null` means none has been chosen yet. */
export type EngineMode = "local" | "cloud";

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
  /** The mailbox this install is for, as a person would recognise it. */
  address?: string;
  mailboxId?: string;
  accountId?: string;
  userId?: string;
  baseUrl?: string;
  /**
   * Whether the engine holds the credential it needs.
   *
   * On the LOCAL door that is the mailbox password. On the CLOUD door it is the hosted session, and
   * `absent` there means "signed out" — the sign-in surface is `POST /cloud/signin` over the bridge,
   * not a shell command, because the password and the code go to the engine and never through the
   * shell.
   */
  credentialState?: "ready" | "absent" | "unreadable" | "unknown";
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
 * What `engineConfigure` takes — SETTINGS ONLY.
 *
 * There is deliberately no password field and no token field on either door, and the shell refuses
 * a payload carrying one rather than storing it. The mailbox password goes to the engine through
 * `PATCH /mailboxes/:id` and the hosted sign-in through `POST /cloud/signin`, both over
 * {@link bridgeFetch} — so a credential is never an argument to a shell command, never held in the
 * shell's memory, and never written to the shell's settings file. The engine seals it under this
 * install's key, which is the one thing the shell does hold.
 */
export type EngineConfig = LocalDoorConfig | CloudDoorConfig;

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
 * The client engine's adapter, wired to the bridge.
 *
 * `baseUrl` is empty, so every path stays root-relative — `/sync`, `/messages/…` — which is what
 * the shell's request encoder expects and what keeps the engine's own base URL a fact the page does
 * not need to know. It is also why nothing here reads `EngineStatus.baseUrl`.
 *
 * The class is the REAL one. In the preview build `vite.config.ts` aliases that module to a stub
 * whose constructor throws, and nothing in the preview calls this — so a preview that ever reached
 * for the Cloud protocol would fail loudly at the point of construction rather than open a socket.
 */
export function createEngineAdapter(): HttpAdapter {
  return new HttpAdapter({ baseUrl: "", fetch: bridgeFetch });
}

/**
 * THE CLIENT ENGINE THIS WINDOW RUNS ON — the same `OhmailEngine` the hosted client builds, over
 * the bridge instead of over a socket.
 *
 * ── WHAT IS DELIBERATELY NOT PASSED ─────────────────────────────────────────────────────────
 *
 * **No `storePolicy`.** The absent branch is `full`, and full is the only correct answer here:
 * this tier's promise is that the mail is on the machine, so a window that evicted the older half
 * of it would be deleting the product. The browser's ninety-day window exists because a browser
 * mirror is a cache in front of a server that still holds everything; nothing about that argument
 * applies to a copy the local engine already keeps on disk.
 *
 * **No `store`.** The mirror is in memory and is rebuilt on each launch. There is already exactly
 * one copy of this mailbox on the disk — the engine's — and writing a second one into the
 * webview's storage would double it for no benefit: the drain that fills this mirror is a pipe to
 * a process on the same machine, not a network round trip, so re-reading it costs a few seconds of
 * local IPC rather than a bootstrap over somebody's connection.
 *
 * ── AND THE BOOTSTRAP IS THE SNAPSHOT, WHICH IT DID NOT USED TO BE ──────────────────────────
 *
 * `OhmailEngine` reaches for an optional `snapshot` method on the adapter it is given and takes
 * `GET /sync/snapshot` — the account's current state, newest first — instead of replaying the
 * change log from the beginning whenever the mirror is cold. This window used to withhold that
 * method, and the cost was visible on every cold start: the mail arrived OLDEST first, a page at a
 * time, so the first thing painted was the least interesting mail in the mailbox and the message
 * somebody opened the app to read appeared last.
 *
 * The withholding was not arbitrary. A snapshot's answer carries `asOfSeq`, the point it was read
 * at, which the client commits as its `/sync` cursor — and the hosted door had no local handler
 * for the route, so it relayed the request onward and returned a cursor counted in the hosted
 * account's sequence, while the very next `/sync` was answered from the local mirror's own. A
 * cursor from the wrong sequence is a mailbox that bootstraps once, looks complete, and then never
 * receives another change. Withholding the method was the correct response to that, and the wrong
 * layer to fix it at.
 *
 * Both doors now answer the route from the database the deltas come from — the standalone engine
 * always did, and `cloud-engine.ts` serves it out of the mirror rather than forwarding it — so
 * there is one sequence per door and the capability is simply passed through.
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
