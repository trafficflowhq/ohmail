import {
  FOLDER_OF_VIEW,
  consentPartition,
  presentationReader,
  pressOutcome,
  rulesList,
  mailboxProfiles,
  senderKey,
  stayVerdict,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type Folder,
  type MutationStatus,
  type RuleDTO,
  type StayVerdict,
  ruleMatchKey,
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

/** {@link screeningVerdict} with the pressed rows the list shows at the place; `null` when the seed is gone. */
export function screeningReadBack(
  reader: EntityReader,
  messageId: string,
  address: string | undefined,
  dest: ScreeningDest,
  scope: ScreeningScope,
  o: { consent: ShellConsentFacts; now: Date; ownAddresses: readonly string[]; retro: boolean },
): { verdict: StayVerdict; at: number; shown: string[] } | null {
  const s = senderScreening(reader, messageId, address);
  if (!s) return null;
  const presented = presentationReader(reader, consentPartition(reader, shellConsentOptions(o.consent, o.now, o.ownAddresses)));
  const out = pressOutcome({
    presented, subject: s.scopes[scope].messages, rules: rulesList(reader), profiles: mailboxProfiles(reader),
    wanted: FOLDER_OF_VIEW[dest], retro: o.retro,
  });
  return { verdict: stayVerdict(out, reader), at: out.at, shown: out.shown };
}

/**
 * THE PRESSED ROWS THE LIST SHOWS AT THE PLACE, read NOW over the lists' own partition — once before
 * a press and again at its answer; {@link pressGained} over the two is the count a sentence states.
 * `consent: null` is the demo, whose lists are the mirror unpartitioned. The subject is the one the
 * press was planned over, so a seed that left the mirror in between still reads.
 */
export function screeningShown(
  reader: EntityReader,
  subject: readonly EngineMessage[],
  dest: ScreeningDest,
  o: { consent: ShellConsentFacts | null; now: Date; ownAddresses: readonly string[] },
): string[] {
  const presented = o.consent === null
    ? reader
    : presentationReader(reader, consentPartition(reader, shellConsentOptions(o.consent, o.now, o.ownAddresses)));
  return pressOutcome({
    presented, subject, rules: rulesList(reader), profiles: mailboxProfiles(reader), wanted: FOLDER_OF_VIEW[dest], retro: false,
  }).shown;
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
  if (v.key === "kept") {
    if (v.rule.kind !== "domain") return "verdictKept";
    return v.field === "body" ? "verdictKeptDomainBody" : "verdictKeptDomain";
  }
  return VERDICT_KEY[v.key];
}

/**
 * THE ARGUMENTS A VERDICT'S SENTENCE TAKES, beside {@link verdictKeyOf}. One place is named as the
 * sheet names it: `null` is History (`history`), a folder by `label`. Several places take no name.
 */
export function verdictArgs(
  v: Exclude<StayVerdict, { key: "none" }>,
  o: { sender: string; place: string; history: string; label: (folder: string) => string; domain: (match: string) => string },
): Record<string, string | number> {
  const base = { sender: o.sender, place: o.place, count: v.count };
  switch (v.key) {
    case "kept": return { ...base, kept: v.kept, keptPlace: o.label(v.keptPlace), term: v.term, domain: o.domain(v.rule.match) };
    case "keptMany": return { ...base, kept: v.kept };
    case "still": return { ...base, still: v.still, stillPlace: v.stillPlace === null ? o.history : o.label(v.stillPlace) };
    case "stillSpread": return { ...base, still: v.still };
    case "undecided": return { ...base, still: v.still, stillPlace: o.label(v.stillPlace), term: v.term };
    case "stillLegacy": return { ...base, still: v.still, folder: v.folder, stillPlace: o.label(v.folder) };
    case "applying": return base;
  }
}

const VERDICT_KEY = {
  keptMany: "verdictKeptMany", still: "verdictStill", stillSpread: "verdictStillSpread", stillLegacy: "verdictStillLegacy", applying: "verdictApplying",
  undecided: "verdictUndecided",
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
      && ruleMatchKey(v.rule.match) === senderKey(pressed.address);
    return own ? { kind: "remove", ruleId: v.rule.id } : null;
  }
  // Never past a message that failed its checks: the sheet offers no move for it either.
  if (v.key === "still" || v.key === "stillSpread" || v.key === "stillLegacy" || v.key === "undecided") {
    return v.movable ? { kind: "move", ids: [...v.ids] } : null;
  }
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
      // A move a newer press for the same message replaced: that press owns the count.
      if (o.status === "superseded") continue;
      if (o.status === "rolled_back") tally.refused++;
      else if (o.status === "awaiting_organizer" || o.status === "queued") tally.waiting++;
      else tally.moved++;
    }
  }
  return tally;
}
