import { X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { Readable } from "node:stream";
import { connect as tlsConnect, type PeerCertificate } from "node:tls";

import { spkiFingerprint } from "./host-lan-tls.js";
import type { Diagnostic } from "./log.js";

/**
 * Pinning another machine's desktop. A desktop set up as a CLIENT opens a mailbox held by another
 * computer's desktop, which serves TLS with a key of its own (`host-lan-tls.ts`) because no CA
 * vouches for a DHCP address. Trust travels in the ceremony: the link carries
 * `SHA-256(SubjectPublicKeyInfo)` of the door's key, all this client accepts. Node cannot validate a
 * self-signed leaf from a fingerprint, so the bootstrap must SEE the certificate first — one
 * handshake with verification off, on a socket that writes ZERO bytes and is destroyed at once
 * (`host-pin-census.test.ts` keeps the count at one); every later connection is verified TLS against
 * the stored leaf. `checkServerIdentity` is REPLACED by the pin check. Never `NODE_EXTRA_CA_CERTS`.
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
 * `SHA-256(SubjectPublicKeyInfo)`, base64url, of a certificate's key — the pin, as the link carries
 * it. Deliberately NOT a second spelling of the hash: it hands the key to `spkiFingerprint`, the one
 * derivation in this repository and what the HOST composes its own link from. Two spellings would
 * agree the day they were written and break the pairing the day either moved; one means a mutation
 * reddens both sides at once. The certificate is parsed with the platform's X.509 reader rather than
 * `PeerCertificate.pubkey`: the DER of the whole certificate is the only field guaranteed present on
 * every peer object, and deriving the key from it is the same operation the host performs.
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
 * See the door's certificate, judge it against the pin, and keep it if it matches. Three properties
 * make the unverified handshake safe: (1) NOTHING is sent — the socket is never written to, so a
 * peer that fails the pin learns only that a TLS connection opened, and the token is spent afterwards
 * over the VERIFIED connection only if this returned `ok`; (2) NOTHING is kept on a mismatch — the
 * leaf is written after the comparison, so a refused peer leaves no trust anchor; (3) the handshake
 * is PROVEN to have happened — `encrypted` and a non-empty certificate are both asserted, because a
 * connection event can fire on the TCP connect, and the peer's own certificate cannot exist without
 * a completed TLS handshake.
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
 * Is the key on the other end the one the ceremony carried? — `checkServerIdentity`'s replacement,
 * exported so it can be watched failing on its own. At the call site a MISMATCH IS UNREACHABLE
 * TODAY: the trust anchor is the door's own leaf, so a verifying chain is exactly one certificate and
 * one that is not the anchor never reaches this — OpenSSL already refused it. The repository's rule
 * is that an unreachable condition is removed or made reachable, so it is kept and made reachable
 * HERE, because this replaces the hostname check (the cert names `ohmail-desktop-host.invalid`) and
 * something must occupy that slot; what occupies it decides what happens the day the anchor stops
 * being a bare leaf, and this keeps the pin decisive. Watched in `host-pin-probe.test.ts`.
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
   * Re-run the bootstrap and hand back a fresh leaf — the recovery for a door that has restarted. The
   * host does NOT keep its certificate: `ensureLanIdentity` keeps the KEY and rebuilds the cert
   * around it every launch with a fresh serial, so a corrupt cert file costs a rebuild instead of
   * un-pairing a household — the fingerprint does not move, the bytes do. So a cached leaf is a cache,
   * never an identity: measured, a pinned connection after the door restarts fails
   * `DEPTH_ZERO_SELF_SIGNED_CERT` though the key and pin are unchanged. The recovery is the
   * bootstrap, judging by the PIN and re-persisting the new leaf, attempted at most ONCE per request
   * and only for a verification failure. Absent ⇒ no recovery, correct for a caller that cannot re-probe.
   */
  refreshLeaf?: () => Promise<string | null>;
  log?: Diagnostic;
}

/**
 * A `fetch` that will talk to ONE door and nothing else — hand-built on `node:https` because the
 * platform's `fetch` has no seam for a trust anchor (its TLS options belong to a dispatcher this
 * package does not depend on, and adding it would put a second HTTP client in a published artifact).
 * `node:https` carries every option; what it does not carry is the `Response` shape, so this composes
 * one, and each decision is deliberate: redirects are NOT followed (a pinned door answering one is
 * answering something this will not chase); `set-cookie` survives via the array (joining is
 * unrecoverable — a cookie's `Expires` contains a comma); the body STREAMS (the wake channel reads
 * it live); and a body shape this cannot send is REFUSED BY NAME rather than sent empty.
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
 * Was this a TLS VERIFICATION refusal — the shape a rotated certificate makes — rather than a network
 * answer? Read off the CAUSE as well as the error, for `describeProbeFailure`'s reason: a transport
 * failure may arrive wrapped, and reading only the outer error classifies every failure as the same
 * shrug. The set is the one Node raises for a chain it cannot build or trust, plus this module's own
 * refusal — a pin that did not match is returned from `checkServerIdentity` as an `Error` that Node
 * surfaces without a code of its own, so it is matched by its sentence.
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
 * The pinned seam — one `fetch` for everything this install says to its host, with the bootstrap,
 * cache and recovery behind it. The lifecycle lives here because the engine composes ONE `fetchImpl`
 * and threads it through the bearer client, mirror, proxy and wake channel: a second way to reach the
 * host is a second place the pin could be forgotten, so every decision (cached cert, does it cover
 * what is served, was identity established) is behind that one function. A missing leaf is NOT a
 * failed launch — the bootstrap is deferred to the first REQUEST, so an engine whose desktop is
 * asleep still serves its local mirror. ONE probe at a time: a restarted host makes every in-flight
 * request fail verification at once, and one in-flight probe serves them all (single-flight).
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
