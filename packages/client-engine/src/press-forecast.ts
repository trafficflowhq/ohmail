import { canonicalDestination, isOrganizedFolder, retroPassWouldMove } from "@trafficflow/core/destinations";
import { outrankCoveringDomains } from "./address-rank.js";
import {
  consentIndex, consentPartition, domainOfAddress, mailboxProfiles, messagePlacement, outranks, ruleMatchKey,
  ruleTerms,
  type ConsentOptions,
} from "./consent-cutline.js";
import { mutationEffects, type MutationEffect } from "./mutations.js";
import type { ScreenIntent } from "./routing-intents.js";
import { oneRowPerKey, pressOverTwins, ruleTwins, twinWinner } from "./rule-twins.js";
import { rulesList, senderKey } from "./selectors.js";
import type { EntityReader } from "./store.js";
import { FOLDER_OF_VIEW, type EngineMessage, type EngineMutation, type Folder, type RuleDTO } from "./types.js";

/**
 * A READER WITH SOME EFFECTS APPLIED — the optimistic overlay's own rule (last effect per type and
 * id wins, `null` deletes), over nothing but memory. Read-only and never published: the press
 * forecast asks the partition of it and drops it. Stamps are the base's; every cache in the
 * partition path is keyed on the reader object, which this is a new one of.
 */
export function readerWithEffects(base: EntityReader, effects: readonly MutationEffect[]): EntityReader {
  if (effects.length === 0) return base;
  const over = new Map<string, Map<string, unknown | null>>();
  for (const e of effects) {
    let byId = over.get(e.type);
    if (!byId) over.set(e.type, (byId = new Map()));
    byId.set(e.id, e.entity);
  }
  const entriesOf = <T>(type: string): Array<{ id: string; entity: T; seq: number }> => {
    const rows = base.entries<T>(type);
    const byId = over.get(type);
    if (!byId) return rows;
    const out: Array<{ id: string; entity: T; seq: number }> = [];
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.id);
      if (!byId.has(r.id)) { out.push(r); continue; }
      const v = byId.get(r.id);
      if (v !== null) out.push({ id: r.id, entity: v as T, seq: r.seq });
    }
    for (const [id, v] of byId) if (!seen.has(id) && v !== null) out.push({ id, entity: v as T, seq: 0 });
    return out;
  };
  return {
    version: () => base.version(),
    stampOf: (type) => base.stampOf(type),
    stampExcept: (ignore) => base.stampExcept(ignore),
    get<T = unknown>(type: string, id: string): T | undefined {
      const byId = over.get(type);
      if (byId?.has(id)) {
        const v = byId.get(id);
        return v === null ? undefined : (v as T);
      }
      return base.get<T>(type, id);
    },
    list<T = unknown>(type: string): T[] {
      return over.has(type) ? entriesOf<T>(type).map((e) => e.entity) : base.list<T>(type);
    },
    entries: entriesOf,
  };
}

/**
 * WHAT A PERSON'S RULE SAID WHEN THE STEP SHOWED IT — kind, match, the two terms, the place and
 * whether it is on. Never `updatedAt` or the stats: a hit counter moving is not a change to the
 * rule the person answered about.
 */
export function ruleFingerprint(r: RuleDTO): string {
  const t = ruleTerms(r);
  return JSON.stringify([r.kind, ruleMatchKey(r.match), t.subject, t.body, canonicalDestination(r.destination), r.enabled]);
}

/** Why a row the press names would be shown somewhere else, by the rule that keeps it there. */
export type ConflictCause = "term-subject" | "term-body" | "domain-outranks" | "own-rule-inside";

export interface ConflictGroup {
  cause: ConflictCause;
  rule: RuleDTO;
  /** Where the list would show these rows (`null` = History); a body rule's own destination. */
  place: Folder | null;
  /** Message ids, or `null` where the client cannot count them (a body term). */
  rows: string[] | null;
}

/** An address press written at its domain rule's priority, so it outranks that rule for this address only. */
export interface PressException {
  rule: RuleDTO;
  priority: number;
}

export type PressResolution = "remove" | "keep";

