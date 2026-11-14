/**
 * Settings › Away responder: the one control in the product that sends mail on its own. A form with a Save, not live
 * controls: the row is a full replace and the message is prose, so nothing is written until Save, and the pane
 * always says which responder is STORED (a press on the switch is an edit, never "on").
 *
 * The rules of the shipped pane are kept here as transitions ({@link awayStep}) so every host keeps them; the shell's
 * hook reads and writes the row, re-reads it while a change travels, holds the leave, and steps the state with each
 * answer. Which piles may be answered is the engine's (`away-scope`), handed in as {@link AwayRules}.
 */

export type AwayAudience = "screened_in" | "everyone";
export type AwayThrottle = "always" | "per_message" | "per_day" | "per_week";

/** The row as it is stored and sent: every field, because a save replaces the whole of it. */
export interface AwayRow {
  readonly enabled: boolean;
  readonly body: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly audience: AwayAudience;
  readonly throttle: AwayThrottle;
  readonly piles: readonly string[];
}

/** Where a change sent to the install that organizes was turned away. */
export interface AwayRefusal {
  readonly holder: string | null;
  readonly refusal: "unreadable" | "other" | null;
}

/** What the last save said. */
export type AwayOutcome =
  | { readonly kind: "saved" }
  /** Not saved here: the install that organizes applies it on its next pass. */
  | { readonly kind: "asked" }
  | { readonly kind: "applied" }
  /** The row moved, and not by this request: it shows what is stored now. */
  | { readonly kind: "changedElsewhere" }
  | { readonly kind: "refused"; readonly by: AwayRefusal }
  /** On with no message. */
  | { readonly kind: "incomplete" }
  /** On with an end date that has passed. */
  | { readonly kind: "expired" }
  /** The write was refused: the edit stays, and the sentence says which responder is stored. */
  | { readonly kind: "failed" };

/** The engine's word on piles: the answerable set, the default, and the effective set for an audience. */
export interface AwayRules {
  readonly defaults: readonly string[];
  effective(piles: readonly string[], audience: AwayAudience): readonly string[];
}

export interface AwayState {
  /** The row as stored here; `null` until it is read. */
  readonly saved: AwayRow | null;
  /** What the person is editing; `null` until the row is read. */
  readonly draft: AwayRow | null;
  /** The row could not be read: nothing is drawn but the sentence. */
  readonly unreachable: boolean;
  /** A save is in flight. */
  readonly pending: boolean;
  readonly outcome: AwayOutcome | null;
  /** What the last travelling save asked for, to tell "applied" from "changed elsewhere". */
  readonly asked: AwayRow | null;
}

export type AwayEvent =
  | { readonly kind: "loaded"; readonly row: AwayRow; readonly refused: AwayRefusal | null }
  | { readonly kind: "unreadable" }
  | { readonly kind: "edit"; readonly patch: Partial<AwayRow> }
  /** Save pressed at `now` (ms): refused here when on with no message or an end date already gone. */
  | { readonly kind: "save"; readonly now: number }
  /** The server answered the save: written here, or `travelled` to the install that organizes. */
  | { readonly kind: "echoed"; readonly row: AwayRow; readonly travelled: boolean }
  | { readonly kind: "refusedWrite" }
  /** A re-read while a change travels found the row moved, or the holder's refusal. */
  | { readonly kind: "heard"; readonly row: AwayRow | null; readonly refused: AwayRefusal | null }
  /** The person chose to leave without saving. */
  | { readonly kind: "discard" };

export const AWAY_START: AwayState = {
  saved: null,
  draft: null,
  unreachable: false,
  pending: false,
  outcome: null,
  asked: null,
};

const instant = (v: string | null): number | null => {
  if (v === null) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};
const asSet = (v: readonly string[]): string => [...new Set(v)].sort().join("\u001f");

/** Two rows ask for the same responder: the same instants, the same scope as a set. */
export function sameRow(a: AwayRow, b: AwayRow): boolean {
  return (
    a.enabled === b.enabled &&
    (a.body ?? null) === (b.body ?? null) &&
    instant(a.startsAt) === instant(b.startsAt) &&
    instant(a.endsAt) === instant(b.endsAt) &&
    a.audience === b.audience &&
    a.throttle === b.throttle &&
    asSet(a.piles) === asSet(b.piles)
  );
}

/** Whether the draft differs from the stored row as it would be sent: an empty message and an inert pile are nothing. */
export function awayUnsaved(draft: AwayRow, saved: AwayRow, rules: AwayRules): boolean {
  const asSent = (d: AwayRow): AwayRow => ({
    ...d,
    body: d.body || null,
    piles: rules.effective(d.piles, d.audience),
  });
  return !sameRow(asSent(saved), asSent(draft));
}

