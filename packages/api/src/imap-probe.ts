import { createHash } from "node:crypto";
import { resolveCname as dnsResolveCname } from "node:dns/promises";
import { type MailboxErrorCode } from "@trafficflow/db";
import {
  ImapAdapter, buildImapAuth, verifySmtpLogin,
  type ImapConfig, type SmtpLoginProof,
} from "@trafficflow/core/adapters/imap";
import {
  ServiceError, assertPublicHost, type HostResolver,
  type ProbeTlsDetail, type ProbeTlsFailureKind, type ProvenEndpoint,
  type SmtpProbe, type SmtpProbeInput,
} from "@trafficflow/services/mail";
import type { ApiDeps } from "./deps.js";
import { imapAdmission } from "./routes/shared.js";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE ADD-TIME PROBE SSRF GUARD — resolve+validate the host, cap the port, before any dial
   ══════════════════════════════════════════════════════════════════════════════════════════

   The probe dials a `host:port` the CALLER typed, behind a verified step-up session. On the
   HOSTED service that is a connect oracle into the deployment's own network and, on a TLS refusal,
   a disclosure of the dialed server's certificate identity — so the hosted deployment resolves the
   host and refuses a private/loopback/link-local/CGNAT address, and refuses a port that is not a
   mail port, BEFORE the socket is opened.

   On a LOCAL install this must NOT fire: a desktop user's own mail server may legitimately sit on
   a LAN address, and refusing it would break the product for exactly the self-hosted user it is
   for. So the guard is a POLICY the host states once — {@link ALLOW_ANY_PROBE_HOST} on the
   sidecar, {@link makeProbeHostGuard} on Cloud — read from `deps.services.probeHostGuard`.

   ── THE RESOLVER IS REQUIRED, WITH NO node:dns DEFAULT, AND THAT IS THE WHOLE TESTABILITY
      ARGUMENT ──────────────────────────────────────────────────────────────────────────────────
   The enforcing guard takes its {@link HostResolver} as a required argument. A default that fell
   back to `node:dns` would be worse than none: the test sandbox blocks DNS, so every test would
   take the refuse branch, the PERMIT branch (a public host is allowed to dial) would ship having
   never executed, and the one thing a mutation test needs to watch — a private answer turning a
   dial into a refusal — could not be driven at all. This is the same rule `ssrf-guard.ts`'s
   {@link HostResolver} docblock spells out, and it is why the sidecar names its permissive policy
   explicitly rather than getting it by omission. */

/** The mail ports the hosted probe will dial. An explicit port outside this set is refused. */
export const MAIL_PROBE_PORTS: Record<"imap" | "smtp", ReadonlySet<number>> = {
  imap: new Set([143, 993]),
  smtp: new Set([25, 465, 587]),
};

/**
 * The add-time probe's host/port gate. `check` throws a {@link ServiceError} to refuse a dial
 * before it happens; a return is permission to dial. Read from `deps.services.probeHostGuard`.
 *
 * ── THE RETURN VALUE IS THE PIN, AND IT USED TO BE `void` ───────────────────────────────────
 *
 * `void` made this HALF a guard. The check resolved the hostname, cleared its addresses, and then
 * handed the same NAME to the dialler, which resolved it a SECOND time — so a DNS-rebinding
 * server answers the check with a public address and answers the socket's independent lookup with
 * `169.254.169.254`, and the connect oracle this guard exists to close is open again through the
 * window between the two lookups. `assertPublicHost`'s own docblock has said so since it started
 * returning the addresses ("Returns the validated address(es) to pin to"); this interface was
 * discarding them.
 *
 * So a permit is now the ADDRESSES the dial may connect to, threaded to the socket as
 * `ImapConfig.pin`. `null` means "no pin" and belongs to a policy that cleared nothing —
 * {@link ALLOW_ANY_PROBE_HOST}, where there is no resolution to be raced. It is deliberately not
 * an empty array: "I checked nothing" and "I checked and nothing is permitted" must not be the
 * same value at a seam whose whole job is to bound a socket.
 */
export interface ProbeHostGuard {
  check(host: string, port: number | undefined, transport: "imap" | "smtp"): Promise<readonly string[] | null>;
}

/**
 * The most addresses one probe will pin to. A DNS answer is attacker-influenced input — the
 * hostname came from a request body — and `assertPublicHost` returns every A/AAAA record it
 * cleared, with no ceiling of its own; a TCP-mode answer can carry thousands. The pin is carried
 * per dial and materialised into a lookup table, so it is bounded here rather than left to
 * whatever the resolver returns.
 *
 * TRUNCATING IS SAFE AND REFUSING WOULD NOT BE: every address in the list was already cleared as
 * public, so keeping the first few narrows the dial without widening what it may reach. The
 * failure mode of the cap is a probe that cannot reach a server whose working address is the
 * seventeenth record — a refusal the person can act on, not a connection to somewhere unchecked.
 * Sixteen is far above any real mail host's record count (the largest providers publish 2–8).
 */
export const MAX_PINNED_PROBE_ADDRESSES = 16;

/**
 * The guard's answer as the dialler takes it: a bounded address list, or `undefined` for
 * "dial by name" (the local policy, which cleared nothing). See {@link MAX_PINNED_PROBE_ADDRESSES}.
 */
function pinFrom(cleared: readonly string[] | null): readonly string[] | undefined {
  if (cleared === null || cleared.length === 0) return undefined;
  return cleared.slice(0, MAX_PINNED_PROBE_ADDRESSES);
}

/**
 * The LOCAL policy: dial anything. A desktop install's own mail server may be on a LAN address or
 * a non-standard port, and this process opens sockets only on the user's own machine, so there is
 * no cross-tenant network to protect. Named explicitly (never a default) so that a HOSTED
 * deployment cannot get "allow any host" by forgetting to wire the enforcing guard.
 */
export const ALLOW_ANY_PROBE_HOST: ProbeHostGuard = {
  // `null`, never `[]`: this policy resolves nothing, so it has no cleared address to pin to and
  // must say so. A pin here would also be wrong on the merits — a desktop user's mail server may
  // be a mDNS/LAN name whose address the OS resolver is the only thing that knows.
  async check() { return null; /* local install: a LAN mail server on a non-standard port is legitimate */ },
};

/**
 * The HOSTED policy: resolve the host through the injected resolver and refuse any private,
 * loopback, link-local, CGNAT, unresolvable or unparseable target (via {@link assertPublicHost}),
 * and refuse an explicit port that is not a {@link MAIL_PROBE_PORTS} port. The resolver is
 * REQUIRED — see the section header for why there is no `node:dns` default.
 */
export function makeProbeHostGuard(resolver: HostResolver): ProbeHostGuard {
  return {
    async check(
      host: string, port: number | undefined, transport: "imap" | "smtp",
    ): Promise<readonly string[]> {
      if (port !== undefined && !MAIL_PROBE_PORTS[transport].has(port)) {
        throw new ServiceError(
          "validation_failed", 400,
          `port ${port} is not a mail port this service will dial`,
        );
      }
      // Throws on a private/unresolvable/unparseable host — the port must never be opened to one.
      // The RETURN is the cleared address set, and returning it is the half that makes this a
      // whole guard rather than a check the socket is free to ignore. See {@link ProbeHostGuard}.
      return await assertPublicHost(host, resolver);
    },
  };
}

/** The active guard for a set of deps — the enforcing policy on Cloud, ALLOW_ANY otherwise. */
function probeHostGuardFor(deps: ApiDeps): ProbeHostGuard {
  return deps.services?.probeHostGuard ?? ALLOW_ANY_PROBE_HOST;
}

