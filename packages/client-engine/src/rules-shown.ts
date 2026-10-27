import { canonicalDestination } from "@trafficflow/core/destinations";
import { compareTwins, effectForDestination } from "@trafficflow/core/rule-order";
import { mailboxProfiles } from "./consent-cutline.js";
import type { AppliedRuleRequest, UnsettledRulePress } from "./engine.js";
import { PROFILE_APPLIED_MAX } from "./profile-bound.js";
import { heldRuleId, heldRuleKey, oneRowPerKey, ruleKeyOf } from "./rule-twins.js";
import { rulesAsRun, rulesList } from "./selectors.js";
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
  /** The organizer's name where every copy names the same one, else `null`. */
  holder: string | null;
}

type Queued = ReadonlyArray<{ ruleId: string; rule: RuleDTO | undefined }>;
type Applied = ReadonlyArray<Pick<AppliedRuleRequest, "requestId" | "mailboxId" | "decidedAt" | "resolvedAt" | "target"> & { kind?: string }>;
type RuleKeyed = Pick<RuleDTO, "kind" | "match" | "subjectContains" | "bodyContains">;
type Press = Applied[number];

/**
 * THE RULES PAGE'S LIST. An organizing install, or a reader with no copy, lists {@link rulesAsRun}.
 * A reader-only install lists the organizer's published rules: identical entries of all copies
 * collapsed, entries that differ under one key kept as twins. A row takes the id of this install's
 * row under its key, so a press names a local entity; one with none is `held:<key>`, which a press
 * names by its key ({@link heldRuleId}). A key this install pressed, whose press the organizer
 * applied and the copy does not include yet, shows this install's rows until it does; with no row
 * here, the copy's rows at the place the press asked for, or none for a removal.
 */
export function rulesShown(
  reader: EntityReader, opts: { readerOnly: boolean; queued: Queued; applied: Applied; now: Date },
): RulesShown {
  const local = rulesAsRun(reader, opts.queued);
  const profiles = opts.readerOnly ? mailboxProfiles(reader) : [];
  if (profiles.length === 0) return { source: "local", rules: local, holder: null };
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
  const listed = (k: string, list: readonly RuleDTO[], destination?: string): void => {
    [...list].sort(twinOrder).forEach((r, i) => {
      const own = i === 0 ? localId.get(k) : undefined;
      const id = own ?? (i === 0 ? heldRuleId(r) : `${heldRuleId(r)}#${i}`);
      rows.push({ ...r, id, ...(destination === undefined ? {} : { destination: destination as RuleDTO["destination"] }) });
    });
  };
  for (const [k, p] of held) {
    const mine = localByKey.get(k);
    if (mine) rows.push(...mine);
    else if (p.kind !== "rule.delete") listed(k, variants.get(k) ?? [], (p.target as { destination?: string }).destination);
  }
  for (const [k, list] of variants) if (!held.has(k)) listed(k, list);
  const names = new Set(profiles.map((p) => p.from.name).filter((n): n is string => n !== null));
  return { source: "published", rules: newestFirst(rows), holder: names.size === 1 ? [...names][0]! : null };
}

/**
 * THE RULES A PRESS PLANS OVER. Where a change made here travels to the organizer (`travels`: every
 * mailbox read, its holder live and taking requests) and its copy is the list, the list the Rules
 * page shows, so a ladder reads where the mail is filed, with this install's presses the organizer
 * has not applied yet laid over it (`unsettled`, newest first: a key's rows at the place its
 * newest press asked for, or gone for a removal); otherwise the local rows, as ever.
 */
export function pressRules(
  reader: EntityReader,
  opts: { travels: boolean; queued: Queued; applied: Applied; unsettled: readonly UnsettledRulePress[]; now: Date },
): RuleDTO[] {
  if (!opts.travels) return rulesList(reader);
  const shown = rulesShown(reader, { readerOnly: true, queued: opts.queued, applied: opts.applied, now: opts.now });
  if (shown.source !== "published") return rulesList(reader);
  const newest = new Map<string, UnsettledRulePress>();
  for (const u of opts.unsettled) {
    const k = ruleKeyOf(u.key);
    if (!newest.has(k)) newest.set(k, u);
  }
  if (newest.size === 0) return shown.rules;
  return shown.rules.flatMap((r) => {
    const u = newest.get(ruleKeyOf(r));
    if (u === undefined) return [r];
    if (u.kind === "rule.delete") return [];
    return u.destination === null ? [r] : [{ ...r, destination: u.destination as RuleDTO["destination"] }];
  });
}

/** The id a press names for `rule`: the row of `rows` under its key (a local id, or its key), else its own. */
export function pressRuleId(rule: RuleKeyed & { id: string }, rows: readonly RuleDTO[]): string {
  const k = ruleKeyOf(rule);
  const named = rows.filter((r) => ruleKeyOf(r) === k && !(r.id.startsWith("held:") && heldRuleKey(r.id) === null));
  return oneRowPerKey(named)[0]?.id ?? rule.id;
}

/**
 * The keys an applied press of this install still holds, each with the newest such press: decided
 * inside the horizon, answered by the holder whose copy this is, and (a) not named in the copy's
 * `applied` list under its bound, or (b) with no list (an older organizer), the copy still
 * disagreeing with the row here or, with none here, with what the press asked for. A key with no
 * row here is decided by its newest press alone.
 */
function heldKeys(
  profiles: readonly MailboxProfileEntity[], localByKey: ReadonlyMap<string, RuleDTO[]>, opts: { applied: Applied; now: Date },
): Map<string, Press> {
  const docOf = new Map(profiles.map((p) => [p.mailboxId, p]));
  const horizon = opts.now.getTime() - APPLIED_OVERLAY_MS;
  const out = new Map<string, Press>();
  const seen = new Set<string>();
  const newest = [...opts.applied].sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt));
  for (const p of newest) {
    const rule = (p.target as { rule?: RuleKeyed }).rule;
    if (!rule || !(Date.parse(p.decidedAt) > horizon)) continue;
    const k = ruleKeyOf(rule);
    const doc = docOf.get(p.mailboxId);
    const mine = localByKey.get(k);
    if (out.has(k) || !doc || (mine === undefined && seen.has(k))) continue;
    const since = doc.from.since === null ? NaN : Date.parse(doc.from.since);
    if (since > Date.parse(p.resolvedAt ?? p.decidedAt)) continue;
    seen.add(k);
    const ids = doc.applied;
    const theirs = doc.rules.filter((r) => ruleKeyOf(r) === k);
    const missing = Array.isArray(ids)
      ? ids.length < PROFILE_APPLIED_MAX && !ids.includes(p.requestId)
      : mine !== undefined ? disagrees(theirs, mine) : !asked(theirs, p);
    if (missing) out.set(k, p);
  }
  return out;
}

/** Whether a copy's rows under one key already say what a press asked: gone, or filing at its place. */
function asked(theirs: readonly RuleDTO[], p: Press): boolean {
  const top = oneRowPerKey(theirs)[0];
  if (p.kind === "rule.delete") return top === undefined;
  const to = (p.target as { destination?: string }).destination;
  return top !== undefined && (to === undefined || canonicalDestination(top.destination) === canonicalDestination(to));
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
