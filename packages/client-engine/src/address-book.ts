/**
 * ═══ THE ADDRESS BOOK, DERIVED FROM THE MIRROR ═══════════════════════════════════════════
 *
 * Reported as: composing a message, the To field *"won't give me addresses from my actual
 * mailboxes I can fast-select on my typing"*. There was no address book at all — the field was
 * a bare text input, so every recipient had to be typed in full and remembered exactly.
 *
 * ── WHY THIS IS A SELECTOR AND NOT AN ENDPOINT ──────────────────────────────────────────
 *
 * There is no contacts table and this does not need one. Every address the user has ever
 * corresponded with is already in the local mirror, on the messages themselves, and the mirror
 * is on the same machine as the keystroke. A server round trip per keystroke would be slower,
 * would leak what is being typed before it is sent, and would need an endpoint, a rate limit
 * and a cache — for data the client already holds. So this is a pure function over the reader,
 * exactly like `tagsCrossView` or `triagePiles`, and it works offline, in the demo and on the
 * desktop shell for free.
 *
 * ── WHERE THE ADDRESSES COME FROM ───────────────────────────────────────────────────────
 *
 * Three places, and the third is the one that matters most:
 *
 *   · the FROM of every message — everyone who has written to the user;
 *   · the TO and CC of every message — everyone the user is in a thread with, including
 *     people who have never written to them directly;
 *   · the TO and CC of the user's own SENT drafts (`status: "sent"`), which is the only
 *     record of outbound correspondence the mirror holds. `Folder` is a closed six-member
 *     union with no Sent in it, so sent MESSAGES never reach the mirror at all — the draft
 *     rows are it, and leaving them out would rank the people the user writes to below the
 *     newsletters that write to them.
 *
 * ── THE ROBOTS ARE EXCLUDED, AND ONLY THE OBVIOUS ONES ──────────────────────────────────
 *
 * `noreply@`, `mailer-daemon@` and friends are addresses no reply can reach, so offering them
 * as recipients is offering to send mail into a hole. The list is deliberately short and
 * matched on the LOCAL PART only: a heuristic that guessed harder would eventually hide a real
 * person, and the cost of that is far worse than the cost of one dead suggestion. `no-reply`
 * and `donotreply` are the same word with punctuation, so punctuation is stripped before the
 * comparison rather than each spelling being listed.
 *
 * ── WHOSE NAME AN ADDRESS WEARS ─────────────────────────────────────────────────────────
 *
 * Reported against a real mailbox: a recipient chip read
 *
 *     Atelier Papierwerk GmbH - Nora Lindt   nora@atelier.invalid   ×
 *
 * — "this is not Nora". The address was right; the name was somebody else's idea of her. (The
 * shape is the report's; the names are this repository's fixture cast, because the reported ones
 * are a real correspondent's and this file is published.)
 *
 * The three sources above are not three sources of the same fact. A From header is the address
 * OWNER saying what they are called. A To or Cc header is a THIRD PARTY's client saying what IT
 * calls them — their own address book, exported into a header, harvested here under that
 * person's address. And a sent draft's recipient label is whatever the user typed or accepted,
 * which after this bug had run once was frequently the wrong name coming back round.
 *
 * The rule used to be "the longest name ever seen", which knows neither who said it nor when. A
 * long company-shaped label from any of those sources therefore won permanently — over the name
 * the person signs their own mail with, on every surface reading this book, and out onto the
 * wire's To header, because accepting a suggestion writes `Name <address>` into the draft.
 *
 * So the choice is made in two steps, and the first one is a HARD tier:
 *
 *   1. SELF-DECLARED beats OBSERVED. A name seen on a From always wins over one seen on a
 *      To, a Cc or a sent draft — however long, however recent. That is what closes the
 *      feedback loop: a wrong name written into a draft is `observed`, so it cannot re-elect
 *      itself over the sender's own signature.
 *   2. WITHIN a tier, the MOST RECENT wins; an exact tie falls back to the longer name, and
 *      then to the strings themselves, so the derivation is TOTAL and cannot flicker between
 *      two candidates as unrelated mail arrives (the same requirement {@link byRank} states
 *      for the ordering).
 *
 * An EMPTY name is never a candidate. `""` is the absence of a claim, not a claim that somebody
 * is now called nothing — most automated mail carries no display name at all, and one bare
 * message must not blank a correspondent everywhere.
 *
 * Nothing here is persisted: the book is recomputed from the mirror on every render, so this
 * rule takes effect on already-stored mail with no migration and no data repair. What it cannot
 * reach is a name a user ALREADY sent — that string is in a delivered message's headers and in
 * the `drafts` row behind it, and rewriting either would be inventing history. Those rows are
 * `observed`, so they stop influencing what is shown from here on.
 */
import type { EntityReader } from "./store.js";
import type { EmailAddress, EngineDraft, EngineMessage } from "./types.js";

