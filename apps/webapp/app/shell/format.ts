/**
 * Display formatting over engine entities. Fixture rows carry the
 * prototype's display time verbatim (`m.time`); rows minted by
 * mutations fall back to a clock/weekday derived from the ISO date.
 */
import {
  clock,
  dateClock,
  folderLeaf,
  isOwnSent,
  fullDateTime as stampFullDateTime,
  messageDisplayTime,
  VIEW_OF_FOLDER,
  weekdayClock,
  zonedFields,
  zonedInstant,
  zonedWeekday,
  type EmailAddress,
  type EngineMessage,
  type TagDTO,
  type WithheldMarker,
} from "@ohmail/client-engine";
import { TAG_HUES, type TagHueName } from "@ohmail/ui";
import { displayAddress } from "./idn";
import { activeFormatLocale, activeFormatZone, liveCopy } from "./locale";

/** An instant's wall clock where the reader is standing — the one call the stamps below share. */
function readerFields(d: Date): ReturnType<typeof zonedFields> {
  return zonedFields(d, activeFormatZone());
}

/**
 * The human name of each client view — the badge on a search hit, the "→ Reads" in a move menu, the
 * toast. Keys are view ids, never folders. It reads the `place` namespace through `liveCopy` rather
 * than a hook because this is a function library: `screener-state.ts` reads it inside a reducer and
 * `AppShell` inside a toast callback, neither of which can call `useTranslations`. The English
 * strings below are the fallback and the parity oracle. Which of the six translate is a product
 * decision: `Ohbox`, `Screener`, `Spam` and `Reads` keep their names in every language (the first
 * two are what the product IS; `Reads` is a real IMAP folder on the reader's own server, and German
 * has no plain noun for it); `Receipts`/`Screened` translate. `test/locale-catalog.test.ts` enforces.
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

/**
 * Which sentence a withheld body gets — the `body.*` catalogue key per marker. `MessageBody.withheld`
 * is the server's closed set (mail 0065 widened it beyond the storage cap), and the selector carries
 * the member through so each member owes its own sentence: the storage cap names the space, the junk
 * filing names the verdict, the expunge says the copies are gone. One resolver for the three
 * rendering surfaces (focused pane, conversation sibling, stream card) — a per-surface copy is three
 * ways for one marker to get two sentences. An absent marker degrades to the storage sentence (the
 * only member that predates the widening); a new member is a type error at this mapping until it
 * gets its own sentence — the parameter is the engine's closed `WithheldMarker`.
 */
export function withheldCopyKey(
  marker: WithheldMarker | null | undefined,
): "withheld" | "withheldJunk" | "withheldExpunged" {
  switch (marker) {
    case "junk_filed":
      return "withheldJunk";
    case "expunged":
      return "withheldExpunged";
    case "storage_cap":
    case null:
    case undefined:
      return "withheld";
    default: {
      // The exhaustiveness proof the doc block promises: a widened set fails to compile here.
      const unreachable: never = marker;
      return unreachable;
    }
  }
}


function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "16:32" — the wall clock an instant shows where the reader is. */
export function clockOf(iso: string): string {
  return clock(new Date(iso), activeFormatZone());
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
 * A meta line, joined — the separator is never printed without a value on both sides. A message with
 * no `Date:` header (spam routinely omits it) carries `date: null` to the client and `displayTime`
 * answers `""` — correctly — so every surface that had committed to the separator rendered a
 * dangling "Ohbox · ": punctuation asserting a second fact that does not exist. The joiner is here,
 * not a guard per call site: hand-written ternaries drift (how `placeLabel`'s fallback shipped
 * `undefined` on screen). The fallback is NOT on the wire: nothing persists INTERNALDATE, and a
 * non-null `MessageDTO.date` would desynchronise the two sort orders (the server sorts by
 * `messages.date`, still NULL). The true repair belongs at ingest and is owed; this stays correct.
 */
export function metaLine(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" · ");
}

/** "Fri 09:00" from an ISO instant (or the raw string when not ISO), read where the reader is. */
export function resurfaceLabel(when: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(when)) return when;
  const d = new Date(when);
  return weekdayClock(d, activeFormatZone(), activeFormatLocale());
}

