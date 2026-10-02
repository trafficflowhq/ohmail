import {
  counterpartyEvidence, type CounterpartyEvidence, type CounterpartyMessage,
} from "@trafficflow/core/sender-headers";
import { ORGANIZED_FOLDERS, canonicalDestination, isConsentingDestination } from "@trafficflow/core/destinations";
import {
  bodyTermOf, compareRules, effectForDestination, placingRule, ruleMatchKey, subjectTermOf,
  type OrderedRule,
} from "@trafficflow/core/rule-order";
import type { EntityReader } from "./store.js";
import { ownAddressKeys } from "./own-address.js";
import {
  isOwnSent, isResurfaced, messagesByDateDesc, newestHeldBySender, queueCoverage, rulesList, screenerWaitingOf, senderKey,
} from "./selectors.js";
import {
  MAILBOX_PROFILE_TYPE, RETIRED_DECIDED_TYPE, type EngineMessage,
  type Folder, type MailboxProfileEntity, type MessageBodyRecord, type RuleDTO,
} from "./types.js";

/** The router's key for a rule's `match`, for the press modules, which import no rule order. */
export { ruleMatchKey };

/* Consent, the cutline, and History. Two rules decide where a message is
   PRESENTED: (1) consent comes from the user's own actions — sitting in the
   INBOX is not consent, a decision's record is a rule; (2) decisions rule
   the future — the past moves only on explicit request. For mail in the two
   undecided residences (INBOX, Screener folder): active mail AT THE GATE
   presents at the gate, admitting rule or none; a ruled sender's mail stays
   where the mailbox has it, a DENY rule's on the screened-out shelf; unruled + active
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

/** Every folder the product presents, both News spellings. A Sent folder or a user's own tree is not a place. */
const KNOWN_FOLDERS: ReadonlySet<string> = new Set<string>(ORGANIZED_FOLDERS);

/**
 * The two folders a message can sit in without any decision standing behind it.
 *
 * The INBOX because that is where mail arrives and where a backlog predates the product, and
 * the Screener folder because holding mail at the gate is the absence of a decision by
 * definition.
 */
const UNDECIDED_RESIDENCES: ReadonlySet<string> = new Set<Folder>(["INBOX", "ohmail/Screener"]);

export type SenderActivity = "active" | "dormant";

