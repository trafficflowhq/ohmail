import { makeHttpServer } from "@trafficflow/core/adapters/http-host";
import { makeAuthConfig, type AuthConfig } from "@trafficflow/services/mail";
import type { Diagnostic } from "./log.js";

/**
 * The loopback listener — the second door on the one engine process (Phase 3). `tailscale serve`
 * publishes it to the tailnet (TLS terminated with a real MagicDNS cert, a secure browser context);
 * the serve invocation is the RUST SHELL's, and this makes the engine side correct: `127.0.0.1` and
 * NOTHING else — not configurable, re-checked against the kernel, so "no open ports" stays true of
 * this door (`tailscale funnel` is forbidden shell-side; the LAN fallback is a different module).
 * Host mode absent ⇒ no listener object is constructed (`resolveHostConfig`, only the exact boolean
 * `true` arms it); bad config DEGRADES with a surfaced reason, never crashes. The body cap is the
 * self-host server's pair, because a phone's send rides an HTTP request here whose cap must clear the announced surface.
 */

/** The one address the host door ever binds. A literal, pinned by census AND re-checked at bind. */
export const HOST_LOOPBACK_ADDRESS = "127.0.0.1";

/** The adapter's request-body ceiling for the host door — see the header for the derivation. */
export const HOST_BODY_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The send surface's ceiling in RAW attachment bytes on the host door. Declared on
 * `depsForHost`'s bag (`engine.ts`), where the stdio door's `null` stays untouched — the two
 * doors of one engine genuinely differ in this one fact.
 */
export const HOST_SEND_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Slowloris ceilings — ruled point 4, the self-host server's values. */
export const HOST_HEADERS_TIMEOUT_MS = 30_000;
export const HOST_REQUEST_TIMEOUT_MS = 300_000;

/**
 * The concurrent-admission bound — how many requests may be IN A HANDLER at once; the next answers
 * `503 host_busy` with `Retry-After` instead of entering. The per-request byte cap bounds one
 * request, but nothing bounded how many a client could hold open, and the redeem route buffers its
 * body — so a burst of near-cap POSTs from one misbehaving device could exhaust the engine's heap and
 * take the WINDOW's door down with the phone's. Sixteen is generous for the legitimate audience (a
 * handful of a person's own devices) and bounds worst-case buffering at 16 × {@link
 * HOST_BODY_MAX_BYTES}. It bounds CONCURRENCY, not aggregate bytes — a byte-metered budget belongs
 * to its own change if the threat model ever widens past this tailnet (funnel is forbidden).
 */
export const HOST_MAX_CONCURRENT_REQUESTS = 16;

/**
 * How long in-flight requests get after `close()` before their sockets are destroyed. SSE is off
 * on this door in v1 (`/events` answers a finite 503), so nothing legitimate holds a response
 * open for minutes — the grace is for an ordinary request that was mid-answer.
 */
export const HOST_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Whether — and with what — this install serves its owner's other devices, resolved ONCE from
 * the three host knobs. `engine.ts` composes from `armed` (the pairing mint, `/hello`'s
 * `pairing`, `handleHost`); `maybeStartHostListener` binds from `origin` + `port`.
 */
export interface HostState {
  /** The armed composition exists: `handleHost`, the window's pairing mint, `pairing: true`. */
  armed: boolean;
  /**
   * The served origin (canonicalized) the host door's request guard allow-lists —
   * `https://<machine>.<tailnet>.ts.net`, the thing `tailscale serve` publishes. `null` when the
   * shell has not passed one; the listener then refuses to start, because a bound socket whose
   * guard allow-lists only `http://localhost` would refuse every real browser mutation as
   * cross-site — the exact defect this field exists to close.
   */
  origin: string | null;
  /** The loopback port the listener binds. `null` when the shell has not passed one. */
  port: number | null;
  /**
   * Why host mode is OFF although it was asked for — the surfaced reason of the degraded state.
   * `null` both when armed and when host mode was simply never requested. Never echoes a
   * configured value: an origin string can embed credentials in the general case.
   */
  reason: string | null;
}

