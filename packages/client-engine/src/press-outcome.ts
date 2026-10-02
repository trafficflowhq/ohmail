import {
  LEGACY_NEWS_FOLDER, canonicalDestination, isOrganizedFolder, retroPassWouldMove,
} from "@trafficflow/core/destinations";
import { RESERVED_FOLDER_LEAF, isSentFolderPath } from "@trafficflow/core/folder-name";
import { consentIndex, messagePlacement, ruleTerms } from "./consent-cutline.js";
import type { EntityReader } from "./store.js";
import { folderLeaf, type EngineMessage, type Folder, type MailboxProfileEntity, type RuleDTO } from "./types.js";

/**
 * A FOLDER THE PERSON MADE: outside the folders ohmail organizes, not Sent, and not a server
 * folder by its name (Trash, Junk, Drafts, All Mail — the leaf belt the folder scan uses). Mail
 * another app filed there is a place the screening sheet and the press sentence count, because
 * the rule's pass leaves it there; Trash and Junk are where the person put mail away, never counted.
 */
export function isPersonsOwnFolder(folder: string | null | undefined): boolean {
  if (!folder || isOrganizedFolder(folder) || isSentFolderPath(folder)) return false;
  return !RESERVED_FOLDER_LEAF.test(folderLeaf(folder));
}

/** Why a pressed row is not shown at the pressed place after the press. */
export type PressStayCause =
  /** A rule for a subject of this mail, from this address or its domain, files it elsewhere. */
  | "subject"
  /** A rule for mail mentioning a term files it elsewhere; this client holds the text. */
  | "body"
  /** A rule for mail mentioning a term decides it, and this client does not hold the text. */
  | "undecided"
  /** A rule for everyone at the domain outranks the pressed one. */
  | "domain"
  /** A domain press under a rule for one of its addresses, which outranks it. */
  | "address"
  /** Filed elsewhere and in the server pass's reach: it moves when that pass runs. */
  | "moving"
  /** Filed elsewhere and outside the pass's reach (set aside, or no past mail asked for). */
  | "kept"
  /** In a folder the person made ({@link isPersonsOwnFolder}), which no pass reaches. */
  | "filed";

export interface PressStay {
  cause: PressStayCause;
  /** Where the list shows these rows, `null` for History. */
  place: Folder | null;
  messageIds: string[];
  /** The rule keeping them there, for the rule causes; for `undecided`, the rule that decides. */
  rule: RuleDTO | null;
}

export interface PressOutcome {
  /** Pressed rows the list shows at the pressed place. */
  at: number;
  /** Their ids — read before a press too, for {@link pressGained}. */
  shown: string[];
  /** Every other pressed row, grouped by cause, place and rule; empty is the only success. */
  away: PressStay[];
}

/**
 * THE AFTER-PRESS READING: where the LIST shows each pressed row — `presented` is the surface's own
 * projection over the mirror after the press, never the filed folder. A row away from the pressed
 * place is named by the rule the partition places it by (`messagePlacement`, the bodies read from
 * `presented`), or by the body rule whose text is not held (`undecided`), else by the server pass
 * still to move it, else kept. A row in a folder the person made stays there (`filed`); Sent,
 * Trash and Junk are not the press's. The wait for another organizer is the caller's to say.
 */
export function pressOutcome(input: {
  presented: EntityReader;
  subject: readonly EngineMessage[];
  rules: readonly RuleDTO[];
  /** The mirror's `mailbox_profile` entities (`mailboxProfiles`): a read mailbox is placed by these. */
  profiles: readonly MailboxProfileEntity[];
  wanted: Folder;
  retro: boolean;
}): PressOutcome {
  const place = canonicalDestination(input.wanted);
  const index = consentIndex(input.rules, input.profiles);
  const groups = new Map<string, PressStay>();
  const atPlace: string[] = [];
  const add = (cause: PressStayCause, where: Folder | null, id: string, ruled: RuleDTO | null) => {
    const key = JSON.stringify([cause, where, ruled?.id ?? null]);
    const held = groups.get(key);
    if (held) held.messageIds.push(id);
    else groups.set(key, { cause, place: where, messageIds: [id], rule: ruled });
  };
  for (const m of input.subject) {
    const filed = m.physicalFolder ?? m.folder;
    const own = isPersonsOwnFolder(filed);
    if (!own && !isOrganizedFolder(filed)) continue;
    const shown = input.presented.get<EngineMessage>("message", m.id);
    const where = shown === undefined ? null : canonicalDestination(shown.folder) as Folder;
    if (own) { add("filed", where, m.id, null); continue; }
    if (where !== null && canonicalDestination(where) === place) { atPlace.push(m.id); continue; }
    const placed = messagePlacement(index, m, input.presented);
    const by = placed.undecided === null ? placed.rule : null;
    const ruled = placed.undecided ?? (by !== null && canonicalDestination(by.destination) !== place ? by : null);
    const cause: PressStayCause = placed.undecided !== null ? "undecided" : ruled !== null ? causeOf(ruled)
      : input.retro && retroPassWouldMove(m, input.wanted) ? "moving" : "kept";
    add(cause, where, m.id, ruled);
  }
  return { at: atPlace.length, shown: atPlace, away: [...groups.values()] };
}

