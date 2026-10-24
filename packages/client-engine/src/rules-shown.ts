import { canonicalDestination } from "@trafficflow/core/destinations";
import { compareTwins, effectForDestination } from "@trafficflow/core/rule-order";
import { mailboxProfiles } from "./consent-cutline.js";
import type { AppliedRuleRequest } from "./engine.js";
import { PROFILE_APPLIED_MAX } from "./profile-bound.js";
import { oneRowPerKey, ruleKeyOf } from "./rule-twins.js";
import { rulesAsRun } from "./selectors.js";
import type { EntityReader } from "./store.js";
import type { MailboxProfileEntity, RuleDTO } from "./types.js";

/**
 * HOW LONG AN APPLIED PRESS HOLDS ITS KEY over a published copy that does not include it yet. The
 * organizer forgets a request id after 24 h, so past this a copy cannot say it is missing.
 */
export const APPLIED_OVERLAY_MS = 23 * 60 * 60 * 1000;

export interface RulesShown {
  /** `published`: the organizer's copy is the list; `local`: this install's own rows, as before. */
  source: "local" | "published";
  rules: RuleDTO[];
  /** Rows made on the organizer with no row here under their key: no press here can name them. */
  doorless: ReadonlySet<string>;
  /** The organizer's name where every copy names the same one, else `null`. */
  holder: string | null;
}

type Queued = ReadonlyArray<{ ruleId: string; rule: RuleDTO | undefined }>;
type Applied = ReadonlyArray<Pick<AppliedRuleRequest, "requestId" | "mailboxId" | "decidedAt" | "resolvedAt" | "target">>;
type RuleKeyed = Pick<RuleDTO, "kind" | "match" | "subjectContains" | "bodyContains">;

const NONE: ReadonlySet<string> = new Set();

/**
 * THE RULES PAGE'S LIST. An organizing install, or a reader with no copy, lists {@link rulesAsRun}.
 * A reader-only install lists the organizer's published rules: identical entries of all copies
 * collapsed, entries that differ under one key kept as twins. A row takes the id of this install's
 * row under its key, so a press names a local entity; one with none is `held:<key>` and doorless.
 * A key this install pressed, whose press the organizer applied and the copy does not include yet,
 * shows this install's rows (none for a removal) until it does.
 */
export function rulesShown(
  reader: EntityReader, opts: { readerOnly: boolean; queued: Queued; applied: Applied; now: Date },
): RulesShown {
  const local = rulesAsRun(reader, opts.queued);
  const profiles = opts.readerOnly ? mailboxProfiles(reader) : [];
  if (profiles.length === 0) return { source: "local", rules: local, doorless: NONE, holder: null };
  const localByKey = byKey(local);
  const localId = new Map(oneRowPerKey(local).map((r) => [ruleKeyOf(r), r.id]));
  const variants = new Map<string, RuleDTO[]>();
  for (const p of profiles) {
    for (const r of p.rules) {
      const k = ruleKeyOf(r);
      const list = variants.get(k);
      if (!list) variants.set(k, [r]);
      else if (!list.some((v) => sameVariant(v, r))) list.push(r);
    }
  }
  const held = heldKeys(profiles, localByKey, opts);
  const rows: RuleDTO[] = [];
  const doorless = new Set<string>();
  for (const k of held) rows.push(...(localByKey.get(k) ?? []));
  for (const [k, list] of variants) {
    if (held.has(k)) continue;
    [...list].sort(twinOrder).forEach((r, i) => {
      const own = i === 0 ? localId.get(k) : undefined;
      const id = own ?? (i === 0 ? `held:${k}` : `held:${k}#${i}`);
      if (own === undefined) doorless.add(id);
      rows.push({ ...r, id });
    });
  }
  const names = new Set(profiles.map((p) => p.from.name).filter((n): n is string => n !== null));
  return { source: "published", rules: newestFirst(rows), doorless, holder: names.size === 1 ? [...names][0]! : null };
}

/**
 * The keys an applied press of this install still holds: decided inside the horizon, answered by
 * the holder whose copy this is, and (a) not named in the copy's `applied` list under its bound,
 * or (b) with no list (an older organizer), the copy still disagreeing with the row here.
 */
function heldKeys(profiles: readonly MailboxProfileEntity[], localByKey: ReadonlyMap<string, RuleDTO[]>, opts: { applied: Applied; now: Date }): Set<string> {
  const docOf = new Map(profiles.map((p) => [p.mailboxId, p]));
  const horizon = opts.now.getTime() - APPLIED_OVERLAY_MS;
  const out = new Set<string>();
  for (const p of opts.applied) {
    const rule = (p.target as { rule?: RuleKeyed }).rule;
    if (!rule || !(Date.parse(p.decidedAt) > horizon)) continue;
    const k = ruleKeyOf(rule);
    const doc = docOf.get(p.mailboxId);
    if (out.has(k) || !doc) continue;
    const since = doc.from.since === null ? NaN : Date.parse(doc.from.since);
    if (since > Date.parse(p.resolvedAt ?? p.decidedAt)) continue;
    const ids = doc.applied;
    const missing = Array.isArray(ids)
      ? ids.length < PROFILE_APPLIED_MAX && !ids.includes(p.requestId)
      : disagrees(doc.rules.filter((r) => ruleKeyOf(r) === k), localByKey.get(k) ?? []);
    if (missing) out.add(k);
  }
  return out;
}

function disagrees(theirs: readonly RuleDTO[], mine: readonly RuleDTO[]): boolean {
  const a = oneRowPerKey(theirs)[0];
  const b = oneRowPerKey(mine)[0];
  if (a === undefined || b === undefined) return (a === undefined) !== (b === undefined);
  return canonicalDestination(a.destination) !== canonicalDestination(b.destination) || a.enabled !== b.enabled;
}

function sameVariant(a: RuleDTO, b: RuleDTO): boolean {
  return canonicalDestination(a.destination) === canonicalDestination(b.destination)
    && a.enabled === b.enabled && a.priority === b.priority;
}

function byKey(rules: readonly RuleDTO[]): Map<string, RuleDTO[]> {
  const out = new Map<string, RuleDTO[]>();
  for (const r of rules) {
    const k = ruleKeyOf(r);
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

const ordered = (r: RuleDTO) => ({ ...r, effect: effectForDestination(canonicalDestination(r.destination)) });
const twinOrder = (a: RuleDTO, b: RuleDTO): number => compareTwins(ordered(a), ordered(b));

/** {@link rulesAsRun}'s order: newest first, the id breaking ties. */
function newestFirst(rows: RuleDTO[]): RuleDTO[] {
  return rows.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
