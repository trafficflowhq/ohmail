import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxCredentials } from "@trafficflow/db";
import { ImapAdapter, RawMessageTooLargeError, buildImapAuth, storedTlsPin, type CredMetaAuth } from "@trafficflow/core/adapters/imap";
import { ServiceError, type OpenAdapter, type AttachmentAdapter } from "@trafficflow/services/mail";
import { isMessageGone } from "@trafficflow/core/mail";
import type { ApiDeps } from "./deps.js";
import { dialFieldsFor, dialPort, portForDial } from "./dial-host-guard.js";
import { imapAdmission } from "./routes/shared.js";
import { IMAP_OPERATION_DEADLINE_MS, raced } from "./imap-budget.js";

/**
 * Build the API's `openAdapter` for on-demand attachment fetch. Mirrors the sync worker's creds
 * boundary without importing the worker: reads `mailbox_credentials`, decrypts via
 * `deps.keyProvider`, returns a connected `ImapAdapter` exposing its reads + `close`; bytes are
 * never persisted server-side. Also the only place that can count connections: providers cap
 * concurrent logins per account, and imapflow marks every LOGIN failure `authenticationFailed`,
 * so an uncapped burst once read as a wrong password. The cap lives here, not in
 * `AttachmentsService` (which never dials IMAP); every caller comes through `openAdapter`. A test
 * injecting its own `openAdapter` bypasses the cap by design — the cap's tests drive this file.
 */

/**
 * How many concurrent IMAP connections the API may hold for one mailbox. Two, a budget shared
 * with the worker rather than an independent allowance: the worker holds one persistent
 * connection per mailbox, so the deployment's steady-state footprint is 3 (up to 5 across a
 * counter window roll — see `IMAP_ADMISSION_WINDOW_MS`). The low end of what mainstream IMAP
 * servers accept per account is around ten, so this leaves room for the user's own mail
 * clients, which we are a guest alongside. Two rather than one because attachment fetches are
 * interactive: one would serialise a person clicking two files behind a slow download.
 *
 * A connection the picture door keeps between requests ({@link KeptImap}) is counted by this
 * process's local gate only, not by the shared counter: giving the shared slot back later would
 * need a database handle that outlives its request. That bound is the whole bound only where one
 * process serves the API and lives on (the long-running server, the desktop engine), which is why
 * the route keeps only where the host says so (`ApiServices.keepImap`), never on a host that
 * freezes after its answer.
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

/**
 * How long a connection the single-part door gave back waits for the next part of the same
 * mailbox. A letter's embedded pictures arrive as one request each, two at a time, so the next
 * request comes within milliseconds; ten seconds covers a slow client and is far below any mail
 * server's idle logout.
 */
export const KEPT_IMAP_IDLE_MS = 10_000;

/**
 * No kept connection is used again once it is this old. The admission counter treats a row nobody
 * touched for `IMAP_ADMISSION_WINDOW_MS` (90 s) as stale, and every API connection is meant to
 * live less than the hosted invocation's 60 s; a connection reused part after part would
 * otherwise outlive both.
 */
export const KEPT_IMAP_MAX_AGE_MS = 50_000;

/**
 * A kept connection that has waited longer than this answers a NOOP before it is used again.
 * imapflow's `usable` stays true on a server that went silent (a dropped NAT entry, a restart
 * without a goodbye), and a picture read over such a connection would hang until its operation
 * clock. The pictures of one letter follow each other within milliseconds and skip the check.
 */
export const KEPT_IMAP_PROVE_AFTER_MS = 2_000;

/** How long that NOOP may take; no answer, and the connection is dropped and a fresh one signs in. */
export const KEPT_IMAP_PROVE_MS = 2_000;

/** What a caller may override, for tests. Production passes nothing but `keep`. */
export interface OpenAdapterOptions {
  maxPerMailbox?: number;
  waitMs?: number;
  /**
   * Keep the connection for the next request of the same mailbox and sign-in, instead of logging
   * out at `close()`. The single-part door sets it: a letter's pictures are one request each.
   */
  keep?: boolean;
  /** The kept connection's idle clock, defaulting to {@link KEPT_IMAP_IDLE_MS}. */
  keepIdleMs?: number;
  /**
   * The PER-OPERATION clock, defaulting to {@link IMAP_OPERATION_DEADLINE_MS}. Injectable the way
   * the door's own `budgetMs` is: a case drives the MECHANISM — a hung operation ends, the socket
   * is destroyed, a later `close()` is a no-op — without waiting out the shipping ceiling, and a
   * case beside it asserts the DEFAULT is that ceiling, so neither half is taken on trust.
   */
  operationBudgetMs?: number;
}

