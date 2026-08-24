import { eq } from "drizzle-orm";
import { mailboxCredentials } from "@trafficflow/db";
import { ImapAdapter, buildImapAuth, type CredMetaAuth } from "@trafficflow/core/adapters/imap";
import { ServiceError, type OpenAdapter, type AttachmentAdapter } from "@trafficflow/services/mail";
import type { ApiDeps } from "./deps.js";
import { imapAdmission } from "./routes/shared.js";

/**
 * Build the API's `openAdapter` for on-demand attachment fetch. Mirrors the
 * sync worker's creds boundary WITHOUT importing the worker: it reads the
 * mailbox's `mailbox_credentials` (envelope-encrypted at rest), decrypts the
 * IMAP secret via `deps.keyProvider`, and constructs a connected `ImapAdapter`.
 * The returned handle exposes just `fetchPart` + `close` (the AttachmentAdapter
 * seam) — the bytes it fetches are NEVER persisted server-side (§13.2/§14).
 *
 * ── IT IS ALSO THE ONLY PLACE THAT CAN COUNT THE CONNECTIONS ───────────────────────────────
 *
 * This function used to construct an adapter and LOG IN per request with no cap of any kind, so a
 * verified account could open unlimited concurrent IMAP logins against its own provider. The
 * worker holds one persistent connection per mailbox on top of whatever this opens, and nothing
 * was shared between the two processes.
 *
 * The consequence is not a failed download, which is what makes it worth this much code. Providers
 * cap concurrent connections per account — iCloud notably low — and imapflow marks EVERY failure of
 * the LOGIN command with `authenticationFailed = true`
 * (`imapflow/lib/commands/login.js:38`, unconditional in the catch). The sync worker's
 * `classifyMailboxError` read that flag FIRST and answered `"auth"`; the client renders `err_auth`
 * as "Sync failed — the mailbox rejected the password"; three consecutive failures detach the
 * mailbox. So an attachment burst told the user their password was wrong and quarantined a mailbox
 * whose password was fine. That classifier has since been reordered to try the structural evidence
 * before the flag, which narrows the misread for the failures a provider names — it does not
 * remove the reason to cap the connections in the first place.
 *
 * The cap lives HERE and not in `AttachmentsService` for two reasons. Connection admission is IMAP
 * knowledge, and that service's contract is that it never dials IMAP and knows nothing about hosts
 * — every test injects a fake adapter through this same seam. And both callers reach IMAP through
 * `openAdapter`: `fetchBytes` once, `downloadAll` once per mailbox group. A release keyed to
 * `close()` is therefore correct for all three byte routes with no service change at all.
 *
 * A consequence worth stating so nobody "fixes" it: a test that injects its own `openAdapter`
 * bypasses the cap entirely, by design. The cap's own tests drive this function directly instead,
 * asserting that simultaneous opens on one mailbox never exceed the cap, that a close returns its
 * slot, that a double close does not hand one back twice, and that two different mailboxes never
 * contend; the shared counter underneath is exercised against real Postgres for the concurrent
 * cases, including the reclaim of a slot leaked by a killed invocation.
 */

/**
 * HOW MANY CONCURRENT IMAP CONNECTIONS THE API MAY HOLD FOR ONE MAILBOX.
 *
 * Two, and the number is a budget shared with the worker rather than an independent allowance:
 * the worker already holds one persistent connection per mailbox, so the deployment's real
 * footprint is 3 in the steady state (and up to 5 across a counter window roll — see
 * `IMAP_ADMISSION_WINDOW_MS`). Providers publish little, but the low end of what mainstream IMAP
 * servers accept per account is around ten, so this leaves room for the user's own mail clients,
 * which are the connections we are a guest alongside and must never crowd out.
 *
 * Two rather than one because attachment fetches are user-initiated and interactive: one would
 * serialise a person clicking two files in a row behind a download that may take seconds, which is
 * the trade this cap must not make.
 */
export const MAX_IMAP_PER_MAILBOX = 2;

