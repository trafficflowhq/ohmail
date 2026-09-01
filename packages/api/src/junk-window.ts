import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  contacts, folderState, junkSweepCandidateWhere, mailboxes, messageBodies, messages, recordChange,
  rules as rulesTbl, type Tx,
} from "@trafficflow/db";
import {
  FOLDER_PAGE_MAX, MessageGoneError, makeRef,
  type FolderPage, type FolderPageItem, type FolderSearchPage,
} from "@trafficflow/core/adapters/imap";
/* `core/mail`, never the default barrel: the barrel re-exports `ai/workflows/*`, whose workflow runner
 * imports the db cloud barrel — so one barrel import here pulls the hosted schema (billing,
 * credits, staff grants) into the LOCAL ENGINE bundle this module is part of. The mail subpath
 * is the same surface minus `ai/*`; every name below lives outside it. */
import { UNMETERED_STORAGE_CAP, normalizeMime, unhuskJunkFiledBody } from "@trafficflow/core/mail";
import {
  ServiceError, foldersEnabled, isUuid, requireImapUint32, requireUuid, IMAP_UINT32_MAX,
  type ServiceContext,
} from "@trafficflow/services/mail";
import { openMailboxImap } from "./attachments-adapter.js";
import type { ApiDeps } from "./deps.js";

/**
 * ═══ THE JUNK WINDOW — a live, UN-MIRRORED view of the provider's own \Junk ═══════════════════
 *
 * FOLDERS-SPEC.md §16.2: the Screener's third segment becomes a window into the mailbox's native
 * Junk folder. The DEFINING property is that Junk never enters `messages` or any client mirror —
 * the window reads the folder itself, on request, bounded. The LIST and BODY reads write nothing
 * anywhere; the RESCUE writes exactly three things, each argued at its site: the user-commanded
 * MOVE on the user's own server (the `imap-types.ts` carve-out's second write), the
 * `sync_requested_at` doorbell that follows it, and — for a message OUR OWN verdict husked — the
 * restoration of the husked body, which is the verdict's reversal made whole. No NEW mirror row
 * is ever created here, and `junk-window.test.ts` counts the tables to keep it that way.
 *
 * ── WHY THE API DIALS DIRECTLY INSTEAD OF QUEUEING ON THE WORKER ────────────────────────────
 *
 * The architecture rule draws its line at applying ORGANIZATION: moves defer to the worker via
 * desired state so a serverless function can never leave a mailbox half-moved, while on-demand
 * reads that store nothing — attachment fetch, the gated send — already open a short-lived
 * connection. A junk LIST/BODY read is exactly that second shape: on-demand, short-lived,
 * nothing stored. The API↔worker seam is a database stamp polled every ~3 s (`sync-kick.ts`) —
 * routing an interactive read through it would add seconds of latency per page AND a result
 * channel that marshals junk headers/bodies through the database, which is precisely the
 * storage the window exists to avoid. So the reads go through {@link openMailboxImap}, the SAME
 * admission-capped, budget-counted door every other API dial uses (`MAX_IMAP_PER_MAILBOX` — the
 * worker's own connection is priced into that budget), and the connection is closed before the
 * response leaves. The window also serves only mailboxes whose `status` is `connected`: a
 * stood-down mailbox is another organizer's (a local install holds the lease), and this module
 * never dials — much less writes into — a mailbox Cloud does not organize. The rescue itself is
 * a single-UID move in a folder no ohmail pass ever enumerates, so it contends with no
 * organizer write by construction; the residual — the spec's letter has the worker execute it
 * under the lease — is a recorded deviation, not an accident.
 *
 * ── EVERYTHING IS EPOCH-SCOPED, because \Junk is a folder other software rewrites ───────────
 *
 * A UID names a message only within one UIDVALIDITY epoch, and junk folders get purged and
 * recreated by providers on their own schedule. So: the list carries each row's epoch; the body
 * read REQUIRES the row's epoch and answers 410 on a mismatch rather than serving whatever
 * message now wears the number; the rescue's move is
 * refused on a mismatch by the adapter's own epoch guard, so a stale press can never move a
 * stranger; and the pagination cursor stores each mailbox's epoch beside its
 * watermark — a renumbered folder restarts that mailbox's window at the top instead of silently
 * skipping everything above a stale mark.
 *
 * ── THE RESCUE RE-ENTERS THROUGH THE PIPELINE, NOT AROUND IT (§16.2/G3) ─────────────────────
 *
 * "Not junk" performs one server-side move OUT of Junk into INBOX — which is what un-trains the
 * provider's filter — and then files NOTHING itself: the message's next appearance is a new UID
 * in a watched folder, which the worker ingests like any arrival. Provider-origin junk is
 * genuinely new mail — an unknown sender therefore waits in the Screener, an allowed sender
 * lands in the Ohbox. A message OUR verdict filed is already a (husked) mirror row, and its
 * re-appearance is the adoption path `junk-filing.ts` designed for exactly this restore; what
 * adoption cannot do is un-husk the body the verdict dropped, so the rescue restores it — the
 * same fetch-verify-rewrite `redacted-restore.ts` performs, byte accounting included. A message
 * the provider expunged mid-flight fails HONESTLY: `MessageGoneError` → 410, never a phantom.
 *
 * ── THE SECOND VERB: "NOT JUNK, ALWAYS ALLOW" — the same rescue plus ONE rule transaction ──
 *
 * The plain rescue deliberately touches no rule: a message can be in Junk for reasons that have
 * nothing to do with the sender (the provider's filter, a one-off verdict), and moving it back is
 * not a statement about their future mail. The second verb IS that statement — §16.2: *"the
 * row's second verb, '…and always allow this sender', mints the allow first — a Screener
 * yes-decision, the standard shape — so the mail and every later mail skips the gate."* It runs
 * `allowSender` BEFORE the move, in one transaction, and it has to do two things, not one:
 *
 *  · DISABLE the sender's own spam-promoting rule(s) — `kind:'sender'`, this address,
 *    `destination:'ohmail/Quarantine'`, enabled. Necessary, not decorative: `compareRules` ranks
 *    DENY above ALLOW at equal priority (core/rules.ts — "the user's explicit no is never lost to
 *    a tie"), so a fresh allow rule beside a standing spam rule would LOSE, and the rescued
 *    message would re-file straight back to Junk on arrival. Sender-scoped on purpose: a
 *    domain-wide spam rule covers other senders too, and one press about one address must not
 *    widen to them (a domain rule still outranks the sender allow, exactly as it does for a
 *    Screener yes-decision today — the standard shape, standard limits).
 *  · MINT the allow — `kind:'sender'`, `destination:'INBOX'`, `provenance:'promoted'`, plus the
 *    `contacts` row a yes-decision writes — unless an enabled sender allow already stands (any
 *    allow-side destination: their admission is already given, and a second row at the same rank
 *    would make the pile a UUID coin toss). Both halves emit their `rule` change rows, so every
 *    mirror's rules surface converges.
 *
 * Rules first, move second: the allow must exist before the message's new INBOX UID is ingested,
 * or the arrival is routed under the old rules. A move that then fails 410 leaves the allow
 * standing — the press was about the SENDER, and the sentence the client shows says both halves.
 *
 * ── THE SEARCH-APPEND (§16.2's table: "async search-append with a timeout") ──────────────────
 *
 * `searchJunk` is the list read's exact shape — the same parallel, deadline-raced, force-closed
 * per-mailbox dial — pointed at `searchFolderPage` instead of `listFolderPage`: one server-side
 * `UID SEARCH` per mailbox, the newest `FOLDER_PAGE_MAX` hits fetched, merged and origin-
 * attributed like a page. A mailbox that does not answer within the bound is stated
 * `unreachable` ("Junk could not be searched"), never silently empty; the client asks it only
 * AFTER its client-side filter over the loaded window found nothing, so the window's first paint
 * never waits on it.
 *
 * ── THE ONE-TIME SWEEP OFFER (§16.1) — a COMMAND recorded here, EXECUTED by the worker ──
 *
 * `junkSweepPreview` is the dry run the offer shows: per mailbox, how much mail still sits
 * physically in `ohmail/Quarantine` (`native_locator`), whether a native \Junk is known to move
 * it into, and whether a press is already queued. Database only, no dial. `requestJunkSweep`
 * stamps `mailboxes.junk_sweep_requested_at` (mail 0076) on the mailboxes that have both
 * candidates and a junk folder; the worker consumes the stamp at the top of the mailbox's serial
 * cycle and runs `junkSweepPass` — the CLI's exact function — under the lease. The sweep is the
 * one junk write this module does NOT perform itself: it is a bulk act over MIRRORED rows, which
 * is the organization the API never applies (the architecture line the header above draws).
 * "Never offered twice" is the candidate count itself — a swept pile has none.
 */

