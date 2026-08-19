import { isIPv4 } from "node:net";
import { makeHttpServer } from "@trafficflow/core/adapters/http-host";
import {
  HOST_BODY_MAX_BYTES,
  HOST_HEADERS_TIMEOUT_MS,
  HOST_REQUEST_TIMEOUT_MS,
  HOST_SHUTDOWN_GRACE_MS,
  trackAdmission,
  type HostState,
} from "./host-listener.js";
import { HOST_CLIENT_CSP } from "./host-static.js";
import type { Diagnostic } from "./log.js";

/**
 * THE LAN DOOR — the no-Tailscale fallback: an explicit second bind to ONE operator-chosen LAN
 * interface, plain HTTP, serving the desktop-host API and nothing else (Phase 3).
 *
 * ── WHY THIS DOOR IS API-ONLY, DECIDED BY AUDIT RATHER THAN BY PREFERENCE ────────────────────
 *
 * The Tailscale door serves a real browser client because `tailscale serve` gives the phone an
 * HTTPS origin — a SECURE CONTEXT. A LAN address is `http://192.168.x.x:<port>`: plain HTTP on a
 * non-loopback host, which no browser treats as secure, and the served client's dependencies on
 * `[SecureContext]`-gated platform APIs are load-bearing, not incidental:
 *
 *  · `crypto.randomUUID()` is called BARE in the shared shell's tag flows
 *    (`apps/webapp/app/shell/AppShell.tsx` — `createTag`, `createTagAlone`); on an insecure
 *    origin the function does not exist and the flow throws.
 *  · `navigator.locks` is what serializes bearer-token rotation across tabs
 *    (`apps/desktop/src/host-client/bearer.ts`); without it a two-tab double-present of one
 *    refresh token is READ AS THEFT by this door's strict reuse detection and revokes the whole
 *    family — the phone silently unpairs. The manager itself documents that the bare fallback
 *    narrows that window and cannot close it.
 *  · `navigator.clipboard` (copy actions) is likewise absent on an insecure origin.
 *
 * Independently, the auth origin model refuses what this door would have to allow-list:
 * `normalizeOrigin` (`packages/services/src/auth/origins.ts`) accepts `http:` on loopback ONLY,
 * and the rpID machinery refuses IP literals — both for reasons that hold everywhere else, so
 * widening them for one door would weaken every composition that boots through them. The honest
 * shape is therefore: the LAN door serves the API for NATIVE clients (which send no `Origin`
 * header and pass the existing request guard's native branch unchanged), a browser-shaped
 * mutation is refused as cross-site by the guard exactly as it stands, and a browser NAVIGATING
 * here gets a script-free page saying plainly why it must use the Tailscale address instead.
 * No guard was widened and no client is served broken.
 *
 * ── THE BIND RULES, SAME DISCIPLINE AS THE LOOPBACK DOOR ─────────────────────────────────────
 *
 *  · **One explicit IPv4 interface literal, chosen by the operator.** Never `0.0.0.0` (that is
 *    every interface, which nobody chose), never loopback (that is the host door's own bind),
 *    never a name (a name is a resolver's answer, not an interface), never IPv6 in v1 — the
 *    refusal names the rule. The census over this file pins ONE `listen()` call site carrying
 *    the configured address, and the kernel's answer is re-checked after the bind.
 *  · **Opt-in on top of opt-in.** `OHMAIL_LAN_BIND` means nothing unless host mode is armed,
 *    and armed-without-it is byte-identical to the loopback-only composition: no handler, no socket, no log
 *    line. A refused value degrades the LAN half alone (`host_lan_config_invalid`) — the
 *    Tailscale half and the stdio door never die over this knob.
 *  · **Same caps, same admission bound, same drain.** The byte cap, slowloris timeouts,
 *    concurrent-admission bound and settled-handler drain are imported from the host listener —
 *    one set of numbers for the long-running doors, not two.
 *
 * Plain HTTP on the local network is the stated trade of this fallback: the transport is only as
 * private as the network the operator chose to serve on, which is why the default remains
 * Tailscale-only and the pane's copy says so in the operator's language.
 */

/** What `OHMAIL_LAN_BIND` resolved to — one address, or one surfaced refusal. */
export interface LanState {
  /** The IPv4 interface literal the LAN door binds, or `null` when LAN is off. */
  address: string | null;
  /** Why the LAN half is off although it was asked for. Fixed text, never the value. */
  reason: string | null;
}

/**
 * THE ONE READING of the LAN knob. Pure, never throws; a refusal names the variable and the
 * rule, never the value (the same discipline as `resolveHostConfig`, and for the same reason).
 */
export function resolveLanBind(cfg: { hostMode?: boolean; lanBind?: string }): LanState {
  const trimmed = cfg.lanBind?.trim() ?? "";
  if (trimmed === "") return { address: null, reason: null };
  if (cfg.hostMode !== true) {
    return {
      address: null,
      reason: "OHMAIL_LAN_BIND is set but host mode is not armed; same-network access is part " +
        "of host mode, so nothing binds",
    };
  }
  if (!isIPv4(trimmed) || trimmed.startsWith("127.") || trimmed.startsWith("0.")) {
    return {
      address: null,
      reason: "OHMAIL_LAN_BIND must be one bare IPv4 address of a network interface on this " +
        "computer — never the wildcard, never loopback (that is the host door's own bind), " +
        "never a hostname or a port, and not IPv6 in this version; same-network access is off " +
        "for this launch",
    };
  }
  return { address: trimmed, reason: null };
}

