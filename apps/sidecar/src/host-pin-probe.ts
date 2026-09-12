import { X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { Readable } from "node:stream";
import { connect as tlsConnect, type PeerCertificate } from "node:tls";

import { spkiFingerprint } from "./host-lan-tls.js";
import type { Diagnostic } from "./log.js";

/**
 * ═══ PINNING ANOTHER MACHINE'S DESKTOP ═════════════════════════════════════════════════════════
 *
 * A desktop set up as a CLIENT opens a mailbox held by another computer's desktop. That other
 * machine serves its door over TLS with a key of its own (`host-lan-tls.ts`), because no
 * certificate authority will vouch for an address a router handed out this morning. The trust
 * therefore travels in the pairing ceremony: the link carries `SHA-256(SubjectPublicKeyInfo)` of
 * the door's key, and that fingerprint — nothing else — is what this client will accept.
 *
 * ── WHY THIS IS ONE FILE, AND WHY IT IS THE ONLY ONE ───────────────────────────────────────────
 *
 * Node cannot validate a self-signed leaf from a fingerprint alone. There is no "verify against
 * this pin" option: `tls.connect` either checks a chain against a trust store or it checks
 * nothing. So the bootstrap has to see the certificate BEFORE it can judge it, and the only way to
 * see it is a handshake with verification off. That is a genuinely dangerous option and it appears
 * exactly once in this whole directory — here, inside {@link probeHostPin}, on a socket that
 * writes ZERO application bytes and is destroyed the instant the certificate has been read.
 * `host-pin-census.test.ts` is what keeps that count at one.
 *
 * Everything after the bootstrap is ordinary verified TLS. The leaf is written to the data
 * directory and every later connection passes it as the trust anchor (`ca: [leaf]`), so
 * `rejectUnauthorized` stays TRUE and a chain that does not lead to that exact certificate is
 * refused by OpenSSL, not by us.
 *
 * ── AND WHY `checkServerIdentity` IS REPLACED RATHER THAN SATISFIED ────────────────────────────
 *
 * The door's certificate names `ohmail-desktop-host.invalid` — a name RFC 2606 guarantees can
 * never be delegated to anyone, chosen precisely so the certificate asserts NOTHING about where it
 * is served from. The client dials an IP address or a tailnet name, neither of which is in that
 * certificate, so the default hostname check fails every time and would have to be turned off.
 *
 * Turning it off is not what happens here. It is REPLACED by the check that is actually meaningful
 * for a pinned door: the peer's public key must hash to the fingerprint the ceremony carried. That
 * is a stronger statement than a name — a name says "somebody who could get a certificate for this
 * label", the pin says "the key the person read off the other machine's screen" — and it is the
 * same predicate the bootstrap used, so the two cannot disagree about what this door is.
 *
 * ── NEVER `NODE_EXTRA_CA_CERTS` ────────────────────────────────────────────────────────────────
 *
 * That variable is process-wide: it widens who may satisfy verification for EVERY connection the
 * engine makes, and this engine also holds a hosted session. A trust anchor for one machine on
 * somebody's LAN must not become a trust anchor for the account's own service. The anchor here is
 * attached to ONE agent, used by ONE base, and is a value in memory rather than an environment
 * variable a child process inherits. `apps/desktop/src-tauri/src/config.rs` composes that variable
 * only for the self-hosted door and the census in this file's test keeps it out of here.
 */

/** The pinned door's certificate, cached beside the mirror. Public bytes; the KEY never leaves the host. */
export const HOST_LEAF_FILE = "host-door.cert.pem";

/**
 * How long the bootstrap waits for a handshake. Short, because somebody is watching a spinner
 * having just pasted a link, and a machine that is not on is the common answer rather than a rare
 * one.
 */
export const PIN_PROBE_DEADLINE_MS = 12_000;

/**
 * WHAT A PERSON READS WHEN THE KEY IS NOT THE ONE THEY PAIRED WITH.
 *
 * A fixed sentence, composed here and never from the peer's own values: whatever answered is
 * unauthenticated by definition at this point in the ceremony, so nothing it said may be echoed
 * into a message a person will act on. It does not offer a way to continue, because there is no
 * safe way to continue — a changed key is either the other machine having been reinstalled (in
 * which case its Devices pane prints a fresh link) or somebody else answering (in which case
 * proceeding hands them the account).
 */
export const PIN_CHANGED_SENTENCE =
  "The computer that answered is not the one this link came from — its identity key is " +
  "different. If you reinstalled it, print a new pairing code from its Settings → Devices and " +
  "use that. If you did not, do not continue: something else is answering at this address.";

/**
 * `SHA-256(SubjectPublicKeyInfo)`, base64url, of a certificate's key — the pin, as the link
 * carries it.
 *
 * Deliberately NOT a second spelling of the hash. It hands the key to `spkiFingerprint`, which is
 * the one derivation in this repository and is what the HOST composes its own link from. Two
 * spellings would agree on the day they were written and the pairing would break on the day either
 * moved; one means a mutation reddens both sides at once.
 *
 * The certificate is parsed with the platform's own X.509 reader rather than by reaching for
 * `PeerCertificate.pubkey`: the DER of the whole certificate is the only field guaranteed present
 * on every peer object, and deriving the key from it is the same operation the host performs on
 * the key it generated.
 */
export function pinOfCertificate(der: Buffer): string {
  return spkiFingerprint(new X509Certificate(der).publicKey);
}

/** The bootstrap's answer. A refusal names what to do and never echoes what answered. */
export type HostPinOutcome =
  | { ok: true; leafPem: string; pin: string }
  | { ok: false; code: "pin_changed" | "unreachable" | "no_certificate"; message: string };

export interface HostPinProbeOptions {
  /** Host to dial — a name or an IP literal, as the pairing link named it. */
  host: string;
  port: number;
  /** The fingerprint from the link. The whole of what this connection is judged against. */
  pin: string;
  /** Where the accepted leaf is cached. Created if absent. */
  dataDir: string;
  log?: Diagnostic;
  timeoutMs?: number;
}

/**
 * SEE THE DOOR'S CERTIFICATE, JUDGE IT AGAINST THE PIN, AND KEEP IT IF IT MATCHES.
 *
 * ── THE THREE PROPERTIES THAT MAKE THE UNVERIFIED HANDSHAKE SAFE ───────────────────────────────
 *
 *  1. **Nothing is sent.** The socket is never written to. There is no request, no header, no
 *     token — a peer that fails the pin learns only that something opened a TLS connection, which
 *     it would learn from a port scan. The credential (the pairing token) is spent afterwards,
 *     over the VERIFIED connection, and only if this returned `ok`.
 *  2. **Nothing is kept on a mismatch.** The leaf is written after the comparison, never before,
 *     so a refused peer leaves no trust anchor behind for a later connection to pick up.
 *  3. **The handshake is PROVEN to have happened.** `encrypted` and a non-empty certificate are
 *     both asserted before anything is judged. A connection event that fires on the TCP connect
 *     rather than on the handshake is indistinguishable from cleartext to anything that only
 *     measures timing, so the evidence taken here is the peer's own certificate — a thing that
 *     cannot exist without a completed TLS handshake.
 */
export async function probeHostPin(opts: HostPinProbeOptions): Promise<HostPinOutcome> {
  const timeoutMs = opts.timeoutMs ?? PIN_PROBE_DEADLINE_MS;
  const unreachable = (): HostPinOutcome => ({
    ok: false,
    code: "unreachable",
    message:
      `Could not reach ${opts.host}. Check that computer is on, awake, and on the same network ` +
      "as this one (or that both are on your tailnet).",
  });

  let der: Buffer;
  try {
    der = await peerCertificate(opts.host, opts.port, timeoutMs);
  } catch (err) {
    // The HOST is on the line and the pin is not: which machine could not be reached is what an
    // operator needs, and a fingerprint in a log is a value somebody may then compare by eye
    // against a screen, which is a ceremony this file deliberately does not invite.
    opts.log?.("host_pin_probe_failed", { err, reason: "the paired computer did not complete a handshake" });
    return unreachable();
  }
  if (der.length === 0) {
    return {
      ok: false,
      code: "no_certificate",
      message:
        `Something answered at ${opts.host}, but it did not present an identity ohmail can check. ` +
        "Check the address, and that it is the pairing link that computer printed.",
    };
  }

  const seen = pinOfCertificate(der);
  if (seen !== opts.pin) {
    // `changed: true` and NOT the two fingerprints. Which key answered is the identifying fact
    // about a machine on somebody's network, and the sidecar log census exists to keep exactly
    // that class of value off the line.
    opts.log?.("host_pin_mismatch", { changed: true });
    return { ok: false, code: "pin_changed", message: PIN_CHANGED_SENTENCE };
  }

  const leafPem = new X509Certificate(der).toString();
  mkdirSync(opts.dataDir, { recursive: true });
  writeFileSync(join(opts.dataDir, HOST_LEAF_FILE), leafPem, { mode: 0o600 });
  opts.log?.("host_pin_accepted", { changed: true });
  return { ok: true, leafPem, pin: seen };
}

/**
 * The cached leaf, or null when this install has never completed a bootstrap against this door.
 *
 * Null is not an error and must never be read as one by a caller that then connects anyway: a
 * launch with no leaf has no trust anchor, and the only correct move is to run the bootstrap
 * again (the pin is in the door record, so this needs nothing from a person).
 */
export function loadHostLeaf(dataDir: string): string | null {
  try {
    const pem = readFileSync(join(dataDir, HOST_LEAF_FILE), "utf8");
    return pem.includes("BEGIN CERTIFICATE") ? pem : null;
  } catch {
    return null;
  }
}

/** THE ONE UNVERIFIED HANDSHAKE. Reads the certificate, writes nothing, and hangs up. */
function peerCertificate(host: string, port: number, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const socket = tlsConnect({
      host,
      port,
      /* THE ONE SITE. Everything above explains why, and `host-pin-census.test.ts` asserts this
         file is the only one in `apps/sidecar/src` that contains this option at all. */
      rejectUnauthorized: false,
      /* SNI is a NAME, and an IP literal is not one — the standard forbids it and a server may
         reject the handshake outright. The door serves one certificate regardless of what is
         asked for, so omitting SNI costs nothing and asking for a literal could cost the
         connection. */
      ...(isIpLiteral(host) ? {} : { servername: host }),
    });

    const timer = setTimeout(() => finish(() => { reject(new Error("the handshake did not complete in time")); }), timeoutMs);
    socket.on("error", (err) => { finish(() => { reject(err); }); });
    socket.on("close", () => { finish(() => { reject(new Error("the connection closed before a certificate arrived")); }); });
    socket.on("secureConnect", () => {
      // PROOF OF A HANDSHAKE, not a timing inference: a peer certificate cannot exist without one,
      // and `encrypted` is the socket's own answer about which kind of socket it is.
      if (!socket.encrypted) {
        finish(() => { reject(new Error("the connection was not encrypted")); });
        return;
      }
      const cert = socket.getPeerCertificate(false);
      const raw = cert && typeof cert === "object" ? cert.raw : undefined;
      finish(() => { resolve(Buffer.isBuffer(raw) ? raw : Buffer.alloc(0)); });
    });
  });
}

