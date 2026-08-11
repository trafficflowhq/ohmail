/**
 * Display formatting over engine entities. Fixture rows carry the
 * prototype's display time verbatim (`m.time`); rows minted by
 * mutations fall back to a clock/weekday derived from the ISO date.
 */
import {
  folderLeaf,
  isOwnSent,
  messageDisplayTime,
  VIEW_OF_FOLDER,
  zonedFields,
  zonedInstant,
  zonedWeekday,
  type EmailAddress,
  type EngineMessage,
  type TagDTO,
} from "@ohmail/client-engine";
import { TAG_HUES, type TagHueName } from "@ohmail/ui";
import { displayAddress } from "./idn";
import { activeFormatLocale, activeFormatZone, liveCopy } from "./locale";

/**
 * THE DAY AND MONTH NAMES, FROM `Intl`, IN THE READER'S LOCALE AND THE READER'S ZONE.
 *
 * These were two hardcoded English arrays, and they are on screen: `resurfaceLabel` renders
 * "Fri 09:00" in a toast and on a Triage row, `fullDateTime` renders "Tue 5 Aug 2026, 14:32" as the
 * hover title of every message stamp. A German reader was getting "Fri" and "Aug".
 *
 * `Intl.DateTimeFormat` replaces the arrays rather than a second pair of German ones, because the
 * abbreviation rules are not ours to invent — German shortens Tuesday to "Di" and September to
 * "Sept." with a full stop, and a hand-written table gets that wrong in a way nobody reviews.
 *
 * ── `timeZone: "UTC"` USED TO STAND HERE, WITH A PARAGRAPH DEFENDING IT ────────────────────────
 *
 * It said the UTC read was "deliberate rather than an oversight", on the grounds that the fixtures
 * and the test surface are stamped in UTC and that localising the words is not localising the
 * clock. The second half is true and the conclusion was wrong, and the product said so: three
 * settings sections (`AboutSection`, `MailboxSection`, `BillingSection`) render account dates
 * through `toLocaleDateString`, which is the reader's zone. So the interface showed TWO clocks at
 * once, and the mail — the half a reader actually navigates by — was the one that was wrong. A
 * message that arrived at 16:32 was stamped "14:32" for a reader in Zurich, and a message that
 * arrived after their midnight was named with the previous day's weekday.
 *
 * A test surface stamped in UTC is an argument for TELLING the formatters which zone to read in,
 * not for pinning them to the server's. That is `activeFormatZone()` in `locale.ts`, beside
 * `activeFormatLocale()`; the tests inject `"UTC"` and keep every expectation they had.
 *
 * Cached per locale AND zone, because constructing a `DateTimeFormat` is the expensive part, these
 * are called once per visible row, and an injected zone has to be visible on the next call.
 */
const DAY_NAMES = new Map<string, Intl.DateTimeFormat>();
const MONTH_NAMES = new Map<string, Intl.DateTimeFormat>();

function namer(cache: Map<string, Intl.DateTimeFormat>, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = activeFormatLocale();
  const zone = activeFormatZone();
  const key = `${locale}|${zone}`;
  const found = cache.get(key);
  if (found) return found;
  const made = new Intl.DateTimeFormat(locale, { ...opts, timeZone: zone });
  cache.set(key, made);
  return made;
}

/** "Fri" / "Fr" — the short weekday of an instant, in the reader's zone and the active locale. */
function weekdayShort(d: Date): string {
  return namer(DAY_NAMES, { weekday: "short" }).format(d);
}

/** "Aug" / "Aug." — the short month of an instant, in the reader's zone and the active locale. */
function monthShort(d: Date): string {
  return namer(MONTH_NAMES, { month: "short" }).format(d);
}

/** An instant's wall clock where the reader is standing — the one call the stamps below share. */
function readerFields(d: Date): ReturnType<typeof zonedFields> {
  return zonedFields(d, activeFormatZone());
}

