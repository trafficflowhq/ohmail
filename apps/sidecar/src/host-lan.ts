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
 * THE LAN DOOR — the no-Tailscale fallback: an explicit second bind to ONE operator-chosen LAN
 * interface, serving the desktop-host API and nothing else (Phase 3).
 *
 * ── IT SERVES TLS, AND IT USED TO SERVE PLAIN HTTP ───────────────────────────────────────────
 *
 * This door existed for exactly one client — a phone's NATIVE app — and that client could not
 * speak to it at all. A release Android build (`targetSdk 36`) permits no cleartext and refuses
 * the socket before opening it; iOS App Transport Security refuses the same load by default. The
 * door was reachable only from DEBUG builds, whose manifest carries `usesCleartextTraffic`, which
 * is why the whole path looked live for its whole life. So the transport changed: the door now
 * presents a persistent self-signed key of its own ({@link LanIdentity},
 * `host-lan-tls.ts`), and **plain HTTP is no longer served to the network at all** — there is no
 * second cleartext socket and no fallback to one, because a fallback is a downgrade an attacker
 * on the same network gets to choose.
 *
 * The trust is the pairing ceremony's, not a certificate authority's: the pairing link carries
 * this key's SPKI fingerprint and the phone pins it. `host-lan-tls.ts` argues what that enforces
 * and what it deliberately does not (no chain, no name, no expiry), and why a real certificate is
 * not available for a DHCP address.
 *
 * **The loopback door is untouched and stays plain HTTP** (`host-listener.ts`): `tailscale serve`
 * terminates TLS in front of it with a real MagicDNS certificate, so TLS there would be a second
 * termination for nothing. Two doors, two transports, one reason each.
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
 * The trade this fallback still makes, stated: the door is only reachable to whoever is on the
 * network the operator chose to serve on, and the TLS above authenticates the DOOR to a paired
 * phone — it does not make the network trustworthy. What it does buy is that nothing on that
 * network can read or rewrite the mail in flight, which is the property plain HTTP did not have
 * and which is why the default remains Tailscale-only.
 */

/** What `OHMAIL_LAN_BIND` resolved to — one address, or one surfaced refusal. */
export interface LanState {
  /** The IPv4 interface literal the LAN door binds, or `null` when LAN is off. */
  address: string | null;
  /** Why the LAN half is off although it was asked for. Fixed text, never the value. */
  reason: string | null;
}

/**
 * Could this string be one unicast IPv4 interface address? The SHAPE half of the bind rules,
 * shared by the resolve and the bind so the two can never disagree:
 *
 *  · not loopback (`127/8` — that is the host door's own bind),
 *  · not `0/8` (the unspecified/wildcard block — "every interface", which nobody chose),
 *  · first octet under 224 — that refuses multicast (`224/4`), the reserved block (`240/4`)
 *    AND `255.255.255.255`, the limited-broadcast address some kernels bind exactly like the
 *    wildcard while the kernel echo still reports the address as given. No unicast interface
 *    address lives above 223.
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
 * The page a BROWSER gets on this door — the honest explainer, in place of the client the
 * Tailscale door serves. Script-free under the same policy, so this page can never become the
 * exposure the real client is defended against, and every sentence is a checked claim.
 *
 * ── THE SENTENCE CHANGED WHEN THE TRANSPORT DID, AND SO DID WHEN A BROWSER SEES IT ───────────
 *
 * It used to say "this connection is plain HTTP", which was true and is now false. The reason a
 * browser still cannot use this address is no longer the scheme — it is that the certificate is
 * self-signed, so a browser shows its interstitial first and, past it, the served client's
 * `[SecureContext]`-gated dependencies (`crypto.randomUUID`, `navigator.locks`,
 * `navigator.clipboard` — the audit above) still would not have a trusted origin to run on.
 *
 * A person who clicks through the warning therefore lands on this page rather than on a broken
 * mail client, which is the same outcome as before by a different route. That interstitial is a
 * real cost of the change and it is accepted deliberately: the alternative is keeping a cleartext
 * socket alive so that an explainer can be read without a click, on a door whose actual client
 * refuses cleartext.
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
 * The production mount: bind the LAN door iff host mode is armed AND the operator chose an
 * address AND a port exists. Anything less is silence or a named degradation — never a crash,
 * and never a socket:
 *
 *  · LAN not asked for (or refused at resolve, already logged) ⇒ `null`, silently — the armed
 *    boot without this knob is byte-identical to the loopback-only one's.
 *  · armed with an address but no port ⇒ `null` + `host_lan_skipped` naming the missing knob.
 *  · a bind failure ⇒ `null` + `host_lan_listen_failed`; every other door keeps serving.
 *
 * A SUCCESSFUL bind is followed by one more question, because binding is not reaching: if this
 * computer's own firewall is holding the port shut, the door is up and useless and the pane must
 * not claim otherwise. See `host-firewall.ts` — in particular why this is a FILE READ and not the
 * self-probe everyone reaches for first. The listener is returned either way: the door is bound,
 * the firewall is the operator's to open, and refusing to serve over it would help nobody.
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

    // ── BOUND IS NOT REACHABLE, AND THE ANSWER HAS TO BE ABLE TO CHANGE ──────────────────────
    //
    // The check re-runs on a timer, and that is a correction rather than a refinement. The first
    // version evaluated the firewall ONCE at bind: it printed `sudo ufw allow <port>/tcp`, the
    // operator ran it, and the warning stayed up until the engine was restarted — because nothing
    // ever asked again. Review caught it, and it is the worst shape a remedy can have: the app
    // tells somebody how to fix a thing and then cannot see that they did.
    //
    // Polled in BOTH directions, and only a CHANGE is announced. Recovery re-emits
    // `host_lan_listening`, which is the same signal the bind emitted, so the pane and the tray
    // return to serving through the path they already have; a firewall closed while the app runs
    // emits the blocked line. Nothing is logged while the verdict is steady, so an ordinary
    // machine's log is unchanged. The files are three small reads.
    //
    // `unitActive` is null in production deliberately: asking the service manager costs a
    // subprocess on every poll, and `ufw disable` — the supported way off — writes `ENABLED=no`
    // into the file this already reads. The seam stays for the cases a test needs to state.
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