/** `1.2.3.4` or a bracketed/bare IPv6 literal — the shapes SNI may not carry. */
function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":") || host.startsWith("[");
}

/**
 * IS THE KEY ON THE OTHER END THE ONE THE CEREMONY CARRIED? — `checkServerIdentity`'s replacement,
 * exported so it can be watched failing on its own rather than only through a connection.
 *
 * ── THE HONEST LIMIT, STATED BECAUSE IT WOULD OTHERWISE READ AS A GUARANTEE ────────────────────
 *
 * At the call site below, a MISMATCH IS UNREACHABLE TODAY. The trust anchor is the door's own leaf,
 * so a chain that verifies is a chain of exactly one certificate — the anchor itself — and a
 * certificate that is not the anchor never reaches this function: OpenSSL has already refused it.
 * The rule of this repository is that a condition whose contrary state is unreachable is either
 * removed or made reachable, because a later reader takes it for a guarantee.
 *
 * It is kept, and made reachable HERE, for a reason that is worth naming rather than implying:
 * this function is what replaces the hostname check, and the hostname check has to be replaced —
 * the door's certificate names `ohmail-desktop-host.invalid`, so the default check refuses every
 * connection. Something must occupy that slot. What occupies it decides what happens the day the
 * anchor stops being a bare leaf (a real authority, an intermediate, a rotation scheme that keeps
 * a signing key), and the two candidates are "return undefined" — accept anything the anchor
 * vouches for, hostname unchecked, which is a genuinely weaker door — and this, which keeps the
 * pin decisive whatever the anchor becomes. Its two outcomes are watched directly in
 * `host-pin-probe.test.ts`.
 */