/**
 * **TRY THE CREDENTIALS BEFORE STORING THEM, AND SAY WHICH THING FAILED.**
 *
 * `POST /mailboxes` encrypted whatever the connect form sent and answered 201. Measured on the
 * route's own harness before this file existed: host `nope.invalid`, password `wrong` → `201`,
 * `status: "connected"`, one `mailbox_credentials` row, **zero connection attempts**. The row
 * says `connected` because that is the column's DEFAULT, so the mailbox looked live from the
 * moment it existed and the first word anybody got about the typo was a worker sync error,
 * minutes later, on a different screen.
 *
 * ── WHY THIS IS NOT A THIRD CONNECTOR ───────────────────────────────────────────────────────
 *
 * `send-adapter.ts` and `attachments-adapter.ts` both open IMAP connections and NEITHER can be
 * reused: both begin by reading `mailbox_credentials` for an EXISTING `mailboxId`, and the whole
 * point here is that nothing has been written yet. What is reused is everything below that seam —
 * `ImapAdapter` (one dialler, one TLS floor, `packages/core`), the IMAP admission counter, and
 * the failure taxonomy. This file adds the two things neither of those has: a config that comes
 * from a request body instead of the database, and a verdict.
 *
 * The classification below is a SECOND COPY of the order in the sync worker's
 * `classifyMailboxError`, and it is a copy under protest: the API package may not import the
 * worker, and the classifier cannot move next to the taxonomy it emits
 * (`packages/db/src/mailbox-errors.ts`) without touching files outside this change. The drift
 * risk is pinned by a table of specimen errors that asserts the verdict for each — every one of
 * them carrying the `authenticationFailed` flag, so reordering the checks below turns the whole
 * table red. Merging the two classifiers is still owed.
 *
 * ── IT MAY NOT BECOME A SECOND WAY TO HOLD A CONNECTION OPEN ────────────────────────────────
 *
 * The IMAP admission counter caps how many IMAP logins this deployment will hold for one mailbox
 * at once, because providers cap them per account and iCloud's cap is low. A probe is a new
 * login, so it goes through `deps.imapAdmission` like the attachment path — a control that
 * already exists is not something to route around.
 *
 * ── NOTHING HERE LOGS, AND THAT IS DELIBERATE RATHER THAN AN OVERSIGHT ──────────────────────
 *
 * The input carries a plaintext password and the throw can carry the server's own text about it
 * (`* NO [ALERT] password "hunter2" not accepted` is a shape real servers produce). So no line in
 * this file prints the input, the error, or any part of either; the only diagnostic that leaves
 * is the seven-value taxonomy code, and `imapFlowOptions` already pins `logger: false` on the
 * client itself. The one `warn` below names a mailbox-free bookkeeping failure.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO, SO NOBODY READS IT AS DONE ─────────────────────────
 *
 * It does NOT check where the host points. This is a synchronous connect oracle for an arbitrary
 * `host:port` — coarse, but real — behind a verified, step-up-authenticated session. The three
 * dialers that already exist (`send-adapter.ts`, `attachments-adapter.ts`, the worker) all dial
 * hosts that were ALREADY STORED, which makes this the front door and the strongest place to put
 * such a check. It is not here because the check needs a `HostResolver` and there is no seam for
 * one on `ApiDeps` — wiring it would mean either changing that interface or hard-wiring
 * `nodeHostResolver`, which puts a live DNS lookup on a path many route tests exercise in an
 * environment where DNS is blocked. A guard whose result comes from the harness rather than from
 * reality is worse than a limitation stated plainly. So it is stated here, and it is true of all
 * four dialers, not only this one. (The `resolveCname` seam on {@link ImapProbeOptions} is NOT
 * that check: it runs only on a hostname-mismatch refusal, to sharpen the error into a
 * suggestion, and its failure mode is a less helpful sentence.)
 *
 * ── EVERY OTHER WRITER OF A MAILBOX CREDENTIAL, AND WHY IT DOES NOT COME THROUGH HERE ───────
 *
 * There are SIX writers besides `MailboxService.create`, and they are recorded here rather than
 * left to be rediscovered, because an undocumented exemption is indistinguishable from an
 * oversight:
 *
 *  1. `MailboxService.update` — `PATCH /mailboxes/:id` carrying an `imap.pass`. **NOW PROBED.**
 *     It was the one reachable path still storing an untried password, and it is the route
 *     `apps/sidecar/src/engine.ts` sends a desktop user to when the install's key can no longer
 *     open its own stored login.
 *  2. The SMTP block, in BOTH create and update. **EXEMPT.** A different transport with its own
 *     credential row; sending is not the connect flow; and dialling a second server doubles both
 *     the latency of an interactive request and the number of connections we open. The IMAP row
 *     is the one the worker logs in with and the one a typo quarantines.
 *  3. `apps/sidecar/src/identity.ts` (`ensureLocalWorld`). **NOTHING TO PROBE** — it creates the
 *     local `mailboxes` row and writes no credential at all.
 *  4. `apps/sidecar/src/engine.ts` (the first-run seal). **EXEMPT, and not silently.** It seals a
 *     password the environment already carried into the local store, and the engine then dials
 *     that mailbox immediately as its ordinary work — so a wrong password surfaces on the same
 *     launch rather than minutes later on another screen, which is the outcome a probe buys,
 *     obtained here without a second login.
 *  5. The sync worker's env-credential bootstrap. **EXEMPT.** An operator-supplied env seed
 *     against an ALREADY EXISTING mailbox id, non-interactive, with nobody watching a form.
 *     The worker's own failure state machine (`markMailboxFailed` + `classifyMailboxError`)
 *     already turns a bad seed into the same taxonomy code a probe would have produced.
 *  6. Test helpers and the direct `insert(mailboxes)` calls across the suites. **TEST-ONLY**,
 *     and none writes a credential; the dialler is stubbed suite-wide so no test opens a socket.
 *
 * Items 3–5 live in other packages, so their at-site comments are owed by whoever next edits
 * them; the reasoning is recorded here so it is not re-derived from scratch.
 */

/** The verdict, structurally identical to `MailboxProbeVerdict` in `packages/services`. */
export type ImapProbeVerdict =
  | { verdict: "ok"; proven?: ProvenEndpoint; folders?: number }
  | { verdict: "store_unverified"; code: MailboxErrorCode; proven?: ProvenEndpoint }
  | { verdict: "refuse"; code: MailboxErrorCode; tls?: ProbeTlsDetail };

/**
 * WHAT THE PROBE IS ASKED TO TRY, and it is a UNION because there are now two kinds of credential.
 *
 * `pass` is the historical member: a password typed into the connect form. `accessToken` is the
 * OAuth2 member — a token minted seconds ago by
 * `POST /mailboxes/oauth/microsoft/callback`'s code exchange, before anything has been stored.
 *
 * ── WHY THE OAUTH ARM CARRIES A TOKEN AND NOT A REFRESH TOKEN ─────────────────────────────
 *
 * `ImapConfig.auth`'s oauth member carries a CALLBACK, not a token, precisely so that a long-lived
 * connection can re-mint. A probe is one dial with one login, the token in hand is a minute old, and
 * there is no mailbox id yet for a token provider to cache against — so the callback this builds
 * simply returns the token it was given. Handing the probe a REFRESH token instead would mean
 * exchanging it here, which is a second code path to the token endpoint and a second place the
 * exchange could differ from the one that just ran.
 *
 * ── AND WHY IT DOES NOT GO THROUGH `buildImapAuth` ────────────────────────────────────────
 *
 * `buildImapAuth` is the one INTERPRETER of a stored `meta.authType`, and its whole value is that it
 * fails closed on a row it does not recognise. There is no row here and no `meta`: this is a literal
 * access token the caller minted. Feeding it a synthetic `{ authType: "oauth2" }` plus a fetcher
 * factory that ignores its own `refreshToken` argument would be a lie in both directions — it would
 * claim to have read a credential that does not exist, and it would make the factory's contract
 * (turn a stored refresh token into a fetcher) false at one call site. The password arm still routes
 * through the builder, because there the `{ user, pass }` shape IS what a stored password row
 * produces and the builder's refusal is worth inheriting.
 */