export interface ResolvedHostConfig {
  state: HostState;
  /**
   * The host door's auth config — request-guard origin allow-list of exactly the served origin —
   * built through the same `makeAuthConfig`/`assertOriginConfig` every other composition boots
   * through. `null` when no origin is configured (the door then keeps the stdio door's loopback
   * config: nothing browser-shaped can reach it without a listener, and the listener refuses to
   * start without an origin).
   */
  authConfig: AuthConfig | null;
}

/**
 * The one reading of the host-mode knobs. Pure, and it NEVER throws: a refused value returns the
 * disarmed state with a `reason`, because the stdio door must never die over host config. `hostMode`
 * must be the exact boolean `true` — absent or garbage stays disarmed with NO reason (nothing was
 * asked for). `hostPort`, when present, is an integer 1..65535; port 0 is refused rather than
 * "ephemeral" because `tailscale serve` points at a FIXED port. `hostOrigin`, when present, is one
 * bare absolute origin (https, or http on loopback) whose hostname doubles as the rpID, through the
 * same `makeAuthConfig`/`assertOriginConfig` path — a MagicDNS name passes, an IP literal is refused
 * exactly as the self-host server refuses it. A refusal names the VARIABLE and the rule, never the value.
 */
export function resolveHostConfig(
  cfg: { hostMode?: boolean; hostOrigin?: string; hostPort?: number },
): ResolvedHostConfig {
  const off = (reason: string | null): ResolvedHostConfig => ({
    state: { armed: false, origin: null, port: null, reason },
    authConfig: null,
  });
  if (cfg.hostMode !== true) return off(null);

  let port: number | null = null;
  if (cfg.hostPort !== undefined) {
    if (!Number.isInteger(cfg.hostPort) || cfg.hostPort < 1 || cfg.hostPort > 65535) {
      return off(
        "OHMAIL_HOST_PORT must be an integer between 1 and 65535 (a fixed port — tailscale " +
          "serve publishes a specific target, so an ephemeral or garbage port would strand the " +
          "published route); host mode is off for this launch",
      );
    }
    port = cfg.hostPort;
  }

  let origin: string | null = null;
  let authConfig: AuthConfig | null = null;
  const rawOrigin = cfg.hostOrigin?.trim() ?? "";
  if (rawOrigin !== "") {
    try {
      const url = new URL(rawOrigin);
      if (url.username || url.password) throw new Error("credentials in origin");
      if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
        throw new Error("origin carries a path, query or fragment");
      }
      // The full ruleset — http-only-on-loopback, DNS-named rpID, public-suffix refusal, the
      // rpID covering the origin — is `assertOriginConfig`'s, the same validator every other
      // door boots through. The hostname doubles as the rpID, the self-host server's shape.
      authConfig = makeAuthConfig({ rpID: url.hostname.toLowerCase(), origin: url.origin });
      origin = url.origin;
    } catch {
      // Fixed text: the validator's own message may quote the value, and an origin can embed
      // credentials in the general case, so nothing of it reaches a log line.
      return off(
        "OHMAIL_HOST_ORIGIN is not usable as the served origin: it must be one bare absolute " +
          "origin — https, or http on loopback only — with a DNS-named host (the MagicDNS name " +
          "tailscale serve publishes; IP literals cannot back the request guard's origin " +
          "allow-list), no path, no credentials; host mode is off for this launch",
      );
    }
  }

  return { state: { armed: true, origin, port, reason: null }, authConfig };
}

/** A bound host-door listener. `close()` is idempotent and never throws. */
export interface HostListener {
  /** The port actually bound — echoes the configured one (tests bind 0 and read the real one). */
  readonly port: number;
  /**
   * Stop accepting, let in-flight requests finish (bounded by the grace), destroy stragglers,
   * release the socket. Called BEFORE the stdio host and the store on the way down: a remote
   * request must not find a closed database under a live socket.
   */
  close(): Promise<void>;
}

