// The desktop's engine: what a refusal is read as, the build's label, and the two disclosures an answer carries.

import { ImapConnectionClosedError } from "@trafficflow/core/adapters/imap";
import { providerAuthservIds } from "@trafficflow/core/mail";
import {
  MailboxErasedError, type MailboxErrorCode, type MailboxSyncBlockReason, SERVER_UNAVAILABLE_CODES,
  SERVER_UNAVAILABLE_RESPONSE_CODES,
} from "@trafficflow/db";
import { seedConsentFor, seedPinFor } from "./credential-host.js";
import { LeaseUnavailableError, leaseRefusalIsNamed } from "@ohmail/organizer/lease";
import type { SidecarImapConfig } from "./engine-types.js";
import { ConnectionReplacedError, LOCAL_CONNECTION_DEAD_AFTER_MS } from "./engine-reconnect.js";

/**
 * Did the server refuse the encrypted way in — the TLS twin of {@link credentialsRefused}.
 * imapflow stamps `tlsFailed` on both of its TLS refusals: no STARTTLS where the options require
 * it (`_failSTARTTLS`), and data injected between the tagged STARTTLS OK and the handshake. Both
 * mean the same thing to a caller: this configuration cannot be dialled, and a poll will not
 * make it dialable — what separates it from a timeout or a refused socket. The same `cause` walk
 * and hop bound as its neighbour: the adapter wraps, and a predicate reading only the outermost
 * error would answer `false` for the wrapped shape.
 */