export function pinnedIdentity(pin: string): (host: string, cert: PeerCertificate) => Error | undefined {
  return (_host: string, cert: PeerCertificate): Error | undefined => {
    const raw = cert && typeof cert === "object" ? cert.raw : undefined;
    if (!Buffer.isBuffer(raw) || raw.length === 0) return new Error("the door presented no certificate");
    if (pinOfCertificate(raw) === pin) return undefined;
    return new Error(PIN_CHANGED_SENTENCE);
  };
}

export interface PinnedFetchOptions {
  /** The certificate {@link probeHostPin} accepted — the ONLY trust anchor this client will use. */
  leafPem: string;
  /** The fingerprint from the link, re-checked on every single connection. */
  pin: string;
  /**
   * RE-RUN THE BOOTSTRAP AND HAND BACK A FRESH LEAF — the recovery for a door that has restarted.
   *
   * ── THE FACT THAT MAKES THIS NECESSARY, MEASURED RATHER THAN ASSUMED ────────────────────────
   *
   * The host does NOT keep its certificate. `ensureLanIdentity` keeps the KEY for ever and rebuilds
   * the certificate around it on every launch, with a fresh random serial — deliberately, so that a
   * corrupt certificate file costs a rebuild instead of un-pairing a household. The fingerprint is
   * the key's and does not move; the bytes do.
   *
   * So a cached leaf is a cache and never an identity. Measured against the real thing: pin a
   * client to a door, restart the door, and the pinned connection fails
   * `DEPTH_ZERO_SELF_SIGNED_CERT` — the anchor no longer covers the certificate being served, even
   * though the key is the same and the pin still matches. Without a recovery a client would pair
   * once, work until the other machine reboots, and then refuse for ever with a TLS error that
   * names nothing a person can act on.
   *
   * The recovery is the bootstrap, which judges by the PIN — the durable half — and re-persists the
   * new leaf. It is attempted at most ONCE per request and only for a verification failure, so a
   * door whose key genuinely changed is refused rather than retried into acceptance: the bootstrap
   * compares the pin and returns nothing on a mismatch.
   *
   * Absent ⇒ no recovery, and a rotated door simply fails. That is the correct reading for a
   * caller that has no way to re-probe (a test driving one connection), and it is why this is
   * optional rather than defaulted to something.
   */
  refreshLeaf?: () => Promise<string | null>;
  log?: Diagnostic;
}