/**
 * Bind the host door on `127.0.0.1:<port>` — the literal, never a parameter — serving one
 * `Request → Response` through the shared node:http adapter with this door's caps.
 *
 * The bound address is re-checked against what the kernel reports and anything else is refused:
 * the census over this file pins the literal at the call site, and this assertion is the runtime
 * half of the same invariant (a resolver or a patched `listen` cannot silently widen the bind).
 */
/** The admission refusal, in the API's own error envelope so clients parse one shape everywhere. */
const HOST_BUSY_BODY = JSON.stringify({
  error: { code: "host_busy", message: "too many concurrent requests on this door; retry shortly" },
});

/**
 * ONE admission budget, however many doors wrap handlers in it. `wrap` refuses entry past
 * {@link HOST_MAX_CONCURRENT_REQUESTS} with `503 host_busy`; `drained` resolves only when every
 * admitted handler has SETTLED — the store-safety half of `close()` on any door.
 */
export interface Admission {
  wrap(handle: (req: Request) => Promise<Response>): (req: Request) => Promise<Response>;
  drained(): Promise<void>;
}

/**
 * The admission bound and the drain — the tracking documented at length inside
 * {@link startHostListener}, factored so every network door carries the SAME two review
 * findings instead of a divergent copy. The `pending` set lives on the ADMISSION object, not on
 * a listener: {@link HOST_MAX_CONCURRENT_REQUESTS} bounds what the one engine PROCESS holds in
 * flight, and a per-listener copy would double the heap bound the moment a second door (the LAN
 * fallback) opened — `main.ts` therefore builds one of these and hands it to both mounts, and a
 * listener started without one gets a private budget (the single-door tests, and any composition
 * that genuinely has one door).
 */
export function createAdmission(): Admission {
  const pending = new Set<Promise<unknown>>();
  return {
    wrap(handle) {
      return (req: Request): Promise<Response> => {
        if (pending.size >= HOST_MAX_CONCURRENT_REQUESTS) {
          return Promise.resolve(new Response(HOST_BUSY_BODY, {
            status: 503,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
              "retry-after": "1",
            },
          }));
        }
        const p = handle(req);
        const settled = p.then(() => undefined, () => undefined);
        pending.add(settled);
        void settled.then(() => pending.delete(settled));
        return p;
      };
    },
    drained: () => Promise.allSettled([...pending]).then(() => undefined),
  };
}

