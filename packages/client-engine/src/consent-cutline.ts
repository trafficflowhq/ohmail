import type { EntityReader } from "./store.js";
import { isResurfaced, rulesList, senderKey } from "./selectors.js";
import type { EngineMessage, Folder, RuleDTO } from "./types.js";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   CONSENT, THE CUTLINE, AND HISTORY

   Two rules decide where a message is PRESENTED, and neither of them is "where the message
   physically sits".

     1. Consent comes from the user's own actions. Sitting in the INBOX is not consent, and
        having been read is not consent. The record of a decision is a RULE — that is why
        "why is this person here?" always has an answer.
     2. Decisions rule the future. The past moves only when somebody asks for it explicitly.

   Rule 2 is the reason this file exists at all. Once consent is a real thing a user grants,
   every mailbox has a large backlog of mail from senders who were never granted it — and the
   honest response is to present that mail differently, not to move thousands of messages
   around somebody's server on the first day. So placement stays exactly as the mail server has
   it, and the product filters what it shows.

   ── THE THREE OUTCOMES ────────────────────────────────────────────────────────────────────

   For a message sitting in one of the two "undecided residences" — the INBOX, or the Screener
   folder — the sender decides which of three things happens:

     · the sender has a rule          → the message presents in that rule's destination. This is
                                        what lets a newly consented sender's old mail appear in
                                        the Ohbox with ZERO server moves.
     · no rule, sender is ACTIVE      → the Screener, because a decision is genuinely wanted.
     · no rule, sender is DORMANT     → History.

   Mail anywhere else — Reads, Receipts, Screened, Quarantine — is already where somebody put
   it. An explicit placement is itself an answer, so it is never second-guessed here.

   ── HISTORY HAS NO BADGE, AND WITH A BASELINE THAT IS A PRODUCT DECISION ──────────────────

   Without a baseline, a sender with ANY unread mail is active whatever its age, so a message
   can only reach History if it has been read — History cannot contain anything that wants
   attention, and the absence of a count follows from {@link senderActivity} rather than from a
   choice the nav bar made.

   **Under a baseline that derivation no longer holds, and the conclusion is kept deliberately.**
   Pre-cutoff mail cannot make a sender active even unread (see {@link ConsentOptions.baselineAt}),
   so History can hold unread mail: the account's old backlog, from senders nobody ever answered
   for. Badging it would be a permanent unread count over mail the baseline exists to say is
   finished — the "1,847 unread" every migrated mailbox arrives with, which is the state this
   product is against. So History stays uncounted, now because that is what it is FOR rather than
   because it cannot contain anything. Anything genuinely new is post-baseline, and post-baseline
   undecided senders never reach History at all — they wait in the Screener until decided.

   It is called History rather than Archive for two reasons. "Archive" is a verb in every other
   mail client — an action this mail never received — and plenty of mailboxes have a real
   server-side Archive folder whose contents this view would not be showing.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * How recently a sender must have written to still be worth a decision. Days.
 *
 * A default, not a constant: every function here takes the window as an argument, and an
 * account may carry its own. It is stated once so that changing the product default moves
 * every account that never touched it.
 */
export const DEFAULT_DORMANCY_DAYS = 60;

/** Every folder the product presents. Anything else — a Sent folder, a user's own tree — is not a place. */
const KNOWN_FOLDERS: ReadonlySet<string> = new Set<Folder>([
  "INBOX", "ohmail/Screener", "ohmail/Reads", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine",
]);

/**
 * The two folders a message can sit in without any decision standing behind it.
 *
 * The INBOX because that is where mail arrives and where a backlog predates the product, and
 * the Screener folder because holding mail at the gate is the absence of a decision by
 * definition.
 */
const UNDECIDED_RESIDENCES: ReadonlySet<string> = new Set<Folder>(["INBOX", "ohmail/Screener"]);

/**
 * Destinations that mean "yes, I hear from this person".
 *
 * Reads and Receipts are consent too — quieter placement, but the sender got through. Screened
 * and Quarantine are the opposite, so a rule pointing at them is a decision that is not
 * consent, and the thread rule below must not treat it as one.
 */
