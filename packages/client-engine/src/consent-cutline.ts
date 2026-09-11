import {
  counterpartyEvidence, type CounterpartyEvidence, type CounterpartyMessage,
} from "@trafficflow/core/sender-headers";
import type { EntityReader } from "./store.js";
import { ownAddressKeys } from "./own-address.js";
import { isOwnSent, isResurfaced, messagesByDateDesc, rulesList, senderKey } from "./selectors.js";
import type { EngineMessage, Folder, RuleDTO } from "./types.js";

/* Consent, the cutline, and History. Two rules decide where a message is
   PRESENTED: (1) consent comes from the user's own actions — sitting in the
   INBOX is not consent, a decision's record is a rule; (2) decisions rule
   the future — the past moves only on explicit request, so placement stays
   as the server has it and the product filters what it shows. For mail in
   the two undecided residences (INBOX, Screener folder): a ruled sender
   presents in the rule's destination (zero server moves); unruled + active
   → Screener; unruled + dormant → History. Explicit placements elsewhere
   are never second-guessed. History has no badge — under a baseline it can
   hold unread backlog, and that is what it is FOR ("Archive" is a verb). */

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
   * Where each message presents. A folder, or `null` for History. The map
   * is total over the mirror so a caller can never silently fall through to
   * the physical folder for a message this did consider. One exception to
   * "null for History": a folder-filed row shown through the History lens
   * (spec §16.5) keeps its folder as its place — `history` is the authority
   * on History's contents; `placeOf` is the authority on removal.
   */
  readonly placeOf: ReadonlyMap<string, Folder | null>;
  /** History's contents, newest first. Read mail only, by construction. */
  readonly history: readonly EngineMessage[];
  readonly activity: ReadonlyMap<string, SenderActivity>;
  readonly counts: ConsentCounts;
}

export interface ConsentOptions {
  now?: Date;
  /**
   * Is "Use folders" ON for this account — the consent answer, not the mirror's contents.
   * `true` widens History into the lens over the user's own folders (spec §16.5); absent or
   * `false` is the pre-feature partition byte for byte, whatever `folder` entities the mirror
   * happens to hold (they can be stale after a disable this tab never drained).
   */
  foldersEnabled?: boolean;
  /** Days. Defaults to {@link DEFAULT_DORMANCY_DAYS}. */
  dormancyDays?: number;
  /**
   * When this account finished screening its backlog
   * (`account_settings.screening_baseline_at`, mail 0056); `null` = never
   * decided anything. Without it the cutoff `now - dormancyDays` moves on
   * its own: the window slides, and old unread mail entering the mirror
   * (the normal case — sync walks newest-first) resurrects worked-past
   * senders. With it the cutoff is fixed at `baselineAt - dormancyDays`:
   * pre-cutoff mail never resurrects a sender, even unread. Absent = the
   * pre-0056 behaviour; `(baselineAt ?? now)` would be a different program.
   */
  baselineAt?: Date | string | null;
  /**
   * Screening scope — `account_settings.screening_scope` (mail 0083).
   * `'window'` (or absent) is the dial above; `'all_time'` is a MODE, not
   * a window value (`dormancy_days` is bounded 1-365, so no number can
   * spell "no cutoff"). Re-declared rather than imported, like
   * {@link DEFAULT_DORMANCY_DAYS}: this package has no `@trafficflow/core`
   * dependency; the parity test pins this to `resolveScreeningCutoff`,
   * order included — `all_time` is tested before the baseline. Anything not
   * exactly `'all_time'` reads as the window, the safe failure direction.
   */
  screeningScope?: "window" | "all_time" | string | null;
  /**
   * The account's own mailbox addresses. Mail from these is the user
   * writing, so it is never a candidate for a place and never makes anybody
   * active. Most of it sits in Sent (already outside the presented set),
   * but self-sent mail and providers that file into INBOX as well land in
   * presented folders — without this the user appears in their own Screener
   * queue. Defaults to the mirror's mailbox rows, which can be empty; a
   * caller that knows the addresses should pass them
   * (`consent-cutline.pg.test.ts` pins the server's answer to this one).
   */
  ownAddresses?: Iterable<string>;
}