/**
 * The per-instance half of the cap. Module level, not inside {@link makeOpenAdapter}: the
 * routes call `makeOpenAdapter(deps)` per handler, so closure state would be per-request and
 * would count nothing (the same shape `routes/events.ts` uses for its SSE counters). It exists
 * alongside the database counter rather than instead of it: this one is exact, free, and gives
 * waiters FIFO order, but bounds one warm instance only; the database counter makes the bound
 * global for every connection a request holds (a kept one between requests counts here only, see
 * {@link MAX_IMAP_PER_MAILBOX}).
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

/**
 * A SIGNED-IN CONNECTION WAITING FOR THE NEXT PART OF ITS MAILBOX. It holds its mailbox's LOCAL
 * slot, so the per-mailbox bound still counts it; the shared database slot is taken by each request
 * that uses it and given back when that request is done, through that request's own handle (a
 * request's handle never outlives the request). Keyed by the mailbox and by the sign-in it was
 * opened with ({@link signInKey}): another mailbox, another account or a changed sign-in never
 * reaches it.
 */
interface KeptImap {
  mailboxId: string;
  key: string;
  adapter: ImapAdapter;
  gate: MailboxGate;
  bornAt: number;
  /** When it was last given back: its last exchange with the server. */
  idleSince: number;
  idle: ReturnType<typeof setTimeout> | null;
}

const kept = new Map<string, KeptImap[]>();

/** The stored sign-in a connection was opened with: its account, mailbox, sealed secret and settings. */
function signInKey(row: { accountId: unknown; mailboxId: unknown; secretEnc: unknown; keyVersion: unknown; meta: unknown; updatedAt: unknown }): string {
  const at = row.updatedAt instanceof Date ? row.updatedAt.getTime() : row.updatedAt;
  return createHash("sha256")
    .update(JSON.stringify([row.accountId, row.mailboxId, row.secretEnc, row.keyVersion, row.meta ?? null, at]))
    .digest("hex");
}

function unkeep(entry: KeptImap): void {
  if (entry.idle !== null) { clearTimeout(entry.idle); entry.idle = null; }
  const list = kept.get(entry.mailboxId);
  if (!list) return;
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) kept.delete(entry.mailboxId);
}

/**
 * Drop a kept connection, then give its local slot back (after the socket, as `close` does). The
 * socket is destroyed, never logged out: a kept connection is idle and holds nothing a LOGOUT would
 * save, and a LOGOUT to a server that went silent waits out the socket timeout, which would hold up
 * the opener, the idle clock or the quit that is discarding it.
 */
function closeKept(entry: KeptImap): void {
  unkeep(entry);
  try {
    entry.adapter.forceClose();
  } catch { /* already down */ } finally {
    giveLocalSlot(entry.mailboxId, entry.gate);
  }
}

/**
 * Drop every kept connection now: the host is going down, or a test is done. Immediate, so a quit's
 * goodbye budget never waits on it. Nothing kept outlives its idle clock anyway.
 */
export function closeKeptImap(): void {
  for (const entry of [...kept.values()].flat()) closeKept(entry);
}

/** Free one local slot of this mailbox held by a waiting connection, so another opener is admitted. */
function evictKept(mailboxId: string): void {
  const oldest = kept.get(mailboxId)?.[0];
  if (oldest) closeKept(oldest);
}

