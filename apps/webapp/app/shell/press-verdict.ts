import {
  FOLDER_OF_VIEW,
  consentPartition,
  presentationReader,
  pressOutcome,
  rulesList,
  senderKey,
  stayVerdict,
  type EngineMutation,
  type EntityReader,
  type Folder,
  type MutationStatus,
  type RuleDTO,
  type StayVerdict,
} from "@ohmail/client-engine";
import { shellConsentOptions, type ShellConsentFacts } from "./consent-options";
import {
  RETRO_VISIBLE_MOVES, senderScreening, type ScreeningDest, type ScreeningScope,
} from "./sender-screening";

/**
 * WHAT A SCREENING PRESS MAY SAY ONCE THE LIST IS READ AGAIN. The pressed
 * rows are placed by the partition the lists are drawn with ({@link shellConsentOptions}) over the
 * mirror after the press, never by their filed folder, and the sentence they earn is the engine's
 * {@link stayVerdict} — the phone reads the same one. `none` leaves the press's own sentence.
 */
export function screeningVerdict(
  reader: EntityReader,
  messageId: string,
  address: string | undefined,
  dest: ScreeningDest,
  scope: ScreeningScope,
  o: { consent: ShellConsentFacts; now: Date; ownAddresses: readonly string[]; retro: boolean },
): StayVerdict {
  return screeningReadBack(reader, messageId, address, dest, scope, o)?.verdict ?? { key: "none" };
}

/** {@link screeningVerdict} with the count of pressed rows the list shows at the place; `null` when the seed is gone. */
export function screeningReadBack(
  reader: EntityReader,
  messageId: string,
  address: string | undefined,
  dest: ScreeningDest,
  scope: ScreeningScope,
  o: { consent: ShellConsentFacts; now: Date; ownAddresses: readonly string[]; retro: boolean },
): { verdict: StayVerdict; at: number } | null {
  const s = senderScreening(reader, messageId, address);
  if (!s) return null;
  const presented = presentationReader(reader, consentPartition(reader, shellConsentOptions(o.consent, o.now, o.ownAddresses)));
  const out = pressOutcome({
    presented, subject: s.scopes[scope].messages, rules: rulesList(reader), wanted: FOLDER_OF_VIEW[dest], retro: o.retro,
  });
  return { verdict: stayVerdict(out, reader), at: out.at };
}

/**
 * WHERE THE BACKLOG PASS IS for the rules a press wrote: `unknown` when a rule is gone or carries
 * no stamp (an older server) — which never reads as done — `applying` while one is asked and not
 * finished, `done` otherwise. A rule nobody asked past mail of is not waited on.
 */
export function retroOf(reader: EntityReader, ruleIds: readonly string[]): "unknown" | "applying" | "done" {
  let applying = false;
  for (const id of ruleIds) {
    const r = reader.get<RuleDTO>("rule", id);
    if (!r || !r.retro) return "unknown";
    if (r.retro.requestedAt !== null && r.retro.doneAt === null) applying = true;
  }
  return applying ? "applying" : "done";
}

/** The ids of the rules a commit wrote — a create's server id, an update's own; `null` when a create's is not known. */
export function writtenRuleIds(
  mutations: readonly EngineMutation[], results: readonly { entityId?: string }[],
): string[] | null {
  const ids: string[] = [];
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i]!;
    if (m.kind === "rule_update") ids.push(m.ruleId);
    else if (m.kind === "rule_create") {
      const id = results[i]?.entityId;
      if (!id) return null;
      ids.push(id);
    }
  }
  return ids;
}

/** The catalogue key a verdict is said in, under `screening`; a domain rule is named as one. */
export function verdictKeyOf(v: Exclude<StayVerdict, { key: "none" }>): string {
  if (v.key === "kept") return v.rule.kind === "domain" ? "verdictKeptDomain" : "verdictKept";
  return VERDICT_KEY[v.key];
}

const VERDICT_KEY = {
  keptMany: "verdictKeptMany", still: "verdictStill", stillLegacy: "verdictStillLegacy", applying: "verdictApplying",
} as const;

/** The one press a verdict's sentence offers. */
export type VerdictAction = { kind: "remove"; ruleId: string } | { kind: "move"; ids: string[] };

/**
 * WHAT THE SENTENCE MAY OFFER TO DO. Remove only a subject rule for the pressed ADDRESS: a rule for
 * the whole domain, or for another address under a domain press, files other people's mail too, so
 * it is named and left to the Rules page. Move them takes every row the sentence counted.
 */
export function verdictAction(
  v: StayVerdict, pressed: { scope: ScreeningScope; address: string },
): VerdictAction | null {
  if (v.key === "kept") {
    const own = pressed.scope === "sender" && v.rule.kind === "sender"
      && senderKey(v.rule.match) === senderKey(pressed.address);
    return own ? { kind: "remove", ruleId: v.rule.id } : null;
  }
  if (v.key === "still" || v.key === "stillLegacy") return { kind: "move", ids: [...v.ids] };
  return null;
}

/**
 * MOVE EVERY ROW, A BATCH AT A TIME. Each move is its own request on the account's write lock and
 * the vocabulary has no bulk move, so the rows go through the one move door in batches of
 * {@link RETRO_VISIBLE_MOVES}, each batch answered before the next is sent — never hundreds at once.
 */
export async function moveInBatches(
  ids: readonly string[], folder: Folder,
  dispatch: (m: EngineMutation) => Promise<{ status: MutationStatus }>,
  size = RETRO_VISIBLE_MOVES,
): Promise<{ moved: number; refused: number; waiting: number }> {
  const tally = { moved: 0, refused: 0, waiting: 0 };
  for (let at = 0; at < ids.length; at += size) {
    const outs = await Promise.all(ids.slice(at, at + size).map((messageId) => dispatch({ kind: "move", messageId, folder })));
    for (const o of outs) {
      if (o.status === "rolled_back") tally.refused++;
      else if (o.status === "awaiting_organizer" || o.status === "queued") tally.waiting++;
      else tally.moved++;
    }
  }
  return tally;
}