export function tlsRefused(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    if ((e as { tlsFailed?: unknown }).tlsFailed === true) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * WAS IT THE CERTIFICATE — the one TLS refusal a re-dial cannot talk its way past. Read off the
 * flag the phone's TLS shim stamps on a handshake the platform refused (`shims/tls.js`); no other
 * transport sets it. Narrower than {@link tlsRefused}, which also covers a server with no STARTTLS.
 */
export function certificateRefused(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    if ((e as { certificateRefused?: unknown }).certificateRefused === true) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * THE SERVER WENT QUIET MID-DIAL: imapflow's socket-inactivity timer (`ETIMEOUT`), the one a held
 * sign-in ends on — two minutes of silence on the sync dial. On a server on this computer that is
 * a gateway still running its own sign-in: said apart, never a stop, the ladder re-dials.
 */
export function dialWentQuiet(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    if ((e as { code?: unknown }).code === "ETIMEOUT") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Did the server reject our credentials — one bit, deliberately narrower than the worker's.
 * `classifyMailboxError` is the real taxonomy and this is not a second copy: it answers one question
 * where that answers six, and importing it would bring `@trafficflow/db/cloud`'s hosted Postgres pool
 * into the desktop. What is shared is the SIGNAL, so the two cannot disagree on the one case both
 * judge: imapflow's `authenticationFailed` flag and the OAuth client's `OAUTH_INVALID_GRANT`, each
 * read only after the server's own "not now" (see {@link providerDeclinedForNow}). Everything else —
 * timeout, TLS failure, refused socket, a server that is down or throttling — is NOT this, which
 * keeps a provider blip from telling somebody their password is wrong.
 */
export function credentialsRefused(err: unknown): boolean {
  /* The server's own "not now" comes first, as in the worker's classifier: imapflow stamps the
     flag on EVERY failed LOGIN, so a throttle or a connection cap carries it too, and reading the
     flag first stopped the re-dial for good on a server that only asked us to wait. */
  if (providerDeclinedForNow(err)) return false;
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    if ((e as { authenticationFailed?: unknown }).authenticationFailed === true) return true;
    if ((e as { code?: unknown }).code === "OAUTH_INVALID_GRANT") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * THE SEED'S DIAL: the settings file's host, port and TLS mode, and the plaintext consent its own
 * credential row records for exactly that endpoint ({@link seedConsentFor}). A consent the
 * configuration already carries (a test seam; the shell composes none) is kept. Every other
 * dialler of a mailbox reads the row's flag the same way, the phone's seed included.
 */
export function seedDial(configured: SidecarImapConfig, meta: unknown): SidecarImapConfig {
  // The certificate its row trusts for exactly this endpoint, on the consent's rule ({@link seedPinFor}).
  const pin = configured.tlsPin ?? seedPinFor(meta, configured);
  const pinned = pin ? { ...configured, tlsPin: pin } : configured;
  if (configured.allowInsecure === true || !seedConsentFor(meta, configured)) return pinned;
  return { ...pinned, allowInsecure: true };
}

/**
 * Did the server decline this for now rather than refuse it — a throttle (`ETHROTTLE`, or a
 * positive `throttleReset` hint), RFC 5530 `UNAVAILABLE`/`LIMIT`, or imapflow's own no-connection
 * codes? The same closed evidence `classifyMailboxError` reads above the flag; literals only.
 */
function providerDeclinedForNow(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    const f = e as { code?: unknown; serverResponseCode?: unknown; throttleReset?: unknown };
    if (typeof f.code === "string" && SERVER_UNAVAILABLE_CODES.has(f.code)) return true;
    if (typeof f.serverResponseCode === "string" && SERVER_UNAVAILABLE_RESPONSE_CODES.has(f.serverResponseCode)) return true;
    if (typeof f.throttleReset === "number" && Number.isFinite(f.throttleReset) && f.throttleReset > 0) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * DID THE SERVER ANSWER A FETCH AND REFUSE IT — a tagged `NO` or `BAD`, never a dead socket. A
 * mailbox over quota, a backend being repaired, a host throttling body fetches: the connection is
 * up, the login stands, and one command was declined. Calling that an outage told a person their
 * connection was lost by a server that had just signed them in.
 *
 * Read off imapflow's `responseStatus` and off the command WE sent; the server's words steer
 * nothing. FETCH only — a declined CREATE, MOVE or APPEND still records an outage. A refused
 * SIGN-IN is excluded by class: that answer is `signInRefused`, and the two must not merge.
 */
export function fetchRefusal(err: unknown): "NO" | "BAD" | null {
  if (credentialsRefused(err)) return null;
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    const status = (e as { responseStatus?: unknown }).responseStatus;
    const sent = (e as { executedCommand?: unknown }).executedCommand;
    if ((status === "NO" || status === "BAD") && typeof sent === "string" && IMAP_FETCH_SENT.test(sent)) {
      return status;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** {@link fetchRefusal} as the one bit a branch wants. */
export function fetchRefused(err: unknown): boolean {
  return fetchRefusal(err) !== null;
}

/**
 * The command THIS PROCESS sent, matched on its verb. imapflow builds `executedCommand` from what
 * we handed it, so it is ours to read; the tag is whatever the driver minted and is skipped.
 */
const IMAP_FETCH_SENT = /^\S+ (?:UID )?FETCH\b/i;

/**
 * Did this failure come from the connection, or from the work? The bound counts connection-class failures and nothing
 * else. `LeaseUnavailableError` alone was wrong: an organizer's drain reads `ohmail/_meta` first, so a dead socket
 * surfaces as that class — a READER's gate takes the append-less peek, which never throws by design, so its dead
 * socket arrived as an ordinary adapter error and advanced neither arm: the mirror froze until restart with the pane
 * reporting the mailbox reachable. Still not "any failure": a store or classifier fault says nothing about the
 * socket, and counting it would churn logins on the strength of a bug elsewhere. {@link ConnectionReplacedError} is
 * excluded because it is our own refusal — counting it would let one re-dial arm the bound toward the next. The
 * `cause` chain is walked because both wrappers carry the driver's error underneath.
 */
export function isConnectionFailure(err: unknown): boolean {
  if (err instanceof ConnectionReplacedError) return false;
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    /* A NAMED lease block (a full or undeletable `_meta`, a wrong clock) is the server answering: counted,
       the bound turned its sentence into "connection lost" after eight polls. */
    if (e instanceof LeaseUnavailableError) return !leaseRefusalIsNamed(e);
    if (e instanceof ImapConnectionClosedError) return true;
    const code = (e as { code?: unknown }).code;
    /* imapflow's own vocabulary for a socket that is gone, plus the adapter's `EIMAPCLOSED` and
       the node-level resets. Matched as a closed set of literals rather than by message text:
       a server's own words must never be able to steer this. */
    if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A FAILED DRAIN THAT LEAVES THE CONNECTION STANDING — anything that is not the connection's: a
 * store refusal, a pipeline fault, a model outage. Excluded besides the connection class: our own
 * refusal of a replaced connection, and a mailbox that is gone (the cycle's two removal classes
 * and a lost shard, named as the loop names them), whose login has nothing left to serve.
 */
export function drainFailureKeepsTheLogin(err: unknown): boolean {
  if (isConnectionFailure(err) || err instanceof ConnectionReplacedError) return false;
  if (err instanceof MailboxErasedError) return false;
  const name = (err as { name?: unknown } | null)?.name;
  return name !== "MailboxRemovedError" && name !== "LeaderFencedError";
}

declare const __OHMAIL_ENGINE_VERSION__: string | undefined;
/** The app version both engine bundlers bake in (`define`); undefined where the engine runs unbundled. */
export const BAKED_ENGINE_VERSION: string | undefined =
  typeof __OHMAIL_ENGINE_VERSION__ === "string" ? __OHMAIL_ENGINE_VERSION__ : undefined;

/**
 * THE ENGINE'S BUILD AS THE LOOP'S VERSION LABEL: the commit where the shell or the app has one,
 * else the app version the bundle carries, else null (an unbundled dev run). A label that differs
 * between two builds is what makes the next build re-read a deterministic write-off and lifts a
 * held backstop; `dev`, the cycle's own label for a build that names none (`UNLABELLED_BUILD`), is
 * the same on every build. `unknown` (a shell built without git) and `dev` (the phone's no-commit
 * spelling) are not identities.
 */
export function engineBuildLabel(
  buildCommit: string | undefined, version: string | undefined = BAKED_ENGINE_VERSION,
): string | null {
  const commit = buildCommit?.trim() ?? "";
  if (commit !== "" && commit !== "unknown" && commit !== "dev") return commit;
  const v = version?.trim() ?? "";
  return v === "" ? null : v;
}

/** The closed set {@link isConnectionFailure} matches. Literals only — never a message. */
const CONNECTION_ERROR_CODES = new Set([
  "NoConnection", "EIMAPCLOSED", "ECONNRESET", "ECONNREFUSED", "EPIPE",
  "ETIMEDOUT", "ETIMEOUT", "ESOCKET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND",
]);

/** The detail token for a device store refusing writes, beside `storage` (the desktop row's sentence keys on it). */
export const STORE_REFUSED_DETAIL = "MAILBOX_STORE_REFUSED";

/**
 * THE LOCAL DOOR'S SYNC-FAILURE DISCLOSURE, derived at read time and never written, so the writer
 * pair clears it: a served cycle ends the outage, a replaced password a refused sign-in. `auth`
 * settles at once, an outage after {@link LOCAL_CONNECTION_DEAD_AFTER_MS}; no password stored is the
 * block `awaiting_credentials`, never an error. A consented organizer's failed lease read is the
 * block `leaseBlockReason` named at the runtime, below the connection's facts; a reader row's `organizerChecked` is the
 * runtime's last look. THE ARM ORDER IS THE INVARIANT: refused sign-in, refused plaintext dial, a
 * stored password this install cannot use (no outage clock; confirmed, a closed detail), no password
 * stored (a block with its own clock), outage. Exported for the cases that drive that order.
 */
export async function discloseLocalSyncFailures(
  res: Response,
  states: readonly {
    mailboxId: string;
    connection: {
      unreachableSince: Date | null; signInRefused: boolean; plaintextRefused?: boolean;
      /** A server on this computer, and whether its last dial ended on its silence. */
      localServer?: boolean; signInWentQuiet?: boolean;
      /** Absent on a caller that cannot say, which overlays nothing and leaves the outage arm. */
      credentialBlocked?: { state: "unreadable" | "foreign-host"; confirmed: boolean } | null;
      /** No password on this install, and since when — both, or the arm overlays nothing. */
      needsCredential?: boolean;
      needsCredentialSince?: Date | null;
      /** Write-offs held by the local backstop: the mail is not arriving, and this is ours. */
      writeOffsHeldSince?: Date | null;
      /** The device store refused a statement and nothing has stored since: the same news. */
      storeFaultSince?: Date | null;
    };
    /** Absent on a caller that cannot say, which overlays nothing. */
    holderLooked?: boolean;
    /** Absent on a caller that cannot say, which overlays no block. */
    organizer?: { unreadableSince: string | null; unreadableReason: MailboxSyncBlockReason | null };
  }[],
  at: Date,
): Promise<Response> {
  /* A NULL `organizer_state` on a reader is "not looked" until a look ANSWERED: a look that
     threw is not a reading, and saying "nobody" over it is the false state. */
  const looked = new Map<string, boolean>();
  for (const r of states) {
    if (r.holderLooked !== undefined) {
      looked.set(r.mailboxId, r.holderLooked && (r.organizer?.unreadableSince ?? null) === null);
    }
  }
  const failures = new Map<string, MailboxErrorCode>();
  /* The closed detail token beside a failure, where the refusal is this install's own. */
  const details = new Map<string, string>();
  /* AND THE OUTAGE'S OWN CLOCK, from its first observation: a fact, not an error, so it rides
     beside `status` at any age. The list's status line and a Pull press read it; the Settings
     pane says the same sentence from the reach poll with no bound either. */
  const outages = new Map<string, string>();
  const unreadable = new Map<string, { since: string; reason: MailboxSyncBlockReason }>();
  /* NO PASSWORD STORED, from the moment the runtime entered that state: nothing refused it and
     nothing dials it, so it is a block (the strip's "Not syncing") and never an error or a clock. */
  const awaiting = new Map<string, string>();
  /* A SERVER ON THIS COMPUTER behind an `auth` or `timeout` failure: the row says it was that
     server's own sign-in, beside the code and never as a new member of the taxonomy. */
  const local = new Set<string>();
  for (const r of states) {
    if (r.connection.signInRefused) {
      failures.set(r.mailboxId, "auth");
      if (r.connection.localServer === true) local.add(r.mailboxId);
    }
    else if (r.connection.plaintextRefused === true) {
      /* Settled at once: nothing was dialled, and the sentence is not "can't reach the server". */
      failures.set(r.mailboxId, "connect");
      details.set(r.mailboxId, "MAILBOX_PLAINTEXT_REFUSED");
    } else if (r.connection.credentialBlocked) {
      if (r.connection.credentialBlocked.confirmed) {
        failures.set(r.mailboxId, "connect");
        details.set(r.mailboxId, r.connection.credentialBlocked.state === "unreadable"
          ? "MAILBOX_CREDENTIAL_UNREADABLE" : "MAILBOX_CREDENTIAL_FOREIGN_HOST");
      }
    } else if (r.connection.needsCredential === true) {
      if (r.connection.needsCredentialSince instanceof Date) {
        awaiting.set(r.mailboxId, r.connection.needsCredentialSince.toISOString());
      }
    } else if (r.connection.unreachableSince !== null) {
      outages.set(r.mailboxId, r.connection.unreachableSince.toISOString());
      if (r.connection.localServer === true && r.connection.signInWentQuiet === true) {
        /* Settled at once: the dial already waited the two minutes this names. */
        failures.set(r.mailboxId, "timeout");
        local.add(r.mailboxId);
      } else if (at.getTime() - r.connection.unreachableSince.getTime() >= LOCAL_CONNECTION_DEAD_AFTER_MS) {
        failures.set(r.mailboxId, "connect");
      }
    } else if (r.connection.writeOffsHeldSince instanceof Date || r.connection.storeFaultSince instanceof Date) {
      /* BELOW THE CONNECTION'S FACTS: the server answers and this install's own store or pipeline
         refuses the mail, so the sentence is ours ("could not store this mail"), never the network. */
      failures.set(r.mailboxId, "storage");
      /* THE STORE ITSELF REFUSING, named apart from a held write-off run: only this one is "this
         computer cannot store mail" — a hold over a healthy store keeps the code's own sentence. */
      if (r.connection.storeFaultSince instanceof Date) details.set(r.mailboxId, STORE_REFUSED_DETAIL);
    } else if (r.organizer?.unreadableSince && r.organizer.unreadableReason) {
      unreadable.set(r.mailboxId, { since: r.organizer.unreadableSince, reason: r.organizer.unreadableReason });
    }
  }
  if (failures.size === 0 && outages.size === 0 && looked.size === 0 && unreadable.size === 0
    && awaiting.size === 0) return res;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return res;
  const overlaid = items.map((row) => {
    const m = row as {
      id?: unknown; status?: unknown; organizerRole?: unknown; organizeConsentedAt?: unknown;
      syncBlockedSince?: unknown;
    } | null;
    const id = m && typeof m.id === "string" ? m.id : null;
    const checked = id !== null && m!.organizerRole === "reader" && looked.has(id)
      ? { organizerChecked: looked.get(id)! } : {};
    // Only a row that claims health is overlaid: `disabled` (tombstone, stand-down) is a
    // louder, truer fact about the row than this install's socket, and stays untouched.
    const healthy = id !== null && m!.status === "connected";
    const code = healthy ? failures.get(id) : undefined;
    const detail = healthy ? details.get(id) : undefined;
    const since = healthy ? outages.get(id) : undefined;
    /* "Not syncing" is true of an ORGANIZER that cannot read its lease and false of a reader,
       which keeps mirroring; a block the row already carries is the store's and stands. */
    const organizes = m?.organizerRole !== "reader" && typeof m?.organizeConsentedAt === "string";
    const blocked = healthy && organizes && (m!.syncBlockedSince ?? null) === null
      ? unreadable.get(id) : undefined;
    /* True of a reader and an organizer alike: with no password neither moves any mail. */
    const awaitingSince = healthy && (m!.syncBlockedSince ?? null) === null
      ? awaiting.get(id) : undefined;
    return {
      ...(row as object),
      ...checked,
      ...(code !== undefined ? { status: "error", errorCode: code } : {}),
      ...(code !== undefined && id !== null && local.has(id) ? { errorLocalServer: true } : {}),
      ...(detail !== undefined ? { errorDetail: detail } : {}),
      ...(since !== undefined ? { unreachableSince: since } : {}),
      ...(blocked !== undefined
        ? { syncBlockedReason: blocked.reason, syncBlockedSince: blocked.since } : {}),
      ...(awaitingSince !== undefined
        ? { syncBlockedReason: "awaiting_credentials", syncBlockedSince: awaitingSince } : {}),
    };
  });
  return new Response(JSON.stringify({ ...(body as object), items: overlaid }), {
    status: res.status, headers: { "content-type": "application/json" },
  });
}

/**
 * WHOSE WORD ON A SENDER THIS DOOR READS, per mailbox row (`MailboxDTO.providerConfirms`): the host
 * each runtime dials, which is what ingest and the unsubscribe believe, over the service's reading of
 * the credential row — a seed with no stored password has none — or, where the host names no
 * authserv-id, whether this engine checks the sender's own signature. A row with no runtime keeps
 * the service's answer.
 */
export async function discloseProviderConfirms(
  res: Response, runtimes: readonly { mailboxId: string; imap: { host: string } }[], signatureChecks: boolean,
): Promise<Response> {
  if (res.status !== 200 || runtimes.length === 0) return res;
  const hostOf = new Map(runtimes.map((r) => [r.mailboxId, r.imap.host]));
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return res;
  const overlaid = items.map((row) => {
    const id = (row as { id?: unknown } | null)?.id;
    const host = typeof id === "string" ? hostOf.get(id) : undefined;
    return host === undefined
      ? row : { ...(row as object), providerConfirms: providerAuthservIds(host).size > 0 || signatureChecks };
  });
  return new Response(JSON.stringify({ ...(body as object), items: overlaid }), {
    status: res.status, headers: { "content-type": "application/json" },
  });
}