export interface AddressBookEntry {
  /** Lower-cased — the identity. Two spellings of one address are one entry. */
  address: string;
  /**
   * The display name this address wears, or `""` when none was ever claimed for it.
   *
   * The name the ADDRESS OWNER last signed with — the most recent non-empty display name on a
   * message whose `from` is this address. Only when they have never written does a label
   * somebody else addressed them by stand in, and then the most recent of those. See the
   * header: a third party's name for a person is not evidence about that person's name, and
   * the previous longest-wins rule made one such label permanent.
   */
  name: string;
  /** How many messages and drafts this address appears on. */
  count: number;
  /** The most recent appearance as epoch ms; `0` when nothing carrying it was dated. */
  lastAt: number;
}

/** Local parts that no reply can reach. Compared after stripping non-letters. */
const ROBOT_LOCALS = [
  "noreply",
  "donotreply",
  "mailerdaemon",
  "bounce",
  "bounces",
  "postmaster",
  "nobody",
];

/**
 * Is this an address a person reads?
 *
 * Exported because the compose surface needs the same answer when deciding whether something
 * the user typed by hand is worth remembering, and two copies of this list would drift.
 */
export function isRobotAddress(address: string): boolean {
  const local = address.slice(0, address.indexOf("@")).toLowerCase().replace(/[^a-z]/g, "");
  if (local === "") return false;
  return ROBOT_LOCALS.includes(local);
}

/*
 * WHERE A CANDIDATE NAME CAME FROM. Ordered, and the order is the whole rule: a higher tier
 * always wins, so no amount of length or recency can promote a stranger's label over the
 * address owner's own. See the header.
 */

/** A To/Cc header, or a sent draft's recipient — somebody ELSE's label for this person. */
const OBSERVED = 0;
/** A From header — the address owner saying what they are called. */
const SELF = 1;
/** No name held. Below every real tier, so the first non-empty claim from ANY source takes it. */
const NONE = -1;

/**
 * The map's value while the walk is running. `nameTier`/`nameAt` describe the name currently
 * held — NOT the entry — which is why they cannot be folded into `lastAt`: `lastAt` is the
 * newest appearance of the address by any route (it feeds {@link rankOf}), while `nameAt` is
 * the date of the message the held NAME was read off. A bare-From message advances the first
 * and must not touch the second.
 *
 * Internal, and deliberately not on {@link AddressBookEntry}: the two fields are the
 * derivation's working state, and every caller constructs entries as `{address,name,count,
 * lastAt}` literals. {@link addressBook} strips them on the way out.
 */
interface Acc extends AddressBookEntry {
  nameTier: number;
  nameAt: number;
}

/**
 * A message's date, AS EVIDENCE OF RECENCY — or {@link NO_EVIDENCE}.
 *
 * `EngineMessage.date` is the `Date:` HEADER, which the sender writes and nobody checks; the
 * mirror holds no arrival clock to use instead (`updatedAt` is the mirror row's own stamp and
 * moves on a read-mark or a folder change, so keying a name off it would reshuffle names on
 * unrelated activity). Under a most-recent-wins rule an unchecked timestamp is a lever: one
 * message dated 2099 — a broken client, an import, or somebody who wanted the last word — would
 * make its display name unbeatable by every correctly dated message that ever follows.
 *
 * TWO inputs carry no usable evidence, and they are told apart from a real date rather than
 * folded into a number that happens to be small:
 *
 *   · a date in the FUTURE — not evidence that a claim is NEWER, so it is not counted as any;
 *   · `stamp()`'s `0`, which is "no `Date:` header, or one that would not parse".
 *
 * Both become `-Infinity`, and that value rather than `0` is the whole of the second version of
 * this function. **`0` is not below the range of a real date.** `pagination.ts` sets this out at
 * length for the same header: a message dated before 1970 is *"ordinary in imported archives"*
 * and gives a NEGATIVE millisecond value. Ranking a rejected 2099 claim at `0` therefore left it
 * beating a legitimate 1968 one — the defect this function exists to close, still open for the
 * one population where a bogus date is most likely to turn up.
 *
 * The name is still a candidate either way — it may be the only one this address has — it just
 * cannot outrank a dated one.
 *
 * `SKEW` because a `Date:` a few minutes ahead of the reader's clock is ordinary mail, not a
 * forgery, and a device with a slow clock must not have every fresh name demoted. A day is far
 * wider than any real skew and still far narrower than any useful forgery.
 *
 * Deliberately scoped to the NAME. `lastAt` and {@link rankOf} keep taking the raw value: that is
 * the ordering this file already had, a future date has always been able to float an entry to the
 * top of the suggestions, and narrowing it here would be an unrelated behaviour change smuggled
 * into a fix about names. Worth doing; not worth doing quietly.
 */