export type ImapProbeCredential =
  | { host: string; port?: number; secure?: boolean; user: string; pass: string; accessToken?: undefined; allowInsecure?: boolean }
  | { host: string; port?: number; secure?: boolean; user: string; accessToken: string; pass?: undefined; allowInsecure?: undefined };

export interface ImapProbeInput {
  accountId: string;
  address: string;
  imap: ImapProbeCredential;
}

/**
 * HOW MANY PROBES MAY BE IN FLIGHT FOR ONE ADDRESS.
 *
 * Two, the same number as `MAX_IMAP_PER_MAILBOX`, and NOT for the same reason — that one buys a
 * person clicking a second attachment while the first downloads, and a connect form has one
 * submit button. The reason here is the leak this file knowingly permits: the deadline path
 * releases its slot LATE (see the `finally` below), and a serverless invocation killed first
 * never releases it at all. At a cap of one, a single hung probe would lock somebody out of
 * adding their own mailbox until the 90 s reclaim window rolled — a self-inflicted refusal on the
 * exact path that is already going badly. The second slot is the retry that gets them through.
 */
export const MAX_PROBES_PER_ADDRESS = 2;

/**
 * How long the whole probe may take before it is abandoned.
 *
 * The connect flow is interactive: somebody is watching this submit button. A probe that hangs is
 * worse than no probe — it holds the invocation, shows a spinner that means nothing, and on the
 * serverless host is eventually killed at `maxDuration = 60` with no error anyone can act on.
 *
 * Twenty seconds, and it is the OUTER bound rather than the only one. {@link PROBE_TIMEOUTS}
 * tightens the client's own three deadlines below it so the library normally rejects first and
 * we get a classifiable errno; this race exists because imapflow's socket deadline does not
 * always fire — `imap-types.ts` records a case where one mailbox's socket timeout stretched to
 * eight minutes. When it expires the user
 * is told the server accepted the connection and then stopped answering — `err_timeout`'s
 * outcome, not a guess at a mechanism.
 */
export const PROBE_DEADLINE_MS = 20_000;

/**
 * Tighter than {@link DEFAULT_NET_TIMEOUTS}, for the one reason that distinguishes this dial from
 * every other: a person is waiting for it. 15 s to connect is right for a background sync cycle
 * and much too long to sit in front of a form that has already been submitted.
 */
export const PROBE_TIMEOUTS = { connectionMs: 10_000, greetingMs: 10_000, socketMs: 12_000 };

/* ── THE CLASSIFIER ────────────────────────────────────────────────────────────────────────
 *
 * The SAME order as the sync worker's `classifyMailboxError`, once that one was reordered to try
 * the structural evidence before the flag — and the order is the entire finding: imapflow stamps
 * `authenticationFailed = true` on EVERY failure of the LOGIN command, unconditionally
 * (`lib/commands/login.js:38`), so a flag read first makes every structural probe below it
 * unreachable for exactly the command a probe consists of. Named server refusals and the
 * library's own connection-error constants therefore sit ABOVE the flag here too. Getting this
 * order wrong does not produce a vague message — it produces a confidently wrong one, "the mail
 * server refused this password", about a password that is fine.
 *
 * ── AND ONE PLACE THIS IS FINER THAN THE WORKER'S, WHICH IS THE POINT ──────────────────────
 *
 * `classifyMailboxError` answers `connect` for both "that host does not exist" and "that host is
 * at its connection cap", and it is right not to care: both mean retry later. Here they must
 * diverge, because one is the typo this file exists for and the other is a working mailbox on a
 * busy morning. So the `connect` class is split by EVIDENCE OF CONTACT — did the server answer
 * at all — and the split is expressed as two named sets rather than a heuristic, for the same
 * reason the worker's own order settled where it did: an atom or code we do not know must fall
 * THROUGH to the safe answer (refuse) rather than being read as permission to store.
 */

/** RFC 5530 atoms that mean the server received our LOGIN and declined to serve it RIGHT NOW. */
const SERVER_BUSY_RESPONSE_CODES: ReadonlySet<string> = new Set(["UNAVAILABLE", "LIMIT"]);

/**
 * imapflow's own constants for "the server hung up on us".
 *
 * Every member implies a socket was established — `ClosedAfterConnectTLS` implies a completed TLS
 * handshake, `ClosedAfterConnectText` a completed TCP connect, `EConnectionClosed` and
 * `NoConnection` a connection that existed and stopped. `ETHROTTLE` is a TAGGED reply, so the
 * server not only answered but explained itself. A mistyped host cannot produce any of them: it
 * fails at DNS or at the SYN, which is {@link CONNECT_ERRNOS}.
 *
 * This is the set that makes the iCloud case work at all. A provider at its per-account cap sends
 * `* BYE [UNAVAILABLE] …` and closes; imapflow keeps only the TEXT attributes of a BYE, and a
 * bracket atom is a SECTION, so the atom is DISCARDED and the pending login rejects with a bare
 * connection error carrying no response code to promote. Matching the atom alone would fix the
 * tagged variant and leave the commoner one refusing a working mailbox.
 */
const SERVER_BUSY_CODES: ReadonlySet<string> = new Set([
  "NoConnection", "EConnectionClosed", "ClosedAfterConnectText", "ClosedAfterConnectTLS",
  "ETHROTTLE",
]);

/** OS-level dial failures: nothing answered, so nothing about this configuration is proven. */
const CONNECT_ERRNOS: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH", "ENETDOWN",
  "ECONNRESET", "EPIPE", "EAI_AGAIN", "EADDRNOTAVAIL",
]);

const TIMEOUT_ERRNOS: ReadonlySet<string> = new Set([
  "ETIMEDOUT", "ESOCKETTIMEDOUT", "ERR_SOCKET_CONNECTION_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  // imapflow@1.5.0's own four.
  "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", "ETIMEOUT",
]);

/** The OpenSSL / Node verification constants imapflow surfaces verbatim. */
const CERT_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "EPROTO",
]);

const isTlsCode = (code: string): boolean =>
  code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || CERT_CODES.has(code);

interface ErrorShape {
  code?: unknown;
  message?: unknown;
  authenticationFailed?: unknown;
  serverResponseCode?: unknown;
}

const codeOf = (err: unknown): string =>
  typeof (err as ErrorShape | null)?.code === "string" ? String((err as ErrorShape).code) : "";

const responseCodeOf = (err: unknown): string =>
  typeof (err as ErrorShape | null)?.serverResponseCode === "string"
    ? String((err as ErrorShape).serverResponseCode) : "";

/** Thrown by {@link withDeadline} only. Distinct so it cannot be confused with a server's timeout. */
class ProbeDeadlineExceeded extends Error {
  constructor() { super("probe deadline exceeded"); this.name = "ProbeDeadlineExceeded"; }
}

/**
 * Turn a throw from `connect()` into a verdict.
 *
 * Exported for its own test: the ORDER is the part that regresses silently, and a test that can
 * only reach it through a socket is a test that will be written once and never mutated.
 *
 * ── IT IS THE CLASSIFIER ONLY, AND THAT IS THE ONE WAY TO INHERIT HALF OF THIS FILE ─────────
 *
 * A new call site that wants to try some credentials must build {@link makeImapProbe}, not call
 * this. Everything that BOUNDS a probe lives in the closure that one returns — the
 * {@link PROBE_DEADLINE_MS} race, the tightened {@link PROBE_TIMEOUTS}, the admission
 * acquire/release pair, and the close-before-release ordering. Dialling by hand and passing the
 * throw here compiles, classifies correctly, and silently has none of them: no deadline, so a
 * provider that goes quiet holds the invocation until the platform kills it, and no admission,
 * so the per-account connection cap this deployment promises stops being enforced on that path.
 */
