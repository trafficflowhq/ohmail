import type { RuleItem, RulesModel } from "./model.js";

/** A state of the Rules pane: its model, and its address in the comparison's registry where the design draws it. */
export interface RulesPaneState {
  readonly address: string | null;
  readonly model: RulesModel;
}

/**
 * What a page hands the states: the rules as the shell's hook would say them (their sentences are the `rules`
 * catalogue's over the engine's facts), the places' names, and the sentences of the pane's other states.
 */
export interface RulesStateWords {
  readonly rules: readonly RuleItem[];
  readonly intro: string;
  readonly introHeld: string;
  readonly facets: RulesModel["facets"];
  readonly waiting: RulesModel["waiting"];
  readonly refusal: NonNullable<RulesModel["refusal"]>;
  readonly locked: string;
}

/**
 * The pane's states. The design's `sec=rules` is the list at rest; `filter` one place; `none` a search that matches
 * nothing (drawn by the page's search, as `none` holds no rule the filter keeps); the others are the shipped pane's
 * own: waiting on the install that organizes, a refusal, a pane that only reads, a copy the organizer published.
 */
export function rulesStates(words: RulesStateWords) {
  const at = (more: Partial<RulesModel> = {}): RulesModel => ({
    rules: words.rules,
    waiting: [],
    intro: words.intro,
    locked: null,
    refusal: null,
    bound: null,
    facets: words.facets,
    refileFirst: true,
    revoke: () => {},
    retarget: () => {},
    lift: () => {},
    revokeAll: () => {},
    contact: () => {},
    ...more,
  });
  return {
    rest: { address: "screen=settings&sec=rules", model: at() },
    empty: { address: null, model: at({ rules: [] }) },
    waiting: { address: "screen=settings&sec=rules&state=waiting", model: at({ waiting: words.waiting }) },
    refusedOther: {
      address: "screen=settings&sec=rules&state=refused-other",
      model: at({ refusal: words.refusal }),
    },
    held: { address: "screen=settings&sec=rules&state=held", model: at({ locked: words.locked }) },
    published: {
      address: "screen=settings&sec=rules&state=published",
      model: at({ intro: words.introHeld }),
    },
  } as const satisfies Record<string, RulesPaneState>;
}