/** Does the connection answer a NOOP within {@link KEPT_IMAP_PROVE_MS}? */
async function answers(adapter: ImapAdapter): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), KEPT_IMAP_PROVE_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    // A NOOP still pending when the clock wins rejects once the caller destroys the socket; caught here.
    return await Promise.race([adapter.noop().then(() => true, () => false), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The refusal, in the one wording every path uses; `retryAfter` is what the envelope turns into `Retry-After`. */
function busy(retryAfter: number): ServiceError {
  return new ServiceError(
    "mailbox_busy", 429,
    "this mailbox already has as many live connections as we will open at once — " +
      "wait a moment and try again",
    { retryAfter },
    true,
  );
}

/**
 * THE MAILBOX'S STORED SIGN-IN, OR THE REFUSAL THAT SAYS THERE IS NONE — one reader for the byte
 * door and the send door. No `imap` row is a mailbox signed out here (a sign-out keeps the mailbox
 * and drops its credentials) or removed: the person's to fix by signing in again, so a 424 that is
 * not retryable. A plain `ServiceError` below 500, so the envelope writes no fault row.
 */
export async function requireImapCredential(deps: ApiDeps, mailboxId: string) {
  const rows = await deps.db.select().from(mailboxCredentials)
    .where(eq(mailboxCredentials.mailboxId, mailboxId));
  const imap = rows.find((r) => r.transport === "imap");
  if (!imap) {
    throw new ServiceError(
      "mailbox_not_signed_in", 424,
      "this mailbox is not signed in here, so nothing was fetched or sent — sign in again in Settings",
      undefined, false,
    );
  }
  return { rows, imap };
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
 * Open the mailbox's stored IMAP login, under the connection cap. Extracted so the second
 * caller (the organizer peek) inherits the cap rather than re-deriving it: a second
 * `new ImapAdapter(...)` elsewhere would be invisible to the cap's tests and quietly break the
 * connection budget this module documents — the failure it prevents is a provider refusing the
 * LOGIN, historically reported to the user as a wrong password. One place decrypts a
 * credential and opens a socket, and every caller queues in the same line;
 * {@link makeOpenAdapter} is a narrowing wrapper over this.
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
  const operationMs = opts.operationBudgetMs ?? IMAP_OPERATION_DEADLINE_MS;
  const keep = opts.keep === true ? { idleMs: opts.keepIdleMs ?? KEPT_IMAP_IDLE_MS } : null;

  return async (mailboxId: string): Promise<AttachmentAdapter> => {
    const opened = await openImapUnderCap(deps, mailboxId, max, waitMs, keep);
    /* ── ONE CLOCK PER OPERATION, AND THE SOCKET DIES ON A BREACH ──
     * This door holds ONE adapter across a multi-part walk and closes it itself, so the unit is
     * one operation ({@link IMAP_OPERATION_DEADLINE_MS}), not the door's dial-and-read budget,
     * which would end an honest download or miss a walk of parts each just under it. A breach
     * DESTROYS the socket rather than leaving it for the caller's `close()`: a graceful close is
     * a LOGOUT the driver queues behind the hanging command, so the teardown — and the mailbox's
     * slot in the shared cap — would wait on the read we gave up on. `dead` latches so the
     * caller's later `close()` is a no-op, not that queued LOGOUT.
     */
    let dead = false;
    /* A GONE MESSAGE IS AN ANSWER, NOT A DEAD SOCKET. The adapter refuses with `MessageGoneError`
     * before any command or after the server answered an empty FETCH, the lock released either way,
     * so the socket is idle and clean: the caller's one re-resolved retry (the forward's read, the
     * repair's tree read, the next part of a walk) runs on it. An optional attachment recovery
     * read can also continue when the declared message size exceeds the source read's cap. */
    const guarded = async <T>(read: () => Promise<T>, keepOpenOnLimit = false): Promise<T> => {
      try {
        return await raced(read(), operationMs);
      } catch (err) {
        const sourceOverLimit =
          keepOpenOnLimit && err instanceof RawMessageTooLargeError && err.sizeBytes > err.limitBytes;
        if (!isMessageGone(err) && !sourceOverLimit) {
          dead = true;
          await opened.forceClose().catch(() => { /* already down; the slots are released */ });
        }
        throw err;
      }
    };
    return {
      // FORWARD `opts` — the ceiling is decided by the service and enforced inside the stream, so
      // dropping it here would leave `ATTACHMENT_MAX_FETCH_BYTES` looking enforced at every layer
      // that reads like it while the only code that can actually stop a 90 MB download never hears
      // the number. The pre-flight would still fire on honest metadata, which is precisely what
      // makes the omission invisible in a test that uses honest metadata.
      fetchPart: (locator, partId, o) => guarded(() => opened.adapter.fetchPart(locator, partId, o)),
      // The streamed read (the desktop's save): the same clock, ceiling and teardown.
      fetchPartTo: (locator, partId, sink, o) => guarded(() => opened.adapter.fetchPartTo(locator, partId, sink, o)),
      // The same clock and teardown, with an optional size-refusal exception for recovery.
      fetchRaw: (locator, o) => guarded(() => opened.adapter.fetchRaw(locator, o), o?.keepOpenOnLimit),
      // The repair's one tree read: the same clock, and a breach destroys the socket the same way.
      fetchStructure: (locator) => guarded(() => opened.adapter.fetchStructure(locator)),
      close: async () => { if (!dead) await opened.close(); },
    };
  };
}

/**
 * Give the shared database slot back. Best-effort by necessity, never silently: if this write is
 * lost the mailbox's counter is one too high until the stale-window reclaim resets it, which is the
 * bounded direction. Throwing here would replace a successful download with an error about our own
 * bookkeeping.
 */
async function giveSharedSlot(deps: ApiDeps, mailboxId: string): Promise<void> {
  try {
    await imapAdmission(deps).release(deps.db, mailboxId, deps.now?.() ?? new Date());
  } catch (err) {
    deps.logger?.warn?.("imap_slot_release_failed", { mailboxId, err });
  }
}

/**
 * A kept connection of this mailbox opened with this sign-in, admitted for this request, or `null`.
 * Connections of another sign-in, dead ones and old ones are dropped on the way, and one that has
 * waited a while is used only once it answers a NOOP ({@link KEPT_IMAP_PROVE_AFTER_MS}). A request the
 * shared counter refuses gets the same refusal a fresh open would, and the kept connection closes.
 */
async function takeKept(
  deps: ApiDeps, mailboxId: string, key: string, max: number, keep: { idleMs: number },
): Promise<OpenedMailboxImap | null> {
  for (const entry of [...(kept.get(mailboxId) ?? [])]) {
    if (entry.key !== key || !entry.adapter.isLive() || Date.now() - entry.bornAt >= KEPT_IMAP_MAX_AGE_MS) {
      closeKept(entry);
    }
  }
  const entry = kept.get(mailboxId)?.pop();
  if (!entry) return null;
  unkeep(entry);
  // Taken out of the waiting list first, so its idle clock cannot drop it under the check.
  if (Date.now() - entry.idleSince >= KEPT_IMAP_PROVE_AFTER_MS && !await answers(entry.adapter)) {
    closeKept(entry);
    return null;
  }
  let admitted: boolean;
  try {
    admitted = await imapAdmission(deps).acquire(deps.db, { mailboxId, max, now: deps.now?.() ?? new Date() });
  } catch (err) {
    closeKept(entry);
    throw err;
  }
  if (!admitted) {
    closeKept(entry);
    throw busy(10);
  }
  return admittedHandle(deps, mailboxId, entry.gate, entry.adapter, { key, bornAt: entry.bornAt, idleMs: keep.idleMs });
}

/**
 * The handle over a connection that holds both slots: `close()` logs out and gives both back, or,
 * for a kept connection, gives the database slot back and leaves the connection waiting with its
 * local slot. Not kept: a dead or old connection, and one another opener is queueing for, whose
 * slot passes to that opener.
 */
function admittedHandle(
  deps: ApiDeps, mailboxId: string, gate: MailboxGate, adapter: ImapAdapter,
  keep: { key: string; bornAt: number; idleMs: number } | null,
): OpenedMailboxImap {
  /**
   * Give each slot back, exactly once.
   *
   * Once, and the flags are load-bearing rather than defensive: `downloadAll`'s `finally` and an
   * error path can both reach `close()`, and a release that ran twice would hand the mailbox a
   * permanent extra unit of budget every time — a cap that silently stops capping, with nothing
   * failing to show for it.
   */
  let localHeld = true;
  let sharedHeld = true;
  const releaseLocal = (): void => {
    if (!localHeld) return;
    localHeld = false;
    giveLocalSlot(mailboxId, gate);
  };
  const releaseShared = async (): Promise<void> => {
    if (!sharedHeld) return;
    sharedHeld = false;
    await giveSharedSlot(deps, mailboxId);
  };
  const release = async (): Promise<void> => {
    releaseLocal();
    await releaseShared();
  };
  return {
    adapter,
    // The slot is returned AFTER the socket is down, never before: releasing first would admit
    // the next request while this connection is still counted by the provider.
    close: async () => {
      if (!localHeld) return;
      if (keep !== null && adapter.isLive() && gate.waiters.length === 0 && Date.now() - keep.bornAt < KEPT_IMAP_MAX_AGE_MS) {
        // The local slot moves to the kept entry; the database slot goes back with this request.
        localHeld = false;
        const entry: KeptImap = { mailboxId, key: keep.key, adapter, gate, bornAt: keep.bornAt, idleSince: Date.now(), idle: null };
        entry.idle = setTimeout(() => { closeKept(entry); }, keep.idleMs);
        (entry.idle as unknown as { unref?: () => void }).unref?.();
        const list = kept.get(mailboxId);
        if (list) list.push(entry); else kept.set(mailboxId, [entry]);
        await releaseShared();
        return;
      }
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
      if (!localHeld) return;
      try {
        adapter.forceClose();
      } finally {
        await release();
      }
    },
  };
}

async function openImapUnderCap(
  deps: ApiDeps, mailboxId: string, max: number, waitMs: number, keep: { idleMs: number } | null = null,
): Promise<OpenedMailboxImap> {
  {
    const { imap: imapRow } = await requireImapCredential(deps, mailboxId);
    // AFTER the credential read: a mailbox signed out here refuses above and reuses nothing. A
    // connection kept from the request before serves this one with no decrypt, no host check and
    // no sign-in.
    const key = keep !== null ? signInKey(imapRow) : null;
    if (keep !== null && key !== null) {
      const reused = await takeKept(deps, mailboxId, key, max, keep);
      if (reused) return reused;
    }

    const meta = (imapRow.meta ?? {}) as CredMetaAuth & {
      host?: string; port?: number; secure?: boolean; insecureConsent?: boolean;
    };
    const imapPort = portForDial(dialPort(meta.port) ?? 993);
    /* THE HOST GUARD, BEFORE EITHER SLOT. This door dials the same stored hostname the send path
     * does, with the same credential, and the check that cleared it ran once at add time — so it
     * runs here too, and the dial goes to what it cleared ({@link dialFieldsFor}). Ahead of the
     * admission slots deliberately: a server this deployment will not dial should cost neither a
     * local slot nor a database one, and refusing after them means two release paths on a request
     * that never had a socket. */
    const dial = await dialFieldsFor(deps, {
      host: meta.host ?? "", port: imapPort, secure: meta.secure ?? true, consent: meta.insecureConsent === true,
      tlsPin: storedTlsPin(meta),
    }, "imap");

    // ADMISSION, before the credential is decrypted and long before a socket exists. Local first:
    // it is free, and reversing the order would spend a database slot on a request that then times
    // out waiting locally and gives it straight back.
    const gate = gateFor(mailboxId);
    // Every slot held by a kept connection waiting for a part: one of them steps aside, so a kept
    // connection never makes another opener of this instance wait or be refused.
    if (gate.held >= max) evictKept(mailboxId);
    if (!await takeLocalSlot(gate, max, waitMs)) {
      retireIfIdle(mailboxId, gate);
      throw busy(Math.max(1, Math.ceil(waitMs / 1000)));
    }

    let admitted: boolean;
    try {
      admitted = await imapAdmission(deps).acquire(deps.db, { mailboxId, max, now: deps.now?.() ?? new Date() });
    } catch (err) {
      // The counter itself failed. FAIL, do not fail open — an uncapped mailbox is exactly the
      // state this exists to prevent, and the route answers it as our own 500. The local slot
      // must still go back or the instance leaks it for ever.
      giveLocalSlot(mailboxId, gate);
      throw err;
    }
    if (!admitted) {
      giveLocalSlot(mailboxId, gate);
      // Longer than the local refusal: this one means another INSTANCE holds the slots, so there
      // is no queue here that could hand one over sooner.
      throw busy(10);
    }

    /** Both slots back, for the two failures below that happen before there is a handle. */
    const release = async (): Promise<void> => {
      giveLocalSlot(mailboxId, gate);
      await giveSharedSlot(deps, mailboxId);
    };

    let adapter: ImapAdapter;
    try {
      const secret = await deps.keyProvider.decrypt(imapRow.secretEnc, imapRow.keyVersion);
      adapter = new ImapAdapter({
        host: meta.host ?? "",
        port: imapPort,
        secure: meta.secure ?? true,
        // The cleared addresses, so the socket goes where the check went, and the plaintext
        // consent only as re-asked there. `host` above is untouched: the pin narrows the ADDRESS.
        ...dial,
        // Read-only attachment fetch: no SMTP. Auth via the shared builder — an oauth2 mailbox mints
        // an access token, a password mailbox is byte-for-byte unchanged.
        auth: buildImapAuth(meta, secret, deps.oauth?.forMailbox(mailboxId, deps.db)),
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
    return admittedHandle(deps, mailboxId, gate, adapter, key !== null ? { key, bornAt: Date.now(), idleMs: keep!.idleMs } : null);
  }
}