export function verdictFor(err: unknown): ImapProbeVerdict {
  // ── ABOVE THE FLAG: what the server, or the socket, NAMED. ──────────────────────────────
  const server = responseCodeOf(err);
  if (SERVER_BUSY_RESPONSE_CODES.has(server)) return { verdict: "store_unverified", code: "connect" };

  const code = codeOf(err);
  if (code) {
    if (isTlsCode(code)) return { verdict: "refuse", code: "tls" };
    if (TIMEOUT_ERRNOS.has(code)) return { verdict: "refuse", code: "timeout" };
    // The split. Contact made and declined ⇒ storable; nothing reached ⇒ unproven, so refused.
    if (SERVER_BUSY_CODES.has(code)) return { verdict: "store_unverified", code: "connect" };
    if (CONNECT_ERRNOS.has(code)) return { verdict: "refuse", code: "connect" };
  }

  // ── THE TLS LAYER ITSELF: imapflow's own flag, set on all five of its TLS failure sites ──
  // (`imap-flow.js`: STARTTLS absent, STARTTLS injection, a plain-socket death mid-upgrade, the
  // upgrade timeout, and a handshake error). Most of those also carry a `code` the block above
  // already classified; the one that carries NO code at all — "Server does not support STARTTLS"
  // — used to fall through to `unknown`, telling the user we could not tell why, about a server
  // whose problem is precisely nameable. Below the code checks so a named errno keeps its finer
  // class; above the auth flag because imapflow stamps that on every failed LOGIN regardless.
  if ((err as ErrorShape & { tlsFailed?: unknown } | null)?.tlsFailed === true) {
    return { verdict: "refuse", code: "tls" };
  }

  // ── THE FLAG: "the LOGIN command did not succeed", and nothing above it explained why. ──
  if ((err as ErrorShape | null)?.authenticationFailed === true) return { verdict: "refuse", code: "auth" };

  // ── BELOW THE FLAG: reachable only for a throw that carried no flag at all. ─────────────
  if (server === "AUTHENTICATIONFAILED" || server === "AUTHORIZATIONFAILED") {
    return { verdict: "refuse", code: "auth" };
  }
  const message = typeof (err as ErrorShape | null)?.message === "string"
    ? String((err as ErrorShape).message) : "";
  if (/\b(authentication|login|credentials|password)\b.*\b(fail|refus|reject|invalid|denied)/i.test(message)
    || /\b(invalid|incorrect)\b.*\b(credentials|password|login)\b/i.test(message)) {
    return { verdict: "refuse", code: "auth" };
  }

  // A throw nobody can name is NOT permission to store. The message says we could not tell,
  // which is true, rather than picking the likeliest-sounding of four sentences.
  return { verdict: "refuse", code: "unknown" };
}

/* ── THE LADDER ────────────────────────────────────────────────────────────────────────────
 *
 * What a mail client is expected to do with a bare hostname: try the standard combinations in
 * a fixed order and keep the first one that yields a valid certificate and an IMAP greeting.
 * PLAINTEXT IS NOT ON THE LADDER — a rung that would authenticate over an unencrypted socket
 * exists only behind the consent gate in {@link makeImapProbe}, and never as a fallback.
 */

export interface ProbeAttempt { port: number; secure: boolean }

/**
 * The dial order for one probe.
 *
 *  · No port          → 993 implicit TLS, then 143 STARTTLS. The standard ladder.
 *  · Port, no mode    → that port only, canonical mode first (993 speaks TLS from the first
 *                       byte; anything else is presumed cleartext-then-STARTTLS), then the
 *                       OTHER mode on the same port — a user who typed a port is telling us
 *                       where the server is, not necessarily how it negotiates. The wrong-mode
 *                       rung costs at most one greeting timeout and only on the failure path.
 *  · Port and mode    → exactly that, once. An explicit combination is respected verbatim —
 *                       it is what every provider preset sends.
 */
export function probeAttempts(port?: number, secure?: boolean): ProbeAttempt[] {
  if (port !== undefined) {
    if (secure !== undefined) return [{ port, secure }];
    return port === 993
      ? [{ port, secure: true }, { port, secure: false }]
      : [{ port, secure: false }, { port, secure: true }];
  }
  return [{ port: 993, secure: true }, { port: 143, secure: false }];
}

/* ── WHAT THE TLS LAYER SAID, PRECISELY ──────────────────────────────────────────────────── */

/**
 * "The server has no STARTTLS" — the ONE TLS failure that licenses the consent flow, so it is
 * matched narrowly: imapflow@1.5.0's `_failSTARTTLS` throws exactly this message with
 * `tlsFailed = true` and NO `code`; every other `tlsFailed` site attaches one.
 */
export const isStarttlsUnavailable = (err: unknown): boolean =>
  (err as { tlsFailed?: unknown } | null)?.tlsFailed === true
  && !codeOf(err)
  && /does not support STARTTLS/i.test(
    typeof (err as ErrorShape | null)?.message === "string" ? String((err as ErrorShape).message) : "",
  );

/**
 * "We spoke TLS to something that answered in plaintext." OpenSSL reports it as a version
 * mismatch, which {@link CERT_CODES} would classify as a certificate problem — but no
 * certificate was ever presented, and for the consent gate the difference is the whole
 * question: this is evidence of TLS being ABSENT on the port, not of TLS being broken.
 */
const isNotTlsListener = (err: unknown): boolean => {
  const code = codeOf(err);
  if (code === "ERR_SSL_WRONG_VERSION_NUMBER") return true;
  const message = typeof (err as ErrorShape | null)?.message === "string"
    ? String((err as ErrorShape).message) : "";
  return code === "EPROTO" && /wrong version number/i.test(message);
};

const TLS_KIND_BY_CODE: Record<string, ProbeTlsFailureKind> = {
  ERR_TLS_CERT_ALTNAME_INVALID: "hostname_mismatch",
  CERT_HAS_EXPIRED: "expired",
  CERT_NOT_YET_VALID: "not_yet_valid",
  DEPTH_ZERO_SELF_SIGNED_CERT: "self_signed",
  SELF_SIGNED_CERT_IN_CHAIN: "self_signed",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "untrusted",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "untrusted",
};

interface PeerCertLike { subject?: { CN?: unknown }; subjectaltname?: unknown }

/** The names on the certificate a failed identity check attached to its error. */
function certNamesOf(err: unknown): { certHost: string | null; altNames: string[] } {
  const cert = (err as { cert?: PeerCertLike } | null)?.cert;
  const cn = typeof cert?.subject?.CN === "string" ? cert.subject.CN : null;
  const san = typeof cert?.subjectaltname === "string" ? cert.subjectaltname : "";
  const altNames = san.split(",")
    .map((s) => s.trim())
    .filter((s) => s.toUpperCase().startsWith("DNS:"))
    .map((s) => s.slice(4));
  return { certHost: cn ?? altNames[0] ?? null, altNames };
}

/**
 * Does this SAN/CN list cover `host`? RFC 6125 matching, wildcards in the LEFTMOST label only —
 * `*.example.com` covers `mail.example.com`, never `example.com` and never `a.b.example.com`.
 */
