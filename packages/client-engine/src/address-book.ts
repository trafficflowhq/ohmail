/**
 * The address book, derived from the mirror — a pure selector, no contacts
 * table, no endpoint: every address the user corresponds with is already on
 * the mirrored messages. Sources: every From and To/Cc, plus sent drafts;
 * sent mail also reaches the mirror (folder "Sent" matches no pile view;
 * field-level selectors see it). Obvious robots (`noreply@` etc.) are
 * excluded. Names: self-declared (From) beats observed (To/Cc/draft) as a
 * hard tier — a wrong drafted name cannot re-elect itself; within a tier
 * most recent, then longer; empty never. Recomputed per render.
 */
import { counterpartyEvidence, type CounterpartyEvidence } from "@trafficflow/core/sender-headers";
import { isOwnSent } from "./selectors.js";
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
  /**
   * WHO PUT THIS ADDRESS IN THE BOOK — `we_wrote` (our own sent mail or a sent draft names them),
   * `they_wrote` (they have written to us), or `sender_named` (they have only ever appeared in a
   * `To`/`Cc` somebody else wrote).
   *
   * The first key {@link byRank} sorts on, because a count alone is a lever: twenty messages from a
   * stranger outranked the colleague written to twice, and a `From` display name the stranger chose
   * put their address under that colleague's name at the top of the suggestions. REQUIRED, so a
   * caller building an entry has to say which it is.
   */
  evidence: CounterpartyEvidence;
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
 * The map's value while the walk runs. `nameTier`/`nameAt` describe the
 * name currently held — not the entry — so they cannot fold into `lastAt`:
 * `lastAt` is the newest appearance of the address by any route (it feeds
 * {@link rankOf}); `nameAt` is the date of the message the held name was
 * read off. A bare-From message advances the first and must not touch the
 * second. Internal, not on {@link AddressBookEntry}: working state, and
 * {@link addressBook} strips it on the way out.
 */
interface Acc extends AddressBookEntry {
  nameTier: number;
  nameAt: number;
}

/** Corroborated first, and within a class the score below decides. */
const EVIDENCE_ORDER: Record<CounterpartyEvidence, number> = {
  we_wrote: 0,
  they_wrote: 1,
  sender_named: 2,
};

/**
 * A message's date, as evidence of recency — or {@link NO_EVIDENCE}.
 * `EngineMessage.date` is the sender-written `Date:` header; under
 * most-recent-wins an unchecked timestamp is a lever (a 2099 date would be
 * unbeatable). A future date and stamp()'s `0` both become `-Infinity` —
 * NOT `0`, which is not below real dates: a rejected 2099 claim at `0`
 * still beat a legitimate 1968 one. The name stays a candidate; it cannot
 * outrank a dated one. `SKEW` (a day) tolerates slow clocks. Scoped to the
 * NAME — `lastAt` and {@link rankOf} keep the raw value.
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
      address, name, count: 1, lastAt: at, evidence: "sender_named",
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

  const rows = reader.list<EngineMessage>("message");
  const sentDrafts = reader.list<EngineDraft>("draft").filter((d) => d.status === "sent");
  /* WHO PUT EACH ADDRESS HERE, by the one rule (`@trafficflow/core/sender-headers`). A message we
     wrote contributes its recipients as our own record; anybody else's mail contributes its author
     and NOT its `To`/`Cc`, which is that sender's claim about who else is involved. A sent draft is
     the same record from the other side, whatever folder its delivered copy landed in. */
  const evidence = counterpartyEvidence([
    ...rows.map((m) => ({
      ownAuthored: isOwnSent(m),
      from: m.from?.address,
      recipients: [...(m.to ?? []), ...(m.cc ?? [])].map((w) => w?.address),
    })),
    ...sentDrafts.map((d) => ({
      ownAuthored: true,
      from: null,
      recipients: [...(d.to ?? []), ...(d.cc ?? [])].map((w) => w?.address),
    })),
  ]);

  for (const m of rows) {
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
    .map(({ nameTier: _t, nameAt: _a, ...entry }) => ({
      ...entry,
      evidence: evidence.get(entry.address) ?? "sender_named",
    }))
    .sort(byRank);
}

/**
 * Recency and frequency, both; the weighting is stated, not tuned.
 * Frequency alone ranks a mailing list above this week's colleague;
 * recency alone ranks the latest sender above the daily correspondent. So:
 * `count` plus a recency bonus capped at 3 — it breaks ties, never
 * overturns them. `lastAt` then `address` make the order total (a
 * comparator returning 0 for different entries flickers with sort
 * stability). Evidence outranks both — count and recency can be produced on
 * demand: written-to, then wrote-to-us, then sender-only-named entries.
 */
const DAY = 86_400_000;

export function rankOf(entry: AddressBookEntry, now: number): number {
  const age = now - entry.lastAt;
  const bonus = entry.lastAt === 0 ? 0 : age < 7 * DAY ? 3 : age < 30 * DAY ? 2 : age < 90 * DAY ? 1 : 0;
  return entry.count + bonus;
}

function byRank(a: AddressBookEntry, b: AddressBookEntry): number {
  const now = Date.now();
  const tier = EVIDENCE_ORDER[a.evidence] - EVIDENCE_ORDER[b.evidence];
  if (tier !== 0) return tier;
  const d = rankOf(b, now) - rankOf(a, now);
  if (d !== 0) return d;
  if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

/**
 * Prefix matching, on the address and on every word of the name — prefix,
 * not substring: typing `an` should offer "Anna" and "andreas@…", not every
 * address containing `an`. The name splits on whitespace so a surname is
 * reachable (`eich` → "Lena Eichspan"); the address matches whole and from
 * its local part, so `example.com` finds the domain's people and `lena`
 * finds `lena@example.com`. An empty query returns nothing: the field is
 * not a browsable directory.
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
 * What accepting a suggestion writes — "Lena Eichspan <lena@example.com>",
 * or the bare address. A name rides along only when the field can read it
 * back: the field's value is one comma-separated string and the chip
 * splitter is blind to quoting, so "Lindt, Nora <nora@…>" (the Exchange
 * default) came back as two chips and disabled Send (`composePlan`).
 * Quoting would not save it, so the name is dropped and the bare address
 * kept — `formatRecipientLine`'s decision (compose-from.ts); one
 * implementation now: `RecipientField.formatFor` calls this.
 */
export function formatRecipient(entry: AddressBookEntry): string {
  if (entry.name === "" || /[<>,;"]/.test(entry.name)) return entry.address;
  return `${entry.name} <${entry.address}>`;
}