/** The junk body read's transfer ceiling — a bounded window never pulls a 90 MB spam payload. */
export const JUNK_BODY_MAX_BYTES = 2_000_000;

/**
 * How long one mailbox's window read may take before it is reported `unreachable`. Reads run in
 * PARALLEL across the account's mailboxes and each is raced against this, so a slow provider
 * costs the response one stated degrade — never the whole invocation's budget (the serverless
 * host's ceiling is 60 s; serial unbounded dials could exhaust it before answering anything).
 */
export const JUNK_READ_TIMEOUT_MS = 20_000;

/** One row of the merged window list, origin attributed. */
export interface JunkItem extends Omit<FolderPageItem, "seq"> {
  mailboxId: string;
  uidValidity: string;
  /**
   * WHO FILED IT (§16.2's origin marker): `"verdict"` — the message-id matches a mirror row our
   * spam verdict (or the one-time sweep) parked at this mailbox's junk path
   * (`messages.native_locator`, written by the worker's filing completion); `"provider"` —
   * everything else, i.e. the mail server's own filter.
   */
  origin: "verdict" | "provider";
}

export interface JunkMailboxState {
  id: string;
  address: string;
  /**
   * The per-mailbox degrade, stated instead of thrown: `"ok"` — the folder was read;
   * `"no_junk_folder"` — the mailbox has no native \Junk (the §16.2 degrade: the segment says
   * so); `"unreachable"` — the dial or the read failed just now (the honest failed state — an
   * empty list is never substituted for it).
   */
  window: "ok" | "no_junk_folder" | "unreachable";
  /**
   * THIS mailbox's pagination cursor was DISCARDED — its UIDVALIDITY changed (the folder was
   * purged/recreated), so the rows in this answer are its new TOP page, not a continuation.
   * The client restarts its window on seeing one (an epoch change with an EMPTY new folder has
   * no row to detect it by, which is why this is stated rather than inferred).
   */
  reset?: boolean;
}

export interface JunkPage {
  mailboxes: JunkMailboxState[];
  items: JunkItem[];
  /** Opaque older-page cursor (per-mailbox epoch + seq watermarks); null when drained. */
  nextCursor: string | null;
}

/** One mailbox's cursor entry: the UIDVALIDITY the watermark belongs to, and the seq below. */
interface CursorEntry { v: string; s: number }

/**
 * How large a junk-window cursor may be on the wire.
 *
 * ── WHY BOTH, AND WHY THEY ARE HERE ─────────────────────────────────────────────────────────
 *
 * This cursor is not an id: it is a caller-supplied base64 JSON OBJECT, one entry per mailbox,
 * and it was bounded by nothing. `parseCursor` decoded the whole value, `JSON.parse`d it and
 * looped every entry — so `?cursor=` could carry any number of keys with any-length `v` strings,
 * and the work was linear in a value the caller typed. The shared `decodeListCursor` never sees
 * this one (it has its own decoder), and the input census recorded `routes/screener.ts#cursor`
 * once for two different readers, so neither guard covered it. Each entry's key must now be a
 * mailbox uuid and its epoch a uint32, which is what stops "any-length `v` strings".
 *
 * ── ONE CEILING, AND A RESIDUAL STATED RATHER THAN HIDDEN ────────────────────────────────
 *
 * This cursor's size IS the account's mailbox count — `listJunk` mints one entry per read lane —
 * and the self-host imposes NO mailbox count limit (`SELF_HOST_MAILBOX_ALLOWANCE`). **So any
 * entry ceiling here rejects a cursor this function itself minted, at some account size.** Two
 * review rounds moved that threshold — 64 entries, then 1 024 — and moving it is not fixing it:
 * the shape of the defect is unchanged, only the account it bites is larger. It is gone.
 *
 * What remains is ONE number, and it is the one this class is actually about: a WIRE ceiling,
 * consulted BEFORE the decode, so an arbitrarily long cursor costs a `.length` rather than a
 * base64 decode, a `JSON.parse` and a loop. It bounds the entry count too, because an entry
 * cannot weigh less than its uuid key.
 *
 * **What it does NOT do, said plainly:** an account with roughly two thousand mailboxes would
 * mint a cursor this refuses. That is not a number a parser can fix — it needs either a real
 * product mailbox ceiling or a cursor whose size does not scale with the mailbox count — and it
 * is a known gap of its own — the same one that carries the unbounded mailbox
 * cardinality this rests on.
 */
export const JUNK_CURSOR_MAX_CHARS = 128 * 1024;