/**
 * THE COUNT A PRESS SENTENCE STATES: pressed rows the list shows at the place after the press that
 * it did not show there before — moved there, or already filed there and now presented there.
 * Never the server's moves: a sender with one letter moved and one re-presented gained two.
 * `before` is {@link PressOutcome.shown} over the same lists, read before anything was dispatched.
 */
export function pressGained(before: readonly string[], after: readonly string[]): number {
  const was = new Set(before);
  return after.filter((id) => !was.has(id)).length;
}

function causeOf(r: RuleDTO): PressStayCause {
  if (ruleTerms(r).subject !== null) return "subject";
  if (ruleTerms(r).body !== null) return "body";
  return r.kind === "domain" ? "domain" : "address";
}

/**
 * THE ONE SENTENCE AN OUTCOME EARNS, for every surface's copy. `none` when every pressed row is
 * at the place; otherwise the first class that holds: one subject rule of theirs keeping rows
 * elsewhere (`kept`, named), several rules (`keptMany`), rows the pass cannot reach or a folder
 * the person made holds (`still`, or `stillLegacy` when all sit in the pre-0.22 News folder), rows
 * it is still moving (`applying`).
 */
export type StayVerdict =
  | { key: "none" }
  /** `field` names which term the rule reads, so each surface says which one. */
  | { key: "kept"; count: number; kept: number; keptPlace: Folder; term: string; field: "subject" | "body"; rule: RuleDTO }
  | { key: "keptMany"; count: number; kept: number }
  /** `folder` is the old folder's own name, the one any other mail app shows for it. */
  | { key: "stillLegacy"; count: number; still: number; ids: string[]; folder: string }
  | { key: "still"; count: number; still: number; stillPlace: string; ids: string[] }
  /** Rows a rule for mail mentioning `term` decides, whose text this client does not hold. */
  | { key: "undecided"; count: number; still: number; stillPlace: string; ids: string[]; term: string; rule: RuleDTO }
  | { key: "applying"; count: number };

export function stayVerdict(out: PressOutcome, reader: EntityReader): StayVerdict {
  const of = (c: PressStayCause) => out.away.filter((g) => g.cause === c);
  const ruled = [...of("subject"), ...of("body"), ...of("domain"), ...of("address")];
  const only = ruled.length === 1 ? ruled[0]! : null;
  const t = only?.rule ? ruleTerms(only.rule) : null;
  if (only?.rule && t !== null && (t.subject !== null || t.body !== null)) {
    const field = t.subject !== null ? "subject" as const : "body" as const;
    return {
      key: "kept", count: out.at, kept: only.messageIds.length, keptPlace: only.rule.destination,
      term: (field === "subject" ? only.rule.subjectContains : only.rule.bodyContains)!.trim(), field, rule: only.rule,
    };
  }
  if (ruled.length > 0) return { key: "keptMany", count: out.at, kept: ruled.reduce((n, g) => n + g.messageIds.length, 0) };
  /* THE TEXT IS NOT HELD, SO NOTHING IS CLAIMED ABOUT WHERE IT GOES: the rows sit at the wire's
     folder, the rule that decides them is named, and Move them stays on offer as for `still`. */
  const unread = of("undecided");
  if (unread.length > 0) {
    const ids = unread.flatMap((g) => g.messageIds);
    const widest = [...unread].sort((a, b) => b.messageIds.length - a.messageIds.length)[0]!;
    const filed = reader.get<EngineMessage>("message", widest.messageIds[0]!);
    return {
      key: "undecided", count: out.at, still: ids.length, ids, rule: widest.rule!,
      stillPlace: widest.place ?? (filed === undefined ? "" : filed.physicalFolder ?? filed.folder),
      term: (widest.rule!.bodyContains ?? "").trim(),
    };
  }
  // A folder the person made is left as `still`, after the pass: while rows are still moving the
  // sentence is `applying`, and the read at the pass's end names what stayed.
  const left = [...of("kept"), ...(of("moving").length > 0 ? [] : of("filed"))];
  if (left.length > 0) {
    const ids = left.flatMap((g) => g.messageIds);
    const filed = (id: string) => {
      const m = reader.get<EngineMessage>("message", id);
      return m === undefined ? "" : m.physicalFolder ?? m.folder;
    };
    if (ids.every((id) => filed(id) === LEGACY_NEWS_FOLDER)) return { key: "stillLegacy", count: out.at, still: ids.length, ids, folder: LEGACY_NEWS_FOLDER };
    const widest = [...left].sort((a, b) => b.messageIds.length - a.messageIds.length)[0]!;
    return { key: "still", count: out.at, still: ids.length, stillPlace: widest.place ?? filed(widest.messageIds[0]!), ids };
  }
  return of("moving").length > 0 ? { key: "applying", count: out.at } : { key: "none" };
}