export function startHostListener(opts: {
  handle: (req: Request) => Promise<Response>;
  port: number;
  log?: Diagnostic;
  /** The process-wide admission budget — see {@link createAdmission}. Absent, a private one. */
  admission?: Admission;
  /** TEST SEAM — production takes {@link HOST_SHUTDOWN_GRACE_MS}. */
  graceMs?: number;
  /** TEST SEAM — see `AdapterOptions.connectionsCheckingIntervalMs`. */
  connectionsCheckingIntervalMs?: number;
}): Promise<HostListener> {
  /**
   * Every handler invocation is TRACKED, carrying both review findings. ADMISSION: a request
   * arriving while {@link HOST_MAX_CONCURRENT_REQUESTS} handlers run answers `503 host_busy` without
   * entering, so a burst of near-cap bodies is bounded before the shared heap dies. DRAIN: `close()`
   * resolves only after every tracked handler has SETTLED, not merely after the sockets are gone —
   * `closeAllConnections()` destroys a straggler's SOCKET, which fires the close callback while the
   * handler still runs against the database, and resolving there lets `main.ts` close PGlite under a
   * live send. The tracked window is the HANDLER promise (`Request → Response` head); response-body
   * streaming past it is socket work. The budget is process-wide when the caller hands the shared one in.
   */
  const admission = opts.admission ?? createAdmission();
  const tracked = admission.wrap(opts.handle);
  const drained = (): Promise<void> => admission.drained();

  const server = makeHttpServer(tracked, {
    bodyMaxBytes: HOST_BODY_MAX_BYTES,
    headersTimeoutMs: HOST_HEADERS_TIMEOUT_MS,
    requestTimeoutMs: HOST_REQUEST_TIMEOUT_MS,
    ...(opts.connectionsCheckingIntervalMs !== undefined
      ? { connectionsCheckingIntervalMs: opts.connectionsCheckingIntervalMs }
      : {}),
  });
  return new Promise<HostListener>((done, fail) => {
    server.once("error", fail);
    server.listen(opts.port, HOST_LOOPBACK_ADDRESS, () => {
      server.removeListener("error", fail);
      const addr = server.address();
      if (addr === null || typeof addr === "string" || addr.address !== HOST_LOOPBACK_ADDRESS) {
        // The runtime half of the loopback pin. Refusing to serve is strictly better than
        // serving one request on a wider bind.
        server.close();
        fail(new Error(
          "the host door bound an address other than 127.0.0.1; refusing to serve — the " +
            "loopback literal is the invariant tailscale serve publishes against",
        ));
        return;
      }
      let closing: Promise<void> | null = null;
      done({
        port: addr.port,
        close: () =>
          (closing ??= new Promise<void>((closed) => {
            const grace = setTimeout(
              () => server.closeAllConnections(),
              opts.graceMs ?? HOST_SHUTDOWN_GRACE_MS,
            );
            grace.unref?.();
            server.close(() => {
              clearTimeout(grace);
              // The sockets are gone; the STORE is not safe yet — see the tracking note above.
              void drained().then(() => closed());
            });
            // Keep-alive sockets with no request in flight would otherwise hold `close()` open
            // for the whole grace on every ordinary quit.
            server.closeIdleConnections();
          })),
      });
    });
  });
}

/** What `maybeStartHostListener` needs of a sidecar — structural, so no import cycle exists. */
export interface HostDoor {
  readonly hostState: HostState;
  handleHost?(req: Request): Promise<Response>;
}

/**
 * The production mount: bind the host door iff the composition is armed AND the shell configured both
 * halves of the published route. Anything less is a named degradation, never a crash and never a
 * socket: disarmed ⇒ `null` silently (no listener object, the byte-identical-boot half of the
 * ruling); armed without BOTH `port` and `origin` ⇒ `null` + `host_listener_skipped` (the origin arm
 * is deliberate — a listener without the served origin refuses every browser mutation as cross-site,
 * worse than no listener); a bind failure ⇒ `null` + `host_listen_failed`, the stdio door still
 * serving.
 */
export async function maybeStartHostListener(
  door: HostDoor,
  log: Diagnostic,
  admission?: Admission,
): Promise<HostListener | null> {
  const { armed, origin, port } = door.hostState;
  if (!armed || door.handleHost === undefined) return null;
  if (origin === null || port === null) {
    if (origin === null && port === null) {
      // Armed with neither knob — the door-only composition, which every armed test drives
      // directly over `handleHost`. Nothing to publish, nothing to say.
      return null;
    }
    log("host_listener_skipped", {
      reason: origin === null
        ? "host mode is armed with a port but no OHMAIL_HOST_ORIGIN; a listener whose request " +
          "guard does not allow-list the served origin would refuse every browser mutation as " +
          "cross-site, so none is started and the stdio door serves alone"
        : "host mode is armed with an origin but no OHMAIL_HOST_PORT; there is nothing to " +
          "bind, so the stdio door serves alone",
    });
    return null;
  }
  try {
    const listener = await startHostListener({
      handle: (req) => door.handleHost!(req),
      port,
      log,
      ...(admission !== undefined ? { admission } : {}),
    });
    log("host_listening", { port: listener.port });
    return listener;
  } catch (err) {
    log("host_listen_failed", {
      err,
      reason: "the host door's loopback listener could not bind; the stdio door keeps serving " +
        "and host mode is off for this launch",
    });
    return null;
  }
}