/** The rules in force per address and per domain, under the server's order ({@link consentIndex}). */
export interface ConsentIndex {
  /** The winner among every rule naming the key, terms or none: the standing decision. */
  readonly bySender: ReadonlyMap<string, RuleDTO>;
  readonly byDomain: ReadonlyMap<string, RuleDTO>;
  /** Every rule naming the key, for the readers that rank the ones applying to one message. */
  readonly allBySender: ReadonlyMap<string, readonly RuleDTO[]>;
  readonly allByDomain: ReadonlyMap<string, readonly RuleDTO[]>;
  /**
   * The index of each mailbox this install only READS, from its `mailbox_profile` entity. A
   * reader's local rule entities are not what the organizer decided, so its mail is judged by the
   * organizer's document; a mailbox absent here is judged by the four maps above.
   */
  readonly byMailbox: ReadonlyMap<string, ConsentIndex>;
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
  /**
   * Decided senders the cutline has retired whose mail still sits at the gate. Not waiting: an
   * admission changes standing, not place, and the server's queue retires them by the same
   * cutline. Read by `screenerSegments` through `presentationReader` (`RETIRED_DECIDED_TYPE`).
   */
  readonly retiredDecided: ReadonlySet<string>;
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
   * The account's own mailbox addresses. Mail from these is the user writing: never queued or
   * retired, never making anybody active, and held at the gate presented in the INBOX. Most of it
   * sits in Sent (outside the presented set), but self-sent mail and providers that file into
   * INBOX as well land in presented folders — without this the user appears in their own Screener
   * queue. Defaults to the mirror's mailbox rows, which can be empty; a caller that knows the
   * addresses should pass them (`consent-cutline.pg.test.ts` pins the server's answer to this one).
   */
  ownAddresses?: Iterable<string>;
  /**
   * The account's cutline is NOT KNOWN yet — its `GET /consent` has not answered. A decision is a
   * rule the mirror already holds, so a ruled sender is decided and their mail presents exactly as
   * with the window known — where the mailbox has it, a DENY rule's on the shelf; only the two halves
   * that need the window wait: no unruled sender is queued in the Screener and nothing is cut to
   * History. An unruled row stays where its folder is, so nothing is hidden.
   */
  rulesOnly?: boolean;
}

/** The domain half of an address, lower-cased, or `null` when there is not one. */
export function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

/** A mirror rule as the shared order reads it: the effect is its destination's side of the gate. */
function ordered(r: RuleDTO): OrderedRule {
  return { ...r, effect: effectForDestination(r.destination) };
}

/** Does `a` outrank `b` under the one order the router uses (`@trafficflow/core/rule-order`)? */
export function outranks(a: RuleDTO, b: RuleDTO): boolean {
  return compareRules(ordered(a), ordered(b)) < 0;
}

/**
 * Index the rules actually in force. Skipped: disabled rules; `header` rules (about a message,
 * not a person); rules pointing at the SCREENER (the absence of a decision). Two rules for one key
 * are ranked by the ROUTER'S order — deny over allow, then terms, provenance and id; no instant is
 * read, and the input order decides nothing. A subject- or body-narrowed rule counts as a decision
 * about the WHOLE sender (mail 0050/0052): terms narrow placement ({@link placedDestination}, per
 * message), never admission. Never add a term check here.
 */
export function consentIndex(
  rules: readonly RuleDTO[], profiles: readonly MailboxProfileEntity[] = [],
): ConsentIndex {
  const byMailbox = new Map<string, ConsentIndex>();
  for (const p of profiles) byMailbox.set(p.mailboxId, consentIndex(p.rules));
  const bySender = new Map<string, RuleDTO>();
  const byDomain = new Map<string, RuleDTO>();
  const allBySender = new Map<string, RuleDTO[]>();
  const allByDomain = new Map<string, RuleDTO[]>();
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.destination === "ohmail/Screener") continue;
    const target = r.kind === "sender" ? bySender : r.kind === "domain" ? byDomain : null;
    if (!target) continue;
    // The router's and the queue SQL's key (`ruleMatchKey`), so all three name one principal.
    const key = ruleMatchKey(r.match);
    if (!key) continue;
    const held = target.get(key);
    if (held === undefined || outranks(r, held)) target.set(key, r);
    const all = r.kind === "sender" ? allBySender : allByDomain;
    const list = all.get(key);
    if (list === undefined) all.set(key, [r]);
    else list.push(r);
  }
  return { bySender, byDomain, allBySender, allByDomain, byMailbox };
}

/**
 * The organizer's arrangement of every mailbox this install only reads, off the mirror. An entity
 * that does not carry a rule list is no document, and its mailbox falls back to the local rules;
 * destinations are read at their current spelling, as {@link rulesList} reads the local ones.
 */
export function mailboxProfiles(reader: EntityReader): MailboxProfileEntity[] {
  const out: MailboxProfileEntity[] = [];
  for (const p of reader.list<MailboxProfileEntity>(MAILBOX_PROFILE_TYPE)) {
    if (typeof p?.mailboxId !== "string" || !Array.isArray(p.rules)) continue;
    out.push({ ...p, rules: p.rules.map((r) => ({ ...r, destination: canonicalDestination(r.destination) as Folder })) });
  }
  return out;
}

/** The index a message of `mailboxId` is judged by — its organizer's, where this install reads it. */
function scoped(index: ConsentIndex, mailboxId: string | undefined): ConsentIndex {
  return mailboxId === undefined ? index : index.byMailbox.get(mailboxId) ?? index;
}

/** The rules naming this address and the rules naming its domain, in `mailboxId`'s index. */
function rulesNaming(
  whole: ConsentIndex, address: string, mailboxId?: string,
): readonly (readonly RuleDTO[])[] {
  const index = scoped(whole, mailboxId);
  const addr = senderKey(address);
  const domain = domainOfAddress(addr);
  return [index.allBySender.get(addr) ?? [], (domain === null ? undefined : index.allByDomain.get(domain)) ?? []];
}