export interface PressInput {
  /** The mirror the press dispatches against (`engine.verbRead()`), rows at their filed folder. */
  reader: EntityReader;
  /** The partition options of the surface's own lists — the forecast places rows as the list does. */
  options: ConsentOptions;
  /** Every row of the subject, filed folder, from `reader`. */
  subject: readonly EngineMessage[];
  scope: "sender" | "domain";
  /** The normalized address or domain the rule names. */
  match: string;
  wanted: Folder;
  makeRule: boolean;
  applyRetro: boolean;
  /** A subject still waiting at the gate: the decide replaces the ladder. */
  decide?: Extract<EngineMutation, { kind: "screener_decide" }>;
  now: Date;
}

export interface PressOutcomeForecast {
  /** Rows the list would show at `wanted`. */
  landing: string[];
  /** The rule writes, in dispatch order, as the surface hands them to `engine.mutate`. */
  writes: EngineMutation[];
  /** Rows the press and the server's pass would refile, and where to — the ROUTER's place per row. */
  moves: Array<Extract<EngineMutation, { kind: "move" }>>;
  /** Where the list would show each of the subject's rows (`null` = History). */
  places: ReadonlyMap<string, Folder | null>;
}

export interface PressForecast {
  /** The conflicts the step names, read under "keep"; empty with no exception means no step. */
  groups: ConflictGroup[];
  exception: PressException | null;
  keep: PressOutcomeForecast;
  remove: PressOutcomeForecast;
}

/**
 * THE PRESS, BEFORE IT IS MADE — where the list would show each of the subject's rows afterwards.
 * The writes are the ladder's (`pressOverTwins`, or the decide) plus the resolution's; each is
 * lifted and applied exactly as `engine.mutate` does (`outrankCoveringDomains`, then
 * `mutationEffects`), so this is the optimistic overlay and not a model of it. Rows in reach of the
 * press are refiled where the router would put them, and the rows are placed by the surface's own
 * `consentPartition` and attributed by its `messagePlacement`.
 */
export function pressForecast(input: PressInput): PressForecast {
  const rules = rulesList(input.reader);
  const place = canonicalDestination(input.wanted);
  const base: EngineMutation[] = input.decide
    ? [input.decide]
    : input.makeRule
      ? pressOverTwins(rules, input.scope, input.match, input.wanted, input.applyRetro).writes
      : [];
  const keep = simulate(input, base);
  const groups = conflictsOf(input, keep.after, keep.placeOf);
  const removals = resolutionWrites(groups, input);
  const remove = removals.length === 0
    ? keep
    : simulate(input, input.decide ? [...removals, ...base] : [...base, ...removals]);
  return {
    groups,
    exception: input.scope === "sender" && (input.makeRule || input.decide) ? exceptionFor(rules, input.match, place) : null,
    keep: outcomeOf(keep, input.subject),
    remove: outcomeOf(remove, input.subject),
  };
}

interface Simulated {
  writes: EngineMutation[];
  moves: Array<Extract<EngineMutation, { kind: "move" }>>;
  after: EntityReader;
  placeOf: ReadonlyMap<string, Folder | null>;
  landing: string[];
}

function outcomeOf(s: Simulated, subject: readonly EngineMessage[]): PressOutcomeForecast {
  const places = new Map<string, Folder | null>();
  for (const m of subject) places.set(m.id, s.placeOf.get(m.id) ?? null);
  return { landing: s.landing, writes: s.writes, moves: s.moves, places };
}

