import { and, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  assertOrganizerRole, fenceErased,
  contacts, folderState, junkRescues, junkSweepCandidateWhere, mailboxes, messages,
  recordRuleDelta, rules as rulesTbl, type LedgerTx, type Tx,
} from "@trafficflow/db";
import {
  FOLDER_PAGE_MAX, epochOf, sameEpoch,
  type FolderPage, type FolderPageItem, type FolderSearchPage,
} from "@trafficflow/core/adapters/imap";
/* `core/mail`, never the default barrel: the barrel re-exports `ai/workflows/*`, whose workflow runner
 * imports the db cloud barrel — so one barrel import here pulls the hosted schema (billing,
 * credits, staff grants) into the LOCAL ENGINE bundle this module is part of. The mail subpath
 * is the same surface minus `ai/*`; every name below lives outside it. */
import { LEGACY_NEWS_FOLDER, normalizeMime } from "@trafficflow/core/mail";
import {
  ServiceError, requireImapUint32, withAccountTx, type ServiceContext,
} from "@trafficflow/services/mail";
import {
  WINDOW_CURSOR_MAX_CHARS, mergeWindowLanes, midKey, mintWindowCursor, parseWindowCursor,
  requireRealEpoch, requireWindowFolders, windowMailboxesOf, type CursorEntry,
} from "./folder-window.js";
import { IMAP_DOOR_DEADLINE_MS, withinDoorBudget } from "./imap-door.js";
import type { ApiDeps } from "./deps.js";

/**
 * The Junk window — a live, un-mirrored view of the provider's own \Junk (FOLDERS-SPEC.md §16.2).
 * Junk never enters `messages` or any client mirror. LIST and BODY are the two READS that dial:
 * they open a short-lived connection through `withinDoorBudget`, serve only `connected` mailboxes,
 * store no bytes, and answer 410 on an epoch mismatch. NOTHING HERE APPLIES ORGANIZATION. The
 * rescue and the sweep are COMMANDS — a `junk_rescues` row and a stamp — recorded with the
 * doorbell and executed by the organizer under its lease, which is what this server promises of
 * every move it makes. The second verb's allow rides the rescue's own transaction.
 */

/** The junk body read's transfer ceiling — a bounded window never pulls a 90 MB spam payload. */
export const JUNK_BODY_MAX_BYTES = 2_000_000;

/**
 * How long one mailbox's window read may take before it is reported `unreachable`. Reads run in
 * PARALLEL across the account's mailboxes and each is raced against this, so a slow provider
 * costs the response one stated degrade — never the whole invocation's budget.
 *
 * The BUDGET is {@link IMAP_DOOR_DEADLINE_MS} and this is the name the junk window's callers
 * know it by: one literal for every API-side dial, so a change here cannot leave one door on an
 * older number.
 */
export const JUNK_READ_TIMEOUT_MS = IMAP_DOOR_DEADLINE_MS;

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
  /**
   * A STANDING "not junk" command on this row (`junk_rescues`): `"queued"` — recorded, waiting for
   * the organizer's next cycle; `"refused"` — the mail server would not take the move after the
   * backoff ladder ran out, and a fresh press tries once more. ABSENT means no command, never
   * `null`: the row leaves the window when the move lands, so "no command" and "moved" are the
   * same fact from here and the client needs one shape for it.
   */
  rescue?: "queued" | "refused";
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

/**
 * How large a junk-window cursor may be on the wire — {@link WINDOW_CURSOR_MAX_CHARS}' argument,
 * kept under this name because the route and its tests know the ceiling by it.
 */
export const JUNK_CURSOR_MAX_CHARS = WINDOW_CURSOR_MAX_CHARS;

/** The opaque cursor: base64url JSON of {mailboxId → {v, s}}. Malformed input is a 400. */
const parseCursor = (raw: string | undefined): Record<string, CursorEntry> =>
  parseWindowCursor(raw, "junk-window", JUNK_CURSOR_MAX_CHARS);

/** The foundation gate every junk route shares: the window exists only behind "Use folders". */
const requireFolders = (deps: ApiDeps, accountId: string): Promise<void> =>
  requireWindowFolders(deps, accountId, "the Junk window");