/** The opaque cursor: base64url JSON of {mailboxId → {v, s}}. Malformed input is a 400. */
function parseCursor(raw: string | undefined): Record<string, CursorEntry> {
  if (!raw) return {};
  if (raw.length > JUNK_CURSOR_MAX_CHARS) {
    throw new ServiceError("validation_failed", 400, "cursor is not a junk-window cursor");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    const entries = Object.entries(parsed);
    const out: Record<string, CursorEntry> = {};
    for (const [k, v] of entries) {
      // The KEY is a mailbox id and the epoch is an IMAP UIDVALIDITY — both were untyped here,
      // so a cursor could name any string as a mailbox and any decimal string as an epoch, and
      // both are compared downstream against values from the user's own server.
      if (!isUuid(k)) throw new Error("shape");
      const e = v as { v?: unknown; s?: unknown };
      if (typeof e?.v !== "string" || !/^[1-9][0-9]{0,9}$/.test(e.v) || Number(e.v) > IMAP_UINT32_MAX) {
        throw new Error("shape");
      }
      if (typeof e?.s !== "number" || !Number.isInteger(e.s) || e.s <= 0) throw new Error("shape");
      out[k] = { v: e.v, s: e.s };
    }
    return out;
  } catch {
    throw new ServiceError("validation_failed", 400, "cursor is not a junk-window cursor");
  }
}

function mintCursor(map: Record<string, CursorEntry>): string | null {
  return Object.keys(map).length === 0
    ? null
    : Buffer.from(JSON.stringify(map), "utf8").toString("base64url");
}

/** The foundation gate every junk route shares: the window exists only behind "Use folders". */
async function requireFolders(deps: ApiDeps, accountId: string): Promise<void> {
  if (!accountId || !(await foldersEnabled(deps.db, accountId))) {
    throw new ServiceError("folders_disabled", 409, "the Junk window is part of the folders feature — turn on “Use folders” first");
  }
}

/**
 * The account's CONNECTED mailboxes with their resolved junk paths — ownership by scoping,
 * never by trust, and `status = 'connected'` because a stood-down or disabled mailbox is not
 * Cloud's to dial: its organizer is elsewhere (the lease principle), even while its credential
 * rows remain stored for a later takeover.
 */
async function junkMailboxesOf(
  deps: ApiDeps, accountId: string, mailboxId?: string,
): Promise<Array<{ id: string; address: string; junkFolder: string | null }>> {
  // `disabled` is the stood-down/lease state — another organizer's mailbox. `error` stays in:
  // a transiently erroring mailbox is still Cloud's to read, and the read itself will state
  // `unreachable` honestly when the dial fails.
  // SHAPE before the predicate: `mailboxes.id` is a uuid column and `?mailboxId=` is caller-
  // chosen, so a malformed one reached Postgres as 22P02 — a 500 for a bad query string. Here
  // rather than in the routes, so every present and future caller of this function gets it, which
  // is the argument `requireRealEpoch` makes about its own placement one function up.
  if (mailboxId !== undefined) requireUuid(mailboxId, "mailboxId");
  const scoped = and(eq(mailboxes.accountId, accountId), ne(mailboxes.status, "disabled"));
  const rows = await deps.db
    .select({ id: mailboxes.id, address: mailboxes.address, junkFolder: mailboxes.junkFolder })
    .from(mailboxes)
    .where(mailboxId === undefined ? scoped : and(scoped, eq(mailboxes.id, mailboxId)));
  if (mailboxId !== undefined && rows.length === 0) {
    throw new ServiceError("not_found", 404, "mailbox not found");
  }
  return rows;
}

/** Race a step against the mailbox read's REMAINING budget; a timeout is an ordinary failure. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("junk window read timed out")), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The LIST page: each mailbox's next window read IN PARALLEL (deadline-raced), merged into ONE
 * account-level page of at most {@link FOLDER_PAGE_MAX} rows, origin-attributed against the
 * mirror's verdict locators. Reads only; writes nothing.
 *
 * The merge keeps a PER-MAILBOX SEQ-PREFIX invariant: rows are taken newest-date-first across
 * mailboxes, but a row is only ever taken after every newer-seq row of its own mailbox — so the
 * per-mailbox cursor (the lowest TAKEN seq) can never skip a row the cap cut. Rows cut by the
 * cap are simply not taken; the next page re-reads them from the watermark.
 */