function simulate(input: PressInput, writes: readonly EngineMutation[]): Simulated {
  let n = 0;
  const ctx = { now: () => input.now, uuid: () => `forecast:${++n}` };
  let reader = input.reader;
  const sent: EngineMutation[] = [];
  for (const w of writes) {
    const lifted = outrankCoveringDomains(rulesList(reader), w);
    sent.push(w);
    reader = readerWithEffects(reader, mutationEffects(reader, lifted, ctx));
  }
  const ruled = reader;
  // The partition's own index, per mailbox: the router's place on a read mailbox is the organizer's.
  const index = consentIndex(rulesList(ruled), mailboxProfiles(ruled));
  const reach = input.applyRetro || (!input.makeRule && !input.decide);
  const moves: Array<Extract<EngineMutation, { kind: "move" }>> = [];
  const moved: MutationEffect[] = [];
  for (const m of input.subject) {
    const now = ruled.get<EngineMessage>("message", m.id) ?? m;
    if (!reach || !retroPassWouldMove(now, input.wanted)) continue;
    const placed = input.makeRule || input.decide ? messagePlacement(index, now, ruled) : null;
    // The router's place is not knowable without the text: the row stays at its folder, unmoved.
    if (placed?.undecided) continue;
    const to = (placed?.rule?.destination ?? input.wanted) as Folder;
    if (canonicalDestination(to) === canonicalDestination(now.physicalFolder ?? now.folder)) continue;
    moves.push({ kind: "move", messageId: m.id, folder: to });
    moved.push({ type: "message", id: m.id, entity: { ...now, folder: to } });
  }
  const after = readerWithEffects(ruled, moved);
  const placeOf = consentPartition(after, input.options).placeOf;
  const place = canonicalDestination(input.wanted);
  const landing = input.subject
    .filter((m) => isOrganizedFolder(m.physicalFolder ?? m.folder))
    .filter((m) => { const p = placeOf.get(m.id); return p != null && canonicalDestination(p) === place; })
    .map((m) => m.id);
  return { writes: sent, moves, after: ruled, placeOf, landing };
}

/**
 * WHERE THE LIST WOULD SHOW ROWS A NO-RULE PRESS FILES TO `wanted` — the ids at the place after
 * the moves, over ONE partition for however many senders the press covers (the bulk bar's), in
 * the lists' own options. The same answer `pressForecast` gives a single no-rule press.
 */
export function landingOfMoves(
  reader: EntityReader, options: ConsentOptions, rows: readonly EngineMessage[], wanted: Folder,
): string[] {
  const moved: MutationEffect[] = [];
  for (const m of rows) {
    if (retroPassWouldMove(m, wanted)) moved.push({ type: "message", id: m.id, entity: { ...m, folder: wanted } });
  }
  const placeOf = consentPartition(readerWithEffects(reader, moved), options).placeOf;
  const place = canonicalDestination(wanted);
  return rows
    .filter((m) => isOrganizedFolder(m.physicalFolder ?? m.folder))
    .filter((m) => { const p = placeOf.get(m.id); return p != null && canonicalDestination(p) === place; })
    .map((m) => m.id);
}

/** The rules that would keep the subject's rows elsewhere after the press, one group per rule. */
function conflictsOf(
  input: PressInput, after: EntityReader, placeOf: ReadonlyMap<string, Folder | null>,
): ConflictGroup[] {
  const place = canonicalDestination(input.wanted);
  const index = consentIndex(rulesList(after), mailboxProfiles(after));
  const groups = new Map<string, ConflictGroup>();
  const unjudged = new Set<string>();
  for (const m of input.subject) {
    if (!isOrganizedFolder(m.physicalFolder ?? m.folder)) continue;
    const shown = placeOf.get(m.id);
    if (shown != null && canonicalDestination(shown) === place) continue;
    const row = after.get<EngineMessage>("message", m.id) ?? m;
    const placed = messagePlacement(index, row, after);
    // An undecided row is the body rule's, named uncounted below: its text is not held here.
    if (placed.undecided !== null) unjudged.add(placed.undecided.id);
    const by = placed.undecided === null ? placed.rule : null;
    if (by === null || canonicalDestination(by.destination) === place) continue;
    const cause = causeOf(input, by);
    if (cause === null) continue;
    const held = groups.get(by.id);
    if (held) held.rows!.push(m.id);
    else groups.set(by.id, { cause, rule: by, place: shown ?? null, rows: [m.id] });
  }
  // A body rule this client could not judge for every row is named uncounted: rows whose text is
  // not held are decided by it when they are filed, and a number would be a guess.
  for (const r of rulesList(after)) {
    if (!r.enabled || r.kind !== "sender" || ruleTerms(r).body === null) continue;
    if (canonicalDestination(r.destination) === place || groups.has(r.id)) continue;
    const inside = input.scope === "domain"
      ? domainOfAddress(ruleMatchKey(r.match)) === input.match
      : ruleMatchKey(r.match) === input.match;
    if (!inside) continue;
    groups.set(r.id, {
      cause: input.scope === "domain" ? "own-rule-inside" : "term-body", rule: r, place: r.destination, rows: null,
    });
  }
  for (const g of groups.values()) if (unjudged.has(g.rule.id)) g.rows = null;
  return [...groups.values()];
}

