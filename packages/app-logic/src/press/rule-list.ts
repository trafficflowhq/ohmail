import type { Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { FOLDER_OF_VIEW, zonedFields } from "@ohmail/client-engine";
import { canonicalDestination } from "@trafficflow/core/folder-name";
import { SCREENING_DESTS } from "./sender-screening.js";
import { displayRuleMatch } from "../text/idn.js";
import { activeFormatZone } from "../text/format-words.js";

import type { RuleWords } from "./rule-management.js";

/**
 * The six canonical folders a rule may file into — the same set the server's rule validation
 * enforces, in the order the rail lists them. The facets' order; what Change OFFERS is the
 * sender sheet's five ({@link changePlaces}), so the two lists cannot drift apart.
 */
export const RULE_DESTINATIONS: readonly Folder[] = [
  "INBOX",
  "ohmail/News",
  "ohmail/Receipts",
  "ohmail/Screener",
  "ohmail/Screened",
  "ohmail/Quarantine",
];

/**
 * WHERE A CHANGE MAY SEND A RULE — the sender sheet's five places, in its order, the rule's current
 * one among them and marked. A destination outside the five (the Screener, a folder of the
 * mailbox's own) is listed first, marked, so the row being changed always names where it files.
 */
export function changePlaces(rule: RuleDTO): Array<{ folder: Folder; current: boolean }> {
  const here = canonicalDestination(rule.destination);
  const five = SCREENING_DESTS.map((d) => FOLDER_OF_VIEW[d]);
  const places = five.map((folder) => ({ folder, current: folder === here }));
  return places.some((p) => p.current) ? places : [{ folder: here as Folder, current: true }, ...places];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "4 Aug 2026" — explicit, and deliberately not `toLocaleDateString`.
 *
 * The rest of the client formats dates by hand for the same reason (`selectors.ts`
 * `messageDisplayTime`): a locale-dependent string renders differently under the test
 * runner's ICU than in the browser, so an assertion about it either passes for the wrong
 * reason or is written loosely enough to assert nothing. The YEAR is always present, unlike
 * the message row's stamp — a rule is a standing decision and "2 Aug" on one made last year
 * is the same ambiguity that stamp already fixed for six-day-old mail. The day is the reader's,
 * as on every other stamp.
 */
export function ruleDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const f = zonedFields(d, activeFormatZone());
  return `${f.day} ${MONTHS[f.month - 1]} ${f.year}`;
}

/** A destination and the rules that file into it — the buckets the facet chips are built from. */
export interface RuleGroup {
  destination: Folder;
  rules: RuleDTO[];
}

/**
 * Bucket rules by destination, canonical order first, any non-canonical destination the server
 * sent appended in first-seen order. Only non-empty buckets are returned — a facet chip for a
 * destination with no rules would filter to nothing. Order within a bucket is preserved (newest
 * first, as the caller supplies).
 */
export function groupByDestination(rules: readonly RuleDTO[]): RuleGroup[] {
  const byDest = new Map<Folder, RuleDTO[]>();
  for (const r of rules) {
    const list = byDest.get(r.destination);
    if (list) list.push(r);
    else byDest.set(r.destination, [r]);
  }
  const groups: RuleGroup[] = [];
  for (const d of RULE_DESTINATIONS) {
    const list = byDest.get(d);
    if (list && list.length) {
      groups.push({ destination: d, rules: list });
      byDest.delete(d);
    }
  }
  for (const [destination, list] of byDest) groups.push({ destination, rules: list });
  return groups;
}

/**
 * The rule's SECOND term, trimmed — or `""` when it carries none.
 *
 * One accessor rather than four inline `?? ""`s, because "does this rule have a subject term" is
 * asked by the row, the search, the confirm and the bulk copy, and a reading that drifts between
 * them is a rule the list describes differently depending on which control you touched. The
 * whitespace class is `core/src/rules.ts#SUBJECT_TERM_TRIM`'s, so this file agrees with the router
 * about which values mean "no term".
 */
export function subjectTermOf(rule: RuleDTO): string {
  return (rule.subjectContains ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
}

/** The rule's THIRD term, on `subjectTermOf`'s contract — `""` for none. */
export function bodyTermOf(rule: RuleDTO): string {
  return (rule.bodyContains ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
}

/**
 * The rules a search box and a destination facet leave standing. Search is a case-insensitive
 * substring over `rule.match` — the address or domain a person recognises — AND over the subject
 * term, because a subject rule is the one kind whose defining feature is not its address: somebody
 * hunting for "the NinjaFirewall rule" types the token, and the sender alone is insufficient
 * to type. The origin and destination are still excluded: they are chrome, not what anybody searches
 * for. An empty or whitespace query matches everything, and `"all"` is every destination.
 */
export function filterRules(rules: readonly RuleDTO[], query: string, facet: Folder | "all"): RuleDTO[] {
  const q = query.trim().toLowerCase();
  return rules.filter(
    (r) =>
      (facet === "all" || r.destination === facet) &&
      (q === "" ||
        r.match.toLowerCase().includes(q) ||
        // …and over the form the ROW SHOWS. On an internationalized domain the row reads
        // `müller.example` and the stored match is `xn--mller-kva.example`, so searching only the
        // stored one loses the rule to the very characters the reader can see (`shell/idn.ts`).
        displayRuleMatch(r.match).toLowerCase().includes(q) ||
        subjectTermOf(r).toLowerCase().includes(q) ||
        // The body term, for the subject term's reason: it is what defines the rule.
        bodyTermOf(r).toLowerCase().includes(q)),
  );
}

/**
 * WHO DECIDED EACH RULE, as the list draws it: a person's rules, then the ones the act on
 * suggestions wrote for them (`RuleDTO.byOhmail`), each group in the caller's order. A rule from
 * a server that sends no mark is a person's.
 */
export function splitByDecider(rules: readonly RuleDTO[]): { yours: RuleDTO[]; ohmail: RuleDTO[] } {
  const yours: RuleDTO[] = [];
  const ohmail: RuleDTO[] = [];
  for (const r of rules) (r.byOhmail === true ? ohmail : yours).push(r);
  return { yours, ohmail };
}

export function ruleSentence(rule: RuleDTO, t: RuleWords): string {
  const base = t(`what.${rule.kind}`, { match: displayRuleMatch(rule.match) });
  const term = subjectTermOf(rule);
  const body = bodyTermOf(rule);
  // A rule may carry either term or both; every carried term is spelled out, because
  // an unnamed conjunct is a row indistinguishable from a broader rule — the defect above.
  if (term !== "" && body !== "") {
    return t("whatBoth", { base, term, body });
  }
  if (body !== "") return t("whatBody", { base, body });
  if (term === "") return base;
  return t("whatSubject", { base, term });
}