export async function listJunk(
  deps: ApiDeps, accountId: string, opts: { cursor?: string } = {},
): Promise<JunkPage> {
  await requireFolders(deps, accountId);
  const before = parseCursor(opts.cursor);
  const boxes = await junkMailboxesOf(deps, accountId);

  const states: JunkMailboxState[] = [];
  const nextBefore: Record<string, CursorEntry> = {};

  const reads = boxes.map(async (box): Promise<{ boxId: string; page: FolderPage | null } | null> => {
    if (box.junkFolder === null) {
      states.push({ id: box.id, address: box.address, window: "no_junk_folder" });
      return null;
    }
    try {
      /**
       * The deadline CANCELS, it does not merely abandon — and it is ONE budget for the whole
       * mailbox read, dial included (two fresh 20 s timers were a 40 s read; a review counted).
       * A race that walked away would leave the admitted IMAP slot and the socket held by a
       * hung operation until the provider relented, and a couple of those turn every later
       * junk/body/attachment request into `mailbox_busy`. So: the dial's own promise is
       * FORCE-closed if it resolves after its slice of the budget, and a read that outlives
       * the deadline has `forceClose()` run under it — the socket is destroyed (a graceful
       * LOGOUT would queue exactly behind the hung command, which round 3 caught) and both
       * admission slots return, independent of anything the provider still owes.
       */
      const startedAt = Date.now();
      const remaining = (): number => Math.max(1, JUNK_READ_TIMEOUT_MS - (Date.now() - startedAt));
      const openedP = openMailboxImap(deps, box.id);
      let opened: Awaited<typeof openedP>;
      try {
        opened = await withDeadline(openedP, remaining());
      } catch (err) {
        void openedP.then((o) => o.forceClose()).catch(() => { /* never came up */ });
        throw err;
      }
      const page = await (async () => {
        try {
          const held = before[box.id];
          const got = await withDeadline(opened.adapter.listFolderPage(box.junkFolder!, {
            limit: FOLDER_PAGE_MAX,
            ...(held !== undefined ? { beforeSeq: held.s, expectUidValidity: held.v } : {}),
          }), remaining());
          await opened.close().catch(() => { /* socket gone; the slot release has its own guard */ });
          return got;
        } catch (err) {
          // The abandon path — never the graceful close, which waits behind the hang.
          await opened.forceClose().catch(() => { /* already down */ });
          throw err;
        }
      })();
      if (page === null) {
        // The recorded junk path no longer opens on a LIVE connection — the same honest
        // degrade as no folder (transport failures threw and land in the catch below).
        states.push({ id: box.id, address: box.address, window: "no_junk_folder" });
        return null;
      }
      const held = before[box.id];
      states.push({
        id: box.id, address: box.address, window: "ok",
        ...(held !== undefined && held.v !== page.uidValidity ? { reset: true } : {}),
      });
      return { boxId: box.id, page };
    } catch (err) {
      deps.logger?.warn?.("junk_window_read_failed", { mailboxId: box.id, err: String(err) });
      states.push({ id: box.id, address: box.address, window: "unreachable" });
      return null;
    }
  });
  const pages = (await Promise.all(reads)).filter((p): p is { boxId: string; page: FolderPage } => p !== null);

  // ── The k-way merge: newest date first, per-mailbox seq order enforced by taking each
  // mailbox's rows through its own pointer. At most FOLDER_PAGE_MAX rows leave, whatever the
  // mailbox count — the account-level page bound.
  const lanes = pages.map(({ boxId, page }) => ({
    boxId,
    uidValidity: page.uidValidity,
    rows: page.items, // already newest-first by seq
    at: 0,
    tookAny: false,
    lowestTakenSeq: 0,
    adapterNext: page.nextBeforeSeq,
  }));
  const taken: Array<{ lane: (typeof lanes)[number]; row: FolderPageItem }> = [];
  const dateOf = (r: FolderPageItem): number => (r.date !== null ? Date.parse(r.date) || 0 : 0);
  while (taken.length < FOLDER_PAGE_MAX) {
    let best: (typeof lanes)[number] | null = null;
    for (const lane of lanes) {
      if (lane.at >= lane.rows.length) continue;
      if (best === null || dateOf(lane.rows[lane.at]!) > dateOf(best.rows[best.at]!)) best = lane;
    }
    if (best === null) break;
    const row = best.rows[best.at]!;
    best.at += 1;
    best.tookAny = true;
    best.lowestTakenSeq = row.seq;
    taken.push({ lane: best, row });
  }

  // ── Per-mailbox cursors: from the lowest TAKEN seq; a lane with rows left (cut by the cap)
  // resumes below what was taken; an untouched lane keeps its incoming watermark verbatim.
  // Every entry carries the epoch it belongs to.
  for (const lane of lanes) {
    const leftover = lane.at < lane.rows.length;
    if (lane.tookAny) {
      if (leftover || lane.adapterNext !== null) {
        nextBefore[lane.boxId] = { v: lane.uidValidity, s: lane.lowestTakenSeq };
      }
    } else if (lane.rows.length > 0) {
      // Nothing of this mailbox fit the page: resume exactly where this request began.
      const held = before[lane.boxId];
      nextBefore[lane.boxId] = held !== undefined && held.v === lane.uidValidity
        ? held
        : { v: lane.uidValidity, s: lane.rows[0]!.seq + 1 };
    } else if (lane.adapterNext !== null) {
      nextBefore[lane.boxId] = { v: lane.uidValidity, s: lane.adapterNext };
    }
  }
  /**
   * WHILE ANY LANE PAGINATES, EVERY READ LANE KEEPS AN EPOCH ENTRY — a DRAINED mailbox
   * included (round 4's finding). Without one, the next "Show older" re-reads the drained
   * mailbox cursorless: a folder recreated in the meantime would serve its new-epoch top page
   * with NO reset stated (there is no held epoch to compare), and the client — which trusts
   * the stated flag — would append fresh mail under stale rows. The drained entry's watermark
   * is its own lowest taken seq (the next page below it is empty, so nothing repeats), or the
   * incoming watermark / the-top for a lane that contributed nothing; what matters is the `v`,
   * which is what lets the NEXT read detect the recreation and say `reset`.
   */
  if (Object.keys(nextBefore).length > 0) {
    for (const lane of lanes) {
      if (nextBefore[lane.boxId] !== undefined) continue;
      const held = before[lane.boxId];
      const s = lane.tookAny
        ? lane.lowestTakenSeq
        : held !== undefined && held.v === lane.uidValidity
          ? held.s
          : (lane.rows[0]?.seq ?? 0) + 1;
      nextBefore[lane.boxId] = { v: lane.uidValidity, s: Math.max(1, s) };
    }
  }

  const items: JunkItem[] = taken.map(({ lane, row }) => {
    const { seq: _seq, ...header } = row;
    return { ...header, mailboxId: lane.boxId, uidValidity: lane.uidValidity, origin: "provider" as const };
  });

  // ── Origin attribution: the verdict's husk keeps the message-id, and the filing completion
  // parks `native_locator` at the junk path — so a live junk row whose mid matches such a row
  // was filed by US on the user's order. Bounded: at most one IN() over this page's mids.
  await attributeOrigin(deps, accountId, items, boxes);

  return { mailboxes: states, items, nextCursor: mintCursor(nextBefore) };
}

/** Longest search term the window accepts — a bound on what is handed to the provider's SEARCH. */
export const JUNK_SEARCH_MAX_CHARS = 120;

export interface JunkSearchPage {
  mailboxes: JunkMailboxState[];
  items: JunkItem[];
  /** Some mailbox matched more than its page carried — the rows are the newest hits only. */
  truncated: boolean;
}

/**
 * Origin attribution shared by the list and the search: a live junk row whose message-id matches
 * a mirror row parked at this mailbox's junk path was filed by US on the user's order. Bounded:
 * at most one IN() over the rows' mids. Mutates `origin` in place.
 */
/**
 * A Message-ID as a comparable key: trimmed, angle brackets off. The live envelope (imapflow)
 * carries `<id@host>`; the mirror stores the id the parser kept, which is bare — so the two
 * sides of the attribution join never met for a sweep-filed row until this normalisation (the
 * first live proof of the sweep showed its own rows marked "filed by your mail server").
 */
const midKey = (raw: string): string => raw.trim().replace(/^<|>$/g, "");

async function attributeOrigin(
  deps: ApiDeps, accountId: string, items: JunkItem[],
  boxes: Array<{ id: string; junkFolder: string | null }>,
): Promise<void> {
  const keys = [...new Set(items.map((i) => i.messageIdHeader).filter((m): m is string => m !== null).map(midKey))];
  if (keys.length === 0) return;
  const junkPathOf = new Map(boxes.map((b) => [b.id, b.junkFolder]));
  // Both spellings are asked for, so a mirror row stored either way is found; the comparison
  // below is on the normalised key regardless.
  const wanted = [...new Set(keys.flatMap((k) => [k, `<${k}>`]))];
  const rows = await deps.db
    .select({ messageIdHeader: messages.messageIdHeader, mailboxId: messages.mailboxId, nativeLocator: messages.nativeLocator })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), inArray(messages.messageIdHeader, wanted)));
  const filedByUs = new Set(
    rows
      .filter((r) => {
        const loc = r.nativeLocator as { folder?: string } | null;
        return r.messageIdHeader !== null && loc?.folder !== undefined && loc.folder === junkPathOf.get(r.mailboxId);
      })
      .map((r) => `${r.mailboxId} ${midKey(r.messageIdHeader!)}`),
  );
  for (const it of items) {
    if (it.messageIdHeader !== null && filedByUs.has(`${it.mailboxId} ${midKey(it.messageIdHeader)}`)) {
      it.origin = "verdict";
    }
  }
}