/** The account's mailboxes with their resolved junk paths — {@link windowMailboxesOf}'s rule. */
async function junkMailboxesOf(
  deps: ApiDeps, accountId: string, mailboxId?: string,
): Promise<Array<{ id: string; address: string; junkFolder: string | null }>> {
  const rows = await windowMailboxesOf(deps, accountId, mailboxes.junkFolder, mailboxId);
  return rows.map((r) => ({ id: r.id, address: r.address, junkFolder: r.folder }));
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

  const reads = boxes.map(async (box): Promise<{ boxId: string; page: FolderPage | null } | null> => {
    if (box.junkFolder === null) {
      states.push({ id: box.id, address: box.address, window: "no_junk_folder" });
      return null;
    }
    try {
      // ONE budget for the whole mailbox read, dial included, and a breach DESTROYS the socket
      // rather than queueing a LOGOUT behind the hang — see `imap-door.ts`. A slot left held by
      // a hung operation turns every later junk, body and attachment request for this mailbox
      // into `mailbox_busy` until the admission window rolls.
      const page = await withinDoorBudget(deps, box.id, (adapter) => {
        const held = before[box.id];
        return adapter.listFolderPage(box.junkFolder!, {
          limit: FOLDER_PAGE_MAX,
          ...(held !== undefined ? { beforeSeq: held.s, expectUidValidity: held.v } : {}),
        });
      }, { budgetMs: JUNK_READ_TIMEOUT_MS });
      if (page === null) {
        // The recorded junk path no longer opens on a LIVE connection — the same honest
        // degrade as no folder (transport failures threw and land in the catch below).
        states.push({ id: box.id, address: box.address, window: "no_junk_folder" });
        return null;
      }
      const held = before[box.id];
      states.push({
        id: box.id, address: box.address, window: "ok",
        ...(held !== undefined && !sameEpoch(epochOf(held.v), epochOf(page.uidValidity)) ? { reset: true } : {}),
      });
      return { boxId: box.id, page };
    } catch (err) {
      deps.logger?.warn?.("junk_window_read_failed", { mailboxId: box.id, err });
      states.push({ id: box.id, address: box.address, window: "unreachable" });
      return null;
    }
  });
  const pages = (await Promise.all(reads)).filter((p): p is { boxId: string; page: FolderPage } => p !== null);

  // ── The k-way merge: newest date first, per-mailbox seq order enforced by taking each
  // mailbox's rows through its own pointer. At most FOLDER_PAGE_MAX rows leave, whatever the
  // mailbox count — the account-level page bound.
  const { taken, nextBefore } = mergeWindowLanes(pages, before);

  const items: JunkItem[] = taken.map(({ boxId, uidValidity, row }) => {
    const { seq: _seq, ...header } = row;
    return { ...header, mailboxId: boxId, uidValidity, origin: "provider" as const };
  });

  // ── Origin attribution: the verdict's husk keeps the message-id, and the filing completion
  // parks `native_locator` at the junk path — so a live junk row whose mid matches such a row
  // was filed by US on the user's order. Bounded: at most one IN() over this page's mids.
  await attributeOrigin(deps, accountId, items, boxes);
  // …and whether a "not junk" press is already standing on any of them, so a row the person
  // pressed says so instead of offering the press again (§16.2's queued command).
  await attributeRescues(deps, accountId, items);

  return { mailboxes: states, items, nextCursor: mintWindowCursor(nextBefore) };
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
 * A standing rescue command per row, for the list and the search alike. ONE indexed read over the
 * page's own keys — never a scan of the mailbox's whole queue, which a refused row can sit in
 * indefinitely: the predicate names the mailboxes, the epochs and the UIDs the page carries, and
 * the triple is matched exactly in memory afterwards (the three `IN`s together admit a cross
 * product the join must not). Mutates `rescue` in place, leaving it ABSENT where nothing stands.
 */
async function attributeRescues(deps: ApiDeps, accountId: string, items: JunkItem[]): Promise<void> {
  if (items.length === 0) return;
  const boxIds = [...new Set(items.map((i) => i.mailboxId))];
  const epochs = [...new Set(items.map((i) => i.uidValidity))].map((v) => BigInt(v));
  const uids = [...new Set(items.map((i) => i.uid))];
  const rows = await deps.db
    .select({
      mailboxId: junkRescues.mailboxId, uidvalidity: junkRescues.uidvalidity,
      uid: junkRescues.uid, status: junkRescues.status,
    })
    .from(junkRescues)
    .where(and(
      eq(junkRescues.accountId, accountId),
      inArray(junkRescues.mailboxId, boxIds),
      inArray(junkRescues.uidvalidity, epochs),
      inArray(junkRescues.uid, uids),
    ));
  const standing = new Map(
    rows.map((r) => [`${r.mailboxId} ${String(r.uidvalidity)} ${r.uid}`, r.status]),
  );
  // The column's word is `pending`; the wire's is `queued`. Two vocabularies deliberately: the
  // row is pending against a QUEUE, and what a person is told is that their press is queued.
  for (const it of items) {
    const status = standing.get(`${it.mailboxId} ${it.uidValidity} ${it.uid}`);
    if (status === "pending") it.rescue = "queued";
    else if (status === "refused") it.rescue = "refused";
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
      const page = await withinDoorBudget(
        deps, box.id,
        (adapter) => adapter.searchFolderPage(box.junkFolder!, term, { limit: FOLDER_PAGE_MAX }),
        { budgetMs: JUNK_READ_TIMEOUT_MS },
      );
      if (page === null) {
        states.push({ id: box.id, address: box.address, window: "no_junk_folder" });
        return null;
      }
      states.push({ id: box.id, address: box.address, window: "ok" });
      if (page.truncated) truncated = true;
      return { boxId: box.id, page };
    } catch (err) {
      deps.logger?.warn?.("junk_window_search_failed", { mailboxId: box.id, err });
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
  // The same standing-command read as the list's: a hit the person already pressed renders as
  // pressed, or the search would offer the verb twice for one message.
  await attributeRescues(deps, accountId, items);
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
 * A UIDVALIDITY that arrived over the wire is only usable if it is a real epoch — a positive
 * integer, no leading zero, no sign, no exponent, no whitespace. The verbs below build
 * `${uidValidity}:${uid}` from it, and the adapter's epoch guard treats `"0"` as "never claimed
 * an epoch" — correct for the worker's internally minted sentinels, wrong for a number a request
 * chose: `uidValidity=0` would switch the guard off for the caller's own rescue. The boundary
 * that accepts the value refuses it, here rather than per route, so every caller gets one rule.
 * Not `Number(v) > 0`: that accepts `"1e9"`, `" 7 "`, `"0x7"` and `"Infinity"`, and the
 * downstream comparison is a string one.
 */
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
  // Under the door budget, like every other dial here: a body read has no ceiling of its own on
  // how long the server may take, and a `finally { close() }` queues its LOGOUT behind the hang.
  const fetched = await withinDoorBudget(
    deps, args.mailboxId,
    (adapter) => adapter.fetchByUid(box.junkFolder!, [args.uid], { maxBytes: JUNK_BODY_MAX_BYTES }),
    { budgetMs: JUNK_READ_TIMEOUT_MS },
  );
  if (!sameEpoch(epochOf(fetched.uidValidity), epochOf(args.uidValidity))) {
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
}

/** The spam-promoting destination a verdict's rule carries — the one the second verb disables. */
const SPAM_RULE_DESTINATION = "ohmail/Quarantine";
/** Where a minted allow files — the Screener yes-decision's default (`YES_FOLDER`). */
const ALLOW_RULE_DESTINATION = "INBOX";
/** Every allow-side destination — an enabled sender rule at any of these already admits them.
 *  Both News spellings: a rule stored before the 0.22 rename points at `ohmail/Reads`. */
const ALLOW_SIDE = ["INBOX", "ohmail/News", LEGACY_NEWS_FOLDER, "ohmail/Receipts"] as const;

export interface AllowSenderOutcome {
  /** Rule ids this press DISABLED — the sender's own spam-promoting rules. */
  disabledRuleIds: string[];
  /** The allow rule minted, or null when an enabled sender allow already stood. */
  createdRuleId: string | null;
}

/**
 * The address half of the second verb, checked WHERE EVERY REFUSAL BELONGS — above the first
 * write. `allowSender` normalises again rather than trusting the caller to have called this: one
 * of the two is the door and the other is the guard, and a guard that can be skipped is not one.
 */
function normalizeAllowAddress(address: string): string {
  const addr = address.trim().toLowerCase();
  if (addr.length === 0 || !addr.includes("@")) {
    throw new ServiceError("unprocessable", 422, "this message has no sender address to allow");
  }
  return addr;
}

/**
 * "ALWAYS ALLOW THIS SENDER" — the rule half of the second verb: the promoted allow rule, the
 * `contacts` row, the change rows, and the one thing it cannot assume — that the sender's spam
 * rule is switched off first, since deny outranks allow at equal priority.
 *
 * IT TAKES THE CALLER'S TRANSACTION. It used to open its own, and the rescue then ran two
 * sequenced transactions, so an interruption left a rule standing with no move behind it. It
 * fences at the top of its own body anyway — `contacts` and `rules` hang off the account alone
 * and `accounts` survives erasure — which the caller already asked, so this takes no lock.
 */
async function allowSender(
  tx: LedgerTx, accountId: string, address: string, nowAt: Date,
): Promise<AllowSenderOutcome> {
  // `dialect(tx)` and not the caller's handle: the brand travels to a transaction object, and
  // reading it from the tx is what keeps this true on a device store as well as a server.
  await fenceErased(tx as unknown as Tx, dialect(tx as unknown as Parameters<typeof dialect>[0]), { accountId });
  const addr = normalizeAllowAddress(address);
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
  await recordRuleDelta(tx, accountId, disabled.map((r) => r.id), "update");

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
    /* The backlog comes with the rescue. "Not junk" says this sender's mail belongs
       in the Ohbox, and the message being rescued is rarely their only one — without the stamp
       the rest stays wherever the spam verdict put it and nothing ever revisits it, because
       NULL is read everywhere as "nobody asked". Stamped in the rescue's own transaction. */
    retroRequestedAt: nowAt,
  }).returning({ id: rulesTbl.id });
  await recordRuleDelta(tx, accountId, [rule!.id], "create");
  return { disabledRuleIds: disabled.map((r) => r.id), createdRuleId: rule!.id };
}

/** What a press leaves behind: the command's id, and the allow half when the second verb ran. */
export interface JunkRescueQueued {
  status: "queued";
  rescueId: string;
  /** Present only for the second verb: what the allow half did, in the same transaction. */
  allowed?: AllowSenderOutcome;
}

/**
 * "NOT JUNK" — the rescue (§16.2/G3): the user's command to move ONE message out of Junk back to
 * INBOX, RECORDED and handed to the organizer. The API never opens IMAP to APPLY organization, so
 * this writes a `junk_rescues` row and rings the doorbell; `junkRescuePass` makes the move under
 * the epoch guard and the lease, and deletes the row. Answered 202: nothing has moved yet.
 *
 * With `allow`, {@link allowSender} runs in THE SAME TRANSACTION, so an interruption leaves
 * NEITHER half. A RE-PRESS resets the ONE command rather than queueing a second move — the UNIQUE
 * is the locator — and `attempts` is left: a second press buys the next rung, not a fresh ladder.
 */
export async function rescueJunk(
  deps: ApiDeps, ctx: ServiceContext,
  args: { mailboxId: string; uid: number; uidValidity: string; allow?: { sender: string } },
): Promise<JunkRescueQueued> {
  const accountId = ctx.accountId;
  // BOTH protocol values, and BEFORE any write. `junkBody` got this guard and this seam did not —
  // the second door onto the same coordinate, which is the shape a per-route check produces.
  requireImapUint32(args.uid, "uid");
  requireRealEpoch(args.uidValidity);
  /* -- A READER RESCUES NOTHING FROM JUNK (mail 0083) --------------------------------------
   *
   * "Not junk" is an organizing act against a mailbox this install may not be arranging — the
   * move itself now, and on the second verb a rule change. It sits with the other refusals ABOVE
   * THE FIRST WRITE, which is this function's own stated discipline.
   */
  await assertOrganizerRole(deps.db as unknown as Tx, dialect(deps.db), accountId, args.mailboxId);
  await requireFolders(deps, accountId);
  const [box] = await junkMailboxesOf(deps, accountId, args.mailboxId);
  if (!box || box.junkFolder === null) {
    throw new ServiceError("no_junk_folder", 404, "this mailbox has no Junk folder");
  }
  // The sender's own shape, above the write like every other refusal here.
  const sender = args.allow !== undefined ? normalizeAllowAddress(args.allow.sender) : null;
  const nowAt = deps.now?.() ?? ctx.now();

  /* THE MAILBOX ARM TOO, not the account alone: `junk_rescues` is keyed by mailbox and a mailbox
     erasure leaves the account standing, so an account-only fence would let a command be recorded
     against a mailbox whose mirror has just been swept. */
  return withAccountTx(ctx, async (tx) => {
    const allowed = sender !== null
      ? await allowSender(tx, accountId, sender, nowAt)
      : undefined;
    const [row] = await tx.insert(junkRescues).values({
      accountId,
      mailboxId: args.mailboxId,
      // The junk path AS IT STANDS NOW, stored rather than re-derived at execution: a rescue names
      // one message in one place, and a discovery that re-points `junk_folder` between the press
      // and the cycle must not silently move the command's source folder with it.
      folder: box.junkFolder!,
      uidvalidity: BigInt(args.uidValidity),
      uid: args.uid,
      requestedAt: nowAt,
      updatedAt: nowAt,
    }).onConflictDoUpdate({
      target: [junkRescues.mailboxId, junkRescues.folder, junkRescues.uidvalidity, junkRescues.uid],
      // The SCHEDULE and its CLASS move together — `folder_state`'s rule: a class without its
      // schedule is a reason for nothing. `attempts` stays: see the function's own note.
      set: { status: "pending", nextAttemptAt: null, lastErrorClass: null, updatedAt: nowAt },
    }).returning({ id: junkRescues.id });

    // Ring the doorbell (`sync_requested_at`, mail 0049) IN THE SAME TRANSACTION: the worker's
    // ~3 s kick pass runs the rescue and then ingests the message's new INBOX UID. Best-effort is
    // no longer the right posture — a command recorded without a kick waits out the poll, and the
    // person is looking at "Will be moved to your inbox" while it does.
    await tx.update(mailboxes)
      .set({ syncRequestedAt: nowAt })
      .where(and(eq(mailboxes.id, args.mailboxId), eq(mailboxes.accountId, accountId)));

    return allowed !== undefined
      ? { status: "queued" as const, rescueId: row!.id, allowed }
      : { status: "queued" as const, rescueId: row!.id };
  }, { db: deps.db, mailboxId: args.mailboxId });
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
      .select({ n: dialect(deps.db).castInt(sql`count(*)`).mapWith(Number) as unknown as SQL<number> })
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
  /**
   * A reader presses no sweep (mail 0083). The sweep is a bulk move — the whole
   * `ohmail/Quarantine` pile into the provider's native Junk — executed by the organizer inside
   * its serial cycle. Stamping the command on a mailbox this install does not organize would
   * either do nothing or be picked up after a later promotion and move a pile somebody has since
   * rearranged. Per mailbox, and every target, because the press covers a set: an account with
   * one organized and one read mailbox may sweep the first, and the refusal must name the second
   * rather than refusing the whole press — filtering silently would be a button that reports
   * success for mailboxes it skipped.
   */
  for (const id of targets) {
    await assertOrganizerRole(deps.db as unknown as Tx, dialect(deps.db), accountId, id);
  }
  await deps.db.update(mailboxes)
    .set({ junkSweepRequestedAt: ctx.now(), syncRequestedAt: ctx.now() })
    .where(and(eq(mailboxes.accountId, accountId), inArray(mailboxes.id, targets)));
  return junkSweepPreview(deps, accountId);
}