/**
 * THE HUMAN NAME OF EACH CLIENT VIEW — the badge on a search hit, the "→ Reads" in a move menu, the
 * "Moved to Receipts." in a toast. Keys are view ids, never folders.
 *
 * It was a hardcoded English table and it is one of the most-repeated pieces of copy in the product,
 * so it now reads the `place` namespace. `liveCopy` rather than a hook because this module is a
 * FUNCTION LIBRARY: `screener-state.ts` reads it from inside a reducer and `AppShell` from inside a
 * toast callback, neither of which can call `useTranslations`. See `app/shell/locale.ts`.
 *
 * The English strings below are the fallback and the parity oracle, exactly as the reading pane's
 * tables are.
 *
 * ── WHICH OF THESE SIX ARE TRANSLATED IS A PRODUCT DECISION, NOT A MECHANICAL ONE ──────────────
 *
 * `Ohbox`, `Screener`, `Spam` and `Reads` keep their names in every language. The first two are what
 * this product IS — a coined word and the signature feature — and a reader who is told about "the
 * Screener" in a review, a changelog or a support thread has to find that word in their own
 * interface. `Reads` is here for a different reason and it is the one that changed: German has no
 * plain one-word noun for it (every candidate is either literary or a coinage), and the pile is a
 * REAL FOLDER named `Reads` on the reader's own IMAP server — a German name in the client would not
 * match what they see in every other mail app. `Receipts` → `Belege` and `Screened` → `Aussortiert`
 * translate, because those are ordinary German words for exactly what the piles hold.
 *
 * The catalogue is where each choice lives; `test/locale-catalog.test.ts` is where it is enforced.
 */
const PLACE_EN = {
  ohbox: "Ohbox",
  reads: "Reads",
  receipts: "Receipts",
  screener: "Screener",
  screened: "Screened",
  spam: "Spam",
};

export const PLACE_LABEL: Record<string, string> = liveCopy("place", PLACE_EN);

/**
 * The place badge for a message — the ONE place that turns a folder into
 * something a user reads. Lives here rather than in each view because both
 * copies previously fell back differently: one rendered the raw folder path,
 * the other rendered `undefined`.
 *
 * Neither is acceptable. A server may send a folder this client has no view
 * for (contract §8), so the fallback is the folder's LEAF ("Receipts", "Q1"),
 * which is always readable and never puts a namespaced path on screen.
 */
export function placeLabel(folder: string): string {
  const view = VIEW_OF_FOLDER[folder as keyof typeof VIEW_OF_FOLDER];
  return (view && PLACE_LABEL[view]) || folderLeaf(folder);
}


function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "16:32" — the wall clock an instant shows where the reader is. */
export function clockOf(iso: string): string {
  const f = readerFields(new Date(iso));
  return `${pad(f.hour)}:${pad(f.minute)}`;
}

/**
 * The row stamp. The rule moved into `@ohmail/client-engine` when the Screener started
 * deriving its own rows, and had to mint the same stamp for senders with no
 * fixture behind them; this stays as the app-side name every view already imports, and
 * delegates so the two can never drift apart.
 */
export function displayTime(m: Pick<EngineMessage, "time" | "date">, now: Date): string {
  /* The active locale, so "Mon" reads "Mo" for a German reader, and the active ZONE, so the bands
     ("today", "this week", dated) fall on the reader's midnights. The engine defaults the locale to
     English — it has no catalogue and its own tests assert the English stamps — and defaults the
     zone to nothing at all, on purpose: see `messageDisplayTime`. This is the seam that supplies
     both. */
  return messageDisplayTime(m, now, activeFormatZone(), activeFormatLocale());
}