function causeOf(input: PressInput, by: RuleDTO): ConflictCause | null {
  if (input.scope === "domain") return by.kind === "sender" ? "own-rule-inside" : null;
  if (by.kind === "domain") return "domain-outranks";
  if (ruleTerms(by).subject !== null) return "term-subject";
  return ruleTerms(by).body !== null ? "term-body" : null;
}

/**
 * What "the press wins" writes over the named rules: a term rule for the subject is removed, and at
 * domain scope an address rule of its own is retargeted (bare) or removed (with a term). A domain
 * rule that outranks an address press is never written here — its other answer is a domain press.
 */
function resolutionWrites(groups: readonly ConflictGroup[], input: PressInput): EngineMutation[] {
  const writable = groups.filter((g) => g.cause !== "domain-outranks");
  const causeOfRule = new Map(writable.map((g) => [g.rule.id, g.cause] as const));
  // One write per key: a PATCH converges the key onto its row and a DELETE takes every row under
  // it, so a write per twin would name a row the first one removed (404).
  const out: EngineMutation[] = [];
  for (const rule of oneRowPerKey(writable.map((g) => g.rule))) {
    const t = ruleTerms(rule);
    if (causeOfRule.get(rule.id) === "own-rule-inside" && t.subject === null && t.body === null) {
      out.push({ kind: "rule_update", ruleId: rule.id, destination: input.wanted, applyRetro: input.applyRetro });
    } else {
      out.push({ kind: "rule_delete", ruleId: rule.id });
    }
  }
  return out;
}

/** The domain rule an address press is lifted over, when one is — the lift the engine will write. */
function exceptionFor(rules: readonly RuleDTO[], match: string, place: string): PressException | null {
  const probe: EngineMutation = { kind: "rule_create", ruleKind: "sender", match, destination: place as Folder };
  const lifted = outrankCoveringDomains(rules, probe);
  if (lifted === probe || lifted.kind !== "rule_create" || lifted.priority === undefined) return null;
  const domain = domainOfAddress(match);
  let top: RuleDTO | null = null;
  for (const r of rules) {
    if (!r.enabled || r.kind !== "domain" || ruleMatchKey(r.match) !== domain) continue;
    if (canonicalDestination(r.destination) === place) continue;
    if (top === null || outranks(r, top)) top = r;
  }
  return top === null ? null : { rule: top, priority: lifted.priority };
}

/** One line of "Their rules": a rule, or identical rules collapsed, and the rows it places now. */
export interface RuleLine {
  rules: RuleDTO[];
  /** Rows the list shows at its place by it; `null` for a body term, which is not counted here. */
  count: number | null;
}

export interface RulesInPlay {
  /** Ranked by the router's order, the winner first. */
  lines: RuleLine[];
  /** At domain scope: the people inside with rules of their own, and the rows those place. */
  inside: { senders: number; count: number } | null;
  /** Whether there is anything to say beyond the Now line and the ✓. */
  worthShowing: boolean;
}

/**
 * EVERY RULE DECIDING THE SUBJECT'S ROWS TODAY — the sheet's "Their rules", placed by the same
 * `messagePlacement` and counted over the same presented places as the list. A body-term rule is
 * counted only where the text of every row it could claim is held; identical rules collapse.
 */