/**
 * A `fetch` that will talk to ONE door and to nothing else.
 *
 * ── WHY THIS IS HAND-BUILT ON `node:https` ─────────────────────────────────────────────────────
 *
 * The platform's own `fetch` has no seam for a trust anchor: its TLS options belong to a
 * dispatcher this package does not depend on, and adding that dependency to pin one connection
 * would put a second HTTP client in a published artifact. `node:https` already carries every
 * option needed and is in the runtime. What it does not carry is the `Response` shape the sidecar's
 * callers are written against, so this composes one — and the composition is the whole of the
 * module's remaining risk, which is why each of the following is a deliberate decision rather than
 * an omission:
 *
 *  · **Redirects are NOT followed.** `fetch` follows them and re-sends a body on 307/308, which the
 *    write-through proxy already had to guard against for the hosted door. A pinned door answering
 *    a redirect is answering something this client will not chase: the 3xx is handed back as it
 *    stands and the caller treats it as the refusal it is.
 *  · **`set-cookie` survives.** Node hands repeated headers as an array, and each value is appended
 *    separately so `getSetCookie()` returns them apart. Joining them would be unrecoverable — a
 *    cookie's own `Expires=Wed, 09 Jun 2027` contains the separator.
 *  · **The body streams.** The wake channel holds one response open and reads it with
 *    `res.body.getReader()`, so the body is the incoming message itself rather than a buffer
 *    collected first; a buffering implementation would have deadlocked that stream and looked like
 *    a host that never sends anything.
 *  · **A body shape this cannot send is REFUSED BY NAME.** Silently sending nothing for a body
 *    kind that was not anticipated is the absent-configuration-selects-the-quiet-branch failure:
 *    the request would go out empty and the door would answer a validation error about a field the
 *    caller believed it had sent.
 */