/** A rule with no term claims every message of the sender that no narrower rule claims. */
function isBare(r: RuleDTO): boolean {
  return subjectTermOf(r) === null && bodyTermOf(r) === null;
}

/**
 * A rule's two terms as the order reads them (case-folded, trimmed, `null` when absent) — the
 * reader the press modules use, so none of them imports the order itself (`press-forecast.ts`).
 */
export function ruleTerms(r: RuleDTO): { subject: string | null; body: string | null } {
  return { subject: subjectTermOf(r), body: bodyTermOf(r) };
}

/**
 * The ONE destination a decision names for this sender, or `null` when no decision exists. With a
 * bare rule, the winner among the bare rules (the router files every message no term claims there);
 * with only narrowed rules, core `standingRule`'s reading over all of them. At equal priority the
 * address rule wins, the more specific claim; a higher-priority domain rule wins over it.
 */
export function decidedDestination(
  whole: ConsentIndex, address: string, mailboxId?: string,
): Folder | null {
  const index = scoped(whole, mailboxId);
  let bare: RuleDTO | undefined;
  for (const list of rulesNaming(index, address)) {
    for (const r of list) if (isBare(r) && (bare === undefined || outranks(r, bare))) bare = r;
  }
  if (bare !== undefined) return bare.destination;
  const addr = senderKey(address);
  const exact = index.bySender.get(addr);
  const domain = domainOfAddress(addr);
  const wide = domain === null ? undefined : index.byDomain.get(domain);
  if (exact === undefined) return wide?.destination ?? null;
  if (wide === undefined) return exact.destination;
  return outranks(wide, exact) ? wide.destination : exact.destination;
}

/** Where a message's text is held on a client: its ready `message_body` record. */
export type BodyTextReader = Pick<EntityReader, "get">;

const bodyNamesCache = new WeakMap<EntityReader, { at: string; names: ReadonlySet<string> }>();

/**
 * IS THIS SENDER NAMED BY A RULE WITH A BODY TERM — the one case in which a body is an input to
 * the partition. `sender:<address>` and `domain:<domain>` keys over the local rules and every
 * organizer's document, memoized on those two stamps. The engine asks it at each body write, so a
 * body that can re-place a message moves the window's derived stamp and no other body does.
 */
export function namedByBodyTerm(reader: EntityReader, address: string): boolean {
  const names = bodyTermNames(reader);
  if (names.size === 0) return false;
  const key = senderKey(address);
  const domain = domainOfAddress(key);
  return names.has(`sender:${key}`) || (domain !== null && names.has(`domain:${domain}`));
}

/**
 * The body-term keys, rebuilt only when the rule or document stamp moved. The engine warms it at
 * every publish ({@link warmBodyTermNames}), so the rebuild lands on the publish that moved a rule
 * — which re-derives the partition anyway — and a body publish reads a warm set, scanning nothing.
 */
function bodyTermNames(reader: EntityReader): ReadonlySet<string> {
  const at = `${reader.stampOf("rule")}:${reader.stampOf(MAILBOX_PROFILE_TYPE)}`;
  let hit = bodyNamesCache.get(reader);
  if (hit === undefined || hit.at !== at) {
    const names = new Set<string>();
    const rules = [...rulesList(reader), ...mailboxProfiles(reader).flatMap((p) => p.rules)];
    for (const r of rules) {
      if (r.enabled && bodyTermOf(r) !== null && (r.kind === "sender" || r.kind === "domain")) {
        names.add(`${r.kind}:${ruleMatchKey(r.match)}`);
      }
    }
    hit = { at, names };
    bodyNamesCache.set(reader, hit);
  }
  return hit.names;
}

/** Rebuild {@link bodyTermNames} now if a stamp moved — the engine's call at each publish. */
export function warmBodyTermNames(reader: EntityReader): void {
  bodyTermNames(reader);
}

/** The rule a message is filed by, and the rule whose body term this client cannot read. */
export interface MessagePlacement {
  rule: RuleDTO | null;
  /** A body-term rule that would outrank `rule` if it claims the message; its text is not held. */
  undecided: RuleDTO | null;
}