/**
 * A META LINE, JOINED — and the separator is never printed without a value on both sides.
 *
 * ── "Ohbox ·" ───────────────────────────────────────────────────────────────────────────
 *
 * A message with **no `Date:` header** — which spam and scripts routinely omit, and which nothing in the pipeline
 * substitutes for — carries `date: null` all the way to the client, so
 * {@link displayTime} answers `""` (`packages/client-engine/src/selectors.ts:66-77`, and
 * correctly: there is no instant to format). Every surface then interpolated that empty
 * string into a template that had already committed to the separator:
 *
 *   · `SearchView`  — `` `${placeLabel(m.folder)} · ${displayTime(m, now)}` `` ⇒ **"Ohbox · "**
 *   · `MessagePane` — `messages.threadMeta` was the literal `"thread ({count}) · "` ⇒
 *                     **"thread (3) · "**, a separator introducing nothing
 *   · `Conversation` — an unconditional `<span className="t num">{displayTime(…)}</span>`,
 *                      i.e. an empty stamp element in a row that has a slot for one
 *
 * A dangling "·" is not a cosmetic defect. It is the interface asserting that a second fact
 * follows, and there is no second fact — the same class of untrue statement as the copy this
 * slice's five siblings fix, said in punctuation instead of words.
 *
 * ── WHY THE JOINER IS HERE AND NOT A GUARD AT EACH CALL SITE ────────────────────────────
 *
 * `placeLabel` two functions up is here for the reason its own docstring records: the two
 * copies of that fallback drifted, and one of them shipped `undefined` on screen. Three
 * hand-written `x ? \` · ${x}\` : ""` ternaries would be that shape again, and the fourth
 * surface — the one nobody has written yet — would get the ternary wrong once and reproduce
 * this exact report.
 *
 * ── AND WHY THE FALLBACK IS NOT ON THE WIRE, WHICH WAS THE FIRST THING TRIED ────────────
 *
 * The audit asks for IMAP INTERNALDATE, and that is the right value — but it is not reachable
 * from anywhere a display fix can stand:
 *
 *  1. **Nothing persists it.** The MIME parser writes `parsed.date ?? null`, and INTERNALDATE is
 *     read only for ORDERING, into an in-memory `arrivalKey` cache. The `messages` table has no
 *     column for it, so materialization has nothing to coalesce to but `createdAt` — when the
 *     sync worker wrote the row. The IMAP adapter already records why that is the wrong answer:
 *     an imported mailbox "leaves every message stamped with the import time".
 *  2. **A non-null `MessageDTO.date` would desynchronise two orderings.** The server sorts by
 *     `messages.date`, which is still NULL; the client sorts by the DTO's `date`, and
 *     `byDateDesc` reads a missing one as 0 — oldest. Synthesizing a value client-side of the
 *     sort would place an undated message NEWEST here and OLDEST there, and the sync contract
 *     makes the server's order the order.
 *
 * So the true repair belongs at ingest, where INTERNALDATE is in hand and one write fixes every
 * surface at once; it is owed rather than done. This function is what stops the product lying in
 * the meantime, and it stays correct after that fix lands: a date that is always present simply
 * means no part is ever dropped.
 */
export function metaLine(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" · ");
}

/** "Fri 09:00" from an ISO instant (or the raw string when not ISO), read where the reader is. */
export function resurfaceLabel(when: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(when)) return when;
  const d = new Date(when);
  const f = readerFields(d);
  return `${weekdayShort(d)} ${pad(f.hour)}:${pad(f.minute)}`;
}

/**
 * ═══ THE RESURFACE HORIZONS ═════════════════════════════════════════════════════════════
 *
 * The action carries a chosen instant, so the presets are computed here rather than baked at the
 * one call site `nextFridayNine` used to serve. All four land at 09:00 IN THE READER'S ZONE, and
 * `resurfaceLabel` reads them back the same way whichever preset produced them.
 *
 * ── WHY 09:00 MOVED, WHICH IS THE HALF THAT IS EASY TO MISS ─────────────────────────────────
 *
 * These used to mint 09:00 UTC, and while every stamp in the product was ALSO read in UTC that was
 * self-consistent: the reader picked "tomorrow" and the label said "09:00". The moment the display
 * side reads the reader's zone, a 09:00Z instant renders as "11:00" to a reader in Zurich in
 * summer — the product would offer a morning and deliver a late morning, having been told which
 * one it meant. So the wall clock is what is fixed at 09:00 and the INSTANT is what varies:
 * 07:00Z in CEST, 08:00Z in CET.
 *
 * Storage is unchanged. `bubbleUpAt` is still a UTC instant on the wire and in the mirror, and the
 * worker still compares instants — it never sees a wall clock and does not need to.
 *
 * ── AND WHY THE ARITHMETIC IS `zonedInstant` AND NOT AN OFFSET ──────────────────────────────
 *
 * "Add two hours" is right for half the year. `zonedInstant` asks the platform what the offset
 * actually is at the instant being minted, which is the only version that survives 29 March and
 * 25 October; the day arithmetic below stays in CALENDAR fields (`day + diff`), which `Date.UTC`
 * normalizes across month and year ends, so no branch of it is counting 86 400 000 milliseconds
 * and hoping every day has that many.
 */