export function createPinnedFetch(opts: PinnedFetchOptions): typeof fetch {
  /* THE TRUST ANCHOR IS THE LEAF ITSELF. A self-signed certificate placed in the trust store
     verifies as a chain of one, so `rejectUnauthorized` stays true and OpenSSL — not this file —
     is what refuses anything else. THE NAME is not the identity here and cannot be: the door's
     certificate names a `.invalid` label on purpose, so {@link pinnedIdentity} takes that slot. */
  const agentFor = (leafPem: string): Agent =>
    new Agent({ ca: [leafPem], keepAlive: true, checkServerIdentity: pinnedIdentity(opts.pin) });

  /* SHARED, AND REPLACED IN PLACE BY A SUCCESSFUL RECOVERY. Each request may attempt at most one
     recovery; a recovery that succeeds is kept, so the requests after a door's restart use the
     fresh anchor instead of each re-probing it. A per-request agent would repair the first request
     and leave every later one to fail and repeat the handshake. */
  let agent = agentFor(opts.leafPem);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url.protocol !== "https:") {
      throw new TypeError(`a pinned connection is https only; refused ${url.protocol}//`);
    }
    const body = bodyBytes(init?.body);
    const headers = new Headers(init?.headers);
    if (body) headers.set("content-length", String(body.byteLength));

    const send = (): Promise<import("node:http").IncomingMessage> =>
      new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const req = httpsRequest(
          url,
          {
            method: init?.method ?? "GET",
            agent,
            headers: Object.fromEntries(headers.entries()),
            ...(init?.signal ? { signal: init.signal } : {}),
          },
          resolve,
        );
        req.on("error", reject);
        if (body) req.end(body);
        else req.end();
      });

    let incoming: import("node:http").IncomingMessage;
    try {
      incoming = await send();
    } catch (err) {
      /* A VERIFICATION FAILURE IS THE ONLY THING RETRIED, and only when a recovery exists. A
         refused connection, a timeout or an abort are answers about the network and repeating the
         bootstrap for them would turn a machine that is off into a loop of handshakes. */
      const refresh = opts.refreshLeaf;
      if (!refresh || !isVerificationFailure(err)) throw err;
      opts.log?.("host_leaf_stale", {
        reason: "the paired computer is serving a certificate this install's cached copy does not " +
          "cover; its identity key is checked again before anything is sent",
      });
      const fresh = await refresh();
      /* NULL means the bootstrap did not accept what answered — a changed key, or an unreachable
         machine. The ORIGINAL failure is what the caller sees, because it is the one that describes
         the connection that was actually attempted. */
      if (fresh === null) throw err;
      agent = agentFor(fresh);
      incoming = await send();
    }

    const out = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const one of value) out.append(name, one);
      else if (typeof value === "string") out.append(name, value);
    }
    const status = incoming.statusCode ?? 502;
    /* 204/205/304 MAY NOT CARRY A BODY — the `Response` constructor throws on one, which would
       turn a perfectly ordinary "nothing changed" into an exception inside the caller's retry. */
    const bodyless = status === 204 || status === 205 || status === 304;
    if (bodyless) incoming.resume();
    return new Response(bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
      status,
      ...(isPrintable(incoming.statusMessage) ? { statusText: incoming.statusMessage } : {}),
      headers: out,
    });
  };
}

/** `Request` is refused by name rather than mis-sent — see the body rule in the header. */
function urlOf(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  throw new TypeError("a pinned connection takes a URL, not a Request object");
}

/** The body kinds the sidecar actually sends. Anything else is named, never quietly dropped. */
function bodyBytes(body: BodyInit | null | undefined): Buffer | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError(`a pinned connection cannot send a ${body.constructor?.name ?? "value"} body`);
}

/**
 * Was this a TLS VERIFICATION refusal — the shape a rotated certificate makes — rather than a
 * network answer?
 *
 * Read off the CAUSE as well as the error, for `describeProbeFailure`'s reason: a transport failure
 * may arrive wrapped, and reading only the outer error classifies every failure as the same shrug.
 * The set is the one Node raises for a chain it cannot build or trust, plus this module's own
 * refusal — a pin that did not match is returned from `checkServerIdentity` as an `Error`, and
 * Node surfaces it with `ERR_TLS_CERT_ALTNAME_INVALID`'s sibling shape rather than a code of its
 * own, so it is matched by its sentence.
 */
