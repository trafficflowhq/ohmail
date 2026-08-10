import { createHash } from "node:crypto";
import { type MailboxErrorCode } from "@trafficflow/db";
import { ImapAdapter, buildImapAuth } from "@trafficflow/core/adapters/imap";
import { ServiceError } from "@trafficflow/services/mail";
import type { ApiDeps } from "./deps.js";
import { imapAdmission } from "./routes/shared.js";

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
 * four dialers, not only this one.
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
  | { verdict: "ok" }
  | { verdict: "store_unverified"; code: MailboxErrorCode }
  | { verdict: "refuse"; code: MailboxErrorCode };

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
  | { host: string; port: number; secure: boolean; user: string; pass: string; accessToken?: undefined }
  | { host: string; port: number; secure: boolean; user: string; accessToken: string; pass?: undefined };

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

export interface ImapProbeOptions {
  maxPerAddress?: number;
  deadlineMs?: number;
}

/**
 * Build the add-time IMAP probe. Injected by `routes/mailboxes.ts` at the call site, the same
 * shape `routes/attachments.ts` injects `makeOpenAdapter(deps)`.
 */
export function makeImapProbe(deps: ApiDeps, opts: ImapProbeOptions = {}): (i: ImapProbeInput) => Promise<ImapProbeVerdict> {
  const max = opts.maxPerAddress ?? MAX_PROBES_PER_ADDRESS;
  const deadlineMs = opts.deadlineMs ?? PROBE_DEADLINE_MS;

  return async (input: ImapProbeInput): Promise<ImapProbeVerdict> => {
    const key = probeAdmissionKey(input.accountId, input.address);

    // ADMISSION FIRST, before a socket exists. A counter failure REFUSES rather than admitting:
    // an uncapped dial is precisely the state the counter exists to prevent, and letting a broken
    // counter mean "go ahead" is how a control stops controlling without anything failing.
    if (!await imapAdmission(deps).acquire(deps.db, { mailboxId: key, max, now: deps.now() })) throw busy();

    const adapter = new ImapAdapter({
      host: input.imap.host,
      port: input.imap.port,
      secure: input.imap.secure,
      // Two arms, one dialler. The password arm goes through the shared builder with no token
      // source: it yields `{ user, pass }` here, and an oauth2 `authType` — were one ever to arrive
      // in a request body — would THROW rather than dial with a refresh token as a password. The
      // oauth arm is a literal, already-minted access token; see {@link ImapProbeCredential} for why
      // it does not pretend to be a stored credential.
      auth: input.imap.accessToken !== undefined
        ? { user: input.imap.user, fetchAccessToken: async () => input.imap.accessToken! }
        : buildImapAuth({ user: input.imap.user }, input.imap.pass ?? ""),
      timeouts: PROBE_TIMEOUTS,
    });

    /**
     * Give the slot back exactly once, and only AFTER the socket is down.
     *
     * Releasing before the close would admit the next probe while this connection is still
     * counted by the provider — the cap would read as enforced and would not be. The `released`
     * flag is load-bearing for the same reason `attachments-adapter.ts` gives: a double release
     * hands the address a permanent extra unit of budget, silently.
     */
    let released = false;
    const closeAndRelease = async (): Promise<void> => {
      if (released) return;
      released = true;
      await adapter.close().catch(() => { /* a connection that never came up has nothing to close */ });
      try {
        await imapAdmission(deps).release(deps.db, key, deps.now());
      } catch (err) {
        // Best-effort by necessity, never silent: a lost release leaves the counter one high
        // until the 90 s stale window reclaims it, which is the bounded direction. `err` is a
        // DATABASE error and carries no credential; the probe's own throw is never logged.
        deps.logger?.warn?.("imap_probe_slot_release_failed", { err: String(err) });
      }
    };

    let timedOut = false;
    let verdict: ImapProbeVerdict;
    try {
      await withDeadline(adapter.connect(), deadlineMs);
      verdict = { verdict: "ok" };
    } catch (err) {
      timedOut = err instanceof ProbeDeadlineExceeded;
      // A deadline is OUR clock expiring, not a code the server sent, so it is classified here
      // rather than fed to `verdictFor` — which would answer `unknown` and blame itself for a
      // provider that went quiet. The user-facing outcome is `err_timeout`'s and it is accurate:
      // the connection was accepted and then nothing came back.
      verdict = timedOut ? { verdict: "refuse", code: "timeout" } : verdictFor(err);
    } finally {
      // NOT AWAITED WHEN THE DEADLINE FIRED, and this is the one asymmetry worth stating: the
      // socket we gave up on is by definition one that is not answering, so awaiting its close
      // would reintroduce exactly the unbounded wait the deadline exists to remove. The slot then
      // comes back late, or not at all if the invocation is killed first — which the admission
      // window already reclaims after 90 s. Every other path awaits it, so the common case
      // releases synchronously and the next attempt is never refused by our own bookkeeping.
      if (timedOut) void closeAndRelease();
      else await closeAndRelease();
    }
    return verdict;
  };
}