/** 09:00 on a calendar day in the reader's zone, as the UTC instant that is. */
function nineOn(zone: string, year: number, month: number, day: number): string {
  return zonedInstant({ year, month, day, hour: 9 }, zone).toISOString();
}

/** How many days forward from `base` the coming `weekday` is — never 0, so today is next week's. */
function daysUntil(base: Date, zone: string, weekday: number): number {
  const diff = (weekday - zonedWeekday(base, zone) + 7) % 7;
  return diff === 0 ? 7 : diff;
}

/** The resurface fallback: the coming Friday, 09:00 where the reader is (keyboard/palette default). */
export function nextFridayNine(base: Date): string {
  const zone = activeFormatZone();
  const f = zonedFields(base, zone);
  return nineOn(zone, f.year, f.month, f.day + daysUntil(base, zone, 5));
}

/** Tomorrow, 09:00 where the reader is. */
export function tomorrowNine(base: Date): string {
  const zone = activeFormatZone();
  const f = zonedFields(base, zone);
  return nineOn(zone, f.year, f.month, f.day + 1);
}

/** The coming Monday, 09:00 — and never "later today": a Monday resolves to the next one. */
export function nextWeekNine(base: Date): string {
  const zone = activeFormatZone();
  const f = zonedFields(base, zone);
  return nineOn(zone, f.year, f.month, f.day + daysUntil(base, zone, 1));
}

/** A picked calendar day ("YYYY-MM-DD" from an `<input type="date">`) at 09:00 where the reader is. */
export function dayNine(day: string): string {
  const zone = activeFormatZone();
  const picked = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  /* The input's own format is the fast path and it is already a CALENDAR day — parsing it through
     `new Date` would read it as UTC midnight and, for a reader far enough east, name the day
     before. Anything else is treated as an instant and asked which of the reader's days it falls
     on; an unparseable one throws here exactly as it used to throw on `toISOString`. */
  const f = picked
    ? { year: Number(picked[1]), month: Number(picked[2]), day: Number(picked[3]) }
    : zonedFields(new Date(day), zone);
  return nineOn(zone, f.year, f.month, f.day);
}

/**
 * The "YYYY-MM-DD" a date input wants, from an ISO instant — used to floor the picker at tomorrow.
 *
 * The READER's calendar day, not the instant's UTC one, and the difference is not cosmetic: 09:00
 * in Auckland is 21:00 the previous day in UTC, so slicing the ISO string would floor the picker a
 * day early and let a reader there choose a horizon that has already passed.
 */
export function dayValue(iso: string): string {
  const f = readerFields(new Date(iso));
  return `${String(f.year).padStart(4, "0")}-${pad(f.month)}-${pad(f.day)}`;
}

/**
 * WHO WROTE IT: their display name, else their address in readable form.
 *
 * The address is passed through {@link displayAddress}, so a sender on an internationalized
 * domain reads as `sarada@götsch.ch` rather than the `xn--…` A-label the mailbox stores. This is
 * the display side of a deliberate split — see `idn.ts`. The identity side of the same message
 * (`avatarHue`, the screening key, every mutation) reads `m.from.address` directly and is
 * untouched, which is why THIS function is safe to decode inside and that field is not.
 */
export function senderName(m: EngineMessage): string {
  return m.from.name || displayAddress(m.from.address);
}