const CONSENTING_DESTINATIONS: ReadonlySet<string> = new Set<Folder>([
  "INBOX", "ohmail/Reads", "ohmail/Receipts",
]);

export type SenderActivity = "active" | "dormant";

/** Rules indexed for lookup: exact addresses first, then domains. */
export interface ConsentIndex {
  readonly bySender: ReadonlyMap<string, Folder>;
  readonly byDomain: ReadonlyMap<string, Folder>;
}

export interface ConsentCounts {
  /** Senders with a rule that lets them through. */
  consentedSenders: number;
  /** Senders with no rule, with unread or recent mail — the queue a decision is wanted for. */
  activeUndecidedSenders: number;
  /** Senders with no rule and nothing recent. They wait in History and cost nothing. */
  dormantUndecidedSenders: number;
  /** Messages presented in History. */
  historyMessages: number;
}

export interface ConsentPartition {
  /**
   * Where each message presents. A folder, or `null` for History.
   *
   * Only messages whose presentation DIFFERS from their folder, plus every History message,
   * need to be consulted — but the map is total over the mirror so that a caller can never
   * silently fall through to the physical folder for a message this did consider.
   */
  readonly placeOf: ReadonlyMap<string, Folder | null>;
  /** History's contents, newest first. Read mail only, by construction. */
  readonly history: readonly EngineMessage[];
  readonly activity: ReadonlyMap<string, SenderActivity>;
  readonly counts: ConsentCounts;
}

export interface ConsentOptions {
  now?: Date;
  /** Days. Defaults to {@link DEFAULT_DORMANCY_DAYS}. */
  dormancyDays?: number;
  /**
   * WHEN THIS ACCOUNT FINISHED SCREENING ITS BACKLOG (`account_settings.screening_baseline_at`,
   * mail 0056), or `null`/absent for an account that has never decided anything.
   *
   * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
   *
   * Without it the cutoff is `now - dormancyDays`, and BOTH halves of {@link senderActivity} move
   * without anybody doing anything:
   *
   *   · the window slides, so a sender leaves the queue because the clock moved;
   *   · unread outranks age, so any OLD unread mail entering the mirror makes its sender active
   *     again. Old mail enters the mirror constantly, and that is a property of how a mailbox is
   *     read rather than an unusual event: the sync walks a mailbox newest-first, so the older mail
   *     arrives continuously behind it, one folder and one batch at a time, and a `\Seen` flag can
   *     be adopted well after the message itself. Each such arrival puts a sender the reader had
   *     already worked past back into "first-time senders waiting"; the read-state then catches up,
   *     or the window slides, and they disappear again. On a mailbox with years of history the
   *     overwhelming majority of what a backfill delivers on any given day is older than the
   *     window, so this is the normal case for that mailbox and not a corner of it.
   *
   * ── WHAT A BASELINE CHANGES ───────────────────────────────────────────────────────────────
   *
   * The cutoff becomes `baselineAt - dormancyDays` and STOPS MOVING. Two consequences:
   *
   *   · pre-cutoff mail can never resurrect a sender, **not even unread**. That mail is the
   *     backlog the account already worked through;
   *   · a stranger who wrote AFTER the baseline is newer than the cutoff for ever, so they never
   *     go dormant and wait until somebody decides. The sliding window could not express that: a
   *     stranger who wrote once and went quiet used to age out of the queue unanswered.
   *
   * ── ABSENT IS EXACTLY THE PRE-0056 BEHAVIOUR, AND IT IS THE DEFAULT ───────────────────────
   *
   * `null`/absent ⇒ cutoff `now - dormancyDays` AND unread outranking age ⇒ byte-identical
   * partitioning to before this field existed. The narrowing in {@link senderActivity} is gated
   * on the baseline being PRESENT, and writing it instead as an unconditional
   * `(baselineAt ?? now) - dormancyDays` is a DIFFERENT PROGRAM: it would also stop unread
   * pre-cutoff mail from making a sender active on accounts that have never decided anything,
   * which empties a live account's Screener queue on deploy. The `??` form is right for the
   * cutoff arithmetic and wrong for the unread test, and that asymmetry is the whole care.
   *
   * A desktop build has no server to read the column from and passes nothing, which is the same
   * safe branch — it keeps today's behaviour rather than guessing a baseline.
   */
  baselineAt?: Date | string | null;
  /**
   * The account's OWN mailbox addresses. Mail from these is the user writing, not a
   * correspondent writing, so it is never a candidate for a place and never makes anybody
   * active.
   *
   * Most of the user's own mail sits in a Sent folder, which is outside the presented set and
   * therefore already ignored — but not all of it does. Mail somebody sends to themselves, and
   * mail a provider files into the INBOX as well as into Sent, lands squarely in the presented
   * folders. Without this the user appears in their own Screener queue.
   *
   * Defaults to whatever mailbox rows the mirror happens to hold. That is empty on a client
   * whose sync feed carries no mailbox entity, so a caller that KNOWS the addresses should pass
   * them — `consent-cutline.pg.test.ts` pins the server's answer to this one.
   */
  ownAddresses?: Iterable<string>;
}

