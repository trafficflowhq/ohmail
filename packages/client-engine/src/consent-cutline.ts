import type { EntityReader } from "./store.js";
import { rulesList, senderKey } from "./selectors.js";
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

   ── HISTORY HAS NO BADGE, AND THAT IS A PROPERTY, NOT A STYLE CHOICE ──────────────────────

   A sender with ANY unread mail is active, whatever its age. So a message can only reach
   History if it has been read. History therefore cannot contain anything that wants attention,
   which is why it carries no count anywhere in the interface. That is a consequence of
   {@link senderActivity}, not a decision the nav bar is free to revisit — if the definition of
   "active" ever stops including unread, the badge question reopens with it.

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
 * ACTIVE if the sender has any unread mail, or any mail inside the window. DORMANT otherwise.
 *
 * Unread wins regardless of age, and that ordering is what makes History badge-free: anything
 * unread makes its sender active, so nothing unread can be in History. A sender with mail from
 * four years ago that was never opened is active — it is exactly the case where a decision is
 * overdue, not the case where it can be assumed away.
 *
 * Only mail the product presents is counted. A message in a Sent folder is the user writing,
 * not the sender writing, and counting it would make every correspondent permanently active.
 */
export function senderActivity(
  messages: readonly EngineMessage[],
  opts: ConsentOptions = {},
  own: ReadonlySet<string> = new Set(),
): Map<string, SenderActivity> {
  const now = opts.now ?? new Date();
  const days = opts.dormancyDays ?? DEFAULT_DORMANCY_DAYS;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;

  const out = new Map<string, SenderActivity>();
  for (const m of messages) {
    if (!KNOWN_FOLDERS.has(m.folder)) continue;
    const key = senderKey(m.from.address);
    if (own.has(key)) continue;
    if (out.get(key) === "active") continue;
    const recent = m.date !== null && new Date(m.date).getTime() >= cutoff;
    out.set(key, m.unread || recent ? "active" : "dormant");
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