const SKEW = 86_400_000;
/** Below every value `Date` can hold (±8.64e15), so no real timestamp can lose to a rejected one. */
const NO_EVIDENCE = Number.NEGATIVE_INFINITY;
/**
 * `null` is "there was no date", and it is a SEPARATE INPUT rather than a number this function
 * recognises. Reading absence off the value itself is what the previous version did — `at === 0`
 * — and `Date.parse("1970-01-01T00:00:00.000Z")` is exactly `0`, so a message legitimately dated
 * at the epoch was classified as having no date at all and lost to a 1968 one. `stamp()` is where
 * "did this parse" is known, so that is where it stays.
 */
function evidenceAt(at: number | null, now: number): number {
  if (at === null) return NO_EVIDENCE;
  return at > now + SKEW ? NO_EVIDENCE : at;
}

function addTo(
  into: Map<string, Acc>,
  who: EmailAddress | null | undefined,
  /** The message's parsed `Date:`, or `null` where it had none or it would not parse. */
  dated: number | null,
  tier: number,
  now: number,
): void {
  /* `lastAt`'s own contract is unchanged: `0` where nothing carrying this address was dated,
     which {@link rankOf} reads as "no recency bonus". That collapses the epoch with the absent
     date exactly as it always has — a pre-existing property of the RANKING, deliberately left
     alone here, because the name rule is what this slice is about. */
  const at = dated ?? 0;
  const raw = who?.address?.trim();
  if (!raw || !raw.includes("@")) return;
  const address = raw.toLowerCase();
  if (isRobotAddress(address)) return;

  const name = (who?.name ?? "").trim();
  const nameAt = evidenceAt(dated, now);
  const prev = into.get(address);
  if (!prev) {
    // An empty name claims nothing, so it holds no tier either — see {@link NONE}.
    into.set(address, {
      address, name, count: 1, lastAt: at,
      nameTier: name === "" ? NONE : tier,
      nameAt: name === "" ? NO_EVIDENCE : nameAt,
    });
    return;
  }
  prev.count += 1;
  if (at > prev.lastAt) prev.lastAt = at;
  // `""` is the absence of a claim, never a claim that the name is now nothing.
  if (name === "") return;
  /* Tier first and absolutely; then recency; then length; then the strings themselves.
     The last two comparisons are not decoration — without a rule for every case the winner
     of a tie is whichever message the mirror happened to enumerate first, which is the same
     unstable-order defect {@link byRank} states for the ordering. Length before lexical
     because the fuller of two same-day spellings ("Lena" / "Lena Eichspan") is the one worth
     showing; lexical only ever settles two DIFFERENT names of equal length written at the
     same instant, where any answer is arbitrary and only stability matters. */
  const better =
    tier > prev.nameTier ||
    (tier === prev.nameTier &&
      (nameAt > prev.nameAt ||
        (nameAt === prev.nameAt &&
          (name.length > prev.name.length ||
            (name.length === prev.name.length && name > prev.name)))));
  if (!better) return;
  prev.name = name;
  prev.nameTier = tier;
  prev.nameAt = nameAt;
}

/**
 * The parsed `Date:`, or `null` where there was none or it would not parse.
 *
 * `null` and not `0`: `Date.parse("1970-01-01T00:00:00.000Z")` IS `0`, so a sentinel inside the
 * number cannot tell a message dated at the epoch from one carrying no date at all — and once
 * {@link evidenceAt} started ranking "no date" below every real one, that collision stopped being
 * harmless and started demoting a legitimate timestamp. Callers that want the old `0` say so.
 */
const stamp = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * Every address the mirror knows, ranked. Newest-and-most-frequent first.
 *
 * @param exclude addresses that must never be offered — the account's own, above all. The
 *   caller supplies them because this module has no way to know whose mailbox it is reading,
 *   and suggesting somebody their own address as a recipient is noise at best.
 */
export function addressBook(
  reader: EntityReader,
  opts: { exclude?: readonly string[] } = {},
): AddressBookEntry[] {
  const into = new Map<string, Acc>();
  // Read ONCE, so every comparison in this walk is against the same instant. Sampling the clock
  // per message would let a long derivation judge its first rows against a different horizon
  // from its last, which is a result that depends on how long it took to compute.
  const now = Date.now();

  for (const m of reader.list<EngineMessage>("message")) {
    const at = stamp(m.date);
    // The From is the only SELF-declared name in the whole walk — see the header.
    addTo(into, m.from, at, SELF, now);
    for (const who of m.to ?? []) addTo(into, who, at, OBSERVED, now);
    for (const who of m.cc ?? []) addTo(into, who, at, OBSERVED, now);
  }

  for (const d of reader.list<EngineDraft>("draft")) {
    // SENT only. A draft still being written names somebody the user has not decided to
    // write to yet, and an abandoned one names somebody they decided not to.
    if (d.status !== "sent") continue;
    const at = stamp(d.updatedAt ?? d.createdAt);
    // OBSERVED, and this is the tier that closes the loop: accepting a suggestion writes
    // `Name <address>` into the draft, so a name chosen here comes back through this very
    // list. At `SELF` it would re-elect itself for ever.
    for (const who of d.to ?? []) addTo(into, who, at, OBSERVED, now);
    for (const who of d.cc ?? []) addTo(into, who, at, OBSERVED, now);
  }

  const blocked = new Set((opts.exclude ?? []).map((a) => a.trim().toLowerCase()));
  return [...into.values()]
    .filter((e) => !blocked.has(e.address))
    // The working fields go no further than this function — see {@link Acc}.
    .map(({ nameTier: _t, nameAt: _a, ...entry }) => entry)
    .sort(byRank);
}