/**
 * THE SENDER CIRCLE — the same letter and the same colour for one person, in
 * every list, on every device, forever.
 *
 * The requirement: the small circle carrying the sender's or receiver's letter belongs on the
 * mail list too, not only in the Screener. The component already existed — it is what the Screener's
 * rows and the doorbell stack — so the only new thing is the derivation, and the only
 * requirement on the derivation is that it be a pure function of the ADDRESS. Not of the
 * display name, which the same person changes between messages, and not of a random seed,
 * which would repaint the list on every reload.
 *
 * The hues are eight fixed angles, not `hash % 360`: the free wheel produces the candy
 * greens and electric blues the Blanc system rules out, while these sit in the same
 * warm-adjacent band as the tag hues (rosewood 25 · terracotta 42 · ochre 78 · olive 112 ·
 * moss 150 · slate 196 · indigo 250 · mauve 318). Lightness and chroma are pinned in
 * `avatar.css` per theme, so legibility is not a property of this table.
 */
const AVATAR_HUES = [25, 42, 78, 112, 150, 196, 250, 318];

export function avatarHue(address: string): number {
  // FNV-1a over the case-folded address. Small, stable, and dependency-free; the value is
  // never persisted, so it may be recomputed anywhere without a migration.
  let h = 0x811c9dc5;
  const key = address.trim().toLowerCase();
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return AVATAR_HUES[h % AVATAR_HUES.length]!;
}

/** The letter in the circle: the display name's first, else the address's. */
export function initialsOf(nameOrAddress: string): string {
  return (nameOrAddress.trim()[0] ?? "?").toUpperCase();
}

/**
 * The address, ONLY when it says something the name did not.
 *
 * `senderName` falls back to the address when a sender has no display name — which is most
 * automated mail — so passing both unconditionally printed it twice in the same line:
 * "verify@atlas-identity.invalid  verify@atlas-identity.invalid", in every row and again in
 * the open message. Caught in the 390px screenshots of the shipped build; the Screener had
 * been guarding against it by hand since it was written.
 */
export function rowAddress(m: EngineMessage): string | undefined {
  return m.from.name ? displayAddress(m.from.address) : undefined;
}

/** The circle for a message row, in one call. */
export function avatarOf(m: EngineMessage): { avatarInitial: string; avatarHue: number } {
  return {
    avatarInitial: initialsOf(senderName(m)),
    avatarHue: avatarHue(m.from.address),
  };
}

/** An own-sent row's addressee: who the mail went to, and how many more it also went to. */
export interface SentRowRecipient {
  /** The first To recipient's display name, else their address READABLY (`idn.ts`). Display only. */
  name: string;
  /**
   * Their address — the stable key the circle's hue derives from, exactly as {@link avatarOf}, and
   * therefore the STORED form, never the decoded one. Two surfaces keying one person off different
   * spellings of their domain would give them two colours.
   */
  address: string;
  /** How many further To recipients there are — the row's "+N". */
  extra: number;
}

/**
 * WHO AN OWN-SENT ROW IS ABOUT.
 *
 * A sent message's `from` is the reader's own identity — the one fact on the row that says
 * nothing. The row says who the mail WENT TO instead ("Me → Nora Lindt"), assembled by the
 * caller from this structure. Pure and i18n-free like {@link recipientSummary}, for the same
 * reason: the words ("Me", "+N") are the app's, read from `en.json` where the row renders.
 *
 * `null` twice, and both mean "keep the ordinary sender display":
 *  · a row that is not the account's own sent mail;
 *  · an own-sent row with no To recipient to name — rows ingested before recipients reached
 *    the wire carry an empty `to`, and "Me →" with nothing after the arrow is the same
 *    punctuation-shaped lie the dangling "·" was ({@link metaLine}).
 *
 * Cc is deliberately not consulted: the label names who the mail was written to, not everyone
 * who was copied — the open view's recipients block is where Cc is said.
 */
export function sentRowRecipient(m: EngineMessage): SentRowRecipient | null {
  if (!isOwnSent(m)) return null;
  const to = m.to ?? [];
  const first = to[0];
  const name = first ? first.name || displayAddress(first.address) : "";
  if (!name) return null;
  return { name, address: first!.address, extra: to.length - 1 };
}

