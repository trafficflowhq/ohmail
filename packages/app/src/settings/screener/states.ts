import type { ScreenerModel, ScreenerOhbox, ScreenerSuggest } from "./model.js";

/** A state of the Screener pane: its model, and its address in the comparison's registry where the design draws it. */
export interface ScreenerPaneState {
  readonly address: string | null;
  readonly model: ScreenerModel;
}

/**
 * What a state shows that is not the `settings` place's: the Screener's own sentences and the review's door, and the
 * page's invented world (a filed letter, words a person wrote, the install that organizes).
 */
export interface ScreenerStateWords {
  readonly suggest: ScreenerSuggest["said"];
  readonly act: { readonly title: string; readonly description: string; readonly failed: string };
  readonly review: { readonly label: string; readonly body: string; readonly action: string };
  readonly defaultBar: string;
  readonly world: {
    readonly from: string;
    readonly subject: string;
    readonly bar: string;
    readonly holder: string;
  };
}

const kept = () => Promise.resolve();

/**
 * The pane's states over the words a page hands in. The design's `sec=screener` is every control at rest; `edited` has
 * words written over the default; `asked`, `applied` and `nottaken` are where a change went; `unreadable` is a change
 * the holder could not read. The review's states and the design's filed list of Spam are other tasks'.
 */
export function screenerStates(words: ScreenerStateWords) {
  const ohbox = (more: Partial<ScreenerOhbox> = {}): ScreenerOhbox => ({
    relevant: true,
    impersonation: true,
    bar: null,
    defaultBar: words.defaultBar,
    note: null,
    change: () => Promise.resolve(false),
    saveBar: (bar) => Promise.resolve({ bar, travelled: false }),
    ...more,
  });
  const at = (more: Partial<ScreenerModel> = {}): ScreenerModel => ({
    ohbox: ohbox(),
    window: { days: 90, scope: "window", defaultDays: 90, note: null, set: kept },
    suggest: {
      on: false,
      phase: "closed",
      priced: false,
      said: words.suggest,
      open: () => {},
      cancel: () => {},
      set: kept,
    },
    ownSuggest: null,
    act: { on: false, why: "needsSuggest", said: { ...words.act, why: null }, set: kept },
    unsubscribe: { on: true, from: "service", setBlocked: kept },
    filed: {
      letters: [{ id: "m1", from: words.world.from, subject: words.world.subject, to: "spam" }],
      more: false,
      putBack: () => Promise.resolve({ back: 1, requested: 0 }),
    },
    review: { said: words.review, open: () => {} },
    ...more,
  });
  return {
    rest: { address: "screen=settings&sec=screener", model: at() },
    edited: {
      address: "screen=settings&sec=screener&state=edited",
      model: at({ ohbox: ohbox({ bar: words.world.bar }) }),
    },
    asked: {
      address: "screen=settings&sec=screener&state=asked",
      model: at({ ohbox: ohbox({ note: { kind: "asked" } }) }),
    },
    applied: {
      address: "screen=settings&sec=screener&state=applied",
      model: at({ ohbox: ohbox({ note: { kind: "applied" } }) }),
    },
    nottaken: {
      address: "screen=settings&sec=screener&state=nottaken",
      model: at({
        ohbox: ohbox({ note: { kind: "refused", holder: words.world.holder, refusal: "other" } }),
      }),
    },
    unreadable: {
      address: "screen=settings&sec=screener&state=unreadable",
      model: at({
        ohbox: ohbox({ note: { kind: "refused", holder: words.world.holder, refusal: "unreadable" } }),
      }),
    },
    noScreening: { address: null, model: at({ ohbox: null, filed: null }) },
  } as const satisfies Record<string, ScreenerPaneState>;
}