/** The domain half of an address, lower-cased, or `null` when there is not one. */
export function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

/**
 * Index the rules actually in force. Skipped: disabled rules; `header`
 * rules (about a message, not a person); rules pointing at the SCREENER
 * (the absence of a decision written down — counting it would park a
 * dormant sender in the queue for ever). Same kind, same target: the more
 * permissive wins — this decides PRESENTATION only, and the permissive
 * reading shows the user their mail. A subject- or body-narrowed rule
 * counts as a decision about the WHOLE sender (mail 0050/0052): terms
 * narrow placement, never admission. Never add a term check here.
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
  const raw = opts.baselineAt == null ? null : new Date(opts.baselineAt).getTime();
  /* "All time" is no cutoff, and it is the FIRST test, before the baseline
   * read — mirroring the server (`resolveScreeningCutoff`); the other order
   * would make the mode silently inert for every account that ever screened
   * anything. `resolveScreeningCutoff` answers `undefined`; this side
   * compares numbers, so the same meaning is `-Infinity` — every parseable
   * date is at or after it, every undecided sender is ACTIVE, nothing falls
   * into History, no mail moves until a decision. `baselined` still answers
   * whether a baseline EXISTS: it gates whether unread outranks age.
   */
  if (opts.screeningScope === "all_time") {
    const baseRaw = raw !== null && Number.isFinite(raw) ? raw : null;
    return { cutoff: -Infinity, baselined: baseRaw !== null };
  }
  const days = opts.dormancyDays ?? DEFAULT_DORMANCY_DAYS;
  // An unparseable stored value is treated as ABSENT, not as epoch 0: a baseline of 1970 would
  // make every message post-cutoff and pin every undecided sender in the queue for ever, which is
  // the loudest possible failure for a value nobody can see. Absent is today's behaviour.
  const baseline = raw !== null && Number.isFinite(raw) ? raw : null;
  const from = baseline ?? now.getTime();
  return { cutoff: from - days * 24 * 60 * 60 * 1000, baselined: baseline !== null };
}

