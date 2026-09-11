import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { makeHttpServer } from "@trafficflow/core/adapters/http-host";
import {
  createAdmission,
  HOST_BODY_MAX_BYTES,
  HOST_HEADERS_TIMEOUT_MS,
  HOST_REQUEST_TIMEOUT_MS,
  HOST_SHUTDOWN_GRACE_MS,
  type Admission,
  type HostState,
} from "./host-listener.js";
import {
  interfaceForAddress,
  readUfwSources,
  ufwVerdict,
  type UfwSources,
  type UfwVerdict,
} from "./host-firewall.js";
import { HOST_CLIENT_CSP } from "./host-static.js";
import type { LanIdentity } from "./host-lan-tls.js";
import type { Diagnostic } from "./log.js";

/**
 * The LAN door — the no-Tailscale fallback: an explicit second bind to ONE operator-chosen LAN
 * interface, serving the desktop-host API and nothing else (Phase 3). It serves TLS now, not plain
 * HTTP: its only client (a phone's native app) refuses cleartext (targetSdk 36 / iOS ATS), so it
 * presents a persistent self-signed key ({@link LanIdentity}) with no cleartext fallback; trust is
 * the pairing pin. It is API-ONLY by audit: a LAN address is insecure-context HTTP, where
 * `crypto.randomUUID`, `navigator.locks`, `navigator.clipboard` are absent and `normalizeOrigin`
 * refuses IP literals — so it serves native clients, refuses a browser mutation cross-site, and shows
 * a browser a script-free page. One explicit IPv4 interface (never `0.0.0.0`/loopback/IPv6), opt-in on opt-in.
 */

/** What `OHMAIL_LAN_BIND` resolved to — one address, or one surfaced refusal. */
export interface LanState {
  /** The IPv4 interface literal the LAN door binds, or `null` when LAN is off. */
  address: string | null;
  /** Why the LAN half is off although it was asked for. Fixed text, never the value. */
  reason: string | null;
}

/**
 * Could this string be one unicast IPv4 interface address? The SHAPE half of the bind rules, shared
 * by the resolve and the bind so the two can never disagree: not loopback (`127/8`, the host door's
 * own bind), not `0/8` (the wildcard block — "every interface", which nobody chose), and first octet
 * under 224 — which refuses multicast (`224/4`), the reserved block (`240/4`) and
 * `255.255.255.255`, the limited-broadcast address some kernels bind like the wildcard while the
 * echo still reports it as given. No unicast interface address lives above 223.
 */
function isUnicastInterfaceShape(address: string): boolean {
  if (!isIPv4(address)) return false;
  const first = Number(address.split(".", 1)[0]);
  return first >= 1 && first <= 223 && first !== 127;
}

/** Is this address actually assigned to one of THIS machine's interfaces, right now? */
function isAssignedHere(address: string): boolean {
  return Object.values(networkInterfaces()).some((list) =>
    (list ?? []).some((iface) => iface.address === address));
}

/**
 * THE ONE READING of the LAN knob. Pure, never throws; a refusal names the variable and the
 * rule, never the value (the same discipline as `resolveHostConfig`, and for the same reason).
 * Membership in the machine's interface list is deliberately NOT checked here — this runs at
 * composition time and must stay pure; the BIND is where membership is a fact worth reading
 * ({@link startLanListener}), and an unassigned address degrades there with the named line.
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
  if (!isUnicastInterfaceShape(trimmed)) {
    return {
      address: null,
      reason: "OHMAIL_LAN_BIND must be one bare unicast IPv4 address of a network interface on " +
        "this computer — never the wildcard, never loopback (that is the host door's own " +
        "bind), never multicast/broadcast, never a hostname or a port, and not IPv6 in this " +
        "version; same-network access is off for this launch",
    };
  }
  return { address: trimmed, reason: null };
}

/**
 * How often the firewall verdict is re-read while the LAN door is up. Short enough that an
 * operator who runs the printed command sees the pane clear while they are still looking at it —
 * which is the whole reason the re-check exists.
 */