/**
 * How long a request may WAIT for a slot before it is refused.
 *
 * Bounded, and short. A request that waits indefinitely is worse than one that is refused: it
 * consumes its serverless invocation, shows the user a spinner that means nothing, and eventually
 * dies at `maxDuration` with no error anyone can act on. Two seconds is enough to absorb the real
 * pattern — a burst of clicks arriving together, where a holder is already finishing — and short
 * enough that a genuinely saturated mailbox answers quickly and truthfully.
 */
export const IMAP_SLOT_WAIT_MS = 2_000;

/** What a caller may override, for tests. Production passes nothing. */
export interface OpenAdapterOptions {
  maxPerMailbox?: number;
  waitMs?: number;
}

/**
 * THE PER-INSTANCE HALF OF THE CAP.
 *
 * MODULE level, not inside {@link makeOpenAdapter}: the routes call `makeOpenAdapter(deps)` inside
 * each handler, so anything held in that closure would be per-request and would count nothing.
 * This is the same shape `routes/events.ts` uses for its SSE stream counters.
 *
 * It exists alongside the database counter rather than instead of it. This one is exact and free
 * and gives the waiters FIFO order; it bounds one warm instance, which on a serverless host is not
 * the same as bounding the account. The database counter is what makes the bound global.
 */
interface MailboxGate {
  held: number;
  /** FIFO. Each waiter is resolved by a release or rejected by its own deadline, never both. */
  waiters: { admit: () => void; refuse: () => void }[];
}

const gates = new Map<string, MailboxGate>();

function gateFor(mailboxId: string): MailboxGate {
  let gate = gates.get(mailboxId);
  if (!gate) { gate = { held: 0, waiters: [] }; gates.set(mailboxId, gate); }
  return gate;
}

/** Drop an idle gate so the map cannot grow one entry per mailbox this instance ever served. */
function retireIfIdle(mailboxId: string, gate: MailboxGate): void {
  if (gate.held === 0 && gate.waiters.length === 0) gates.delete(mailboxId);
}

/** The refusal, in the one wording every path uses. */
function busy(retryAfterSeconds: number): ServiceError {
  return new ServiceError(
    "mailbox_busy", 429,
    "this mailbox already has as many live connections as we will open at once — " +
      "wait a moment and try again",
    { retryAfterSeconds },
    true,
  );
}

/**
 * Take a local slot, waiting at most `waitMs`. Resolves `true` when the slot is held.
 *
 * The timer and the queue entry are torn down together on BOTH arms, so a waiter can never be
 * admitted after it has already been refused (which would hold a slot nobody ever releases) and
 * can never be left in the queue after it has been admitted (which would consume a later
 * release and stall the next waiter behind a slot that was never really free).
 */
function takeLocalSlot(gate: MailboxGate, max: number, waitMs: number): Promise<boolean> {
  if (gate.held < max) { gate.held += 1; return Promise.resolve(true); }
  if (waitMs <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const entry = {
      admit: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The releaser already counted this slot as ours — see `giveLocalSlot`.
        resolve(true);
      },
      refuse: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      },
    };
    const timer = setTimeout(() => {
      const i = gate.waiters.indexOf(entry);
      if (i >= 0) gate.waiters.splice(i, 1);
      entry.refuse();
    }, waitMs);
    // `unref` where the runtime has it: a pending refusal timer must never be the reason a
    // process stays alive. Absent in the browser-shaped typings, so it is probed, not assumed.
    (timer as unknown as { unref?: () => void }).unref?.();
    gate.waiters.push(entry);
  });
}

/**
 * Hand a local slot to the next waiter, or back to the gate.
 *
 * The slot is passed DIRECTLY rather than decremented and re-acquired: dropping `held` first would
 * open a window in which a brand-new request could take the slot ahead of somebody who has already
 * been queueing, which is how a FIFO queue silently becomes a lottery under load.
 */