/**
 * ONE deadline-raced, force-closed dial of one mailbox, running `work` on the opened adapter —
 * the list read's connection discipline (see the comment inside {@link listJunk}) lifted out so
 * the search shares it verbatim rather than restating it. ONE budget for dial and read together;
 * a read that outlives the deadline has its socket destroyed, never a graceful LOGOUT queued
 * behind the hang.
 */
async function dialWithinBudget<T>(
  deps: ApiDeps, mailboxId: string, budgetMs: number,
  work: (adapter: Awaited<ReturnType<typeof openMailboxImap>>["adapter"]) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const remaining = (): number => Math.max(1, budgetMs - (Date.now() - startedAt));
  const openedP = openMailboxImap(deps, mailboxId);
  let opened: Awaited<typeof openedP>;
  try {
    opened = await withDeadline(openedP, remaining());
  } catch (err) {
    void openedP.then((o) => o.forceClose()).catch(() => { /* never came up */ });
    throw err;
  }
  try {
    const got = await withDeadline(work(opened.adapter), remaining());
    await opened.close().catch(() => { /* socket gone; the slot release has its own guard */ });
    return got;
  } catch (err) {
    await opened.forceClose().catch(() => { /* already down */ });
    throw err;
  }
}

/**
 * THE SEARCH-APPEND: every mailbox's junk folder searched IN PARALLEL behind the read budget,
 * the newest hits merged into ONE bounded, origin-attributed answer. Reads only; writes nothing.
 * A mailbox that fails or times out is stated `unreachable` — "Junk could not be searched" — so
 * an empty answer beside it is never read as "nothing matched".
 */
export async function searchJunk(
  deps: ApiDeps, accountId: string, query: string,
): Promise<JunkSearchPage> {
  await requireFolders(deps, accountId);
  const term = query.trim();
  if (term.length === 0 || term.length > JUNK_SEARCH_MAX_CHARS) {
    throw new ServiceError("validation_failed", 400, `q must be 1–${JUNK_SEARCH_MAX_CHARS} characters`);
  }
  const boxes = await junkMailboxesOf(deps, accountId);
  const states: JunkMailboxState[] = [];
  let truncated = false;

  const reads = boxes.map(async (box): Promise<{ boxId: string; page: FolderSearchPage } | null> => {
    if (box.junkFolder === null) {
      states.push({ id: box.id, address: box.address, window: "no_junk_folder" });
      return null;
    }
    try {
      const page = await dialWithinBudget(deps, box.id, JUNK_READ_TIMEOUT_MS, (adapter) =>
        adapter.searchFolderPage(box.junkFolder!, term, { limit: FOLDER_PAGE_MAX }));
      if (page === null) {
        states.push({ id: box.id, address: box.address, window: "no_junk_folder" });
        return null;
      }
      states.push({ id: box.id, address: box.address, window: "ok" });
      if (page.truncated) truncated = true;
      return { boxId: box.id, page };
    } catch (err) {
      deps.logger?.warn?.("junk_window_search_failed", { mailboxId: box.id, err: String(err) });
      states.push({ id: box.id, address: box.address, window: "unreachable" });
      return null;
    }
  });
  const pages = (await Promise.all(reads)).filter((p): p is { boxId: string; page: FolderSearchPage } => p !== null);

  // Newest-date-first across mailboxes, capped at the page bound — the hits are a window too.
  const dateOf = (r: FolderPageItem): number => (r.date !== null ? Date.parse(r.date) || 0 : 0);
  const all = pages.flatMap(({ boxId, page }) => page.items.map((row) => ({ boxId, uidValidity: page.uidValidity, row })));
  all.sort((a, b) => dateOf(b.row) - dateOf(a.row));
  if (all.length > FOLDER_PAGE_MAX) truncated = true;
  const items: JunkItem[] = all.slice(0, FOLDER_PAGE_MAX).map(({ boxId, uidValidity, row }) => {
    const { seq: _seq, ...header } = row;
    return { ...header, mailboxId: boxId, uidValidity, origin: "provider" as const };
  });
  await attributeOrigin(deps, accountId, items, boxes);
  return { mailboxes: states, items, truncated };
}

/**
 * The BODY on open — fetched live, parsed, returned as TEXT, never persisted and never HTML:
 * junk is the one pile whose bodies are hostile by definition, and a plain-text rendering loads
 * no remote content, runs no markup, and fires no tracker. The session cache is the client's.
 * EPOCH-BOUND: the caller names the UIDVALIDITY its row came from, and a folder renumbered
 * since answers 410 — never the body of whatever message now wears the UID.
 */
/**
 * A UIDVALIDITY that arrived over the wire is only usable if it is a REAL epoch — a positive
 * integer with no leading zero, no sign, no exponent, no whitespace.
 *
 * The two verbs below take `(uid, uidValidity)` from the client and `rescueJunk` builds
 * `${uidValidity}:${uid}` from it, so this value IS the epoch the adapter's guard
 * (`ImapAdapter#assertLocatorEpoch`) compares against the live folder. That guard treats `"0"` as
 * "this locator never claimed an epoch" and lets it through — correct for the worker's cold-drain
 * sentinels, which are minted internally, and wrong for a number a request chose: `uidValidity=0`
 * would switch the guard off for that caller's own rescue and move whatever now wears the UID.
 * Nothing crosses an account boundary (the mailbox is still theirs), so this is a footgun rather
 * than a breach — but it is a footgun in the one place the epoch rule is supposed to hold, and the
 * adapter cannot tell a supplied zero from a sentinel one. So the boundary that accepts the value
 * is the boundary that refuses it.
 *
 * Rejected here rather than in `routes/screener.ts` so there is ONE rule rather than one per
 * route: every present and future caller of these two functions gets it, and it is asserted at the
 * same seam the rest of this module's behaviour is proven at — the Junk window's own suite, which
 * calls these two functions directly.
 *
 * Not `Number(v) > 0`: that accepts `"1e9"`, `" 7 "`, `"0x7"` and `"Infinity"`, none of which is an
 * epoch — and the comparison downstream is a STRING one against the server's decimal digits, so
 * such a value would not match anything and would fail somewhere less honest than here.
 */
function requireRealEpoch(uidValidity: string): void {
  // ── AND IT IS BOUNDED, because the protocol bounds it ──────────────────────────────────
  //
  // `^[1-9][0-9]*$` accepted a decimal string of ANY length. RFC 3501 §2.3.1.1 makes UIDVALIDITY
  // an unsigned 32-bit integer, so a five-hundred-digit "epoch" is not one — and it survived to
  // be compared against the server's answer, which is a value the caller chose reaching a socket
  // conversation with somebody else's mail server. The digit ceiling is checked before the range
  // so an absurd string costs a `.length` rather than a `Number()`.
  if (!/^[1-9][0-9]*$/.test(uidValidity) || uidValidity.length > 10
    || Number(uidValidity) > IMAP_UINT32_MAX) {
    throw new ServiceError(
      "validation_failed", 400,
      `uidValidity must be the row's epoch — an integer between 1 and ${IMAP_UINT32_MAX}`,
    );
  }
}