const FIREWALL_RECHECK_MS = 15_000;

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
  /**
   * THE DOOR'S OWN KEY — required, and required as a TYPE rather than checked at runtime.
   *
   * An optional field here would mean a caller that forgot it silently gets the cleartext door
   * back, which is the exact defect this parameter exists to close, on the one code path where
   * nothing would fail: the socket binds, the log line prints, and the phone refuses it in the
   * field. Making it non-optional means that mistake does not compile.
   */
  identity: LanIdentity;
  log?: Diagnostic;
  /** The process-wide admission budget — see `createAdmission`. Absent, a private one. */
  admission?: Admission;
  /** TEST SEAM — production takes {@link HOST_SHUTDOWN_GRACE_MS}. */
  graceMs?: number;
  /** TEST SEAM — see `AdapterOptions.connectionsCheckingIntervalMs`. */
  connectionsCheckingIntervalMs?: number;
}): Promise<LanListener> {
  if (!isUnicastInterfaceShape(opts.address)) {
    return Promise.reject(new Error(
      "the LAN door binds one explicit unicast IPv4 interface address; loopback, the wildcard, " +
        "multicast/broadcast and everything that is not an interface literal are refused",
    ));
  }
  if (!isAssignedHere(opts.address)) {
    // MEMBERSHIP, not just shape: the kernel refuses most unassigned unicast binds on its own
    // (EADDRNOTAVAIL), but the addresses a kernel treats as specially bindable are exactly the
    // dangerous ones — so the rule is stated positively: the address must be one this machine's
    // interfaces hold RIGHT NOW, the same list the ceremony offered the choice from.
    return Promise.reject(new Error(
      "the LAN door binds only an address assigned to one of this machine's own network " +
        "interfaces, and this address is not one of them right now",
    ));
  }
  const admission = opts.admission ?? createAdmission();
  const tracked = admission.wrap(opts.handle);
  const drained = (): Promise<void> => admission.drained();
  const server = makeHttpServer(tracked, {
    bodyMaxBytes: HOST_BODY_MAX_BYTES,
    headersTimeoutMs: HOST_HEADERS_TIMEOUT_MS,
    requestTimeoutMs: HOST_REQUEST_TIMEOUT_MS,
    // The transport half of this door. Same caps, same timeouts, same drain as the loopback
    // door — the ONLY difference between the two listeners is this line.
    tls: { key: opts.identity.key, cert: opts.identity.cert },
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
 * The page a BROWSER gets on this door — the honest explainer, in place of the client the Tailscale
 * door serves. Script-free under the same policy, so it can never become the exposure the real
 * client is defended against, and every sentence is a checked claim. The sentence changed when the
 * transport did: it used to say "this connection is plain HTTP" (now false); a browser still cannot
 * use this address because the certificate is self-signed, so the interstitial shows first and past
 * it the client's `[SecureContext]`-gated dependencies still have no trusted origin. A person who
 * clicks through lands here rather than on a broken mail client — the same outcome by a different
 * route, and the interstitial is a real cost accepted deliberately over keeping a cleartext socket alive.
 */
const LAN_EXPLAINER_PAGE =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>ohmail</title></head><body>" +
  "<p>This address serves the ohmail mail API for the ohmail app on your phone — it is not a " +
  "web page. A browser cannot use it: this computer secures the connection with a key of its " +
  "own that the ohmail app checks when you pair it, and a browser has no way to know that key, " +
  "so it warns and then has no trusted origin to run the mail client on. To read mail in a " +
  "browser on another device, use the Tailscale address shown in the ohmail desktop app under " +
  "Settings → Devices.</p>" +
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
  /**
   * The door's TLS identity, resolved once by the engine that owns the data directory. `null`
   * means the identity could not be established — which turns the LAN door OFF, and never into a
   * cleartext one. `lanState.reason` carries the sentence in that case.
   */
  readonly lanIdentity?: LanIdentity | null;
}

/**
 * The production mount: bind the LAN door iff host mode is armed AND the operator chose an address
 * AND a port exists. Anything less is silence or a named degradation, never a crash and never a
 * socket: LAN not asked for (or refused at resolve) ⇒ `null` silently, byte-identical to the
 * loopback-only boot; armed with an address but no port ⇒ `null` + `host_lan_skipped`; a bind
 * failure ⇒ `null` + `host_lan_listen_failed`, every other door still serving. A SUCCESSFUL bind is
 * followed by one more question, because binding is not reaching: if this computer's own firewall is
 * holding the port shut the door is up and useless and the pane must not claim otherwise (see
 * `host-firewall.ts` — a FILE READ, not the self-probe). The listener is returned either way.
 */
export async function maybeStartLanListener(
  door: LanDoor,
  log: Diagnostic,
  admission?: Admission,
  /** TEST SEAM — production reads the real files; a test supplies its own three bodies. */
  firewallSources?: () => UfwSources,
  /** TEST SEAM — production takes {@link FIREWALL_RECHECK_MS}. */
  recheckMs?: number,
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
  // NO IDENTITY, NO SOCKET — and this is the branch that must never grow an `else`. The engine
  // has already logged WHY (`host_lan_identity_*`); what matters here is that the answer to "the
  // door has no key" is a closed door, not a plain-HTTP one. A cleartext fallback would bind
  // cleanly, log `host_lan_listening`, satisfy every state this module reports, and be refused
  // by the only client it exists for — the original defect, re-armed as a fallback.
  const identity = door.lanIdentity ?? null;
  if (identity === null) {
    log("host_lan_skipped", {
      reason: "same-network access has no key to secure the connection with, so the door stays " +
        "closed; it is never served without one",
    });
    return null;
  }
  try {
    const listener = await startLanListener({
      handle: (req) => door.handleLan!(req),
      address,
      port: door.hostState.port,
      identity,
      log,
      ...(admission !== undefined ? { admission } : {}),
    });
    // The PORT only, never the address: the log census keeps identifying values off every line,
    // and the chosen interface address identifies the operator's network. The shell knows the
    // address anyway — it configured it.
    log("host_lan_listening", { port: listener.port });

    // Bound is not reachable, and the answer has to be able to change. The check re-runs on a timer,
    // a correction rather than a refinement: the first version evaluated the firewall ONCE at bind,
    // so it printed `sudo ufw allow <port>/tcp`, the operator ran it, and the warning stayed up until
    // restart — the worst shape a remedy can have, telling somebody how to fix a thing and then not
    // seeing that they did. Polled in BOTH directions and only a CHANGE is announced: recovery
    // re-emits `host_lan_listening`, a firewall closed while running emits the blocked line, and a
    // steady verdict logs nothing. `unitActive` is null in production deliberately — asking the
    // service manager costs a subprocess per poll, and `ufw disable` writes the file this already reads.
    const readSources = firewallSources ?? readUfwSources;
    const boundInterface = interfaceForAddress(address);
    /** The firewall as it stands. Pure of logging, so the caller decides what is worth saying. */
    const evaluate = (): UfwVerdict =>
      ufwVerdict({
        port: listener.port,
        address,
        sources: readSources(),
        unitActive: null,
        boundInterface,
      });
    // The remedy is the whole value of this line, and it names a PORT, never the interface —
    // same rule as the listening line above.
    const announce = (remedy: string): void => {
      log("host_lan_firewall_blocked", {
        port: listener.port,
        reason: "same-network access is bound, but this computer's firewall is not admitting the " +
          "port, so nothing on the network can reach it; the operator opens it with " + remedy,
      });
    };
    const first = evaluate();
    let blocked = first.state === "blocks";
    if (first.state === "blocks") announce(first.remedy);
    const recheck = setInterval(() => {
      const next = evaluate();
      // ONLY A POSITIVE VERDICT MAY CLEAR A WARNING. `unreadable` is not evidence the firewall
      // opened — it is evidence of nothing — and treating it as recovery would announce a
      // reachable door because a file briefly could not be read. Whatever stands, stands.
      if (next.state === "unreadable") return;
      // Only a CHANGE is announced — a steady verdict says nothing, in either direction.
      if (next.state === "blocks" && !blocked) announce(next.remedy);
      else if (next.state !== "blocks" && blocked) log("host_lan_listening", { port: listener.port });
      blocked = next.state === "blocks";
    }, recheckMs ?? FIREWALL_RECHECK_MS);
    recheck.unref?.();
    return {
      port: listener.port,
      close: async () => {
        clearInterval(recheck);
        await listener.close();
      },
    };
  } catch (err) {
    log("host_lan_listen_failed", {
      err,
      reason: "the LAN door could not bind the chosen interface; every other door keeps " +
        "serving and same-network access is off for this launch",
    });
    return null;
  }
}