function giveLocalSlot(mailboxId: string, gate: MailboxGate): void {
  const next = gate.waiters.shift();
  if (next) { next.admit(); return; }
  gate.held -= 1;
  retireIfIdle(mailboxId, gate);
}

/**
 * A LIVE, ADMITTED IMAP CONNECTION FOR ONE MAILBOX, AND THE ONE WAY TO GET ONE HERE.
 *
 * `close()` puts BOTH slots back — the per-instance one and the shared database counter — and is
 * safe to call twice.
 */
export interface OpenedMailboxImap {
  adapter: ImapAdapter;
  close(): Promise<void>;
  /** Destroy the socket NOW (no LOGOUT — that queues behind a hung command) and free the slots. */
  forceClose(): Promise<void>;
}

/**
 * Open the mailbox's stored IMAP login, under the connection cap.
 *
 * ── EXTRACTED SO THE SECOND CALLER INHERITS THE CAP RATHER THAN RE-DERIVING IT ─────────────
 *
 * This was the body of {@link makeOpenAdapter}, and it stayed private for as long as attachments
 * were the only reason the API dialled IMAP. The organizer peek is the second reason, and the
 * dangerous version of adding it is a second `new ImapAdapter(...)` somewhere else: it would be
 * correct on the day it was written and invisible to every one of the cap's tests, so a mailbox's
 * real concurrent-connection count would quietly stop matching the number this module documents.
 * The cap is not a nicety — the failure it prevents is a provider refusing the LOGIN, which
 * `classifyMailboxError` has historically reported to the user as a wrong password.
 *
 * So: one place decrypts a credential and opens a socket, and every caller queues in the same
 * line. {@link makeOpenAdapter} is now a narrowing wrapper over this.
 */
export async function openMailboxImap(
  deps: ApiDeps, mailboxId: string, opts: OpenAdapterOptions = {},
): Promise<OpenedMailboxImap> {
  const max = opts.maxPerMailbox ?? MAX_IMAP_PER_MAILBOX;
  const waitMs = opts.waitMs ?? IMAP_SLOT_WAIT_MS;
  return openImapUnderCap(deps, mailboxId, max, waitMs);
}

export function makeOpenAdapter(deps: ApiDeps, opts: OpenAdapterOptions = {}): OpenAdapter {
  const max = opts.maxPerMailbox ?? MAX_IMAP_PER_MAILBOX;
  const waitMs = opts.waitMs ?? IMAP_SLOT_WAIT_MS;

  return async (mailboxId: string): Promise<AttachmentAdapter> => {
    const opened = await openImapUnderCap(deps, mailboxId, max, waitMs);
    return {
      // FORWARD `opts` — the ceiling is decided by the service and enforced inside the stream, so
      // dropping it here would leave `ATTACHMENT_MAX_FETCH_BYTES` looking enforced at every layer
      // that reads like it while the only code that can actually stop a 90 MB download never hears
      // the number. The pre-flight would still fire on honest metadata, which is precisely what
      // makes the omission invisible in a test that uses honest metadata.
      fetchPart: (locator, partId, o) => opened.adapter.fetchPart(locator, partId, o),
      close: () => opened.close(),
    };
  };
}