/**
 * RECENCY AND FREQUENCY, both, and the weighting is stated rather than tuned.
 *
 * Frequency alone ranks a mailing list above the colleague written to twice this week;
 * recency alone ranks whoever happened to send something an hour ago above the person written
 * to every day for a year. So the score is `count` plus a small recency bonus — frequency
 * leads, and recency only reorders addresses of comparable weight. The bonus is capped at 3,
 * which is deliberately less than the difference a handful of extra messages makes: it breaks
 * ties, it does not overturn them.
 *
 * `lastAt` then `address` are the tiebreaks, so the order is TOTAL. A comparator that can
 * return 0 for two different entries gives an order that depends on the engine's sort
 * stability, which is how a suggestion list flickers between two candidates as unrelated mail
 * arrives.
 */
const DAY = 86_400_000;

export function rankOf(entry: AddressBookEntry, now: number): number {
  const age = now - entry.lastAt;
  const bonus = entry.lastAt === 0 ? 0 : age < 7 * DAY ? 3 : age < 30 * DAY ? 2 : age < 90 * DAY ? 1 : 0;
  return entry.count + bonus;
}

function byRank(a: AddressBookEntry, b: AddressBookEntry): number {
  const now = Date.now();
  const d = rankOf(b, now) - rankOf(a, now);
  if (d !== 0) return d;
  if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

/**
 * PREFIX MATCHING, on the address and on every word of the name.
 *
 * Prefix and not substring, and that is the whole difference between a useful list and a
 * confusing one: typing `an` should offer "Anna" and "andreas@…", not every address with the
 * letters `an` somewhere inside it. The name is split on whitespace so a surname is reachable
 * — somebody typing `eich` expects "Lena Eichspan" — and the address is matched both whole and
 * from its local part, so `example.com` finds people at that domain while `lena` finds
 * `lena@example.com`.
 *
 * An empty query returns nothing rather than everything. The field is not a browsable
 * directory; suggestions appear because the user started typing a name.
 */
export function matchAddresses(
  book: readonly AddressBookEntry[],
  query: string,
  limit = 6,
): AddressBookEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];

  const hit = (e: AddressBookEntry): boolean => {
    if (e.address.startsWith(q)) return true;
    const at = e.address.indexOf("@");
    if (at > 0 && e.address.slice(at + 1).startsWith(q)) return true;
    return e.name
      .toLowerCase()
      .split(/\s+/)
      .some((word) => word !== "" && word.startsWith(q));
  };

  const out: AddressBookEntry[] = [];
  for (const e of book) {
    if (!hit(e)) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * WHAT ACCEPTING A SUGGESTION WRITES — "Lena Eichspan <lena@example.com>", or the bare address.
 *
 * ── A NAME RIDES ALONG ONLY WHEN THE FIELD CAN READ IT BACK ─────────────────────────────
 *
 * The recipient field's value is ONE comma-separated string and the splitter that turns it into
 * chips is blind to quoting. So "Lindt, Nora" — the Exchange/Outlook default, not an exotic
 * shape — was written as `Lindt, Nora <nora@…>`, came back as TWO chips, and `Lindt` was
 * reported as not an address. One invalid entry empties the whole envelope by design
 * (`composePlan`), so picking a contact out of your own address book DISABLED SEND.
 *
 * Quoting the name would not save it: the splitter would still cut inside the quotes. So the
 * name is dropped and the bare address kept, which is the decision `formatRecipientLine`
 * (`apps/webapp/app/shell/compose-from.ts`) already made for the reply prefill, in the same
 * words and against the same character class — the envelope is the address; the name is sugar.
 * That rule now has one implementation instead of three: `RecipientField.formatFor` calls this,
 * and `formatRecipientLine` states the shared reason.
 */
export function formatRecipient(entry: AddressBookEntry): string {
  if (entry.name === "" || /[<>,;"]/.test(entry.name)) return entry.address;
  return `${entry.name} <${entry.address}>`;
}