/** The router's haystack as this client holds it: a ready, stored body's text, else `null`. */
function heldText(bodies: BodyTextReader | null, id: string): string | null {
  const rec = bodies?.get<MessageBodyRecord>("message_body", id);
  return rec !== undefined && rec.state === "ready" && rec.withheld == null ? rec.text : null;
}

/**
 * WHERE THE ORGANIZER FILES THIS MESSAGE, asked of the ONE claim (`placingRule`, core
 * `rule-order.ts`) the router's `evaluateRules` asks. The body is read only when a rule naming the
 * sender carries a body term; a text not held makes that rule `undecided`, never a guess. A reader
 * naming WHICH rule placed a row asks this, the partition's own answer.
 */
export function messagePlacement(index: ConsentIndex, m: EngineMessage, bodies: BodyTextReader | null): MessagePlacement {
  const rules = rulesNaming(index, m.from.address, m.mailboxId).flat();
  const needsText = rules.some((r) => bodyTermOf(r) !== null);
  const placed = placingRule(rules.map((r) => ({ ...r, effect: effectForDestination(r.destination), of: r })), {
    author: senderKey(m.from.address), subject: m.subject ?? "",
    text: needsText ? heldText(bodies, m.id) : null, headers: null,
  });
  return { rule: placed.rule?.of ?? null, undecided: placed.undecided?.of ?? null };
}

/** {@link messagePlacement}'s rule alone, for a reader that does not ask about an unread body. */
export function placedRule(index: ConsentIndex, m: EngineMessage, bodies: BodyTextReader | null): RuleDTO | null {
  return messagePlacement(index, m, bodies).rule;
}

/**
 * Where the organizer FILES this message; with no rule, a standing DENIAL is carried out and a
 * standing admission places nothing (`null`). An `undecided` placement projects nothing either:
 * the row stays at the wire's folder until the organizer, which holds the text, has filed it.
 */
function placedDestination(index: ConsentIndex, m: EngineMessage, bodies: BodyTextReader | null): Folder | null {
  const placed = messagePlacement(index, m, bodies);
  if (placed.undecided !== null) return null;
  if (placed.rule !== null) return placed.rule.destination;
  const standing = decidedDestination(index, m.from.address, m.mailboxId);
  return standing !== null && effectForDestination(standing) === "deny" ? standing : null;
}

/**
 * THE INSTANT THE CUTLINE DATES A MESSAGE BY — the `Date:` header, else the arrival.
 *
 * `Date:` is sender-written and nullable, so any stranger can send mail this answered `null` for,
 * and the sender then retired: mail filed at the gate a minute earlier presented under History —
 * "hasn't written in a while" about mail that had just arrived. {@link EngineMessage.arrivedAt}
 * is the moment the mailbox recorded it, the same fact the server's `cutlineInstant` coalesces to.
 * `null` only when the row carries neither, which no server this engine talks to can produce.
 */
/**
 * WHAT THE STORE'S QUEUE PAGE SAYS ABOUT ONE SENDER'S MAIL — `true` when it answers "not waiting".
 * Mail the store keeps OUTSIDE the gate is never held, so a sender the page does not list is not
 * waiting over it. Mail AT the gate is spoken for only inside the page's range: the sender's newest
 * held letter newer than its last row (the route orders by that representative), or anywhere when
 * the page is the whole queue. A subject the server is still deciding is left to the Screener's decided rows.
 */
function storeSaysNotWaiting(
  reader: EntityReader, messages: readonly EngineMessage[],
): (m: EngineMessage, key: string) => boolean {
  const store = screenerWaitingOf(reader);
  if (store === null) return () => false;
  const newest = newestHeldBySender(messages);
  // No readable instant on the last row: the page speaks for no gate mail but its own.
  const { listed, boundary } = queueCoverage(store);
  const deciding = new Set(store.page.inFlight.map((d) => `${d.scope}:${d.match}`));
  return (m, key) => {
    if (listed.has(key) || deciding.has(`sender:${key}`)) return false;
    const at = key.lastIndexOf("@");
    if (at >= 0 && deciding.has(`domain:${key.slice(at + 1)}`)) return false;
    if (m.folder !== "ohmail/Screener") return true;
    // By the sender's NEWEST held letter (header, else arrival), as the server pages them.
    const ms = newest.get(key);
    return ms !== undefined && ms > boundary;
  };
}

