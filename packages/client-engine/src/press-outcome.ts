import {
  LEGACY_NEWS_FOLDER, canonicalDestination, isOrganizedFolder, retroPassWouldMove,
} from "@trafficflow/core/destinations";
import { subjectTermOf } from "@trafficflow/core/rule-order";
import { consentIndex, placedRule } from "./consent-cutline.js";
import type { EntityReader } from "./store.js";
import type { EngineMessage, Folder, RuleDTO } from "./types.js";

/** Why a pressed row is not shown at the pressed place after the press. */
export type PressStayCause =
  /** A rule for a subject of this mail, from this address or its domain, files it elsewhere. */
  | "subject"
  /** A rule for everyone at the domain outranks the pressed one. */
  | "domain"
  /** A domain press under a rule for one of its addresses, which outranks it. */
  | "address"
  /** Filed elsewhere and in the server pass's reach: it moves when that pass runs. */
  | "moving"
  /** Filed elsewhere and outside the pass's reach (set aside, or no past mail asked for). */
  | "kept";

export interface PressStay {
  cause: PressStayCause;
  /** Where the list shows these rows, `null` for History. */
  place: Folder | null;
  messageIds: string[];
  /** The rule keeping them there, for the three rule causes. */
  rule: RuleDTO | null;
}

export interface PressOutcome {
  /** Pressed rows the list shows at the pressed place. */
  at: number;
  /** Every other pressed row, grouped by cause, place and rule; empty is the only success. */
  away: PressStay[];
}

/**
 * THE AFTER-PRESS READING: where the LIST shows each pressed row — `presented` is the surface's own
 * projection over the mirror after the press, never the filed folder. A row away from the pressed
 * place is named by the rule the partition places it by ({@link placedRule}), else by the server
 * pass still to move it, else kept. Rows the lists do not show (a user's own folder, Sent) are not
 * the press's. The wait for another organizer is the caller's to say: nothing is read under it.
 */
export function pressOutcome(input: {
  presented: EntityReader;
  subject: readonly EngineMessage[];
  rules: readonly RuleDTO[];
  wanted: Folder;
  retro: boolean;
}): PressOutcome {
  const place = canonicalDestination(input.wanted);
  const index = consentIndex(input.rules);
  const groups = new Map<string, PressStay>();
  let at = 0;
  for (const m of input.subject) {
    if (!isOrganizedFolder(m.physicalFolder ?? m.folder)) continue;
    const shown = input.presented.get<EngineMessage>("message", m.id);
    const where = shown === undefined ? null : canonicalDestination(shown.folder) as Folder;
    if (where !== null && canonicalDestination(where) === place) { at++; continue; }
    const by = placedRule(index, m);
    const ruled = by !== null && canonicalDestination(by.destination) !== place ? by : null;
    const cause: PressStayCause = ruled !== null ? causeOf(ruled)
      : input.retro && retroPassWouldMove(m, input.wanted) ? "moving" : "kept";
    const key = JSON.stringify([cause, where, ruled?.id ?? null]);
    const held = groups.get(key);
    if (held) held.messageIds.push(m.id);
    else groups.set(key, { cause, place: where, messageIds: [m.id], rule: ruled });
  }
  return { at, away: [...groups.values()] };
}

function causeOf(r: RuleDTO): PressStayCause {
  if (subjectTermOf(r) !== null) return "subject";
  return r.kind === "domain" ? "domain" : "address";
}

/**
 * THE ONE SENTENCE AN OUTCOME EARNS, for every surface's copy. `none` when every pressed row is
 * at the place; otherwise the first class that holds: one subject rule of theirs keeping rows
 * elsewhere (`kept`, named), several rules (`keptMany`), rows the pass cannot reach (`still`, or
 * `stillLegacy` when all of them sit in the pre-0.22 News folder), rows it is still moving
 * (`applying`).
 */
export type StayVerdict =
  | { key: "none" }
  | { key: "kept"; count: number; kept: number; keptPlace: Folder; term: string; rule: RuleDTO }
  | { key: "keptMany"; count: number; kept: number }
  /** `folder` is the old folder's own name, the one any other mail app shows for it. */
  | { key: "stillLegacy"; count: number; still: number; ids: string[]; folder: string }
  | { key: "still"; count: number; still: number; stillPlace: string; ids: string[] }
  | { key: "applying"; count: number };

export function stayVerdict(out: PressOutcome, reader: EntityReader): StayVerdict {
  const of = (c: PressStayCause) => out.away.filter((g) => g.cause === c);
  const ruled = [...of("subject"), ...of("domain"), ...of("address")];
  const only = ruled.length === 1 ? ruled[0]! : null;
  if (only?.rule && subjectTermOf(only.rule) !== null) {
    return {
      key: "kept", count: out.at, kept: only.messageIds.length, keptPlace: only.rule.destination,
      term: only.rule.subjectContains!.trim(), rule: only.rule,
    };
  }
  if (ruled.length > 0) return { key: "keptMany", count: out.at, kept: ruled.reduce((n, g) => n + g.messageIds.length, 0) };
  const left = of("kept");
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
