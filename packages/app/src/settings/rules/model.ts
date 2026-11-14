/**
 * Settings › Rules, as data. Every Screener decision writes a rule; this lists them as their sentences, filters them
 * by sender or domain and by where they file, and changes or revokes them. A rule's change and revocation go through
 * the engine's verbs, and the RESULT decides what is said: the shell's hook runs the verb, reads its answer and hands
 * the pane what to say (a refusal standing on the pane, a toast for the rest). What the engine and the core decide
 * about a rule (which name it shows, what outranks it, what waits on the install that organizes) arrives here
 * already said.
 */

/** A place a rule can file into, as the change menu offers it. */
export interface RulePlace {
  readonly folder: string;
  /** Its name, as the Screener's piles name it. */
  readonly name: string;
  /** Where the rule files now: marked, and not pressable. */
  readonly current: boolean;
}

/** One rule, as its line draws it. */
export interface RuleItem {
  readonly id: string;
  /** Whose mail it files, as it is written: a sender's address or a domain. */
  readonly who: string;
  /** A sender's circle, which opens their card; `null` for a whole domain or a header. */
  readonly person: { readonly name: string; readonly address: string } | null;
  /** The rule's whole sentence ("Mail from …"), what a confirm repeats. */
  readonly what: string;
  /** Where it files now. */
  readonly folder: string;
  readonly place: string;
  /** Where it came from and when, paused or not: the line under its sentence. */
  readonly origin: string;
  /** It was decided for the person by a confident suggestion: listed under its own heading. */
  readonly byOhmail: boolean;
  /** What else stands about it, each said: what outranks it, a shared provider's domain, its copies, what waits. */
  readonly notes: readonly string[];
  /** Another rule outranks it: the person may let this one decide. */
  readonly outranked: boolean;
  /** A verb of it waits on this browser's queue: nothing else may be pressed on it. */
  readonly queued: boolean;
  /** The places the change menu offers. */
  readonly places: readonly RulePlace[];
  /** What moving its past mail means for this rule, said: the switch's name, its count, and the explanation with it on. */
  readonly refile: { readonly label: string; readonly note: string; readonly on: string };
  /** What the search finds it by, lower case: the match as stored and as shown, and its subject and body terms. */
  readonly finds: string;
}

/** A request waiting on the install that organizes that has no line of its own here. */
export interface RuleWaiting {
  readonly key: string;
  readonly what: string;
  readonly line: string;
}

export interface RulesModel {
  readonly rules: readonly RuleItem[];
  readonly waiting: readonly RuleWaiting[];
  /** Whose rules these are: the person's own, or a copy the install that organizes published. */
  readonly intro: string;
  /** Why nothing here can be pressed now (this install only reads), or `null`. */
  readonly locked: string | null;
  /** The last change refused, standing on the pane: its lead and the reason, when there is one. */
  readonly refusal: { readonly lead: string; readonly why: string | null } | null;
  /** The note where the list is longer than what travels to another install, or `null`. */
  readonly bound: string | null;
  /** The places the filter offers: where at least one rule files, in the Screener's order. */
  readonly facets: readonly { readonly folder: string; readonly name: string }[];
  /** Whether a change starts with moving the past mail too, as the Screener's decisions do. */
  readonly refileFirst: boolean;
  revoke(id: string): void;
  /** Files new matching mail into `folder`; with `refile`, also asks the pass to move the mail it already filed. */
  retarget(id: string, folder: string, refile: boolean): void;
  /** Lets an outranked rule decide again. */
  lift(id: string): void;
  revokeAll(ids: readonly string[]): void;
  /** Opens the sender's card at their circle. */
  contact(address: string, anchor: HTMLElement): void;
}

/** The rules a search and a filter leave, in their order. A filter on a place no rule files into shows all. */
export function rulesShown(
  model: Pick<RulesModel, "rules" | "facets">,
  query: string,
  facet: string,
): readonly RuleItem[] {
  const q = query.trim().toLowerCase();
  const at = facet !== "all" && model.facets.some((f) => f.folder === facet) ? facet : "all";
  return model.rules.filter((r) => (at === "all" || r.folder === at) && (q === "" || r.finds.includes(q)));
}

/** The person's own rules first, then the ones a confident suggestion decided, each kept in order. */
export function rulesByDecider(rules: readonly RuleItem[]): {
  readonly yours: readonly RuleItem[];
  readonly ohmail: readonly RuleItem[];
} {
  return { yours: rules.filter((r) => !r.byOhmail), ohmail: rules.filter((r) => r.byOhmail) };
}

/** What a bulk revoke would take: what is shown, without a rule whose verb already waits. */
export function rulesRevokable(shown: readonly RuleItem[]): readonly RuleItem[] {
  return shown.filter((r) => !r.queued);
}