function ownSet(reader: EntityReader, opts: ConsentOptions): Set<string> {
  const explicit = opts.ownAddresses;
  const source = explicit ?? reader.list<{ address?: unknown }>("mailbox")
    .map((m) => (typeof m.address === "string" ? m.address : ""));
  const out = new Set<string>();
  for (const a of source) {
    const key = senderKey(String(a));
    if (key) out.add(key);
  }
  return out;
}

/** The domain half of an address, lower-cased, or `null` when there is not one. */
export function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

/**
 * Index the rules that are actually in force.
 *
 * Disabled rules are skipped: a rule the user switched off is not a decision they are still
 * making. `header` rules are skipped too — they are statements about a message, not about a
 * person, so they can neither grant nor withhold consent for a sender.
 *
 * A rule pointing at the SCREENER is skipped as well, and that one is easy to get wrong. Such a
 * rule is representable and means "hold this sender at the gate" — which is the absence of a
 * decision written down, not a decision. Counting it as one would take a dormant sender the
 * user has never answered for and park them in the queue for ever, exempt from the cutline
 * that exists to keep the queue honest.
 *
 * Where two rules of the same kind name the same target, the more permissive one wins. This
 * only decides PRESENTATION, and presenting a sender's mail in the Ohbox when one rule says
 * Ohbox and another says Screened is the reading that shows the user their mail; the reverse
 * hides mail on account of a rule they can no longer see the effect of.
 *
 * ── A SUBJECT- OR BODY-NARROWED RULE COUNTS AS A DECISION ABOUT THE WHOLE SENDER ───────────
 * ── (mail 0050, and mail 0052 on identical reasoning) ──────────────────────────────────────
 *
 * `subject_contains` and `body_contains` are deliberately NOT read here, and that is a ruling
 * rather than an omission — it decides the dormancy cutline, so it is worth stating rather than
 * leaving to be rediscovered. Everything below said of a subject term holds verbatim for a body
 * term: both narrow placement, neither narrows admission.
 *
 * A rule saying *from `info@` AND subject contains `[NinjaFirewall]` → Reads* narrows PLACEMENT for
 * a slice of that sender's mail. It does not narrow ADMISSION: writing it is the user saying they
 * know this sender and want their mail organised, which is exactly the thing this index exists to
 * record. So the sender is treated as decided, and the cutline leaves them alone rather than parking
 * them back in the Screener queue for going quiet — which is what reading the term here would do,
 * and it would do it to a sender the user has demonstrably answered for.
 *
 * The RESIDUAL, named: the `Folder` recorded for that sender is the narrow rule's destination, which
 * is only true of the messages the term names. That is tolerable for the same reason the
 * more-permissive-wins rule above is tolerable — this index decides PRESENTATION and never routing
 * (the router reads `core/src/rules.ts`, which does apply the conjunction) — and where the account
 * carries both a narrow and a bare rule for one address the permissive reading picks the one that
 * shows the user their mail. What must never be added here is a term check that flips a decided
 * sender back to undecided.
 */
