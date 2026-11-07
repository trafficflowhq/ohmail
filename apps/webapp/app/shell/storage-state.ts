/**
 * What to say about stored letter text, from the `storage` block `GET /account/access` answers for a
 * metered account with a cap. When the stored text reaches the cap, ohmail empties the text of the
 * oldest letters (ratified 2026-08-21); the letters stay complete in the person's mailbox on their
 * mail server and stay listed and findable here. Nothing here ever says mail is declined or refused:
 * mail keeps arriving at the cap. Absent or malformed figures say nothing, never "0 of 0".
 * The server decides which card is due (its dismissal applied) and sizes the plan offer; prices
 * come only from that offer. Shared by the browser and the desktop window (same block, over its bridge).
 */
import { firstImportsOf } from "./consent-options";

/** The card atop the Ohbox: near the cap, at it, or above the plan's own lower limit. */
export type StorageCard = "near" | "full" | "drop";

/** Why the cap is what it is: the plan's own limit, the trial's room above it, or a lower limit held. */
export type StorageLimitReason = "plan" | "trial" | "held";

export type StoragePlanName = "solo" | "plus" | "pro";

/** What the mail is expected to need once every folder is counted (the worker's snapshot). */
export interface StorageEstimate {
  expectedBytes: number;
  expectedLetters: number;
  storedLetters: number;
  avgLetterBytes: number;
  /** The average is the account's own (1,000 letters with text measured), else the default. */
  avgMeasured: boolean;
  /** Every folder has a count; false while one has none. */
  complete: boolean;
}

/** One mailbox, by id: the bytes it holds of the counter, and what it is expected to need. */
export interface StorageMailbox {
  id: string;
  usedBytes: number;
  letters: number;
  expectedLetters: number;
  expectedBytes: number;
  importing: boolean;
}

/** The program's offer, narrowed: amounts in minor units, never guessed. */
export interface StorageOffer {
  currency: string;
  interval: "month" | "year";
  plans: Array<{ plan: StoragePlanName; mailboxes: number; roomBytes: number; amount: number }>;
  addon: { unitBytes: number; amount: number; maxUnits: number } | null;
  current: { plan: StoragePlanName; addonUnits: number; roomBytes: number; roomFrom: "now" | "first_payment" };
  fit: { plan: StoragePlanName; addonUnits: number; roomBytes: number; amount: number; keepsAll: boolean };
  canChange: boolean;
}

/**
 * The block, narrowed. `keptFrom` is "YYYY-MM": text is kept for letters from that month on. The
 * fields after `limitDropsAt` came with the storage estimate; an older server sends none of them.
 */
export interface StorageFacts {
  usedBytes: number;
  limitBytes: number;
  emptiedForSpace: number;
  firstEmptiedAt: string | null;
  keptFrom: string | null;
  withheldOnArrival: number;
  /** The server's word: is the current cap what empties text now? */
  emptyingNow: boolean;
  /** Under a trial's room or a held drop: the plan's own, lower limit, else `null`. */
  planLimitBytes: number | null;
  /** When the plan's limit applies (ISO); `null` until a first payment dates it. */
  limitDropsAt: string | null;
  limitReason: StorageLimitReason;
  /** A mailbox is still on its first import. */
  importing: boolean;
  /** The card due now, the person's dismissal applied; `null` for none. */
  card: StorageCard | null;
  /** Storage mails are on. */
  mail: boolean;
  estimate: StorageEstimate | null;
  mailboxes: StorageMailbox[];
  offer: StorageOffer | null;
}