/**
 * The resurface horizons. The action carries a chosen instant, so the presets are computed here; all
 * four land at 09:00 IN THE READER'S ZONE and `resurfaceLabel` reads them back the same way. They
 * used to mint 09:00 UTC — self-consistent while every stamp was read in UTC, but once display reads
 * the reader's zone, a 09:00Z instant renders as "11:00" in Zurich summer: the wall clock is what
 * is fixed and the instant varies (07:00Z in CEST, 08:00Z in CET). Storage is unchanged —
 * `bubbleUpAt` stays a UTC instant and the worker compares instants. The arithmetic is
 * `zonedInstant`, not an offset: "add two hours" is right for half the year, and the day arithmetic
 * stays in calendar fields (`day + diff`, normalized by `Date.UTC`) — nothing counts 86 400 000 ms.
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

/* ═══ THE SEND-LATER HORIZONS (mail 0077) ══════════════════════════════════════════════════
 *
 * The resurface presets above are reused where the meaning coincides — "tomorrow morning" and
 * "Monday morning" ARE `tomorrowNine`/`nextWeekNine`, the product's one 09:00-where-the-reader-is
 * convention — and this block adds only what sending needs that resurfacing never did: an
 * EVENING preset (nobody resurfaces mail at dinner; plenty of people send it then), and a label
 * that can name a day further out than a week, because an appointment may be months away while
 * a resurface label never had to say more than "Fri 09:00".
 */

/** Today at 18:00 where the reader is — the "this evening" send preset. May be in the past
 *  late in the day; the caller offers it only while it is meaningfully ahead of now. */
export function todayEvening(base: Date): string {
  const zone = activeFormatZone();
  const f = zonedFields(base, zone);
  return zonedInstant({ year: f.year, month: f.month, day: f.day, hour: 18 }, zone).toISOString();
}

/**
 * "Fri 18:00" inside the coming week, "12 Sep, 18:00" beyond it — the appointment, read where
 * the reader is. The week band matches `resurfaceLabel`'s so the two future-time vocabularies
 * agree; past a week a bare weekday is ambiguous (which Friday?), and an appointment is exactly
 * the value that ambiguity would mislead about.
 */
export function scheduleLabel(when: string, now: Date): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(when)) return when;
  const d = new Date(when);
  const zone = activeFormatZone();
  const locale = activeFormatLocale();
  if (d.getTime() - now.getTime() < 6 * 24 * 60 * 60 * 1000) return weekdayClock(d, zone, locale);
  /* THE FAR BAND IS DAY-FIRST, and the sentence above this function has said so all along. It was
     built from a combined `{day, month}` pattern, which ICU orders month-first for `en` — so it
     rendered "Sep 20, 07:05" while the docblock promised "12 Sep, 18:00", and while every dated ROW
     stamp in the same product read "2 Aug". The appointment now speaks the list's order. */
  return dateClock(d, zone, locale);
}

/**
 * An instant as an `<input type="datetime-local">` value — the wall clock it shows WHERE THE
 * READER IS, "YYYY-MM-DDTHH:mm". The input's own value is zoneless by spec; pairing this with
 * {@link instantOfLocalInput} pins both directions of the conversion to `activeFormatZone()`,
 * so the picker, the presets and every label read one clock.
 */
export function localInputValue(iso: string): string {
  const f = readerFields(new Date(iso));
  return `${f.year}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}`;
}

/** The other direction: a picked "YYYY-MM-DDTHH:mm" wall clock, read in the reader's zone, as
 *  the UTC instant it names — or `null` for anything that is not that shape. */
export function instantOfLocalInput(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return zonedInstant({
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]),
  }, activeFormatZone()).toISOString();
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
 * A picked calendar day at the END of that day WHERE THE READER IS — the away responder's chosen
 * last day, as the instant its `endsAt` stores.
 *
 * 23:59:59 rather than the next midnight: the responder's window is inclusive at both ends
 * (`ends_at >= now`), so this is the last instant a reply may go out on the day somebody named.
 * Paired with {@link dayValue}, which reads the same instant back as the same calendar day.
 */