/** A bound LAN-door listener. `close()` is idempotent and never throws. */
export interface LanListener {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Bind the LAN door on the CHOSEN interface — `opts.address`, validated here again because a
 * bind is the one action this module performs that cannot be un-taken quietly. The kernel's
 * answer is re-checked, exactly as the loopback listener re-checks its literal.
 */
export function startLanListener(opts: {
  handle: (req: Request) => Promise<Response>;
  address: string;
  port: number;
  log?: Diagnostic;
  /** TEST SEAM — production takes {@link HOST_SHUTDOWN_GRACE_MS}. */
  graceMs?: number;
  /** TEST SEAM — see `AdapterOptions.connectionsCheckingIntervalMs`. */
  connectionsCheckingIntervalMs?: number;
}): Promise<LanListener> {
  if (!isIPv4(opts.address) || opts.address.startsWith("127.") || opts.address.startsWith("0.")) {
    return Promise.reject(new Error(
      "the LAN door binds one explicit IPv4 interface address; loopback, the wildcard and " +
        "everything that is not an interface literal are refused",
    ));
  }
  const { tracked, drained } = trackAdmission(opts.handle);
  const server = makeHttpServer(tracked, {
    bodyMaxBytes: HOST_BODY_MAX_BYTES,
    headersTimeoutMs: HOST_HEADERS_TIMEOUT_MS,
    requestTimeoutMs: HOST_REQUEST_TIMEOUT_MS,
    ...(opts.connectionsCheckingIntervalMs !== undefined
      ? { connectionsCheckingIntervalMs: opts.connectionsCheckingIntervalMs }
      : {}),
  });
  return new Promise<LanListener>((done, fail) => {
    server.once("error", fail);
    server.listen(opts.port, opts.address, () => {
      server.removeListener("error", fail);
      const addr = server.address();
      if (addr === null || typeof addr === "string" || addr.address !== opts.address) {
        // The runtime half of the chosen-address pin: a resolver or a patched `listen` must not
        // silently widen the bind. Refusing to serve is strictly better than serving wider.
        server.close();
        fail(new Error(
          "the LAN door bound an address other than the one configured; refusing to serve — " +
            "the operator's chosen interface is the invariant",
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
              // Sockets gone ≠ store safe — the drain is the same store-safety wait the
              // loopback door keeps; see `trackAdmission`.
              void drained().then(() => closed());
            });
            server.closeIdleConnections();
          })),
      });
    });
  });
}

/** The API's own envelope, so a client parses one error shape on both halves of this door. */
function refuse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * The page a BROWSER gets on this door — the honest explainer, in place of the client the
 * Tailscale door serves. Script-free under the same policy, so this page can never become the
 * exposure the real client is defended against, and every sentence is a checked claim:
 * the API is what this door serves; a browser needs HTTPS for a network address; the Tailscale
 * path is where a browser works.
 */
const LAN_EXPLAINER_PAGE =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>ohmail</title></head><body>" +
  "<p>This address serves the ohmail mail API for apps on your network — it is not a web " +
  "page. A browser cannot use it: browsers require a secure HTTPS connection for a network " +
  "address, and this connection is plain HTTP. To read mail in a browser on another device, " +
  "use the Tailscale address shown in the ohmail desktop app under Settings → Devices.</p>" +
  "</body></html>";

/**
 * Serve one non-API request on the LAN door. App routes get {@link LAN_EXPLAINER_PAGE}; asset
 * paths are honestly absent (nothing is packaged for this door, by the ruling above); writes to
 * unknown paths are the app's own 404 shape.
 */
export function serveLanFallback(req: Request): Response {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return refuse(404, "not_found", "no route matches this path");
  }
  const pathname = new URL(req.url).pathname;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (lastSegment.includes(".")) {
    return refuse(404, "not_found", "this door serves no browser client assets");
  }
  return new Response(method === "HEAD" ? null : LAN_EXPLAINER_PAGE, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": HOST_CLIENT_CSP,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/** What `maybeStartLanListener` needs of a sidecar — structural, so no import cycle exists. */
export interface LanDoor {
  readonly hostState: Pick<HostState, "armed" | "port">;
  readonly lanState: LanState;
  handleLan?(req: Request): Promise<Response>;
}

/**
 * The production mount: bind the LAN door iff host mode is armed AND the operator chose an
 * address AND a port exists. Anything less is silence or a named degradation — never a crash,
 * and never a socket:
 *
 *  · LAN not asked for (or refused at resolve, already logged) ⇒ `null`, silently — the armed
 *    boot without this knob is byte-identical to the loopback-only one's.
 *  · armed with an address but no port ⇒ `null` + `host_lan_skipped` naming the missing knob.
 *  · a bind failure ⇒ `null` + `host_lan_listen_failed`; every other door keeps serving.
 */
export async function maybeStartLanListener(
  door: LanDoor,
  log: Diagnostic,
): Promise<LanListener | null> {
  const { address } = door.lanState;
  if (!door.hostState.armed || door.handleLan === undefined || address === null) return null;
  if (door.hostState.port === null) {
    log("host_lan_skipped", {
      reason: "same-network access is configured with an address but no OHMAIL_HOST_PORT; " +
        "there is nothing to bind, so the LAN door stays closed",
    });
    return null;
  }
  try {
    const listener = await startLanListener({
      handle: (req) => door.handleLan!(req),
      address,
      port: door.hostState.port,
      log,
    });
    // The PORT only, never the address: the log census keeps identifying values off every line,
    // and the chosen interface address identifies the operator's network. The shell knows the
    // address anyway — it configured it.
    log("host_lan_listening", { port: listener.port });
    return listener;
  } catch (err) {
    log("host_lan_listen_failed", {
      err,
      reason: "the LAN door could not bind the chosen interface; every other door keeps " +
        "serving and same-network access is off for this launch",
    });
    return null;
  }
}