export async function junkBody(
  deps: ApiDeps, accountId: string,
  args: { mailboxId: string; uid: number; uidValidity: string },
): Promise<{ subject: string; text: string }> {
  requireRealEpoch(args.uidValidity);
  // The UID has the same protocol ceiling as its epoch and had none: `?uid=1e100` is an integer
  // to JavaScript, survived the route's own check, and was written into a FETCH command. See
  // `requireImapUint32`.
  requireImapUint32(args.uid, "uid");
  await requireFolders(deps, accountId);
  const [box] = await junkMailboxesOf(deps, accountId, args.mailboxId);
  if (!box || box.junkFolder === null) {
    throw new ServiceError("no_junk_folder", 404, "this mailbox has no Junk folder");
  }
  const opened = await openMailboxImap(deps, args.mailboxId);
  try {
    const fetched = await opened.adapter.fetchByUid(box.junkFolder, [args.uid], {
      maxBytes: JUNK_BODY_MAX_BYTES,
    });
    if (fetched.uidValidity !== args.uidValidity) {
      throw new ServiceError("junk_message_gone", 410, "the Junk folder changed under this row — reload the list");
    }
    if (fetched.oversize.includes(args.uid)) {
      throw new ServiceError("junk_body_too_large", 413, "this message is too large to preview here — read it in your own mail client");
    }
    const create = fetched.creates.find((c) => c.raw !== undefined);
    if (!create || !create.raw) {
      throw new ServiceError("junk_message_gone", 410, "this message is no longer in the Junk folder");
    }
    const parsed = await normalizeMime(create.raw);
    return { subject: parsed.subject, text: parsed.textBody };
  } finally {
    await opened.close().catch(() => { /* socket gone; the slot release has its own guard */ });
  }
}

/** The spam-promoting destination a verdict's rule carries — the one the second verb disables. */
const SPAM_RULE_DESTINATION = "ohmail/Quarantine";
/** Where a minted allow files — the Screener yes-decision's default (`YES_FOLDER`). */
const ALLOW_RULE_DESTINATION = "INBOX";
/** Every allow-side destination — an enabled sender rule at any of these already admits them. */
const ALLOW_SIDE = ["INBOX", "ohmail/Reads", "ohmail/Receipts"] as const;

export interface AllowSenderOutcome {
  /** Rule ids this press DISABLED — the sender's own spam-promoting rules. */
  disabledRuleIds: string[];
  /** The allow rule minted, or null when an enabled sender allow already stood. */
  createdRuleId: string | null;
}

/**
 * "ALWAYS ALLOW THIS SENDER" — the rule half of the second verb, ONE transaction. The module
 * header argues both halves; this is the mechanism. Everything the standard yes-decision writes
 * for a sender's admission — the promoted allow rule, the `contacts` row, the `rule` change rows
 * — and the one thing it cannot assume: that the sender's spam rule is switched off first, since
 * deny outranks allow at equal priority and the new rule would otherwise never win.
 *
 * Exported for the test; not a route of its own — it exists only beside the rescue.
 */
export async function allowSender(
  deps: ApiDeps, ctx: ServiceContext, address: string,
): Promise<AllowSenderOutcome> {
  const accountId = ctx.accountId;
  const addr = address.trim().toLowerCase();
  if (addr.length === 0 || !addr.includes("@")) {
    throw new ServiceError("unprocessable", 422, "this message has no sender address to allow");
  }
  const nowAt = ctx.now();
  // The services' `asTx` cast: the host's `Db` is the same drizzle handle under a narrower type.
  return (deps.db as unknown as Tx).transaction(async (tx) => {
    // 1. The spam-promoting rules for THIS address, switched off. `.returning()` so the change
    //    rows describe exactly the rows that flipped — an already-disabled rule is not re-announced.
    const disabled = await tx.update(rulesTbl)
      .set({ enabled: false, updatedAt: nowAt })
      .where(and(
        eq(rulesTbl.accountId, accountId),
        eq(rulesTbl.kind, "sender"),
        eq(rulesTbl.match, addr),
        eq(rulesTbl.destination, SPAM_RULE_DESTINATION),
        eq(rulesTbl.enabled, true),
      ))
      .returning({ id: rulesTbl.id });
    for (const r of disabled) {
      await recordChange(tx, { accountId, entityType: "rule", entityId: r.id, op: "update", meta: null });
    }

    // 2. The admission — the yes-decision's `contacts` row, idempotent.
    await tx.insert(contacts).values({ accountId, address: addr })
      .onConflictDoNothing({ target: [contacts.accountId, contacts.address] });

    // 3. The allow rule, unless one already stands. Any allow-side destination counts: their
    //    admission is given, and a second sender allow at the same rank would leave the pile to
    //    a UUID tie-break (`compareRules`' last clause) rather than to a decision.
    const [standing] = await tx.select({ id: rulesTbl.id }).from(rulesTbl)
      .where(and(
        eq(rulesTbl.accountId, accountId),
        eq(rulesTbl.kind, "sender"),
        eq(rulesTbl.match, addr),
        eq(rulesTbl.enabled, true),
        inArray(rulesTbl.destination, [...ALLOW_SIDE]),
        isNull(rulesTbl.subjectContains),
        isNull(rulesTbl.bodyContains),
      ))
      .limit(1);
    if (standing !== undefined) {
      return { disabledRuleIds: disabled.map((r) => r.id), createdRuleId: null };
    }
    const [rule] = await tx.insert(rulesTbl).values({
      accountId,
      kind: "sender",
      match: addr,
      destination: ALLOW_RULE_DESTINATION,
      provenance: "promoted",
      enabled: true,
    }).returning({ id: rulesTbl.id });
    await recordChange(tx, { accountId, entityType: "rule", entityId: rule!.id, op: "create", meta: null });
    return { disabledRuleIds: disabled.map((r) => r.id), createdRuleId: rule!.id };
  });
}

/**
 * "NOT JUNK" — the rescue (§16.2/G3): ONE user-commanded, EPOCH-GUARDED move OUT of Junk back
 * to INBOX, the doorbell, and — for a message OUR verdict husked — the body's restoration. See
 * the module header for how each half re-enters the normal flow.
 *
 * With `allow` — the second verb — {@link allowSender} runs FIRST, for the sender the caller
 * names (the row's own `from`, which the client has in hand and the server cannot learn without
 * a second fetch): the rules must stand before the message's re-arrival is routed. A 410 after
 * the allow leaves it standing, and the answer to the client is the same 410 it knows.
 */