/**
 * The circle for an own-sent row: the RECIPIENT's identity, never the writer's own. The person
 * a sent row is about is the person it went to, so the circle follows the label — same letter
 * and same hue for that person as every row where they are the sender. Hue keys on the address
 * (the one rule, {@link avatarHue}), falling back to the name for a recipient stored without one.
 */
export function sentAvatarOf(r: SentRowRecipient): { avatarInitial: string; avatarHue: number } {
  return { avatarInitial: initialsOf(r.name), avatarHue: avatarHue(r.address || r.name) };
}

export function firstName(m: EngineMessage): string {
  return senderName(m).split(" ")[0] ?? senderName(m);
}

/**
 * ABSOLUTE date and time, for the hover title on a message's relative stamp — "Tue 5 Aug 2026,
 * 14:32". The visible stamp is {@link displayTime} (relative: "09:12", "Mon"); this is what the
 * reader gets when they want the exact instant, so it carries the year and never abbreviates
 * to a weekday.
 *
 * The reader's zone, like every other formatter in this file (`clockOf`, `resurfaceLabel`,
 * `displayTime`) — this is the value a reader opens precisely to check an exact time against
 * their own clock, so it is the one place a UTC render would be most obviously wrong. Note the
 * DATE moves with it, not only the hour: 22:10 UTC on the 4th is 00:10 on the 5th in Zurich.
 * Empty string for a message with no `Date:` header — there is no instant to name, exactly as
 * `displayTime` answers "" — so a caller interpolating it prints nothing rather than
 * "Invalid Date".
 */
export function fullDateTime(m: EngineMessage): string {
  if (!m.date) return "";
  const d = new Date(m.date);
  if (Number.isNaN(d.getTime())) return "";
  const f = readerFields(d);
  return (
    `${weekdayShort(d)} ${f.day} ${monthShort(d)} ` +
    `${f.year}, ${pad(f.hour)}:${pad(f.minute)}`
  );
}

/**
 * ═══ A LIST ROW'S STAMP, BOTH FORMS AND THE FLIP BETWEEN THEM ═══════════════════════════════
 *
 * `MessageRow`'s three stamp props in one call, the way {@link avatarOf} is its two circle props:
 * a view spreads this where it used to pass `time={displayTime(m, now)}`, and the rule for which
 * form is on screen, which is on hover, and whether the date may be pressed at all lives HERE
 * rather than seven times over.
 *
 * WHICH FORM IS SHOWN is the caller's `absolute` — one boolean the shell owns for the whole
 * session, so every row in the list (and the open message with them) flips together and none of
 * them holds a state of its own. The TITLE is always the other one: relative on screen names the
 * exact instant on hover, absolute on screen names the relative one, so hovering says something
 * new either way.
 *
 * ── A MESSAGE WITH NO `Date:` HEADER GETS NO FLIP, AND THAT IS THE POINT ────────────────────
 *
 * Spam and scripts routinely omit the header, and `fullDateTime` answers "" for one because there
 * is no instant to name (the same "" `displayTime` answers). Such a row has ONE form, so it is
 * handed no title and no `onToggleTime` — a date that cannot be exact must not offer to be. This
 * is also the production path that keeps `MessageRow`'s unwired branch honest rather than
 * theoretical.
 */
export interface RowStampProps {
  /** What the row shows — the relative form, or the absolute one once the list is flipped. */
  time: string;
  /** The other form, as the hover title; absent when there is only one. */
  timeTitle?: string;
  /** The flip, passed on only when there are two forms to flip between. */
  onToggleTime?: () => void;
}

export function rowStamp(
  m: EngineMessage,
  now: Date,
  absolute?: boolean,
  onToggle?: () => void,
): RowStampProps {
  const rel = displayTime(m, now);
  const abs = fullDateTime(m);
  if (!abs) return { time: rel };
  return absolute
    ? { time: abs, timeTitle: rel || undefined, onToggleTime: onToggle }
    : { time: rel, timeTitle: abs, onToggleTime: onToggle };
}