async function openImapUnderCap(
  deps: ApiDeps, mailboxId: string, max: number, waitMs: number,
): Promise<OpenedMailboxImap> {
  {
    const rows = await deps.db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, mailboxId));
    const imapRow = rows.find((r) => r.transport === "imap");
    if (!imapRow) throw new ServiceError("upstream_unavailable", 502, "mailbox has no IMAP credentials");

    // ADMISSION, before the credential is decrypted and long before a socket exists. Local first:
    // it is free, and reversing the order would spend a database slot on a request that then times
    // out waiting locally and gives it straight back.
    const gate = gateFor(mailboxId);
    if (!await takeLocalSlot(gate, max, waitMs)) {
      retireIfIdle(mailboxId, gate);
      throw busy(Math.max(1, Math.ceil(waitMs / 1000)));
    }

    let admitted: boolean;
    try {
      admitted = await imapAdmission(deps).acquire(deps.db, { mailboxId, max, now: deps.now?.() ?? new Date() });
    } catch (err) {
      // The counter itself failed. FAIL, do not fail open — an uncapped mailbox is exactly the
      // state this exists to prevent, and the route's blanket 502 is honest about a database
      // fault. The local slot must still go back or the instance leaks it for ever.
      giveLocalSlot(mailboxId, gate);
      throw err;
    }
    if (!admitted) {
      giveLocalSlot(mailboxId, gate);
      // Longer than the local refusal: this one means another INSTANCE holds the slots, so there
      // is no queue here that could hand one over sooner.
      throw busy(10);
    }

    /**
     * Give both slots back, exactly once.
     *
     * Once, and the flag is load-bearing rather than defensive: `downloadAll`'s `finally` and an
     * error path can both reach `close()`, and a release that ran twice would hand the mailbox a
     * permanent extra unit of budget every time — a cap that silently stops capping, with nothing
     * failing to show for it.
     */
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      giveLocalSlot(mailboxId, gate);
      // Best-effort by necessity, never silently: if this write is lost the mailbox's counter is
      // one too high until the stale-window reclaim resets it, which is the bounded direction.
      // Throwing here would replace a successful download with an error about our own bookkeeping.
      try {
        await imapAdmission(deps).release(deps.db, mailboxId, deps.now?.() ?? new Date());
      } catch (err) {
        deps.logger?.warn?.("imap_slot_release_failed", { mailboxId, err: String(err) });
      }
    };

    const meta = (imapRow.meta ?? {}) as CredMetaAuth & {
      host?: string; port?: number; secure?: boolean; insecureConsent?: boolean;
    };
    let adapter: ImapAdapter;
    try {
      const secret = await deps.keyProvider.decrypt(imapRow.secretEnc, imapRow.keyVersion);
      adapter = new ImapAdapter({
        host: meta.host ?? "",
        port: meta.port ?? 993,
        secure: meta.secure ?? true,
        // The connect-time plaintext consent — same threading as the worker and the send
        // adapter, so every dialler of this credential row negotiates the way the probe proved.
        ...(meta.insecureConsent === true ? { allowInsecure: true } : {}),
        // Read-only attachment fetch: no SMTP. Auth via the shared builder — an oauth2 mailbox mints
        // an access token, a password mailbox is byte-for-byte unchanged.
        auth: buildImapAuth(meta, secret, deps.oauth?.forMailbox(mailboxId)),
      });
    } catch (err) {
      // A decrypt that throws happens with both slots held and no adapter to close them through.
      await release();
      throw err;
    }

    // `connect()` does more than dial: it LOGs IN and then LISTs the folders. A failure in the
    // list — a provider hiccup, a hostile mailbox name — happens with a live, authenticated
    // socket already open, and the caller never receives a handle it could close. Without this
    // catch that socket leaks for the rest of the invocation, and a retry loop turns leaked
    // sockets into the provider's rate limiter. Close, then rethrow the ORIGINAL error.
    try {
      await adapter.connect();
    } catch (err) {
      await adapter.close().catch(() => { /* the connection is already broken */ });
      // And the slots go back with it. A connection that never came up holding its slot until the
      // window rolls would turn one bad login into a mailbox nobody can read.
      await release();
      throw err;
    }
    return {
      adapter,
      // The slot is returned AFTER the socket is down, never before: releasing first would admit
      // the next request while this connection is still counted by the provider.
      close: async () => {
        try {
          await adapter.close();
        } finally {
          await release();
        }
      },
      // The abandon path: a caller escaping a HUNG command must not wait behind it — a graceful
      // LOGOUT queues exactly there. The socket is destroyed synchronously (which is what ends
      // the hung command), then both slots go back; settles independently of anything queued.
      forceClose: async () => {
        try {
          adapter.forceClose();
        } finally {
          await release();
        }
      },
    };
  }
}