function isVerificationFailure(err: unknown): boolean {
  const codes = new Set([
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_UNTRUSTED",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ]);
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code === "string" && codes.has(code)) return true;
    /* THE PIN'S OWN REFUSAL must NOT be retried — a key that changed is exactly the case the
       ceremony refuses — so it is named here and answered `false`. */
    if ((e as Error)?.message === PIN_CHANGED_SENTENCE) return false;
  }
  return false;
}

/** A reason phrase the `Response` constructor will accept — anything else is dropped, not thrown. */
function isPrintable(text: string | undefined): text is string {
  return typeof text === "string" && text !== "" && /^[\t\x20-\x7e\x80-\xff]*$/.test(text);
}

export interface HostFetchOptions {
  /** The door's origin, as configured — `https://host[:port]`. */
  origin: string;
  /** The fingerprint the pairing link carried. The whole of what this connection is judged against. */
  pin: string;
  /** Where the accepted leaf is cached between launches. */
  dataDir: string;
  log?: Diagnostic;
}

/**
 * THE PINNED SEAM — one `fetch` for everything this install says to its host, with the bootstrap,
 * the cache and the recovery behind it.
 *
 * ── WHY THE LIFECYCLE LIVES HERE AND NOT AT THE CALL SITE ─────────────────────────────────────
 *
 * The engine composes ONE `fetchImpl` and threads it through the bearer client, the mirror, the
 * write-through proxy and the wake channel. That is the property worth protecting: a second way to
 * reach the host is a second place the pin could be forgotten. So everything this needs to decide
 * — is there a cached certificate, does it still cover what is being served, was the identity ever
 * established at all — is decided behind that one function, and the engine passes it along like
 * any other `fetch`.
 *
 * ── A MISSING LEAF IS NOT A FAILED LAUNCH ─────────────────────────────────────────────────────
 *
 * The bootstrap is deferred to the first REQUEST rather than run at construction, and that is a
 * decision about what happens when the other machine is off. An engine that refused to start
 * without a handshake would leave a person looking at a window that will not open, on a laptop
 * whose desktop is asleep, with the mirror they already hold unreadable — the mirror is local and
 * there is nothing wrong with it. Deferring means the app comes up, serves what it has, and the
 * requests that need the host fail with the sentence the probe composed.
 *
 * ── ONE PROBE AT A TIME ───────────────────────────────────────────────────────────────────────
 *
 * The pull loop has several requests in flight, so a host that has just restarted makes all of
 * them fail verification at once. Each starting its own bootstrap would open a handshake per
 * in-flight request at a machine that is already busy coming back. One in-flight probe serves them
 * all — `createCloudAuth`'s single-flight refresh, for the same reason and with the same shape.
 */
export function createHostFetch(opts: HostFetchOptions): typeof fetch {
  const url = new URL(opts.origin);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port === "" ? 443 : Number(url.port);

  let pinned: typeof fetch | null = null;
  let probing: Promise<string | null> | null = null;

  /** Establish (or re-establish) the leaf. One in flight; the result is shared. */
  const establish = (): Promise<string | null> => {
    probing ??= probeHostPin({ host, port, pin: opts.pin, dataDir: opts.dataDir, ...(opts.log ? { log: opts.log } : {}) })
      .then((out) => (out.ok ? out.leafPem : null))
      .finally(() => { probing = null; });
    return probing;
  };

  const build = (leafPem: string): typeof fetch =>
    createPinnedFetch({
      leafPem,
      pin: opts.pin,
      ...(opts.log ? { log: opts.log } : {}),
      /* NOTHING IS REBUILT HERE, and that is worth stating because the obvious line to write is
         `pinned = build(fresh)`. It would be dead: `createPinnedFetch` swaps its OWN agent on a
         successful recovery, and `pinned` holds that same function object, so every later request
         already goes through the repaired anchor. Writing it anyway would be a line no mutation
         can redden — which a later reader takes for the thing that keeps the repair. */
      refreshLeaf: establish,
    });

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (pinned === null) {
      const cached = loadHostLeaf(opts.dataDir);
      const leaf = cached ?? await establish();
      if (leaf === null) {
        /* NAMED, not a generic transport error. This is the state a person can act on — the other
           computer is off, or somewhere else, or is no longer the one this install paired with —
           and a bare socket error would send them to look at this machine. */
        throw new Error(
          `Could not establish a secure connection to ${opts.origin}: its identity could not be ` +
          "confirmed. Check that computer is on and reachable from this one.",
        );
      }
      pinned = build(leaf);
    }
    return pinned(input, init);
  };
}