/** One recipient, folded: the reader's own address becomes "me", everyone else keeps a name. */
export type RecipientChip = { me: true } | { name: string };

/**
 * WHO ELSE THE MESSAGE WENT TO, summarised for a single line under the sender.
 *
 * Pure and i18n-free on purpose: it returns STRUCTURE, not sentence. The words ("to", "me",
 * "cc", "+N") are the app's, read from `messages/en.json` at the card; folding the reader's own
 * address to a translated "me" here would bake one locale's copy into a function every locale
 * shares. So an own address surfaces as `{ me: true }` and the card swaps in `t("me")`.
 *
 * The rules, in the order they bite:
 *  · **Nothing to say → `empty`.** A message with no To and no Cc renders no recipients line at
 *    all — never a dangling "to" with nothing after it, which is the punctuation-shaped lie
 *    `metaLine` exists to prevent one row up.
 *  · **Own addresses fold to "me", case-folded.** The comparison is `toLowerCase()` on both
 *    sides; `ownAddresses` is whatever `GET /mailboxes` reported (see `AppShell`), and an empty
 *    set means the reader is recognised nowhere — every address renders in full, which is the
 *    honest degradation, not "me" applied to a stranger.
 *  · **At most two To names, then "+N".** `to` holds the first two folded recipients and
 *    `toOverflow` counts the rest, so "to me, Anna Roth +3" is the card's job to assemble.
 *  · **Cc is one name or a count.** A single Cc shows its (possibly folded) name; several show
 *    only how many, because a card is not the place to list eleven addresses — `details` is.
 */
export interface RecipientSummary {
  /** The first two To recipients, folded. */
  to: RecipientChip[];
  /** How many further To recipients there are past the two in `to`. */
  toOverflow: number;
  /** The Cc line: a single folded name, a bare count, or nothing. */
  cc: { name: RecipientChip } | { count: number } | null;
  /** True only when there is no To and no Cc — the card renders no recipients line. */
  empty: boolean;
}

/**
 * The fold compares STORED addresses and returns a DISPLAY name, and the order of those two
 * matters: `ownAddresses` is what `GET /mailboxes` answered, which is A-labels, so a fold done on
 * the decoded string would stop recognising the reader on their own internationalized mailbox and
 * print their address back at them where "me" belongs.
 */
function foldRecipient(r: EmailAddress, own: ReadonlySet<string>): RecipientChip {
  if (own.has(r.address.trim().toLowerCase())) return { me: true };
  return { name: r.name || displayAddress(r.address) };
}

export function recipientSummary(
  m: EngineMessage,
  ownAddresses: readonly string[],
): RecipientSummary {
  const to = m.to ?? [];
  const cc = m.cc ?? [];
  if (to.length === 0 && cc.length === 0) {
    return { to: [], toOverflow: 0, cc: null, empty: true };
  }
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()));
  const foldedTo = to.map((r) => foldRecipient(r, own));
  const ccSummary: RecipientSummary["cc"] =
    cc.length === 0
      ? null
      : cc.length === 1
        ? { name: foldRecipient(cc[0]!, own) }
        : { count: cc.length };
  return {
    to: foldedTo.slice(0, 2),
    toOverflow: Math.max(0, foldedTo.length - 2),
    cc: ccSummary,
    empty: false,
  };
}

/** Tag lookup helpers over the mirror's tag entities. */
export function tagsOfMessage(m: EngineMessage, tags: TagDTO[]): TagDTO[] {
  return tags.filter((t) => m.labels.includes(t.id));
}

/**
 * The renderable hue for a tag, CLAMPED. `tag.hue` is a free `string` on the wire and a row
 * written by an older build (or a future one) can carry a name `chip.css` has no rule for — which
 * would paint an invisible dot. Anything off the canonical list falls back to `moss` so every tag
 * has a visible colour; the picker only ever offers members of the list, so a clamp fires only for
 * legacy or skewed data.
 */
export function hueOf(tag: TagDTO): TagHueName {
  return TAG_HUES.includes(tag.hue as TagHueName) ? (tag.hue as TagHueName) : "moss";
}