export function rulesInPlay(input: {
  reader: EntityReader;
  /** Where the list shows each row (`consentPartition(...).placeOf`). */
  placeOf: ReadonlyMap<string, Folder | null>;
  subject: readonly EngineMessage[];
  scope: "sender" | "domain";
  match: string;
}): RulesInPlay {
  const local = rulesList(input.reader).filter((r) => r.enabled);
  // A read mailbox's rows are placed by its organizer's rules, and those are the ones named here.
  const reading = new Set(input.subject.map((m) => m.mailboxId));
  const profiles = mailboxProfiles(input.reader);
  const index = consentIndex(local, profiles);
  const rules = [
    ...local,
    ...profiles.filter((p) => reading.has(p.mailboxId)).flatMap((p) => p.rules.filter((r) => r.enabled)),
  ];
  const counts = new Map<string, number>();
  const insideSenders = new Set<string>();
  let insideCount = 0;
  const unjudged = new Set<string>();
  for (const m of input.subject) {
    const placed = messagePlacement(index, m, input.reader);
    if (placed.undecided !== null) unjudged.add(placed.undecided.id);
    const by = placed.undecided === null ? placed.rule : null;
    const shown = input.placeOf.has(m.id) ? input.placeOf.get(m.id)! : m.folder;
    if (by === null || shown === null || canonicalDestination(shown) !== canonicalDestination(by.destination)) continue;
    if (input.scope === "domain" && by.kind === "sender") {
      insideSenders.add(ruleMatchKey(by.match));
      insideCount++;
      continue;
    }
    counts.set(by.id, (counts.get(by.id) ?? 0) + 1);
  }
  // THE RULE THE SUBJECT'S MAIL FOLLOWS is named even while its letters sit where an older rule
  // filed them: it is where their mail goes, and the rows alone would leave it unsaid.
  const own = twinWinner(ruleTwins(local, input.scope, input.match));
  const named = rules.filter((r) => {
    if (counts.has(r.id) || r === own) return true;
    if (r.kind !== "sender" || ruleTerms(r).body === null) return false;
    return input.scope === "sender" ? ruleMatchKey(r.match) === input.match : false;
  });
  named.sort((a, b) => (outranks(a, b) ? -1 : outranks(b, a) ? 1 : 0));
  const lines: RuleLine[] = [];
  const byPrint = new Map<string, RuleLine>();
  for (const r of named) {
    const key = ruleFingerprint(r);
    const body = ruleTerms(r).body !== null;
    const line = byPrint.get(key);
    if (line) {
      line.rules.push(r);
      if (line.count !== null) line.count += counts.get(r.id) ?? 0;
      continue;
    }
    // A body rule is counted only where this client read every row it could claim.
    const fresh: RuleLine = { rules: [r], count: body && unjudged.has(r.id) ? null : counts.get(r.id) ?? 0 };
    byPrint.set(key, fresh);
    lines.push(fresh);
  }
  const inside = input.scope === "domain" && insideSenders.size > 0
    ? { senders: insideSenders.size, count: insideCount }
    : null;
  const only = lines.length === 1 ? lines[0]!.rules[0]! : null;
  const t = only ? ruleTerms(only) : null;
  // A lone rule that does not place every row is worth naming: the mail is split from it.
  const placed = lines.reduce((n, l) => n + (l.count ?? 0), 0);
  const worthShowing = lines.length >= 2 || inside !== null
    || (only !== null && (t!.subject !== null || t!.body !== null || only.kind === "domain" || only.priority > 0
      || placed < input.subject.length));
  return { lines, inside, worthShowing };
}

/**
 * THE ONE COMMIT PLANNER for a v2 sender-sheet press, re-read from the mirror when its window
 * closes: the twin ladder for the subject, and for "remove" a delete of each rule the step SHOWED
 * whose fingerprint is still the one shown. A shown rule that changed or went is left alone and
 * named in `changed`; a rule nobody was shown is never touched (the ladder's twins aside).
 */
export function planScreenCommit(
  reader: EntityReader, intent: ScreenIntent,
): { writes: EngineMutation[]; changed: string[] } {
  const rules = rulesList(reader);
  const wanted = FOLDER_OF_VIEW[intent.dest];
  const match = senderKey(intent.address);
  const writes: EngineMutation[] = intent.makeRule
    ? [...pressOverTwins(rules, "sender", match, wanted, intent.applyRetro).writes]
    : [];
  const changed: string[] = [];
  if (intent.resolution === "remove") {
    const removable: RuleDTO[] = [];
    for (const s of intent.shown) {
      const r = rules.find((x) => x.id === s.id);
      if (!r || ruleFingerprint(r) !== s.fp) { changed.push(s.id); continue; }
      // Only a term rule about this address is the press's to remove; anything else shown stays.
      const t = ruleTerms(r);
      if (r.kind !== "sender" || ruleMatchKey(r.match) !== match || (t.subject === null && t.body === null)) continue;
      removable.push(r);
    }
    // A DELETE takes every row under its key: one per key.
    for (const r of oneRowPerKey(removable)) writes.push({ kind: "rule_delete", ruleId: r.id });
  }
  return { writes, changed };
}