export function certCoversHost(names: readonly string[], host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  for (const raw of names) {
    const n = raw.trim().toLowerCase().replace(/\.$/, "");
    if (n === h) return true;
    if (n.startsWith("*.")) {
      const dot = h.indexOf(".");
      if (dot > 0 && h.slice(dot) === n.slice(1)) return true;
    }
  }
  return false;
}

/** Classify a TLS-layer throw into the detail the refusal message is built from. */
export function tlsDetailOf(err: unknown, expectedHost: string): ProbeTlsDetail {
  if (isStarttlsUnavailable(err)) return { kind: "tls_unavailable" };
  const kind = TLS_KIND_BY_CODE[codeOf(err)];
  if (!kind) return { kind: "generic" };
  if (kind !== "hostname_mismatch") return { kind };
  const { certHost } = certNamesOf(err);
  return { kind, expectedHost, ...(certHost ? { certHost } : {}) };
}

/** A syntactically plausible DNS name — the only shape ever surfaced as a suggestion. */
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * The canonical-host suggestion for a HOSTNAME MISMATCH — the vanity-CNAME shape, measured
 * live on the first external mailbox this failed for: a vanity `mail.<own-domain>` host that
 * is a CNAME to the provider's real server, whose (publicly trusted, chain-valid) certificate
 * names the provider's hosts, that CNAME target among them.
 *
 * ── WHY THIS IS NOT A TRUST DECISION ──────────────────────────────────────────────────────
 *
 * Node validates the CHAIN before the identity, so `ERR_TLS_CERT_ALTNAME_INVALID` — the only
 * path that reaches here — means the certificate is trusted and current, wrong only in name.
 * The suggestion is derived from that certificate (preferring the DNS CNAME target when the
 * certificate covers it, else the certificate's own subject), and it is only ever SHOWN: the
 * user confirms it, the re-probe dials the confirmed name, and the handshake verifies strictly
 * against it, floor unchanged. A spoofed DNS answer can therefore steer the SUGGESTION but
 * never past validation — the same property Thunderbird's confirm-what-autoconfig-found flow
 * rests on. Silently connecting to the suggestion would be the trust change; that is the line
 * this deliberately does not cross.
 */
async function suggestedHostFor(
  host: string,
  seen: { certHost: string | null; altNames: string[] },
  resolveCname: (host: string) => Promise<string | null>,
): Promise<string | null> {
  const { certHost, altNames } = seen;
  const names = altNames.length > 0 ? altNames : certHost ? [certHost] : [];
  const target = await resolveCname(host).catch(() => null);
  if (
    target && HOSTNAME_RE.test(target)
    && target.toLowerCase() !== host.trim().toLowerCase()
    && certCoversHost(names, target)
  ) return target;
  if (
    certHost && !certHost.includes("*") && HOSTNAME_RE.test(certHost)
    && certHost.toLowerCase() !== host.trim().toLowerCase()
  ) return certHost;
  return null;
}

/**
 * The default CNAME resolver — consulted ONLY on the hostname-mismatch failure path, never on
 * a working dial, so no route test and no healthy connect ever depends on DNS being reachable.
 * Absence of a CNAME and a resolver failure are the same answer: no suggestion from DNS.
 */
async function nodeResolveCname(host: string): Promise<string | null> {
  try {
    const target = (await dnsResolveCname(host))[0]?.trim().replace(/\.$/, "");
    return target ? target : null;
  } catch {
    return null;
  }
}

/** The refusal when OUR OWN budget, not the mail server, is the reason nothing was tried. */
const busy = (): ServiceError => new ServiceError(
  "mailbox_busy", 429,
  "we are already opening a connection to that mailbox — wait a moment and try again",
  { retryAfterSeconds: 10 },
  true,
);

/**
 * The admission key for an address nothing has been stored for yet.
 *
 * The admission counter keys on a mailbox id and deliberately does NOT hash it, because a
 * mailbox id is an opaque internal UUID, not an address or an identity, so there is nothing
 * there a hash would protect. The inverse holds exactly: at probe time there is no id and
 * the only stable identity of the thing being dialled is the account plus the address — which IS
 * an identity, and the table's other identity-bearing namespaces (`mail:<quota>:<sha256(…)>`)
 * hash for that reason. So this one hashes.
 *
 * Lower-cased before hashing, so the same mailbox typed with different capitalisation shares one
 * budget — matching mail 0021's `lower(address)` index, whose documented collation caveat this
 * inherits and does not need to improve on: it is a connection budget, not a uniqueness rule.
 *
 * The counter PREPENDS its own namespace, so the stored key is
 * `imap:mailbox:probe:<hash>` — inside the same prefix the attachment path's admission counter
 * uses, which is what a prune covering that prefix will need to know.
 */
export function probeAdmissionKey(accountId: string, address: string): string {
  return `probe:${createHash("sha256").update(`${accountId}:${address.toLowerCase()}`).digest("hex")}`;
}

/**
 * Race a promise against a deadline.
 *
 * ── THE LOSER OF THE RACE STILL SETTLES, AND IT MUST NOT CRASH THE PROCESS ──────────────────
 *
 * `Promise.race` decides which value the caller sees; it does not cancel the other side. When the
 * deadline wins, `p` is still live and will reject later — a dead socket, an `ETIMEOUT` — with
 * nobody awaiting it. In Node that is an unhandled rejection, and this repository has already
 * spent an outage on precisely that class: an IMAP failure arriving out of band, with no `await`
 * holding it, taking the process with it. The noop catch attached BEFORE the race is what makes
 * the abandoned attempt merely abandoned.
 *
 * The timer is CLEARED on both arms: a probe that finishes in 200 ms must not keep a 20 s handle
 * alive, which in a test is the difference between a suite that ends and one that hangs. `unref`
 * where the runtime has it, for the same reason `attachments-adapter.ts` probes for it — a
 * pending deadline must never be why a process stays alive.
 */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let settled = false;
  // Attached to the ORIGINAL promise, not to a derived one, and before the race: a rejection that
  // arrives after the deadline has already answered has nowhere else to go.
  p.catch(() => { /* the deadline arm owns the answer; this arrival is only being disarmed */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then((v) => { settled = true; return v; }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { if (!settled) reject(new ProbeDeadlineExceeded()); }, ms);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What a probe needs of an adapter — the seam the ladder tests dial through. */
export interface ProbeDialer {
  connect(): Promise<void>;
  close(): Promise<void>;
  /**
   * OPTIONAL, and optional is the point: every existing caller of {@link makeImapProbe} injects a
   * two-method double, and requiring a third would break them all to serve one new option. The
   * real `ImapAdapter` has it; a double that does not simply yields an ok verdict with no count,
   * which the copy layer already has to handle (a probe built without {@link
   * ImapProbeOptions.countFolders} never counts either).
   */
  listFolders?(): Promise<string[]>;
}

export interface ImapProbeOptions {
  /**
   * COUNT THE FOLDERS on the rung that answers, for the TEST action's verdict.
   *
   * OFF BY DEFAULT, and deliberately: the create and claim paths have no use for the number, and a
   * LIST on those paths would spend a round trip inside the probe deadline to produce something
   * nobody reads. Only the test action — whose whole output is a sentence a person checks against
   * their own mailbox — turns it on.
   */
  countFolders?: boolean;
  maxPerAddress?: number;
  deadlineMs?: number;
  /**
   * Adapter construction, injectable so the LADDER — which config is dialled, in what order,
   * and which is never dialled at all — can be asserted without a socket. The default is the
   * real `ImapAdapter`, exactly as before.
   */
  adapterFactory?: (config: ImapConfig) => ProbeDialer;
  /**
   * One CNAME lookup, used ONLY to sharpen a hostname-mismatch refusal into a suggestion (see
   * {@link suggestedHostFor}). This is deliberately NOT the `HostResolver` the header note
   * declines to add: it runs on a path that has already failed, its answer can only add a
   * sentence, and a resolver outage degrades to the plain refusal.
   */
  resolveCname?: (host: string) => Promise<string | null>;
}

/**
 * Build the add-time IMAP probe. Injected by `routes/mailboxes.ts` at the call site, the same
 * shape `routes/attachments.ts` injects `makeOpenAdapter(deps)`.
 */
export function makeImapProbe(deps: ApiDeps, opts: ImapProbeOptions = {}): (i: ImapProbeInput) => Promise<ImapProbeVerdict> {
  const countFolders = opts.countFolders === true;
  const max = opts.maxPerAddress ?? MAX_PROBES_PER_ADDRESS;
  const deadlineMs = opts.deadlineMs ?? PROBE_DEADLINE_MS;

  const makeAdapter = opts.adapterFactory ?? ((config: ImapConfig): ProbeDialer => new ImapAdapter(config));
  const resolveCname = opts.resolveCname ?? nodeResolveCname;

  const hostGuard = probeHostGuardFor(deps);

  return async (input: ImapProbeInput): Promise<ImapProbeVerdict> => {
    // SSRF/port gate BEFORE admission and before any socket: on the hosted deployment this refuses
    // a host that resolves to a private/loopback/link-local address and a non-mail port, closing
    // the connect oracle and the cert-identity disclosure at the network layer. No-op on a local
    // install (see {@link ALLOW_ANY_PROBE_HOST}). It throws its own ServiceError to refuse.
    //
    // RESOLVED ONCE, HERE, FOR THE WHOLE LADDER. The permit is the cleared address set and every
    // rung below dials THAT, so the name is never resolved a second time: not between the check
    // and the first dial, and not between rung 993 and rung 143. A DNS answer that changes after
    // this line cannot move any connection this probe opens.
    const pin = pinFrom(await hostGuard.check(input.imap.host, input.imap.port, "imap"));

    const key = probeAdmissionKey(input.accountId, input.address);

    // ADMISSION FIRST, before a socket exists, and ONCE for the whole ladder: the rungs dial
    // strictly one at a time, so a ladder holds exactly one login against the provider — the
    // property the counter caps. A counter failure REFUSES rather than admitting: an uncapped
    // dial is precisely the state the counter exists to prevent, and letting a broken counter
    // mean "go ahead" is how a control stops controlling without anything failing.
    if (!await imapAdmission(deps).acquire(deps.db, { mailboxId: key, max, now: deps.now() })) throw busy();

    const startedAt = Date.now();
    const budgetLeft = (): number => deadlineMs - (Date.now() - startedAt);

    // Two arms, one dialler. The password arm goes through the shared builder with no token
    // source: it yields `{ user, pass }` here, and an oauth2 `authType` — were one ever to arrive
    // in a request body — would THROW rather than dial with a refresh token as a password. The
    // oauth arm is a literal, already-minted access token; see {@link ImapProbeCredential} for why
    // it does not pretend to be a stored credential.
    const auth = input.imap.accessToken !== undefined
      ? { user: input.imap.user, fetchAccessToken: async (): Promise<string> => input.imap.accessToken! }
      : buildImapAuth({ user: input.imap.user }, input.imap.pass ?? "");

    /**
     * One rung: dial, then put the socket down before the next rung may start.
     *
     * The close is awaited on every path EXCEPT a deadline expiry — the socket we gave up on is
     * by definition one that is not answering, so awaiting its close would reintroduce exactly
     * the unbounded wait the deadline exists to remove. That abandoned close finishes (or the
     * admission window's 90 s reclaim covers it), and no further rung is dialled after a
     * deadline, so the one-login-at-a-time property survives the asymmetry.
     */
    const dialOnce = async (
      attempt: ProbeAttempt, allowInsecure: boolean,
    ): Promise<{ ok: true; folders?: number } | { ok: false; err: unknown; timedOut: boolean }> => {
      const adapter = makeAdapter({
        // The NAME, still — SNI and certificate validation must see what the user typed. Only
        // `pin` decides which address the socket goes to. See `ImapConfig.pin`.
        host: input.imap.host,
        port: attempt.port,
        secure: attempt.secure,
        ...(allowInsecure ? { allowInsecure: true } : {}),
        ...(pin ? { pin } : {}),
        auth,
        timeouts: PROBE_TIMEOUTS,
      });
      try {
        await withDeadline(adapter.connect(), Math.max(1, budgetLeft()));
      } catch (err) {
        const timedOut = err instanceof ProbeDeadlineExceeded;
        const close = adapter.close().catch(() => { /* a connection that never came up has nothing to close */ });
        if (!timedOut) await close;
        return { ok: false, err, timedOut };
      }
      /**
       * THE FOLDER COUNT, INSIDE THE SAME CONNECTION AND THE SAME DEADLINE.
       *
       * Between the accepted LOGIN and the close, because a second dial to count would be a second
       * login against the provider — outside the admission slot's one-login-at-a-time property and
       * charged again against providers that rate-limit authentication.
       *
       * A LIST THAT THROWS IS NOT A SUCCESS. It falls through to the same `verdictFor` ladder every
       * other failure on this rung takes, so "signed in but your folders could not be read" gets a
       * named refusal rather than a green verdict with no number on it. A LIST that runs out of
       * BUDGET is reported as a timeout, because that is what it is.
       */
      if (countFolders && typeof adapter.listFolders === "function") {
        try {
          const names = await withDeadline(adapter.listFolders(), Math.max(1, budgetLeft()));
          await adapter.close().catch(() => { /* the count is in hand; a noisy logout is not */ });
          return { ok: true, folders: names.length };
        } catch (err) {
          const timedOut = err instanceof ProbeDeadlineExceeded;
          const close = adapter.close().catch(() => { /* already failing; the close is best-effort */ });
          if (!timedOut) await close;
          return { ok: false, err, timedOut };
        }
      }
      await adapter.close().catch(() => { /* the greeting was the evidence; a noisy logout is not */ });
      return { ok: true };
    };

    try {
      const attempts = probeAttempts(input.imap.port, input.imap.secure);

      // What the walk learns, for the one refusal reported at the end. The FIRST certificate
      // failure wins — on the standard ladder that is 993, the rung a provider presenting a
      // certificate at all presents it on first.
      let certDetail: ProbeTlsDetail | null = null;
      let certErr: unknown;
      let starttlsAbsent = false;
      let sawTimeout = false;
      let fallback: ImapProbeVerdict | null = null;

      for (const attempt of attempts) {
        if (budgetLeft() < 250) { sawTimeout = true; break; }
        const r = await dialOnce(attempt, false);
        if (r.ok) {
          return {
            verdict: "ok",
            proven: { host: input.imap.host, port: attempt.port, secure: attempt.secure },
            // Spread, never `folders: r.folders` — the key must be genuinely ABSENT when nobody
            // counted, because absent and `0` are different answers and the copy tells them apart.
            ...(r.folders === undefined ? {} : { folders: r.folders }),
          };
        }
        if (r.timedOut) { sawTimeout = true; continue; }

        if (isStarttlsUnavailable(r.err)) { starttlsAbsent = true; continue; }

        const v = verdictFor(r.err);
        // Contact was made and the server declined to serve RIGHT NOW — positive evidence for
        // exactly this combination, so it is the one stored. No later rung could learn more.
        if (v.verdict === "store_unverified") {
          return { ...v, proven: { host: input.imap.host, port: attempt.port, secure: attempt.secure } };
        }
        // The LOGIN was reached and refused: host, port and TLS mode are all PROVEN, only the
        // password is wrong. Walking on would retry a bad password against the same account,
        // which helps nobody and hurries providers toward a lockout.
        if (v.verdict === "refuse" && v.code === "auth") return v;

        if (v.verdict === "refuse" && v.code === "tls") {
          if (isNotTlsListener(r.err)) {
            // TLS spoken to a plaintext talker: evidence about the PORT, not about a
            // certificate. It neither blocks the consent gate nor beats the generic fallback.
            fallback = fallback ?? v;
          } else if (!certDetail) {
            certDetail = tlsDetailOf(r.err, input.imap.host);
            certErr = r.err;
          }
          continue;
        }
        if (v.verdict === "refuse" && v.code === "timeout") { sawTimeout = true; continue; }
        fallback = fallback ?? v;
      }

      /**
       * ── THE CONSENT GATE — plaintext, never automatic, never on a server that HAS TLS ─────
       *
       * Dialled only when ALL of the following held in THIS call, never on the client's word:
       *  · the caller carried the explicit consent flag AND a password (an OAuth mailbox is
       *    refused this path by type and by the check below);
       *  · a rung reached an IMAP greeting and the server named no STARTTLS — TLS is ABSENT;
       *  · no rung presented a certificate, valid or not. A server whose TLS exists but fails
       *    validation keeps its precise refusal: offering plaintext there would convert a
       *    certificate problem into a downgrade path, which is the attack, not the fix.
       */
      if (
        starttlsAbsent && !certDetail
        && input.imap.allowInsecure === true && input.imap.pass !== undefined
        && budgetLeft() >= 250
      ) {
        const port = input.imap.port ?? 143;
        const r = await dialOnce({ port, secure: false }, true);
        if (r.ok) {
          return { verdict: "ok", proven: { host: input.imap.host, port, secure: false, insecure: true } };
        }
        if (!r.timedOut) {
          const v = verdictFor(r.err);
          if (v.verdict === "store_unverified") {
            return { ...v, proven: { host: input.imap.host, port, secure: false, insecure: true } };
          }
          return v;
        }
        sawTimeout = true;
      }

      // The one refusal, ranked by how much the walk actually learned: a certificate examined
      // beats "no TLS anywhere", beats "our clock expired", beats "nothing answered".
      if (certDetail) {
        const suggested = certDetail.kind === "hostname_mismatch"
          ? await suggestedHostFor(input.imap.host, certNamesOf(certErr), resolveCname)
          : null;
        return {
          verdict: "refuse", code: "tls",
          tls: suggested ? { ...certDetail, suggestedHost: suggested } : certDetail,
        };
      }
      if (starttlsAbsent) return { verdict: "refuse", code: "tls", tls: { kind: "tls_unavailable" } };
      // A deadline is OUR clock expiring, not a code the server sent — classified here rather
      // than fed to `verdictFor`, which would answer `unknown` and blame itself for a provider
      // that went quiet. The user-facing outcome is `err_timeout`'s and it is accurate.
      if (sawTimeout) return { verdict: "refuse", code: "timeout" };
      return fallback ?? { verdict: "refuse", code: "connect" };
    } finally {
      // Give the slot back exactly once, after the last rung's socket is down (see `dialOnce`
      // for the deadline asymmetry). Best-effort by necessity, never silent: a lost release
      // leaves the counter one high until the 90 s stale window reclaims it, which is the
      // bounded direction. `err` is a DATABASE error and carries no credential; the probe's
      // own throw is never logged.
      try {
        await imapAdmission(deps).release(deps.db, key, deps.now());
      } catch (err) {
        deps.logger?.warn?.("imap_probe_slot_release_failed", { err: String(err) });
      }
    }
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SMTP PROBE — the other transport, same discipline
   ══════════════════════════════════════════════════════════════════════════════════════════

   Same connect-time promise as the IMAP probe (try it before storing it, say which thing
   failed, never log a body or a throw), same ladder idea, one deliberate asymmetry: there is
   NO consent arm. Plaintext SMTP authentication is not offered in this flow at all, so a
   no-TLS submission host refuses with the `tls_unavailable` sentence and stops.

   The classifier reads SENTENCES where the IMAP one reads codes, and that is nodemailer's
   doing, not a choice: `smtp-connection` wraps every TLS-layer failure in a fresh Error
   ("Error initiating TLS - …" at connect, `_actionSTARTTLS` at upgrade), so the OpenSSL code
   and the `cert` object are gone and only the original message text survives. Pinned to
   nodemailer@6.10.1; the specimen table in the tests is what notices a version moving it. */

const smtpMessageOf = (err: unknown): string =>
  typeof (err as ErrorShape | null)?.message === "string" ? String((err as ErrorShape).message) : "";

/** SMTP replies that mean "the credentials were parsed and refused" (RFC 4954). */
const SMTP_AUTH_RESPONSE_CODES: ReadonlySet<number> = new Set([534, 535]);

/**
 * The certificate names an SMTP failure carried. MEASURED LIVE against the same vanity-CNAME
 * mailbox the suggestion above was written for:
 * on both the 465 handshake and the 587 upgrade, nodemailer routes the identity failure
 * through `_onSocketError` → `_formatError('ESOCKET')`, which OVERWRITES `err.code` but
 * PRESERVES the original message, `cert`, `reason` and `host`. So the cert object is first
 * choice, and Node's own sentence ("… is not in the cert's altnames: DNS:a, DNS:b") is the
 * fallback for any path that really does re-wrap into a fresh Error.
 */
export function smtpCertNamesOf(err: unknown): { certHost: string | null; altNames: string[] } {
  const { certHost, altNames } = certNamesOf(err);
  if (certHost || altNames.length > 0) return { certHost, altNames };
  const parsed = [...smtpMessageOf(err).matchAll(/DNS:([A-Za-z0-9.*-]+)/g)]
    .map((m) => m[1]!)
    .filter((n) => n.length > 0);
  return { certHost: parsed[0] ?? null, altNames: parsed };
}

/**
 * The TLS-layer classification of an SMTP dial failure, or null when TLS was not the layer.
 *
 * SENTENCES FIRST, code classes second — the reverse of the IMAP classifier — because
 * nodemailer's `_formatError` stamps its own transport code (`ESOCKET`/`ECONNECTION`/`ETLS`)
 * over whatever OpenSSL said, so the code alone reads "socket problem" about a certificate
 * refusal. Measured live before this ordering existed: the vanity host's hostname mismatch
 * arrived as `code: "ESOCKET"` with Node's full identity sentence intact, and the
 * code-gated version of this function answered `connect` — a true sentence about the wrong
 * thing, on the exact host this classifier was written against.
 */
export function smtpTlsDetailOf(err: unknown, expectedHost: string): ProbeTlsDetail | null {
  const message = smtpMessageOf(err);
  const code = codeOf(err);
  // requireTLS sent STARTTLS even unadvertised and the server answered non-2xx: no upgrade to
  // be had. The one SMTP shape that maps to "this server offers no encryption".
  if (/upgrading connection with STARTTLS/i.test(message)) return { kind: "tls_unavailable" };
  if (/does not match certificate'?s altnames/i.test(message)) {
    const { certHost } = smtpCertNamesOf(err);
    return { kind: "hostname_mismatch", expectedHost, ...(certHost ? { certHost } : {}) };
  }
  if (/certificate has expired/i.test(message)) return { kind: "expired" };
  if (/not yet valid/i.test(message)) return { kind: "not_yet_valid" };
  if (/self[- ]signed certificate/i.test(message)) return { kind: "self_signed" };
  if (/unable to (verify the first certificate|get local issuer certificate)/i.test(message)) {
    return { kind: "untrusted" };
  }
  if (code === "ETLS" || isTlsCode(code) || /initiating TLS/i.test(message)) return { kind: "generic" };
  return null;
}

/**
 * The submission ladder. 465 (implicit TLS) before 587 (STARTTLS) when no port is named —
 * RFC 8314 §3.3's preference — and mode negotiation on a named port, exactly as
 * {@link probeAttempts} does for IMAP.
 */
export function smtpProbeAttempts(port?: number, secure?: boolean): ProbeAttempt[] {
  if (port !== undefined) {
    if (secure !== undefined) return [{ port, secure }];
    return port === 465
      ? [{ port, secure: true }, { port, secure: false }]
      : [{ port, secure: false }, { port, secure: true }];
  }
  return [{ port: 465, secure: true }, { port: 587, secure: false }];
}

/** The non-TLS classification of an SMTP dial failure. Order mirrors {@link verdictFor}. */
export function smtpVerdictFor(err: unknown): ImapProbeVerdict {
  const code = codeOf(err);
  if (code) {
    if (TIMEOUT_ERRNOS.has(code)) return { verdict: "refuse", code: "timeout" };
    if (CONNECT_ERRNOS.has(code) || code === "ECONNECTION" || code === "ESOCKET" || code === "EDNS") {
      return { verdict: "refuse", code: "connect" };
    }
    if (code === "EAUTH") return { verdict: "refuse", code: "auth" };
  }
  const rc = (err as { responseCode?: unknown } | null)?.responseCode;
  if (typeof rc === "number") {
    if (SMTP_AUTH_RESPONSE_CODES.has(rc)) return { verdict: "refuse", code: "auth" };
    // 421: the server was reached, said it is shutting the door right now, and proved the
    // combination in the process — the SMTP twin of the IMAP `UNAVAILABLE` case.
    if (rc === 421) return { verdict: "store_unverified", code: "connect" };
  }
  return { verdict: "refuse", code: "unknown" };
}

/** Same keyspace prefix as the IMAP probe's, own namespace — the two budgets are independent. */
export function smtpProbeAdmissionKey(accountId: string, address: string): string {
  return `probe:smtp:${createHash("sha256").update(`${accountId}:${address.toLowerCase()}`).digest("hex")}`;
}

export interface SmtpProbeOptions {
  maxPerAddress?: number;
  deadlineMs?: number;
  /**
   * The dial, injectable for the ladder tests. Default: {@link verifySmtpLogin} on the floor.
   *
   * It resolves to what the login PROVED — today the server's advertised `SIZE` — and a double
   * that resolves `undefined` is treated as "nothing was learned", so every pre-SIZE test double
   * keeps meaning exactly what it meant.
   */
  dial?: (
    smtp: {
      host: string; port: number; secure: boolean; auth: { user: string; pass: string };
      /** The cleared addresses this dial may connect to, when the deployment's guard cleared any
       * — see {@link ProbeHostGuard}. Optional so every existing double keeps compiling and keeps
       * meaning what it meant; a double that ignores it simply asserts less than the real dial. */
      pin?: readonly string[];
    },
  ) => Promise<SmtpLoginProof | void>;
  resolveCname?: (host: string) => Promise<string | null>;
}

/** Build the add-time SMTP probe. Injected by `routes/mailboxes.ts` beside {@link makeImapProbe}. */
export function makeSmtpProbe(deps: ApiDeps, opts: SmtpProbeOptions = {}): SmtpProbe {
  const max = opts.maxPerAddress ?? MAX_PROBES_PER_ADDRESS;
  const deadlineMs = opts.deadlineMs ?? PROBE_DEADLINE_MS;
  const dial: NonNullable<SmtpProbeOptions["dial"]> = opts.dial
    ?? deps.services?.smtpVerify
    ?? ((smtp): Promise<SmtpLoginProof> => verifySmtpLogin(smtp, PROBE_TIMEOUTS));
  const resolveCname = opts.resolveCname ?? nodeResolveCname;
  const hostGuard = probeHostGuardFor(deps);

  return async (input: SmtpProbeInput): Promise<ImapProbeVerdict> => {
    // SSRF/port gate, same as the IMAP probe — refused hosts and non-mail ports never reach a dial,
    // and the permit is the pin every rung of the submission ladder dials. The submission host is
    // its own name and gets its own check, so its pin is separate from the IMAP leg's.
    const pin = pinFrom(await hostGuard.check(input.smtp.host, input.smtp.port, "smtp"));

    const key = smtpProbeAdmissionKey(input.accountId, input.address);
    if (!await imapAdmission(deps).acquire(deps.db, { mailboxId: key, max, now: deps.now() })) throw busy();

    const startedAt = Date.now();
    const budgetLeft = (): number => deadlineMs - (Date.now() - startedAt);

    try {
      const attempts = smtpProbeAttempts(input.smtp.port, input.smtp.secure);
      let certDetail: ProbeTlsDetail | null = null;
      let certErr: unknown;
      let starttlsAbsent = false;
      let sawTimeout = false;
      let fallback: ImapProbeVerdict | null = null;

      for (const attempt of attempts) {
        if (budgetLeft() < 250) { sawTimeout = true; break; }
        let failure: { err: unknown } | null = null;
        let proof: SmtpLoginProof | void = undefined;
        try {
          proof = await withDeadline(dial({
            // The NAME, for SNI and the certificate check; `pin` alone decides the address.
            host: input.smtp.host, port: attempt.port, secure: attempt.secure,
            auth: { user: input.smtp.user, pass: input.smtp.pass },
            ...(pin ? { pin } : {}),
          }), Math.max(1, budgetLeft()));
        } catch (err) {
          failure = { err };
        }
        if (!failure) {
          return {
            verdict: "ok",
            proven: {
              host: input.smtp.host, port: attempt.port, secure: attempt.secure,
              // `?? null` and never `?? undefined`: a dial that resolved without a number said
              // "this server announced no ceiling", which is a fact worth storing as such. A test
              // double resolving `void` lands in the same place, which is what makes it inert.
              maxMessageBytes: proof?.maxMessageBytes ?? null,
            },
          };
        }
        if (failure.err instanceof ProbeDeadlineExceeded) { sawTimeout = true; continue; }

        const tls = smtpTlsDetailOf(failure.err, input.smtp.host);
        if (tls) {
          if (tls.kind === "tls_unavailable") { starttlsAbsent = true; continue; }
          if (!certDetail) { certDetail = tls; certErr = failure.err; }
          continue;
        }
        const v = smtpVerdictFor(failure.err);
        if (v.verdict === "store_unverified") {
          return { ...v, proven: { host: input.smtp.host, port: attempt.port, secure: attempt.secure } };
        }
        if (v.verdict === "refuse" && v.code === "auth") return v;
        if (v.verdict === "refuse" && v.code === "timeout") { sawTimeout = true; continue; }
        fallback = fallback ?? v;
      }

      // Same ranking as the IMAP walk: a certificate examined beats "no TLS", beats the clock,
      // beats "nothing answered". And NO consent gate — see the section header.
      if (certDetail) {
        const suggested = certDetail.kind === "hostname_mismatch"
          ? await suggestedHostFor(input.smtp.host, smtpCertNamesOf(certErr), resolveCname)
          : null;
        return {
          verdict: "refuse", code: "tls",
          tls: suggested ? { ...certDetail, suggestedHost: suggested } : certDetail,
        };
      }
      if (starttlsAbsent) return { verdict: "refuse", code: "tls", tls: { kind: "tls_unavailable" } };
      if (sawTimeout) return { verdict: "refuse", code: "timeout" };
      return fallback ?? { verdict: "refuse", code: "connect" };
    } finally {
      try {
        await imapAdmission(deps).release(deps.db, key, deps.now());
      } catch (err) {
        deps.logger?.warn?.("smtp_probe_slot_release_failed", { err: String(err) });
      }
    }
  };
}