const count = (v: unknown): number | null =>
  (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const PLANS: readonly StoragePlanName[] = ["solo", "plus", "pro"];
const isPlan = (v: unknown): v is StoragePlanName => (PLANS as readonly unknown[]).includes(v);
const rec = (v: unknown): Record<string, unknown> | null =>
  (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function estimateOf(raw: unknown): StorageEstimate | null {
  const e = rec(raw);
  if (e === null) return null;
  const n = [e.expectedBytes, e.expectedLetters, e.storedLetters, e.avgLetterBytes].map(count);
  if (n.some((v) => v === null)) return null;
  return {
    expectedBytes: n[0]!, expectedLetters: n[1]!, storedLetters: n[2]!, avgLetterBytes: n[3]!,
    avgMeasured: e.avgMeasured === true, complete: e.complete !== false,
  };
}

function mailboxesOf(raw: unknown): StorageMailbox[] {
  if (!Array.isArray(raw)) return [];
  const out: StorageMailbox[] = [];
  for (const item of raw) {
    const m = rec(item);
    if (m === null || typeof m.id !== "string" || m.id.length === 0) continue;
    const n = [m.usedBytes, m.letters, m.expectedLetters, m.expectedBytes].map(count);
    if (n.some((v) => v === null)) continue;
    out.push({
      id: m.id, usedBytes: n[0]!, letters: n[1]!, expectedLetters: n[2]!, expectedBytes: n[3]!, importing: m.importing === true,
    });
  }
  return out;
}

/** The offer, field by field: one that cannot be read is no offer, so no price is ever drawn from it. */
export function storageOfferOf(raw: unknown): StorageOffer | null {
  const o = rec(raw);
  if (o === null || typeof o.currency !== "string" || !/^[a-z]{3}$/i.test(o.currency)) return null;
  if (o.interval !== "month" && o.interval !== "year") return null;
  if (!Array.isArray(o.plans) || o.plans.length === 0) return null;
  const plans: StorageOffer["plans"] = [];
  for (const item of o.plans) {
    const p = rec(item);
    if (p === null || !isPlan(p.plan) || !isCount(p.mailboxes) || !isCount(p.roomBytes) || !isCount(p.amount)) return null;
    plans.push({ plan: p.plan, mailboxes: p.mailboxes, roomBytes: p.roomBytes, amount: p.amount });
  }
  let addon: StorageOffer["addon"] = null;
  if (o.addon !== undefined && o.addon !== null) {
    const a = rec(o.addon);
    if (a === null || !isCount(a.unitBytes) || a.unitBytes === 0 || !isCount(a.amount) || !isCount(a.maxUnits)) return null;
    addon = { unitBytes: a.unitBytes, amount: a.amount, maxUnits: a.maxUnits };
  }
  const c = rec(o.current);
  const f = rec(o.fit);
  if (c === null || !isPlan(c.plan) || !isCount(c.addonUnits) || !isCount(c.roomBytes)
    || (c.roomFrom !== "now" && c.roomFrom !== "first_payment")) return null;
  if (f === null || !isPlan(f.plan) || !isCount(f.addonUnits) || !isCount(f.roomBytes) || !isCount(f.amount)
    || typeof f.keepsAll !== "boolean") return null;
  return {
    currency: o.currency.toLowerCase(), interval: o.interval, plans, addon,
    current: { plan: c.plan, addonUnits: c.addonUnits, roomBytes: c.roomBytes, roomFrom: c.roomFrom },
    fit: { plan: f.plan, addonUnits: f.addonUnits, roomBytes: f.roomBytes, amount: f.amount, keepsAll: f.keepsAll },
    canChange: o.canChange === true,
  };
}

/** Narrow `GET /account/access`'s `storage` block; `null` for an older server or a malformed one. */
export function storageFactsOf(raw: unknown): StorageFacts | null {
  const r = rec(raw);
  if (r === null) return null;
  const usedBytes = count(r.usedBytes);
  const limitBytes = count(r.limitBytes);
  const emptiedForSpace = count(r.emptiedForSpace);
  if (usedBytes === null || limitBytes === null || limitBytes <= 0 || emptiedForSpace === null) return null;
  const plan = count(r.planLimitBytes);
  const planLimitBytes = plan !== null && plan > 0 && plan < limitBytes ? plan : null;
  const drops = planLimitBytes !== null && typeof r.limitDropsAt === "string" && Number.isFinite(Date.parse(r.limitDropsAt))
    ? r.limitDropsAt : null;
  return {
    usedBytes, limitBytes, emptiedForSpace,
    firstEmptiedAt: typeof r.firstEmptiedAt === "string" && r.firstEmptiedAt.length > 0 ? r.firstEmptiedAt : null,
    keptFrom: typeof r.keptFrom === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(r.keptFrom) ? r.keptFrom : null,
    withheldOnArrival: Math.min(count(r.withheldOnArrival) ?? 0, emptiedForSpace),
    emptyingNow: typeof r.emptyingNow === "boolean" ? r.emptyingNow : usedBytes >= limitBytes,
    planLimitBytes, limitDropsAt: drops,
    limitReason: r.limitReason === "trial" || r.limitReason === "held" ? r.limitReason : "plan",
    importing: r.importing === true,
    card: r.card === "near" || r.card === "full" || r.card === "drop" ? r.card : null,
    mail: r.mail !== false,
    estimate: estimateOf(r.estimate),
    mailboxes: mailboxesOf(r.mailboxes),
    offer: storageOfferOf(r.offer),
  };
}

/** The share of the cap in use, whole percent, never 100 short of the cap. */
export function storagePercent(facts: Pick<StorageFacts, "usedBytes" | "limitBytes">): number {
  const pct = Math.floor((facts.usedBytes / facts.limitBytes) * 100);
  return facts.usedBytes >= facts.limitBytes ? 100 : Math.min(99, Math.max(0, pct));
}

/**
 * The room as the cap's reason names it, as a catalogue key: "your trial room of 4 GB", "your plan's
 * 2 GB", "the 15 GB you keep until {date}". A held drop with no date reads as the plan's.
 */
export type StorageRoomLine =
  | { key: "storageRoomTrial" | "storageRoomPlan"; values: { limit: string } }
  | { key: "storageRoomHeld"; values: { limit: string; date: string } };

export function storageRoomLine(facts: StorageFacts, locale: string): StorageRoomLine {
  const limit = formatStorageBytes(facts.limitBytes, locale);
  if (facts.limitReason === "trial") return { key: "storageRoomTrial", values: { limit } };
  if (facts.limitReason === "held" && facts.limitDropsAt !== null) {
    return { key: "storageRoomHeld", values: { limit, date: storageDayName(facts.limitDropsAt, locale) } };
  }
  return { key: "storageRoomPlan", values: { limit } };
}

/** Is the offer's fit a change from what the account holds now? An unchanged fit offers nothing. */
export function storageFitIsChange(offer: StorageOffer): boolean {
  return offer.fit.plan !== offer.current.plan || offer.fit.addonUnits !== offer.current.addonUnits;
}

/** The storage the fit adds, or `null` with no add-on units. */
export function storageFitExtraBytes(offer: StorageOffer): number | null {
  return offer.addon !== null && offer.fit.addonUnits > 0 ? offer.fit.addonUnits * offer.addon.unitBytes : null;
}

/** An amount in the offer's minor unit, in the reader's language: "$25", "25,50 €". */
export function formatStoragePrice(amount: number, currency: string, locale: string): string {
  const whole = amount % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency", currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  }).format(amount / 100);
}

/**
 * Where the storage refill stands for the account's mailboxes (the shell's `GET /mailboxes` facts):
 * `runs` with a mailbox ohmail still reads and none of them on its first import; `waits` while one is
 * (the refill waits for it, one in error included); `never` when ohmail reads none of them (the worker
 * never visits a removed mailbox). `null` with no facts yet. The account's import stamp first
 * (`firstImportsOf`); a row with none is no hold.
 */
export type StorageRefill = "runs" | "waits" | "never";

export function storageRefillOf(
  mailboxes: ReadonlyArray<{
    id: string; status: string | null; initialImportCompletedAt?: string | null; hostedImportCompletedAt?: string | null;
  }> | null,
): StorageRefill | null {
  if (mailboxes === null) return null;
  const read = mailboxes.filter((m) => m.status !== "disabled");
  if (read.length === 0) return "never";
  const imports = firstImportsOf(read) ?? {};
  return read.every((m) => imports[m.id] !== null) ? "runs" : "waits";
}

/**
 * "2019-04" as the reader's month name, "April 2019". Mid-month at noon UTC, formatted in UTC, so no
 * zone can move it into a neighbouring month. The month text is kept from, not a mail stamp.
 */
export function storageMonthName(keptFrom: string, locale: string): string {
  const [y, m] = keptFrom.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 15, 12)).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The day the plan's limit applies, in the reader's language and zone: "November 8, 2026". */
export function storageDayName(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Bytes for a sentence, in DECIMAL units — the plan card's convention (`storageBytes` is 2/5/10 × 10⁹ so
 * "2 GB" is the enforced number). One decimal under 10 GB, whole above; sub-GB steps down so a fresh
 * account reads "12 MB of 2 GB", not "0 GB of 2 GB"; `fine` keeps the decimal to 100 GB ("about 12.5 GB",
 * the storage screens' figures). The locale is REQUIRED: a decimal point in a
 * German pane is a thousands separator, and the host's locale is not the reader's choice.
 */
export function formatStorageBytes(bytes: number, locale: string, fine = false): string {
  const n = (v: number, decimals: number): string =>
    v.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
  if (bytes >= 1_000_000_000) {
    const gb = bytes / 1_000_000_000;
    return `${n(gb >= (fine ? 100 : 10) ? Math.round(gb) : Math.round(gb * 10) / 10, 1)} GB`;
  }
  if (bytes >= 1_000_000) return `${n(Math.round(bytes / 1_000_000), 0)} MB`;
  if (bytes >= 1_000) return `${n(Math.round(bytes / 1_000), 0)} KB`;
  return `${n(bytes, 0)} B`;
}

/**
 * THE ESTIMATE THAT TURNS BYTES INTO AN EMAIL COUNT, the plan card's: a round number that rounds
 * against us. Restated here because the webapp cannot import the server's packages;
 * `test/landing-pricing-matches-plan-card.test.ts` compares the two literals.
 */
export const BYTES_PER_STORED_EMAIL_ESTIMATE = 25_000;

/** Bytes → the advertised email count, floored. A number: the catalogue groups it in the reader's language. */
export function estimatedEmails(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_STORED_EMAIL_ESTIMATE);
}