/** One answer or press, applied, as the shipped pane holds them. */
export function awayStep(state: AwayState, event: AwayEvent, rules: AwayRules): AwayState {
  switch (event.kind) {
    case "loaded":
      return {
        ...state,
        saved: event.row,
        draft: event.row,
        unreachable: false,
        outcome: event.refused ? { kind: "refused", by: event.refused } : null,
      };
    case "unreadable":
      return { ...state, saved: null, draft: null, unreachable: true };
    case "edit": {
      if (!state.draft) return state;
      const draft = { ...state.draft, ...event.patch };
      /* Narrowing the audience drops the Screener pile: the pair is refused at the write door. */
      const piles = event.patch.audience ? rules.effective(draft.piles, draft.audience) : draft.piles;
      return { ...state, draft: { ...draft, piles }, outcome: null };
    }
    case "save": {
      const { draft } = state;
      if (state.pending || !draft) return state;
      if (draft.enabled && (draft.body ?? "").trim().length === 0)
        return { ...state, outcome: { kind: "incomplete" } };
      const ends = instant(draft.endsAt);
      if (draft.enabled && ends !== null && ends < event.now)
        return { ...state, outcome: { kind: "expired" } };
      return { ...state, pending: true, outcome: null, asked: draft };
    }
    case "echoed": {
      const editedMeanwhile =
        state.draft !== null && state.asked !== null && awayUnsaved(state.draft, state.asked, rules);
      return {
        ...state,
        saved: event.row,
        draft: editedMeanwhile ? state.draft : event.row,
        pending: false,
        outcome: { kind: event.travelled ? "asked" : "saved" },
      };
    }
    case "refusedWrite":
      return { ...state, pending: false, outcome: { kind: "failed" } };
    case "heard": {
      const edited =
        state.draft !== null && state.saved !== null && awayUnsaved(state.draft, state.saved, rules);
      if (event.refused) {
        return {
          ...state,
          draft: edited ? state.draft : (state.asked ?? state.draft),
          outcome: { kind: "refused", by: event.refused },
        };
      }
      if (!event.row || !state.saved || !state.draft) return state;
      const applied = state.asked !== null && sameRow(event.row, state.asked);
      return {
        ...state,
        saved: event.row,
        draft: edited ? state.draft : event.row,
        outcome: { kind: applied ? "applied" : "changedElsewhere" },
      };
    }
    case "discard":
      return { ...state, draft: state.saved, outcome: null };
  }
}

/** One pile the responder may answer, as the control draws it. */
export interface AwayPileChoice {
  readonly pile: string;
  /** The word the shared `place` vocabulary names it by. */
  readonly word: "ohbox" | "reads" | "receipts" | "screener";
  /** In the effective scope: drawn pressed. */
  readonly on: boolean;
  /** The Ohbox while it is answered: always answered, not a choice. */
  readonly fixed: boolean;
  /** The Screener while the audience is the people let in: only with everyone. */
  readonly audienceLocked: boolean;
}

/**
 * The piles as the control draws them, from the engine's answerable set in its order. Pressed is the EFFECTIVE scope,
 * never the stored array: a stored Screener beside "people I've let in" answers nobody, so it is not drawn pressed.
 */
export function awayPileChoices(
  answerable: readonly { readonly pile: string; readonly word: AwayPileChoice["word"] }[],
  draft: AwayRow,
  rules: AwayRules,
): readonly AwayPileChoice[] {
  const effective = rules.effective(draft.piles, draft.audience);
  return answerable.map(({ pile, word }) => {
    const on = effective.includes(pile);
    return {
      pile,
      word,
      on,
      fixed: word === "ohbox" && on,
      audienceLocked: word === "screener" && draft.audience !== "everyone",
    };
  });
}

/** The scope after one pile is pressed: over the engine's set, in its order, never reordered or invented. */
export function awayPilesAfter(
  choices: readonly AwayPileChoice[],
  pile: string,
  on: boolean,
): readonly string[] {
  return choices.filter((c) => (c.pile === pile ? on : c.on)).map((c) => c.pile);
}

/** Where the replies leave from: the service, this computer while it is open, or another install while it is. */
export type AwayRunsOn = "service" | "thisComputer" | { readonly host: string };

/** What the pane draws: the state, the piles, and the verbs the shell's hook wires. */
export interface AwayModel {
  readonly state: AwayState;
  readonly piles: readonly AwayPileChoice[];
  readonly runsOn: AwayRunsOn;
  /** The end dates as the reader's calendar writes them; the shell formats them. */
  readonly endsSaid: { readonly draft: string | null; readonly saved: string | null };
  /** The stored end date has passed while the stored responder is on. */
  readonly savedEnded: boolean;
  /** A leave is held: the pane asks before the edit is dropped. */
  readonly leaving: boolean;
  edit(patch: Partial<AwayRow>): void;
  /** Opens the shell's date picker at the control that asked. */
  pickEnd(anchor: HTMLElement): void;
  save(): void;
  /** The held leave's two answers. */
  discard(): void;
  keep(): void;
}