export async function rescueJunk(
  deps: ApiDeps, ctx: ServiceContext,
  args: { mailboxId: string; uid: number; uidValidity: string; allow?: { sender: string } },
): Promise<{ status: "rescued"; allowed?: AllowSenderOutcome }> {
  const accountId = ctx.accountId;
  // BOTH protocol values, and BEFORE any write. `junkBody` got this guard and this seam did not —
  // the second door onto the same FETCH/MOVE, which is the shape a per-route check produces. The
  // ORDER matters as much as the presence: `allowSender` below COMMITS a rule change, so a
  // malformed UID checked after it would leave the user's screening changed by a request that
  // then failed. Every refusal on this path belongs above the first write.
  requireImapUint32(args.uid, "uid");
  requireRealEpoch(args.uidValidity);
  await requireFolders(deps, accountId);
  const [box] = await junkMailboxesOf(deps, accountId, args.mailboxId);
  if (!box || box.junkFolder === null) {
    throw new ServiceError("no_junk_folder", 404, "this mailbox has no Junk folder");
  }
  const ref = makeRef(args.uidValidity, args.uid);
  const allowed = args.allow !== undefined ? await allowSender(deps, ctx, args.allow.sender) : undefined;

  /**
   * EVERYTHING AFTER THE ALLOW SPEAKS THE PARTIAL-OUTCOME LANGUAGE. The move's own catch below
   * translates its two failures; this boundary covers the steps BEFORE it — the husk lookup and
   * the dial itself (a busy mailbox, an unreadable credential, a refused LOGIN) — which used to
   * rethrow raw and read as "nothing happened" while the sender's rules had already changed.
   * An inner ServiceError passes through untouched.
   */
  try {

  /**
   * THE HUSK, if this is our own verdict coming back: the filing completion parked the row's
   * locator at exactly this junk ref, and the verdict dropped the body. Identified BEFORE the
   * move (the raw must be fetched while the message is still in Junk, on the same connection);
   * restored AFTER it (the move is the user's command — a failed restore must not undo it).
   */
  const [husk] = await deps.db
    .select({
      id: messages.id, dedupKey: messages.dedupKey, messageIdHeader: messages.messageIdHeader,
    })
    .from(messages)
    .where(and(
      eq(messages.accountId, accountId),
      eq(messages.mailboxId, args.mailboxId),
      sql`${messages.nativeLocator}->>'folder' = ${box.junkFolder}`,
      sql`${messages.nativeLocator}->>'ref' = ${ref}`,
    ))
    .limit(1);

  const opened = await openMailboxImap(deps, args.mailboxId);
  let raw: Buffer | null = null;
  try {
    if (husk !== undefined) {
      const [body] = await deps.db
        .select({ withheld: messageBodies.withheldReason, text: messageBodies.text, html: messageBodies.html })
        .from(messageBodies)
        .where(eq(messageBodies.messageId, husk.id))
        .limit(1);
      if (body?.withheld === "junk_filed") {
        try {
          const fetched = await opened.adapter.fetchByUid(box.junkFolder, [args.uid], {
            maxBytes: JUNK_BODY_MAX_BYTES,
          });
          const c = fetched.uidValidity === args.uidValidity
            ? fetched.creates.find((x) => x.raw !== undefined)
            : undefined;
          raw = (c?.raw as Buffer | undefined) ?? null;
        } catch (err) {
          // Best-effort: an oversize or failed pre-fetch narrows the rescue to the move; the
          // body stays husked and the marker stays TRUE until the move lands (it still names
          // where the bytes live). Logged, never fatal — the user pressed "move", not "fetch".
          deps.logger?.warn?.("junk_rescue_prefetch_failed", { mailboxId: args.mailboxId, err: String(err) });
        }
      }
    }

    // The move itself. Epoch-guarded, so a recreated folder's reused UID can never send a
    // STRANGER to the inbox under a stale press — the guard is `ImapAdapter#assertLocatorEpoch`
    // and it is unconditional now. It used to be this call site's `{ requireEpoch: true }`, and
    // the flag was the bug: this was the only caller that set it, so the organizer's own move,
    // batch-move and flag mutations ran without it.
    await opened.adapter.move({ folder: box.junkFolder, ref }, "INBOX");
  } catch (err) {
    if (err instanceof MessageGoneError) {
      // The provider (or another client) took it first — or the folder was renumbered. The
      // rescue fails honestly: never a phantom arrival, never a claim of a move that did not
      // happen, and never a different message moved in this one's name. With the second verb
      // the allow was written BEFORE this, and stands — carried in `details` so the client can
      // say both halves.
      //
      // THE SENTENCE NAMES ALL THREE CAUSES AND THEN THE FIX. It used to read "it may have been
      // deleted there", which picks the most alarming of the three and is the least likely: the
      // guard fires on ANY epoch mismatch, and a provider rebuilding the Junk folder renumbers
      // every message in it without deleting one. Naming a deletion that usually did not happen,
      // and offering nothing to do about it, is the over-claim living in the reassuring half of a
      // refusal. The recovery is real — the next scan re-finds the message by Message-ID and
      // repoints it, after which the same press works.
      throw new ServiceError(
        "junk_message_gone", 410,
        "this message is no longer where the mailbox recorded it — it may have moved, been "
          + "deleted in another mail app, or your provider may have rebuilt the Junk folder. "
          + "Refresh and try again.",
        allowed !== undefined ? { allowed } : undefined,
      );
    }
    if (allowed !== undefined) {
      // A move that failed for any OTHER reason (a timeout, a provider refusal) after the allow
      // committed is a PARTIAL outcome, and the client must be able to report it as one: the
      // message is still in Junk, but the sender's rules changed. A bare rethrow would read as
      // "nothing happened".
      throw new ServiceError(
        "junk_rescue_move_failed", 502,
        "the move could not be made just now — the sender is allowed from now on regardless",
        { allowed },
      );
    }
    throw err;
  } finally {
    await opened.close().catch(() => { /* socket gone; the slot release has its own guard */ });
  }

  // ── The verdict's reversal made whole: put the husked body back through the ONE shared
  // verify/rewrite (`core/husk-restore.ts` — the identity witness, the lock-and-recheck, the
  // at-cap posture; the worker's convergence pass for a message that leaves Junk WITHOUT this
  // verb ends at the same function, which is what keeps the two doors from drifting).
  // Best-effort AFTER the move — a failure here leaves the rescue done and the husk standing,
  // which the next verdict surface states honestly.
  if (husk !== undefined && raw !== null) {
    try {
      const fresh = await normalizeMime(raw);
      /**
       * THE CAP HOLDS HERE TOO — resolved HERE, because `storageCapOf` is this host's seam. An
       * absent resolver is a host nobody has read — the `ApiServices.storageCapOf` contract: the
       * unmetered tiers DECLARE the symbol, so undefined must refuse rather than infer unmetered
       * (round 3's finding). The husk stands; the rescue itself has landed.
       */
      const capOf = deps.services?.storageCapOf;
      if (capOf === undefined) {
        deps.logger?.warn?.("junk_rescue_unhusk_no_cap_resolver", { mailboxId: args.mailboxId });
      } else {
        const cap = await capOf(ctx);
        const nowAt = deps.now?.();
        const outcome = await unhuskJunkFiledBody(deps.db, {
          accountId,
          husk: { id: husk.id, dedupKey: husk.dedupKey, messageIdHeader: husk.messageIdHeader },
          fresh,
          capBytes: cap === UNMETERED_STORAGE_CAP ? null : cap,
          ...(nowAt !== undefined ? { now: nowAt } : {}),
        });
        if (outcome === "at_cap") {
          // The decline is the design: the husk STANDS, with its marker still true (the bytes
          // live on in the mailbox), which is exactly the state the storage-cap copy explains.
          deps.logger?.warn?.("junk_rescue_unhusk_at_cap", { mailboxId: args.mailboxId });
        }
      }
    } catch (err) {
      deps.logger?.warn?.("junk_rescue_unhusk_failed", { mailboxId: args.mailboxId, err: String(err) });
    }
  }

  } catch (err) {
    // Only the rescue's OWN answers pass through: `junk_message_gone` (which already carries the
    // allow) and an inner `junk_rescue_move_failed`. Every other failure — a typed dial refusal
    // (`mailbox_busy`, unreadable credentials) as much as a raw transport throw — happened AFTER
    // the allow committed, and must say so (the blanket ServiceError passthrough
    // hid the partial outcome behind the dial's own vocabulary).
    const rescueOwn = err instanceof ServiceError
      && (err.code === "junk_message_gone" || err.code === "junk_rescue_move_failed");
    if (rescueOwn) throw err;
    if (allowed !== undefined) {
      throw new ServiceError(
        "junk_rescue_move_failed", 502,
        "the move could not be made just now — the sender is allowed from now on regardless",
        { allowed, ...(err instanceof ServiceError ? { cause: err.code } : {}) },
      );
    }
    throw err;
  }

  // Ring the doorbell (`sync_requested_at`, mail 0049): the worker's ~3 s kick pass ingests the
  // rescued message's new INBOX UID without waiting for the poll. Best-effort — the poll is the
  // floor beneath it either way.
  try {
    await deps.db.update(mailboxes)
      .set({ syncRequestedAt: deps.now?.() ?? new Date() })
      .where(and(eq(mailboxes.id, args.mailboxId), eq(mailboxes.accountId, accountId)));
  } catch (err) {
    deps.logger?.warn?.("junk_rescue_kick_failed", { mailboxId: args.mailboxId, err: String(err) });
  }
  return allowed !== undefined ? { status: "rescued", allowed } : { status: "rescued" };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE ONE-TIME SWEEP OFFER (FOLDERS-SPEC.md §16.1) — preview and press. Database only.
   The worker executes; see the module header and `apps/worker/src/junk-sweep.ts`.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

export interface JunkSweepMailbox {
  id: string;
  address: string;
  /** Messages still physically in `ohmail/Quarantine` for this mailbox — what a press would move. */
  candidates: number;
  /** Whether a native \Junk is known for this mailbox — without one, nothing can move. */
  hasJunkFolder: boolean;
  /** A press is recorded and the worker has not consumed it yet. */
  pending: boolean;
}

export interface JunkSweepPreview {
  mailboxes: JunkSweepMailbox[];
  /** Candidates across the mailboxes that CAN move (have a junk folder) — the offer's number. */
  movable: number;
  /** Any mailbox has a press outstanding. */
  pending: boolean;
}

/**
 * The dry run the offer shows — per connected, PARTICIPATING mailbox, the pile's size and whether
 * it can move. One count per mailbox over the sweep's own predicate (`junkSweepCandidateWhere`,
 * shared with the worker's pass so the number offered is the number moved), one mailbox read; no
 * dial, no write. A mailbox switched off under "Use folders" (§17, `folders_disabled_at`) is
 * absent from the answer and can therefore never be stamped: an opted-out mailbox performs no
 * move and no IMAP write on the feature's account.
 */
export async function junkSweepPreview(deps: ApiDeps, accountId: string): Promise<JunkSweepPreview> {
  await requireFolders(deps, accountId);
  const boxes = await deps.db
    .select({
      id: mailboxes.id, address: mailboxes.address, junkFolder: mailboxes.junkFolder,
      requestedAt: mailboxes.junkSweepRequestedAt,
    })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, accountId),
      ne(mailboxes.status, "disabled"),
      isNull(mailboxes.foldersDisabledAt),
    ));
  if (boxes.length === 0) return { mailboxes: [], movable: 0, pending: false };
  const countOf = new Map<string, number>();
  for (const b of boxes) {
    const [row] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(junkSweepCandidateWhere(accountId, b.id));
    countOf.set(b.id, Number(row?.n ?? 0));
  }
  const out: JunkSweepMailbox[] = boxes.map((b) => ({
    id: b.id, address: b.address,
    candidates: countOf.get(b.id) ?? 0,
    hasJunkFolder: b.junkFolder !== null,
    pending: b.requestedAt !== null,
  }));
  return {
    mailboxes: out,
    movable: out.filter((m) => m.hasJunkFolder).reduce((n, m) => n + m.candidates, 0),
    pending: out.some((m) => m.pending),
  };
}

/**
 * THE PRESS: record the command on every mailbox that has both something to move and somewhere
 * to move it. Idempotent in effect — a second press re-stamps, and the worker's clear-what-it-
 * observed discipline means the later stamp is served by a later cycle, never lost and never a
 * second sweep of an already-empty pile (a sweep of zero candidates is a no-op by construction).
 * Answers the preview it leaves behind, so the client renders "queued" from the same shape.
 */
export async function requestJunkSweep(deps: ApiDeps, ctx: ServiceContext): Promise<JunkSweepPreview> {
  const accountId = ctx.accountId;
  const preview = await junkSweepPreview(deps, accountId);
  const targets = preview.mailboxes.filter((m) => m.hasJunkFolder && m.candidates > 0).map((m) => m.id);
  if (targets.length === 0) {
    throw new ServiceError("nothing_to_sweep", 409, "there is nothing left in ohmail/Quarantine to move");
  }
  await deps.db.update(mailboxes)
    .set({ junkSweepRequestedAt: ctx.now(), syncRequestedAt: ctx.now() })
    .where(and(eq(mailboxes.accountId, accountId), inArray(mailboxes.id, targets)));
  return junkSweepPreview(deps, accountId);
}