export function consentIndex(rules: readonly RuleDTO[]): ConsentIndex {
  const bySender = new Map<string, Folder>();
  const byDomain = new Map<string, Folder>();
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.destination === "ohmail/Screener") continue;
    const target = r.kind === "sender" ? bySender : r.kind === "domain" ? byDomain : null;
    if (!target) continue;
    const key = r.match.trim().toLowerCase();
    if (!key) continue;
    const held = target.get(key);
    if (held !== undefined && CONSENTING_DESTINATIONS.has(held)) continue;
    target.set(key, r.destination);
  }
  return { bySender, byDomain };
}

/**
 * The destination a decision names for this sender, or `null` when no decision exists.
 *
 * Address before domain, because naming one mailbox is a more specific claim than naming a
 * whole domain and the specific claim is the one the user meant.
 */
export function decidedDestination(index: ConsentIndex, address: string): Folder | null {
  const addr = senderKey(address);
  const exact = index.bySender.get(addr);
  if (exact !== undefined) return exact;
  const domain = domainOfAddress(addr);
  if (domain === null) return null;
  return index.byDomain.get(domain) ?? null;
}

/**
 * The instant a message is inside the window ⇒ `null` when it is not a legal time at all.
 *
 * A message with no `Date:` is `null` here and is never "recent"; it cannot make its sender
 * active on recency, which is the same answer this function gave before the baseline existed.
 */