/**
 * THE SENDERS THIS COPY HOLDS AT THE GATE, while the queue page says it was read ahead of this copy
 * (`copyBehind`: a mirror still taking in the account). Such a page stops listing a sender decided
 * on another device long before the rule reaches this copy, so its silence about a sender held here
 * is not an answer; empty when the page says nothing of the kind.
 */
function heldAheadOfTheCopy(reader: EntityReader, messages: readonly EngineMessage[]): ReadonlySet<string> {
  if (screenerWaitingOf(reader)?.page.copyBehind !== true) return NO_SENDERS;
  const out = new Set<string>();
  for (const m of messages) if (m.folder === "ohmail/Screener") out.add(senderKey(m.from.address));
  return out;
}
const NO_SENDERS: ReadonlySet<string> = new Set();

function messageMs(m: EngineMessage): number | null {
  const header = m.date === null ? Number.NaN : new Date(m.date).getTime();
  if (Number.isFinite(header)) return header;
  const arrived = m.arrivedAt == null ? Number.NaN : new Date(m.arrivedAt).getTime();
  return Number.isFinite(arrived) ? arrived : null;
}

/** The cutoff both halves of the cutline measure from. See {@link ConsentOptions.baselineAt}. */
export function cutlineFor(
  opts: ConsentOptions,
): { cutoff: number; baselined: boolean; allTime: boolean } {
  const now = opts.now ?? new Date();
  const raw = opts.baselineAt == null ? null : new Date(opts.baselineAt).getTime();
  /* "All time" is no cutoff, and it is the FIRST test, before the baseline
   * read — mirroring the server (`resolveScreeningCutoff`); the other order
   * would make the mode inert for every account that ever screened anything.
   * `allTime` is a MODE and not only `-Infinity`, because a cutoff is read
   * through a COMPARISON: a row with no instant answered "not recent"
   * against every number, so the mode retired mail the server's own
   * `activeSenderExpr` returns `true` for. `-Infinity` stays for the date
   * arms that do compare; `baselined` still says whether one EXISTS.
   */
  if (opts.screeningScope === "all_time") {
    const baseRaw = raw !== null && Number.isFinite(raw) ? raw : null;
    return { cutoff: -Infinity, baselined: baseRaw !== null, allTime: true };
  }
  const days = opts.dormancyDays ?? DEFAULT_DORMANCY_DAYS;
  // An unparseable stored value is treated as ABSENT, not as epoch 0: a baseline of 1970 would
  // make every message post-cutoff and pin every undecided sender in the queue for ever, which is
  // the loudest possible failure for a value nobody can see. Absent is today's behaviour.
  const baseline = raw !== null && Number.isFinite(raw) ? raw : null;
  const from = baseline ?? now.getTime();
  return { cutoff: from - days * 24 * 60 * 60 * 1000, baselined: baseline !== null, allTime: false };
}

/**
 * ACTIVE if the sender has mail worth a decision today, DORMANT otherwise.
 * Without a baseline: any unread mail (regardless of age — that is exactly
 * where a decision is overdue), or any mail inside `now - dormancyDays`.
 * With one: the unread term narrows to `unread && inside the window`, fixed
 * at `baselineAt - dormancyDays` — pre-cutoff mail cannot resurrect a
 * sender. That term is subsumed by the recency term and written out anyway
 * as the rule's statement; never drop `&& within`, which restores the
 * resurrection. Sent mail is the user writing; `all_time` reads no date.
 */