export function dayEnd(day: string): string {
  const zone = activeFormatZone();
  const picked = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  const f = picked
    ? { year: Number(picked[1]), month: Number(picked[2]), day: Number(picked[3]) }
    : zonedFields(new Date(day), zone);
  return zonedInstant(
    { year: f.year, month: f.month, day: f.day, hour: 23, minute: 59, second: 59 }, zone,
  ).toISOString();
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
 * THE SENDER CIRCLE — the same letter and the same colour for one person, in every list, on every device, forever.
 * The requirement: the small circle carrying the sender's or receiver's letter belongs on the mail list too, not only
 * in the Screener. The component already existed — it is what the Screener's rows and the doorbell stack — so the
 * only new thing is the derivation, and the only requirement on the derivation is that it be a pure function of the
 * ADDRESS. Not of the display name, which the same person changes between messages, and not of a random seed, which
 * would repaint the list on every reload. The hues are eight fixed angles, not `hash % 360`: the free wheel produces
 * the candy greens and electric blues the Blanc system rules out, while these sit in the same warm-adjacent band as
 * the tag hues (rosewood 25 · terracotta 42 · ochre 78 · olive 112 · moss 150 · slate 196 · indigo 250 · mauve 318).
 */

/**
 * Lightness and chroma are pinned in `avatar.css` per theme, so legibility is not a property of this table.
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
 * WHO AN OWN-SENT ROW IS ABOUT. A sent message's `from` is the reader's own identity — the one fact on the row that
 * says nothing. The row says who the mail WENT TO instead ("Me → Nora Lindt"), assembled by the caller from this
 * structure. Pure and i18n-free like {@link recipientSummary}, for the same reason: the words ("Me", "+N") are the
 * app's, read from `en.json` where the row renders. `null` twice, and both mean "keep the ordinary sender display":
 * · a row that is not the account's own sent mail;
 * · an own-sent row with no To recipient to name — rows ingested before recipients reached the wire carry an empty
 *   `to`, and "Me →" with nothing after the arrow is the same punctuation-shaped lie the dangling "·" was ({@link
 *   metaLine}).
 */

/**
 * Cc is deliberately not consulted: the label names who the mail was written to, not everyone who was copied — the
 * open view's recipients block is where Cc is said.
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
 * ABSOLUTE date and time, for the hover title on a message's relative stamp — "Tue 5 Aug 2026, 14:32". The visible
 * stamp is {@link displayTime} (relative: "09:12", "Mon"); this is what the reader gets when they want the exact
 * instant, so it carries the year and never abbreviates to a weekday. The reader's zone, like every other formatter
 * in this file (`clockOf`, `resurfaceLabel`, `displayTime`) — this is the value a reader opens precisely to check an
 * exact time against their own clock, so it is the one place a UTC render would be most obviously wrong. Note the
 * DATE moves with it, not only the hour: 22:10 UTC on the 4th is 00:10 on the 5th in Zurich. Empty string for a
 * message with no `Date:` header — there is no instant to name, exactly as `displayTime` answers "" — so a caller
 * interpolating it prints nothing rather than "Invalid Date".
 */
/*
 * `Pick<…, "date">` and not the whole message, because `date` is all it reads. The away-answer
 * mark needs the absolute form of an instant that is NOT the message's arrival — the responder's
 * `awayRepliedAt` — and the alternative was to spread a message with the field swapped in, which
 * costs a copy per render and reads as though some other field mattered. `displayTime` above
 * already takes a `Pick` for the same reason.
 */
export function fullDateTime(m: Pick<EngineMessage, "date">): string {
  if (!m.date) return "";
  const d = new Date(m.date);
  if (Number.isNaN(d.getTime())) return "";
  return stampFullDateTime(d, activeFormatZone(), activeFormatLocale());
}

/**
 * A list row's stamp, both forms and the flip between them — `MessageRow`'s three stamp props in one call, the way
 * {@link avatarOf} is its two circle props: a view spreads this where it used to pass `time={displayTime(m, now)}`,
 * and the rule for which form is on screen, which is on hover, and whether the date may be pressed lives here rather
 * than seven times over. Which form is shown is the caller's `absolute` — one boolean the shell owns for the whole
 * session, so every row (and the open message) flips together and none holds its own state. The title is always the
 * other form, so hovering says something new either way. A message with no `Date:` header gets no flip:
 * `fullDateTime` answers "" (no instant to name), so the row is handed no title and no `onToggleTime` — a date that
 * cannot be exact must not offer to be.
 */

/**
 * This is also the production path that keeps `MessageRow`'s unwired branch honest.
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

/**
 * One recipient, WRITTEN OUT — a chip under the header (viewer redesign). `me` marks the reader's own address so the
 * card can swap the ACCOUNT's identity onto the face; the flag is computed here, on the STORED form, and the name the
 * account goes by is deliberately not — that answer belongs to `GET /mailboxes` and reaches the card through the
 * chrome (`ownNameOf`), not through a pure function every mount shares. `address` is the wire form, untouched: every
 * action a chip offers (copy, write, screening) acts on it, and only the FACE decodes (`displayAddress`, at the
 * render site). Carrying a pre-decoded string here is exactly the leak `idn.ts`'s header forbids.
 */
export interface RecipientRowChip {
  /** True when this recipient IS the reader — fold on the stored, case-folded address. */
  me: boolean;
  /** The display name as the sender wrote it, or null. The card ignores it for `me` chips. */
  name: string | null;
  /** The STORED wire address. Never decoded — the face decodes at render, the value does not. */
  address: string;
}

/**
 * WHO THE MESSAGE WENT TO, in full — the summarised single line and its "+N" fold are retired with the viewer
 * redesign: every To and Cc recipient renders as its own chip, so nothing here caps, counts or folds. Pure and
 * i18n-free like the summary it replaces: the row labels ("To", "Cc") are the card's, from `messages/*.json`. The two
 * rules that survive from the old fold, because they are invariants and not layout:
 * · **Nothing to say → `empty`.** No To and no Cc renders no block at all — never a dangling label with nothing
 *   after it.
 */

/**
 * · **The me-fold compares STORED addresses.** `ownAddresses` is what `GET /mailboxes` answered — A-labels — so a
 *   fold on the decoded string would stop recognising the reader on their own internationalized mailbox. An empty set
 *   recognises the reader nowhere and every address renders in full, which is the honest degradation.
 */
export interface RecipientRows {
  to: RecipientRowChip[];
  cc: RecipientRowChip[];
  /** True only when there is no To and no Cc — the card renders no block. */
  empty: boolean;
}

export function recipientRows(
  m: EngineMessage,
  ownAddresses: readonly string[],
): RecipientRows {
  const to = m.to ?? [];
  const cc = m.cc ?? [];
  if (to.length === 0 && cc.length === 0) return { to: [], cc: [], empty: true };
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()));
  const chip = (r: EmailAddress): RecipientRowChip => ({
    me: own.has(r.address.trim().toLowerCase()),
    name: r.name || null,
    address: r.address,
  });
  return { to: to.map(chip), cc: cc.map(chip), empty: false };
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

