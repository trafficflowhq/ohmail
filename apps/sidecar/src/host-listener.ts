import { makeHttpServer } from "@trafficflow/core/adapters/http-host";
import { makeAuthConfig, type AuthConfig } from "@trafficflow/services/mail";
import type { Diagnostic } from "./log.js";

/**
 * THE LOOPBACK LISTENER — the second door on the one engine process (Phase 3).
 *
 * `tailscale serve --bg https:443 http://127.0.0.1:<port>` is what publishes this to the tailnet:
 * Tailscale terminates TLS with a real MagicDNS certificate, the phone gets a secure browser
 * context, and roaming is Tailscale's problem. The serve invocation itself is the RUST SHELL's
 * (no shell-outs from this process, ever); this module's whole job is to make the engine side of
 * that arrangement correct:
 *
 *  · **`127.0.0.1` and NOTHING else.** Never the tailnet interface, never `0.0.0.0`, never a
 *    hostname — and deliberately NOT configurable: there is no host/interface option on
 *    {@link startHostListener}, the literal below is the only address that ever reaches
 *    `listen()`, and the bind is re-checked at runtime against what the kernel actually gave us.
 *    "No open ports" stays literally true; only a process on this machine (in practice, the
 *    tailscaled proxy) can reach the socket. `tailscale funnel` is FORBIDDEN — that is pinned on
 *    the shell side, where the invocation lives.
 *  · **Host mode absent ⇒ no listener object is even constructed.** {@link resolveHostConfig} is
 *    the one reading of the host knobs, and only the exact boolean `true` arms anything — the
 *    dangerous branch requires configuration, three times over (mode, port, origin).
 *  · **Bad host config degrades, never crashes.** The stdio door is the product; the host door
 *    is an addition to it. A garbage origin or port turns host mode OFF with a surfaced reason
 *    ({@link resolveHostConfig} refuses, `engine.ts` logs `host_config_invalid`) — the boot
 *    itself must not be able to fail because the host half was misconfigured.
 *
 * ── THE BODY CAP, SIZED AGAINST THE SEND CEILING THIS DOOR ANNOUNCES ─────────────────────────
 *
 * The listener changes a fact the stdio composition was built on. The local bag declares
 * `sendSurfaceMaxTotalBytes: null` — "no platform ceiling" — because the compose form, the
 * handler and the SMTP dial are one process with no request body between them. On THIS door that
 * is no longer true: a phone's send rides an HTTP request through this adapter, attachments
 * inline as base64, so the door must declare a surface ceiling and the adapter's byte cap must
 * clear it — or the compose surface accepts a send the transport then kills with an opaque 413.
 *
 * The pair below is the self-host server's, deliberately (`apps/server/src/config.ts`:
 * `BODY_MAX_BYTES` / `SELF_HOST_SEND_MAX_TOTAL_BYTES`): 32 MB of raw attachment bytes encodes to
 * ~42.7 MB of base64, which clears a 50 MB body cap with megabytes to spare for the JSON
 * envelope. The two long-running doors state one number. What actually applies to a send is
 * still `effectiveAttachmentCap` — the SMALLER of this surface and the submission server's own
 * RFC 1870 `SIZE` announcement (`mailboxes.smtp_max_size_bytes`, probed per mailbox) — so a
 * stingier server binds first, an unprobed one stays at the strict hosted constant, and a
 * generous one (Gmail announces ~34 MB) is bounded by the surface rather than by a transport
 * error. Bigger buys almost nothing (no mainstream submission server accepts much past this) and
 * inflates what an always-on listener must be willing to buffer per request; unbounded is not an
 * option at all — the cap is the DoS bound (ruled point 4).
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
 * THE CONCURRENT-ADMISSION BOUND — how many requests may be IN A HANDLER at once; the next one
 * answers `503 host_busy` with `Retry-After` instead of entering.
 *
 * The per-request byte cap bounds one request; nothing else bounded how many of them a client
 * could hold open at once, and the redeem route buffers its body — so a burst of concurrent
 * near-cap POSTs from one misbehaving (or compromised) paired device could exhaust the one
 * engine process's heap and take the WINDOW's door down with the phone's. Sixteen is generous
 * for the legitimate audience — a handful of a person's own devices, each issuing a few
 * requests in parallel — and it bounds the worst-case in-flight buffering at
 * 16 × {@link HOST_BODY_MAX_BYTES}.
 *
 * Stated honestly: this bounds CONCURRENCY, not aggregate bytes — a byte-metered admission
 * budget would need hooks inside the adapter's body stream and belongs to its own change if the
 * threat model ever widens past this machine's own tailnet (funnel is forbidden, so it has not).
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
 * THE ONE READING of the host-mode knobs. Pure, and it NEVER throws: a refused value returns the
 * disarmed state with a `reason`, because the stdio door must never die over host config.
 *
 * Rules, in order:
 *  · `hostMode` must be the exact boolean `true`. Absent — every install that has never heard of
 *    host mode — and any garbage value stay disarmed with NO reason: nothing was asked for.
 *    (Pinned since the door first landed; an absent config value must never select the
 *    dangerous branch.)
 *  · `hostPort`, when present, is an integer in 1..65535. Port 0 is refused rather than treated
 *    as "ephemeral": `tailscale serve` points at a FIXED port, and a port that changes per
 *    launch would silently strand the published route.
 *  · `hostOrigin`, when present, must be one bare absolute origin — https, or http on loopback
 *    only — whose hostname doubles as the rpID, validated by the SAME
 *    `makeAuthConfig`/`assertOriginConfig` path the managed host, the self-host server and the
 *    stdio door construct through. A MagicDNS name passes cleanly: `ts.net` is on the public
 *    suffix list, so `machine.tailnet.ts.net` is a registrable name of its own. An IP literal —
 *    including the tailnet 100.x address — is refused, exactly as the self-host server refuses
 *    it: the published origin is the MagicDNS name, which is also the only thing Tailscale will
 *    mint a certificate for.
 *
 * A refusal names the VARIABLE and the rule, never the value (`loadOrigin` in
 * `apps/server/src/config.ts` is the precedent: the underlying validator's message may quote the
 * offending string, so the surfaced sentence is fixed text).
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

export function startHostListener(opts: {
  handle: (req: Request) => Promise<Response>;
  port: number;
  log?: Diagnostic;
  /** TEST SEAM — production takes {@link HOST_SHUTDOWN_GRACE_MS}. */
  graceMs?: number;
  /** TEST SEAM — see `AdapterOptions.connectionsCheckingIntervalMs`. */
  connectionsCheckingIntervalMs?: number;
}): Promise<HostListener> {
  /**
   * EVERY handler invocation is TRACKED, and the tracking carries both review findings:
   *
   *  · ADMISSION — a request arriving while {@link HOST_MAX_CONCURRENT_REQUESTS} handlers are
   *    already running answers `503 host_busy` without entering one, so a burst of concurrent
   *    near-cap bodies is bounded instead of buffering until the shared heap dies.
   *  · DRAIN — `close()` resolves only after every tracked handler has SETTLED, not merely
   *    after the sockets are gone. `closeAllConnections()` destroys a straggler's SOCKET, which
   *    makes node fire the close callback while the handler promise is still running against
   *    the database; resolving there lets `main.ts` close PGlite underneath a live send. The
   *    settled-set wait is deliberately unbounded — a destroyed socket cannot feed a handler
   *    more bytes, its awaited work is local (the store, one SMTP dial), and the shell's own
   *    process grace is the backstop for a genuinely hung one.
   *
   * The tracked window is the HANDLER promise — `Request → Response` head. Response-body
   * streaming past that point is socket work, not store work: this door's large responses are
   * buffered JSON (SSE is off), so nothing reads the store after the head resolves.
   */
  const pending = new Set<Promise<unknown>>();
  const tracked = (req: Request): Promise<Response> => {
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
    const p = opts.handle(req);
    const settled = p.then(() => undefined, () => undefined);
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    return p;
  };

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
              void Promise.allSettled([...pending]).then(() => closed());
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
 * The production mount: bind the host door iff the composition is armed AND the shell configured
 * both halves of the published route. Anything less is a named, surfaced degradation — never a
 * crash, and never a socket:
 *
 *  · disarmed ⇒ `null`, silently: no listener object is even constructed, and the absence of a
 *    log line is the byte-identical-boot half of the ruling.
 *  · armed without BOTH `port` and `origin` ⇒ `null` + `host_listener_skipped` naming the
 *    missing knob. The origin arm is deliberate: a listener without the served origin would
 *    refuse every real browser mutation as cross-site (the request guard would allow-list only
 *    the stdio door's loopback origin), which is worse than no listener — it pairs a phone and
 *    then fails it on first use.
 *  · a bind failure (the port is taken, the kernel refused) ⇒ `null` + `host_listen_failed`;
 *    the stdio door keeps serving.
 */
export async function maybeStartHostListener(
  door: HostDoor,
  log: Diagnostic,
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