export function senderActivity(
  messages: readonly EngineMessage[],
  opts: ConsentOptions = {},
  own: ReadonlySet<string> = new Set(),
): Map<string, SenderActivity> {
  const { cutoff, baselined, allTime } = cutlineFor(opts);

  const out = new Map<string, SenderActivity>();
  for (const m of messages) {
    if (!KNOWN_FOLDERS.has(m.folder)) continue;
    const key = senderKey(m.from.address);
    if (own.has(key)) continue;
    if (out.get(key) === "active") continue;
    // ALL TIME IS A MODE, NOT A CUTOFF — the server's `activeSenderExpr` returns `true` here and
    // reads no date at all. Answering it through `cutoff = -Infinity` made it a comparison, so a
    // row with no instant read "not recent" and its sender retired under the one setting that
    // means "retire nobody". Every dated row reaches the same answer either way.
    if (allTime) { out.set(key, "active"); continue; }
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
  const index = consentIndex(rulesList(reader), mailboxProfiles(reader));
  const own = ownAddressKeys(reader, opts);
  const notWaiting = storeSaysNotWaiting(reader, messages);
  const heldAhead = heldAheadOfTheCopy(reader, messages);
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
  const rulesOnly = opts.rulesOnly === true;
  const activity = rulesOnly ? new Map<string, SenderActivity>() : senderActivity(messages, opts, own);
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
  const retiredDecided = new Set<string>();

  for (const m of messages) {
    /**
     * OUTBOUND MAIL MEETS THE SAME CUTLINE AS INBOUND MAIL. A folder outside the presented set is either one of the
     * user's own folders (the lens branch below) or the mailbox's Sent folder ({@link isOwnSent}, a positive test on
     * the path); a row that is neither keeps its own place and presents under its folder. Sent rows ARE presented —
     * the Ohbox's "Earlier" is a history of what the reader has finished with, and half of every conversation is what
     * they wrote. This branch used to exempt outbound mail from the cutline entirely (`placeOf.set(m.id, m.folder);
     * continue;`), which on a mailbox with years of Sent mail poured the whole backlog into "Earlier" — the "1,847
     * unread" arrival state this product refuses, wearing a different label.
     */

    /**
     * With no sender to weigh (the user is never a stranger to themselves) the cutline reduces to its date half: mail
     * written before the line is part of the backlog the baseline says is finished, and it is History.
     */

    /*
     * Two deliberate exceptions, and the handoff. A RESURFACED row keeps its place — its only
     * home is the Ohbox's pinned group, and filing it in History would orphan a message the
     * user just asked to see. A row with NO instant is never assumed historical: {@link
     * messageMs} answers `null` only when neither the header nor the arrival is readable, and a
     * row nobody can place in time has not been shown to be finished with. The thread rule then
     * applies unchanged, which is why outbound mail routes through `historyIds` rather than
     * being filed directly: a pre-cutline reply on a thread holding consented mail follows its
     * thread, so the user's own half of a conversation is never in History alone.
     */
    if (!KNOWN_FOLDERS.has(m.folder)) {
      /**
       * FOLDER-FILED MAIL — the lens branch (spec §16.5), only while folders are on. A message in one of the user's
       * OWN folders is FILED: somebody put it there, and an explicit placement is already an answer (the rule
       * `UNDECIDED_RESIDENCES` states for the organized folders). It always KEEPS ITS PLACE — the folder view must
       * show everything the server holds there, and a null place would delete rows from a folder's own list. History
       * reads it as a LENS, never a move: the old-and-read slice from never-screened senders joins `historyIds` while
       * `placeOf` stays the folder, so the row presents in both. Unread mail never joins (History is read-only by
       * construction), a decided sender's mail never joins, the user's own mail never joins; the thread rule below
       * still applies.
       */

      /*
       * With the flag OFF `userFolders` is empty and every row falls through to the branch
       * below, byte-for-byte the pre-feature partition — which is why {@link isOwnSent} had to
       * stop being a negative test: with the flag off nothing here tells `Promotions` from
       * `Sent`, so the Ohbox's own-sent union claimed the mailbox's whole folder tree.
       * `placeOf` is unaffected either way; what the Ohbox does with the row is not this
       * partition's decision to make.
       */
      if (inUserFolder(m)) {
        placeOf.set(m.id, m.folder);
        const key = senderKey(m.from.address);
        if (!own.has(key) && !m.unread && !isResurfaced(m)) {
          const decided = decidedDestination(index, m.from.address, m.mailboxId);
          const ms = messageMs(m);
          if (!rulesOnly && decided === null && ms !== null && ms < cutoff) historyIds.add(m.id);
        }
        continue;
      }
      const sentMs = messageMs(m);
      if (!rulesOnly && !isResurfaced(m) && sentMs !== null && sentMs < cutoff) {
        placeOf.set(m.id, null);
        historyIds.add(m.id);
      } else {
        placeOf.set(m.id, m.folder);
      }
      continue;
    }

    const key = senderKey(m.from.address);
    /* The user is not one of their own correspondents: their mail is never History (a queue of
       people who have not been screened) and never a Screener decision. Held at the gate it
       presents in the INBOX — nothing moves on the server; elsewhere it keeps its place. */
    if (own.has(key)) { placeOf.set(m.id, m.folder === "ohmail/Screener" ? "INBOX" : m.folder); continue; }
    const decided = decidedDestination(index, m.from.address, m.mailboxId);
    /* "Yes, I hear from this person" is core's one list (`isConsentingDestination`), which the
       server's queue SQL is pinned to: Screened and Quarantine are decisions that are not consent. */
    const consented = decided !== null && isConsentingDestination(decided);
    if (consented) consentedSenders.add(key);

    /**
     * A RESURFACED ROW IS THE USER'S OWN ACT, AND THE CUTLINE KEEPS ITS HANDS OFF: Rule 1 above says consent comes
     * from the user's own actions — and snoozing a message and scheduling THIS moment for its return is nothing else.
     * Yet this partition used to weigh the row by its SENDER like any other undecided-residence mail: an active
     * undecided sender's resurfaced row presented in the Screener (a queue of sender rows, where no pin exists), and
     * a dormant one's was deleted from the projected list entirely (History). Either way the Ohbox's pinned group —
     * the state's only home, `ohboxView.resurfaced` — never saw it, so a message the user explicitly asked to see
     * again was, at the very moment they asked to see it, in NO list at all. Reachable by search, filed nowhere:
     * measured on a live mailbox. So a resurfaced row keeps its place — the INBOX when it sits at the gate.
     */

    /**
     * `ohboxView` pins it from any folder; what this exemption owes it is to stay OUT of the Screener grouping and
     * OUT of History's deletion. The sender's own standing is untouched — their other mail still queues or rests
     * exactly as before, and reading the pinned row (which clears the state to `none`) hands this one back to the
     * ordinary rules below. Only `resurfaced`: the bottom piles are each a visible home of their own, so their rows
     * are never orphaned by this loop.
     */
    // Held at the gate it presents in the INBOX, so the pin is its one surface and no waiting row holds it.
    if (isResurfaced(m)) { placeOf.set(m.id, m.folder === "ohmail/Screener" ? "INBOX" : m.folder); continue; }

    // An explicit placement is already an answer. Never second-guessed.
    if (!UNDECIDED_RESIDENCES.has(m.folder)) { placeOf.set(m.id, m.folder); continue; }

    // With the cutline unknown every sender counts as active, and an unruled one keeps its
    // folder (the `rulesOnly` arm) rather than being queued or retired.
    const active = rulesOnly || activity.get(key) === "active";
    /**
     * A RULE THAT HAS NOT MOVED THE MAIL CHANGES NOTHING A PERSON SEES, in either residence and in
     * every posture. A letter presents at its folder as the wire states it — the server's desired
     * folder, else where it is — so a move the organizer plans shows the moment it is written, and
     * a rule nothing carried out (a Move press that left the backlog, a reader's store, a mailbox
     * nothing organizes) shows nothing. An admission changes the sender's STANDING — decided: never
     * queued, never cut to History — and never a letter's place. One projection stays: a DENY
     * rule's mail, the person's own answer, on the screened-out shelf.
     */
    const placed = placedDestination(index, m, reader);
    if (placed !== null || decided !== null) {
      placeOf.set(m.id, placed !== null && effectForDestination(placed) === "deny" ? placed : m.folder);
      if (m.folder === "ohmail/Screener" && !active) retiredDecided.add(key);
    } else if (decided === null && (rulesOnly || active) && notWaiting(m, key)) {
      // THE STORE HAS ANSWERED FOR THIS SENDER: not waiting (a correspondent, a contact, decided
      // elsewhere), so their mail presents in the Ohbox, never at the gate. The count keeps asking
      // the cutline's own question, which is the one the SQL twin answers. EXCEPT a sender this copy
      // holds at the gate while the page was read ahead of it ({@link heldAheadOfTheCopy}): kept at
      // the gate until the rule lands or the copy catches up, never released early to the Ohbox.
      if (!rulesOnly) activeUndecided.add(key);
      placeOf.set(m.id, heldAhead.has(key) ? "ohmail/Screener" : "INBOX");
    } else if (rulesOnly) {
      placeOf.set(m.id, m.folder);
    } else if (active) {
      // The COUNTS keep the cutline's own question — senders with no rule still owed a decision —
      // because that is the one `cutlineCounts` answers in SQL and the parity test pins. Only the
      // PLACE moves here; a ruled sender is `decided` on both sides of that pin.
      if (decided === null) activeUndecided.add(key);
      placeOf.set(m.id, "ohmail/Screener");
    } else {
      dormantUndecided.add(key);
      placeOf.set(m.id, null);
      historyIds.add(m.id);
    }

    // The thread anchor is the newest message from a CONSENTED sender, wherever it presents.
    const place = placeOf.get(m.id);
    if (m.threadId && place !== null && place !== undefined && consentedSenders.has(key)
        && isConsentingDestination(place)) {
      const held = consentedByThread.get(m.threadId);
      if (!held || byDateDesc(m, held) < 0) consentedByThread.set(m.threadId, m);
    }
  }

  /**
   * THE THREAD RULE. A conversation is one thing: if a consented sender and a never-screened sender both wrote on a
   * thread, splitting it across the Ohbox and History hides half a conversation in a place nobody looks — with the
   * hidden half decided by which participant happens to be dormant. So a thread holding any consented mail presents
   * ENTIRELY where that mail lives, anchored on the thread's most recent consented message. Nothing physical moves;
   * this is the same presentation filter as everything else in this file. It deliberately does NOT rescue
   * Screener-placed messages: the Screener is a per-sender decision queue, not a place, and pulling a sender out
   * because they replied on a consented thread would skip the decision the queue exists to ask. That sender keeps
   * their row; only their History mail follows the thread.
   */

  /**
   * The join itself has to be corroborated. `threadId` is the header chain, and In-Reply-To/References are the
   * sender's own writing: a stranger naming a Message-ID this mailbox holds joins that conversation, and the rescue
   * would carry their first message into the consented pile — a first-contact decision skipped by a header. So the
   * account's OWN outbound on the thread must name the sender: `we_wrote` is the only class that can corroborate,
   * because the placed row is the sender's writing and "they wrote to us" would corroborate itself
   * (`@trafficflow/core/sender-headers`). The stated cost: a stranger's reply on a consented thread the user has not
   * answered stays in History until they do — the recoverable direction, since an unrescued row is in a list while an
   * admitted one skipped the queue.
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
        // The wire's `MessageDTO.authVerdict`; absent (a server older than the field) is `null`,
        // "nobody asked" — the permissive member, never "the provider said it was fine".
        authVerdict: m.authVerdict ?? null,
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
    retiredDecided,
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
    /* FORWARDED, and the projection adds nothing of its own: it re-places messages the
       partition already decided about, so it is stale exactly when its base reader is. A
       wrapper that dropped these would fall back to nothing — the shell would key its
       derivations on a stamp that never moves. `reader-stamp-forwarding.test.ts` refuses a
       wrapper that answers a stamp its base does not. */
    stampOf: (type) => reader.stampOf(type),
    stampExcept: (ignore) => reader.stampExcept(ignore),
    get<T = unknown>(type: string, id: string): T | undefined {
      const v = reader.get<T>(type, id);
      if (type !== "message" || v === undefined) return v;
      return (project(v as unknown as EngineMessage) ?? undefined) as T | undefined;
    },
    list<T = unknown>(type: string): T[] {
      // The partition's own answer, never stored — see `RETIRED_DECIDED_TYPE`.
      if (type === RETIRED_DECIDED_TYPE) return [...partition.retiredDecided].map((key) => ({ key }) as T);
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
    entries<T = unknown>(type: string): Array<{ id: string; entity: T; seq: number }> {
      const rows = reader.entries<T>(type);
      if (type !== "message") return rows;
      const out: Array<{ id: string; entity: T; seq: number }> = [];
      for (const r of rows) {
        const p = project(r.entity as unknown as EngineMessage);
        if (p) out.push({ id: r.id, entity: p as unknown as T, seq: r.seq });
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