/**
 * The waterline's stamp — WHEN the reader last left the stream, as "Mon 18:40" in their
 * locale. The engine stores the instant (`WaterlineMeta.at`), never display strings, so the
 * two streams format it here through one function rather than each composing its own. An
 * unparseable instant yields "" and the caller renders the line with no meta — a line with a
 * wrong time would be a claim, a line without one is just the line.
 */
export function waterlineStamp(atIso: string, locale: string): string {
  const at = new Date(atIso);
  if (Number.isNaN(at.getTime())) return "";
  /* THE READER'S ZONE, WHICH THIS DID NOT HAVE. It asked `Intl` for a combined weekday-and-time
     pattern with no `timeZone` at all, so alone among the product's stamps it read the BROWSER's
     zone — a waterline that could name a different hour from the rows directly beneath it. The
     combined pattern was the second defect: German renders it "Mi., 18:40", with a comma no caller
     chose, while every other "a day this week at a time" in the product reads "Mi 18:40". */
  return weekdayClock(at, activeFormatZone(), locale);
}

/**
 * The one sentence fragment `Intl.RelativeTimeFormat` cannot produce: an age too young for a
 * unit. `liveCopy` rather than a hook because {@link agoStamp} is called from a component's
 * helper functions that take no translator — the same argument `PLACE_LABEL` states above.
 * The English string is the fallback and the parity oracle; the catalogue's `relativeTime`
 * namespace is the live copy, and `test/locale-shim-parity.test.ts` holds the two together.
 */
const AGO_EN = { justNow: "just now" };
export const AGO_COPY: typeof AGO_EN = liveCopy("relativeTime", AGO_EN);

/**
 * How long ago an instant was, in the reader's language — plus the absolute stamp for the tooltip:
 * "2 minutes ago" answers "is it fresh", the title answers "when exactly". It sat in
 * `MailboxSection` with `Intl.RelativeTimeFormat(undefined, …)`, which reads the BROWSER's locale —
 * a German session showed "Synchronisiert 1 minute ago" — and its under-45-seconds arm was
 * hardcoded English. `activeFormatLocale()` is the app's own choice and the young arm goes through
 * the catalogue. An unparseable instant echoes back rather than rendering "Invalid Date": a
 * verbatim token in a sentence is at least debuggable.
 */
export function agoStamp(iso: string, now: number): { rel: string; abs: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { rel: iso, abs: iso };
  const locale = activeFormatLocale();
  const abs = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: activeFormatZone(),
  }).format(d);
  const secs = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (secs < 45) return { rel: AGO_COPY.justNow, abs };
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (secs < 3600) return { rel: rtf.format(-Math.round(secs / 60), "minute"), abs };
  if (secs < 86400) return { rel: rtf.format(-Math.round(secs / 3600), "hour"), abs };
  return { rel: rtf.format(-Math.round(secs / 86400), "day"), abs };
}

/**
 * The day something became true — a date, with no clock on it. "You stopped organizing this here on
 * 3 Sep 2026" is a standing fact somebody reads once; a timestamp makes it an event log and invites
 * watching, the reason the mailbox row carries when an install BECAME the organizer rather than when
 * it was last seen (so not `agoStamp(…).abs`, which is built for a tooltip). It lives here because
 * the desktop's Mailboxes pane and the browser's render the same sentence from the same catalogue
 * key — two copies would be two dates for one fact. An absent or unparseable instant renders an em
 * dash rather than "Invalid Date": a sentence with a dash is still readable.
 */
export function dayStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleDateString(activeFormatLocale(), {
    dateStyle: "medium",
    timeZone: activeFormatZone(),
  });
}