/**
 * ACTIVE if the sender has mail worth a decision today, DORMANT otherwise.
 * Without a baseline: any unread mail (regardless of age — that is exactly
 * where a decision is overdue), or any mail inside `now - dormancyDays`.
 * With one: the unread term narrows to `unread && inside the window`, fixed
 * at `baselineAt - dormancyDays` — pre-cutoff mail cannot resurrect a
 * sender. The narrowed unread term is subsumed by the recency term and
 * written out anyway as the statement of the rule; never drop `&& within`,
 * which restores the resurrection. Sent mail is the user writing.
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
  const own = ownAddressKeys(reader, opts);
  /* The user's own folders, when "Use folders" is on (FOLDERS-SPEC.md
   * §16.5). Two gates, both must say yes: the caller's
   * {@link ConsentOptions.foldersEnabled} (the account's consent answer —
   * the authority) and the mirror's `folder` entities (the data) — a mirror
   * can hold stale entities, and inferring authority from them would keep
   * the lens on over an interface that says folders are off. Keys are
   * `mailboxId|path` (spec §17): two mailboxes may both keep a `Projects`,
   * and a disabled mailbox's mail falls through rather than being vetoed by
   * a same-named folder elsewhere; an entity with no `mailboxId` keeps the
   * name-only reach. Junk and Trash never appear — never ingested. */
  const userFolders = new Set<string>();
  if (opts.foldersEnabled === true) {
    for (const f of reader.list<{ name?: unknown; mailboxId?: unknown }>("folder")) {
      if (typeof f.name !== "string" || f.name.length === 0) continue;
      userFolders.add(
        typeof f.mailboxId === "string" && f.mailboxId.length > 0
          ? `${f.mailboxId}|${f.name}`
          : f.name,
      );
    }
  }
  /** Is this message's folder one of its OWN mailbox's live user folders? */
  const inUserFolder = (m: EngineMessage): boolean =>
    userFolders.has(`${m.mailboxId}|${m.folder}`) || userFolders.has(m.folder);
  const activity = senderActivity(messages, opts, own);
  // The same line {@link senderActivity} measures from, read here for outbound mail — see the
  // own-sent branch below. One call, so the two halves of the partition cannot disagree about
  // where the cutline is.
  const { cutoff } = cutlineFor(opts);

  const placeOf = new Map<string, Folder | null>();
  /** Messages whose sender is consented, by thread — the anchor the thread rule uses. */
  const consentedByThread = new Map<string, EngineMessage>();
  const historyIds = new Set<string>();
  const consentedSenders = new Set<string>();
  const activeUndecided = new Set<string>();
  const dormantUndecided = new Set<string>();

  for (const m of messages) {
    /* ── OUTBOUND MAIL MEETS THE SAME CUTLINE AS INBOUND MAIL ────────────────────────────
     *
     * A folder outside the presented set is either one of the user's OWN folders (the lens branch
     * immediately below) or the mailbox's Sent folder ({@link isOwnSent}, a POSITIVE test on the
     * path — see that function for what this branch's old premise poured into the Ohbox). A row
     * that is neither keeps its own place here and presents under its folder, never as the
     * account's own writing.
     * Those rows ARE presented: the Ohbox's "Earlier" is a history of what the reader has
     * finished with, and half of every conversation is what they wrote.
     *
     * This branch used to be an unconditional `placeOf.set(m.id, m.folder); continue;`, which
     * exempted outbound mail from the cutline entirely. On a mailbox with years of Sent mail
     * that pours the whole backlog into "Earlier" — the "1,847 unread" arrival state this
     * product refuses, wearing a different label. There is no sender to weigh here (the user is
     * not one of their own correspondents, and never a stranger to themselves), so the cutline
     * reduces to its date half: mail written before the line is part of the backlog the
     * baseline says is finished, and it is History, exactly as a dormant stranger's mail is.
     *
     * Two things it deliberately does NOT do. A RESURFACED row keeps its place, for the reason
     * spelled out below — the state's only home is the Ohbox's pinned group, so filing it in
     * History would orphan a message the user just asked to see. And an UNDATED row is never
     * assumed historical: {@link messageMs} answers `null` for one, and a row nobody can place
     * in time has not been shown to be finished with.
     *
     * The thread rule below then applies to what lands here unchanged, which is the point of
     * routing outbound mail through `historyIds` rather than filing it directly: a pre-cutline
     * reply on a thread that holds consented mail follows its thread, so the user's own half of
     * a conversation is never in History while the other half is in the Ohbox.
     */
    if (!KNOWN_FOLDERS.has(m.folder)) {
      /* ── FOLDER-FILED MAIL — the lens branch (spec §16.5), only while folders are on ─────
       *
       * A message living in one of the user's OWN folders is FILED: somebody (the user, their
       * other client, years of Thunderbird) put it there, and an explicit placement is already
       * an answer — the same rule `UNDECIDED_RESIDENCES` states for the organized folders. So
       * it always KEEPS ITS PLACE: the folder view must show everything the server holds
       * there, and a null place here would delete rows from a folder's own list.
       *
       * History then reads it as a LENS, never as a move: the old-and-read slice from senders
       * nobody ever screened joins `historyIds` while `placeOf` stays the folder, so the same
       * row presents in both — badged by its folder in History, in place in the folder view.
       * Unread mail never joins (History is read-only by construction — the rail's no-badge
       * argument), a decided sender's mail never joins (the cutline is about senders never
       * screened, unchanged), and the user's own mail never joins. The thread rule below still
       * applies: a lens row on a thread holding consented mail leaves History with the thread.
       *
       * With the flag OFF `userFolders` is empty and every row here falls through to the branch
       * below, byte-for-byte the pre-feature partition — and that fallthrough is exactly why
       * {@link isOwnSent} had to stop being a negative test. With the flag off NOTHING here tells
       * `Promotions` from `Sent`, so the Ohbox's own-sent union claimed the mailbox's whole folder
       * tree. `placeOf` is unaffected either way (a row that is neither a user folder's nor Sent
       * still keeps its own folder below); what the Ohbox does with it is not this partition's
       * decision to make. */
      if (inUserFolder(m)) {
        placeOf.set(m.id, m.folder);
        const key = senderKey(m.from.address);
        if (!own.has(key) && !m.unread && !isResurfaced(m)) {
          const decided = decidedDestination(index, m.from.address);
          const ms = messageMs(m);
          if (decided === null && ms !== null && ms < cutoff) historyIds.add(m.id);
        }
        continue;
      }
      const sentMs = messageMs(m);
      if (!isResurfaced(m) && sentMs !== null && sentMs < cutoff) {
        placeOf.set(m.id, null);
        historyIds.add(m.id);
      } else {
        placeOf.set(m.id, m.folder);
      }
      continue;
    }

    const key = senderKey(m.from.address);
    // The user is not one of their own correspondents. Their mail keeps the place it is in —
    // never History, which is a queue of people who have not been screened.
    if (own.has(key)) { placeOf.set(m.id, m.folder); continue; }
    const decided = decidedDestination(index, m.from.address);
    if (decided !== null && CONSENTING_DESTINATIONS.has(decided)) consentedSenders.add(key);

    /**
     * A RESURFACED ROW IS THE USER'S OWN ACT, AND THE CUTLINE KEEPS ITS HANDS OFF: Rule 1 above says consent comes
     * from the user's own actions — and snoozing a message and scheduling THIS moment for its return is nothing else.
     * Yet this partition used to weigh the row by its SENDER like any other undecided-residence mail: an active
     * undecided sender's resurfaced row presented in the Screener (a queue of sender rows, where no pin exists), and
     * a dormant one's was deleted from the projected list entirely (History). Either way the Ohbox's pinned group —
     * the state's only home, `ohboxView.resurfaced` — never saw it, so a message the user explicitly asked to see
     * again was, at the very moment they asked to see it, in NO list at all. Reachable by search, filed nowhere:
     * measured on a live mailbox. So a resurfaced row keeps its physical place.
     */

    /**
     * `ohboxView` pins it from any folder; what this exemption owes it is to stay OUT of the Screener grouping and
     * OUT of History's deletion. The sender's own standing is untouched — their other mail still queues or rests
     * exactly as before, and reading the pinned row (which clears the state to `none`) hands this one back to the
     * ordinary rules below. Only `resurfaced`: the bottom piles are each a visible home of their own, so their rows
     * are never orphaned by this loop.
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
   *
   * ── AND THE JOIN ITSELF HAS TO BE CORROBORATED ────────────────────────────────────────────
   *
   * `threadId` is the header chain, and In-Reply-To/References are the sender's own writing: a
   * stranger who names a Message-ID this mailbox holds joins that conversation, and the rescue
   * would then carry their first message into the consented pile — a first-contact decision
   * skipped by a header. So the account's OWN outbound on that thread has to name the sender.
   * `we_wrote` is the only class that can corroborate the row being placed, because the row is
   * the sender's own writing and "they wrote to us" would corroborate itself
   * (`@trafficflow/core/sender-headers`). The cost is stated: a stranger's reply on a consented
   * thread the user has not answered stays in History until they do, which is the recoverable
   * direction — an unrescued row is in a list, an admitted one skipped the queue.
   */
  if (consentedByThread.size > 0) {
    const onThread = new Map<string, CounterpartyMessage[]>();
    for (const m of messages) {
      if (!m.threadId || !consentedByThread.has(m.threadId)) continue;
      const list = onThread.get(m.threadId) ?? [];
      if (list.length === 0) onThread.set(m.threadId, list);
      list.push({
        ownAuthored: isOwnSent(m),
        from: m.from?.address,
        recipients: [...(m.to ?? []), ...(m.cc ?? [])].map((w) => w?.address),
      });
    }
    const ourRecordOn = new Map<string, Map<string, CounterpartyEvidence>>();
    for (const [threadId, list] of onThread) ourRecordOn.set(threadId, counterpartyEvidence(list));

    for (const m of messages) {
      if (!historyIds.has(m.id) || !m.threadId) continue;
      const anchor = consentedByThread.get(m.threadId);
      if (!anchor) continue;
      /* The account's OWN mail is not an admission of anybody: this rescue keeps the user's own
         half of a conversation out of History, and it is our own writing by construction. Only a
         stranger's row needs the corroboration. */
      const key = senderKey(m.from.address);
      const ours = isOwnSent(m) || own.has(key);
      if (!ours && ourRecordOn.get(m.threadId)?.get(key) !== "we_wrote") continue;
      const anchorPlace = placeOf.get(anchor.id);
      if (anchorPlace === null || anchorPlace === undefined) continue;
      /* AN OWN-SENT ROW IS RESCUED TO ITS OWN FOLDER, NEVER TO THE ANCHOR'S.
       *
       * The rescue exists so a conversation is not split, and for inbound mail "not split" means
       * "wherever the consented half is". For OUTBOUND mail it cannot: the anchor's place may be
       * `ohmail/Reads` or `ohmail/Receipts`, and re-homing a sent row there would put the user's
       * own mail into a reading stream — the piles group by folder, so the row would be counted
       * and rendered as an issue in Reads. Keeping its own folder presents it in "Earlier" when
       * that folder is the mailbox's Sent folder ({@link isOwnSent}), which is the one place
       * outbound mail belongs and is on the same screen as the thread it answers.
       */
      placeOf.set(m.id, KNOWN_FOLDERS.has(m.folder) ? anchorPlace : m.folder);
      historyIds.delete(m.id);
    }
  }

  // Filtered from the shared per-version order rather than sorted here: History is the one
  // subset that can be nearly the whole mirror, so its own sort was a second whole-mirror
  // sort on every bump (`messagesByDateDesc` carries the identical-order argument).
  const history = messagesByDateDesc(reader).filter((m) => historyIds.has(m.id));

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
 * A read-only view of the mirror in which every message sits where it is PRESENTED. This exists so the pile selectors
 * keep working untouched: they group by folder, and after this projection grouping by folder is grouping by place.
 * History mail is absent from the `message` list entirely — it belongs to no pile, and {@link
 * ConsentPartition.history} is where it is read from instead. The rewritten rows keep their real folder in
 * `physicalFolder`, so a projected message can always still say where it actually is on the server. Nothing else
 * about the row changes. NEVER use this reader to open a message, to search, or behind a mutation. A mutation reads
 * the current folder to work out what it is moving from, and this reader would answer with a presentation rather than
 * a location. Pass the mirror's own reader to all three.
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
      if (type !== "message") return reader.list<T>(type);
      /**
       * ITERATE THE BASE READER'S SHARED DATE ORDER, not its raw list. `list()`'s order is
       * unspecified, so any order is legal here — and `project` never touches a date, so the
       * projected rows come out already newest-first. `messagesByDateDesc` OVER THIS PROJECTION
       * then sorts an already-sorted array, which is one O(n) verification pass instead of a
       * whole-mirror sort — and the projection is rebuilt every version (its object identity
       * cannot carry the cache), so without this it paid the full sort on every bump.
       */
      const rows = messagesByDateDesc(reader);
      const out: T[] = [];
      for (const r of rows) {
        const p = project(r);
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