function messageMs(m: EngineMessage): number | null {
  if (m.date === null) return null;
  const t = new Date(m.date).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The cutoff both halves of the cutline measure from. See {@link ConsentOptions.baselineAt}. */
export function cutlineFor(opts: ConsentOptions): { cutoff: number; baselined: boolean } {
  const now = opts.now ?? new Date();
  const days = opts.dormancyDays ?? DEFAULT_DORMANCY_DAYS;
  const raw = opts.baselineAt == null ? null : new Date(opts.baselineAt).getTime();
  // An unparseable stored value is treated as ABSENT, not as epoch 0: a baseline of 1970 would
  // make every message post-cutoff and pin every undecided sender in the queue for ever, which is
  // the loudest possible failure for a value nobody can see. Absent is today's behaviour.
  const baseline = raw !== null && Number.isFinite(raw) ? raw : null;
  const from = baseline ?? now.getTime();
  return { cutoff: from - days * 24 * 60 * 60 * 1000, baselined: baseline !== null };
}

/**
 * ACTIVE if the sender has mail worth a decision today. DORMANT otherwise.
 *
 * ── WITHOUT A BASELINE (`baselineAt` absent) ──────────────────────────────────────────────
 *
 * Any unread mail, or any mail inside `now - dormancyDays`. Unread wins regardless of age: a
 * sender with mail from four years ago that was never opened is active, because that is exactly
 * the case where a decision is overdue rather than one that can be assumed away.
 *
 * ── WITH A BASELINE ───────────────────────────────────────────────────────────────────────
 *
 * The unread term NARROWS to `m.unread && inside the window`, and the window is now fixed at
 * `baselineAt - dormancyDays`. Pre-cutoff mail therefore cannot make a sender active by any
 * route, which is the resurrection this exists to stop — see {@link ConsentOptions.baselineAt}
 * for the measurement.
 *
 * **The narrowed unread term is subsumed by the recency term, and that is not dead code being
 * left in.** `(unread && within) || within` is `within`; the term is written out because it is
 * the STATEMENT of the rule at the seam where a future editor will reach for it, and because
 * changing the shape of either half must keep the other visible. What must never happen is the
 * simplification going the other way — dropping `&& within` — which restores the resurrection.
 *
 * Only mail the product presents is counted. A message in a Sent folder is the user writing,
 * not the sender writing, and counting it would make every correspondent permanently active.
 */
export function senderActivity(
  messages: readonly EngineMessage[],
  opts: ConsentOptions = {},
  own: ReadonlySet<string> = new Set(),
): Map<string, SenderActivity> {
  const { cutoff, baselined } = cutlineFor(opts);

  const out = new Map<string, SenderActivity>();
  for (const m of messages) {
    if (!KNOWN_FOLDERS.has(m.folder)) continue;
    const key = senderKey(m.from.address);
    if (own.has(key)) continue;
    if (out.get(key) === "active") continue;
    const ms = messageMs(m);
    const recent = ms !== null && ms >= cutoff;
    // Baselined ⇒ unread only counts inside the window. Absent ⇒ unread outranks age, exactly as
    // before mail 0056. The gate is on the BASELINE, never on the cutoff — see `ConsentOptions`.
    const unreadWins = m.unread && (!baselined || recent);
    out.set(key, unreadWins || recent ? "active" : "dormant");
  }
  return out;
}

/**
 * THE PARTITION. One pass over the mirror, then one pass over the threads.
 */
export function consentPartition(reader: EntityReader, opts: ConsentOptions = {}): ConsentPartition {
  const messages = reader.list<EngineMessage>("message");
  const index = consentIndex(rulesList(reader));
  const own = ownSet(reader, opts);
  const activity = senderActivity(messages, opts, own);

  const placeOf = new Map<string, Folder | null>();
  /** Messages whose sender is consented, by thread — the anchor the thread rule uses. */
  const consentedByThread = new Map<string, EngineMessage>();
  const historyIds = new Set<string>();
  const consentedSenders = new Set<string>();
  const activeUndecided = new Set<string>();
  const dormantUndecided = new Set<string>();

  for (const m of messages) {
    if (!KNOWN_FOLDERS.has(m.folder)) { placeOf.set(m.id, m.folder); continue; }

    const key = senderKey(m.from.address);
    // The user is not one of their own correspondents. Their mail keeps the place it is in —
    // never History, which is a queue of people who have not been screened.
    if (own.has(key)) { placeOf.set(m.id, m.folder); continue; }
    const decided = decidedDestination(index, m.from.address);
    if (decided !== null && CONSENTING_DESTINATIONS.has(decided)) consentedSenders.add(key);

    /* ── A RESURFACED ROW IS THE USER'S OWN ACT, AND THE CUTLINE KEEPS ITS HANDS OFF ──────
     *
     * Rule 1 above says consent comes from the user's own actions — and snoozing a message and
     * scheduling THIS moment for its return is nothing else. Yet this partition used to weigh
     * the row by its SENDER like any other undecided-residence mail: an active undecided sender's
     * resurfaced row presented in the Screener (a queue of sender rows, where no pin exists),
     * and a dormant one's was deleted from the projected list entirely (History). Either way the
     * Ohbox's pinned group — the state's only home, `ohboxView.resurfaced` — never saw it, so a
     * message the user explicitly asked to see again was, at the very moment they asked to see
     * it, in NO list at all. Reachable by search, filed nowhere: measured on a live mailbox.
     *
     * So a resurfaced row keeps its physical place. `ohboxView` pins it from any folder; what
     * this exemption owes it is to stay OUT of the Screener grouping and OUT of History's
     * deletion. The sender's own standing is untouched — their other mail still queues or
     * rests exactly as before, and reading the pinned row (which clears the state to `none`)
     * hands this one back to the ordinary rules below. Only `resurfaced`: the bottom piles are
     * each a visible home of their own, so their rows are never orphaned by this loop.
     */
    if (isResurfaced(m)) { placeOf.set(m.id, m.folder); continue; }

    // An explicit placement is already an answer. Never second-guessed.
    if (!UNDECIDED_RESIDENCES.has(m.folder)) { placeOf.set(m.id, m.folder); continue; }

    if (decided !== null) {
      placeOf.set(m.id, decided);
    } else if (activity.get(key) === "active") {
      activeUndecided.add(key);
      placeOf.set(m.id, "ohmail/Screener");
    } else {
      dormantUndecided.add(key);
      placeOf.set(m.id, null);
      historyIds.add(m.id);
    }

    // The thread anchor is the newest message from a CONSENTED sender, wherever it presents.
    const place = placeOf.get(m.id);
    if (m.threadId && place !== null && place !== undefined && consentedSenders.has(key)
        && CONSENTING_DESTINATIONS.has(place)) {
      const held = consentedByThread.get(m.threadId);
      if (!held || byDateDesc(m, held) < 0) consentedByThread.set(m.threadId, m);
    }
  }

  /* ── THE THREAD RULE ───────────────────────────────────────────────────────────────────
   *
   * A conversation is one thing. If somebody the user has consented to and somebody they have
   * never screened both wrote on the same thread, splitting that thread across the Ohbox and
   * History would hide half a conversation in a place nobody looks — and the half that gets
   * hidden is decided by which participant happens to be dormant, which is not a distinction
   * anybody reading the thread cares about.
   *
   * So: a thread that holds any consented mail presents ENTIRELY where that mail lives, and
   * the anchor is the thread's most recent consented message. Nothing physical moves; this is
   * the same presentation filter as everything else in this file.
   *
   * It deliberately does NOT rescue Screener-placed messages the same way. The Screener is a
   * per-sender decision queue rather than a place, and pulling a sender out of it because they
   * once replied on a consented thread would silently skip the decision the queue exists to
   * ask for. That sender keeps their own row; only their History mail follows the thread.
   */
  if (consentedByThread.size > 0) {
    for (const m of messages) {
      if (!historyIds.has(m.id) || !m.threadId) continue;
      const anchor = consentedByThread.get(m.threadId);
      if (!anchor) continue;
      const anchorPlace = placeOf.get(anchor.id);
      if (anchorPlace === null || anchorPlace === undefined) continue;
      placeOf.set(m.id, anchorPlace);
      historyIds.delete(m.id);
    }
  }

  const history = messages.filter((m) => historyIds.has(m.id)).sort(byDateDesc);

  return {
    placeOf,
    history,
    activity,
    counts: {
      consentedSenders: consentedSenders.size,
      activeUndecidedSenders: activeUndecided.size,
      dormantUndecidedSenders: dormantUndecided.size,
      historyMessages: history.length,
    },
  };
}

/**
 * A read-only view of the mirror in which every message sits where it is PRESENTED.
 *
 * This exists so the pile selectors keep working untouched: they group by folder, and after
 * this projection grouping by folder is grouping by place. History mail is absent from the
 * `message` list entirely — it belongs to no pile, and {@link ConsentPartition.history} is
 * where it is read from instead.
 *
 * The rewritten rows keep their real folder in `physicalFolder`, so a projected message can
 * always still say where it actually is on the server. Nothing else about the row changes.
 *
 * NEVER use this reader to open a message, to search, or behind a mutation. A mutation reads
 * the current folder to work out what it is moving from, and this reader would answer with a
 * presentation rather than a location. Pass the mirror's own reader to all three.
 */
export function presentationReader(reader: EntityReader, partition: ConsentPartition): EntityReader {
  const project = (m: EngineMessage): EngineMessage | null => {
    const place = partition.placeOf.get(m.id);
    if (place === undefined) return m;
    if (place === null) return null;
    if (place === m.folder) return m;
    return { ...m, folder: place, physicalFolder: m.folder };
  };

  return {
    version: () => reader.version(),
    get<T = unknown>(type: string, id: string): T | undefined {
      const v = reader.get<T>(type, id);
      if (type !== "message" || v === undefined) return v;
      return (project(v as unknown as EngineMessage) ?? undefined) as T | undefined;
    },
    list<T = unknown>(type: string): T[] {
      const rows = reader.list<T>(type);
      if (type !== "message") return rows;
      const out: T[] = [];
      for (const r of rows) {
        const p = project(r as unknown as EngineMessage);
        if (p) out.push(p as unknown as T);
      }
      return out;
    },
    entries<T = unknown>(type: string): Array<{ id: string; entity: T }> {
      const rows = reader.entries<T>(type);
      if (type !== "message") return rows;
      const out: Array<{ id: string; entity: T }> = [];
      for (const r of rows) {
        const p = project(r.entity as unknown as EngineMessage);
        if (p) out.push({ id: r.id, entity: p as unknown as T });
      }
      return out;
    },
  };
}

/** History's contents. Newest first, read mail only. */
export function historyView(partition: ConsentPartition): readonly EngineMessage[] {
  return partition.history;
}

/** Where a message actually is on the mail server, whatever place it is being presented in. */
export function physicalFolderOf(m: EngineMessage): string {
  return m.physicalFolder ?? m.folder;
}

function byDateDesc(a: EngineMessage, b: EngineMessage): number {
  const at = a.date ? new Date(a.date).getTime() : 0;
  const bt = b.date ? new Date(b.date).getTime() : 0;
  if (at !== bt) return bt - at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
