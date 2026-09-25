/**
 * THE ORDER OVER RULES — one comparator for every door that decides between two rules: the
 * router's `winningRule` and `standingRule` (`rules.ts`) and the client engine's consent index.
 * Two orders were how one sender's rule twins were filed by the server one way and presented by
 * the clients another. Import-free, so a browser, a phone bundle and a Node consumer all load it
 * from source; `listRules` states the same order in SQL and the two must agree literally.
 */

/** Whether a rule lets the sender through the gate or holds them at it. */
export type RuleEffect = "allow" | "deny";

/**
 * What the order reads. The enum-shaped fields are `string`: they reach every caller through an
 * unvalidated cast (`text` columns, a mirror row), and an unknown value ranks LAST, never NaN.
 */
export interface OrderedRule {
  id: string;
  priority: number;
  effect: string;
  kind: string;
  provenance: string;
  subjectContains?: string | null;
  bodyContains?: string | null;
}

/**
 * A destination's side of the gate — the one mapping, for a caller holding a destination and no
 * `effect`. A string outside the three holding folders is no assertion of denial, so it allows:
 * never a new reason for a rule to win a tie. `rules.ts` types it on `Destination`.
 */
export function effectForDestination(destination: string): RuleEffect {
  switch (destination) {
    case "ohmail/Screener":
    case "ohmail/Screened":
    case "ohmail/Quarantine":
      return "deny";
    default:
      return "allow";
  }
}

/** Among rules of one kind, deny outranks allow: the user's "no" never loses a tie. */
const EFFECT_RANK: Readonly<Record<string, number>> = { deny: 0, allow: 1 };
/** Specificity: one mailbox, then a set of them, then a statement about a message. */
const KIND_RANK: Readonly<Record<string, number>> = { sender: 0, domain: 1, header: 2 };
/** What the user typed, then imported, then decided in the Screener, then the onboarding seed. */
const PROVENANCE_RANK: Readonly<Record<string, number>> = {
  manual: 0, migrated: 1, promoted: 2, "seeded-from-sent": 3,
};

/** Unknown ranks last, and an inherited key (`constructor`) is unknown. */
function rank(table: Readonly<Record<string, number>>, value: string): number {
  return Object.prototype.hasOwnProperty.call(table, value) ? table[value]! : Number.MAX_SAFE_INTEGER;
}

/**
 * THE ONE PRIORITY BOUND: a rule's priority is an integer in 0..RULE_PRIORITY_MAX at every door
 * that stores or carries one — `RulesService`, the organizer's request drain (`request-apply.ts`,
 * which holds a pinned copy) and the profile import. A value past it that one door admitted and
 * another refused made the drain drop a whole rule request.
 */
export const RULE_PRIORITY_MAX = 1000;

/** `priority` is `integer NOT NULL`, but a non-finite value would poison the comparator. */
function finitePriority(p: number): number {
  return Number.isFinite(p) ? p : 0;
}

/**
 * The whitespace a term is trimmed of — the six characters the SQL CHECK and `ORDER BY` can
 * express (`[^ \t\n\r\f\v]`), deliberately not what `trim()` strips: a term of one U+00A0 would
 * rank specific in SQL and read absent here. Verified against Postgres in `rules-subject.pg`.
 */
const SUBJECT_TERM_TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

function termOf(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const term = raw.replace(SUBJECT_TERM_TRIM, "").toLowerCase();
  return term.length === 0 ? null : term;
}

/**
 * The rule's subject term, case-folded and trimmed, or `null` — THE one answer to "does this rule
 * carry a subject term?". The router's `matches` and this order both ask it; if they disagreed the
 * narrow rule would win its tie and then decline to fire. `null`, `""` and blank all answer `null`.
 */
export function subjectTermOf(r: Pick<OrderedRule, "subjectContains">): string | null {
  return termOf(r.subjectContains);
}

/** The same question for the body term (mail 0052), with the same trim. */
export function bodyTermOf(r: Pick<OrderedRule, "bodyContains">): string | null {
  return termOf(r.bodyContains);
}

/**
 * Does `subject` satisfy the rule's subject term — THE one term match, asked by the router's
 * `matches` and by the clients' per-message placement (`consent-cutline.ts`). Case-folded
 * substring and nothing cleverer; an absent term is satisfied, `""` satisfies no term.
 */
export function subjectTermSatisfied(r: Pick<OrderedRule, "subjectContains">, subject: string): boolean {
  const term = subjectTermOf(r);
  return term === null || subject.toLowerCase().includes(term);
}

/** The same for the body term; `null`, a text not known to the caller, satisfies no term. */
export function bodyTermSatisfied(r: Pick<OrderedRule, "bodyContains">, text: string | null): boolean {
  const term = bodyTermOf(r);
  return term === null || (text !== null && text.toLowerCase().includes(term));
}

/** A rule carrying the term outranks one without, within one kind: 0 wins. */
const subjectRank = (r: OrderedRule): number => (subjectTermOf(r) === null ? 1 : 0);
const bodyRank = (r: OrderedRule): number => (bodyTermOf(r) === null ? 1 : 0);

/**
 * Ascending = wins. Priority (higher first) → how narrowly the rule names the sender: address over
 * domain over header → deny over allow → with a subject term → with a body term → manual, migrated,
 * promoted, seeded → `id`. The kind before the effect: a person allowed by name is never screened
 * out by a rule on their domain; the effect before the terms: a term never overturns a screen-out.
 * No instant is read: twins that tie on everything fall to the id, compared with `<` (one order).
 */
export function compareRules(a: OrderedRule, b: OrderedRule): number {
  const priority = finitePriority(b.priority) - finitePriority(a.priority);
  if (priority !== 0) return priority;
  const kind = rank(KIND_RANK, a.kind) - rank(KIND_RANK, b.kind);
  if (kind !== 0) return kind;
  const effect = rank(EFFECT_RANK, a.effect) - rank(EFFECT_RANK, b.effect);
  if (effect !== 0) return effect;
  // Below the effect, above `provenance`: a term refines a claim about the same principal, and the
  // pair it exists for is two `manual` rules for one address, where provenance separates nothing.
  const subject = subjectRank(a) - subjectRank(b);
  if (subject !== 0) return subject;
  const body = bodyRank(a) - bodyRank(b);
  if (body !== 0) return body;
  const provenance = rank(PROVENANCE_RANK, a.provenance) - rank(PROVENANCE_RANK, b.provenance);
  if (provenance !== 0) return provenance;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
