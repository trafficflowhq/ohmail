import {
  AWAY_START,
  awayPileChoices,
  type AwayModel,
  type AwayRow,
  type AwayRules,
  type AwayState,
} from "./model.js";

/** A state of the Away pane: its model, and its address in the comparison's registry where the design draws it. */
export interface AwayPaneState {
  readonly address: string | null;
  readonly model: AwayModel;
}

/** The engine's piles, as the states page draws them: the Ohbox, News, Receipts and the Screener. */
export const AWAY_STATE_PILES = [
  { pile: "INBOX", word: "ohbox" },
  { pile: "ohmail/News", word: "reads" },
  { pile: "ohmail/Receipts", word: "receipts" },
  { pile: "ohmail/Screener", word: "screener" },
] as const;

/** The engine's rule over those piles: the Screener only with everyone, the Ohbox by default. */
export const AWAY_STATE_RULES: AwayRules = {
  defaults: ["INBOX"],
  effective: (piles, audience) => piles.filter((p) => p !== "ohmail/Screener" || audience === "everyone"),
};

/**
 * The pane's states over a message and a date a page hands in (the shell formats dates). The design's `sec=away` is
 * the responder at rest, off; `refused` is a save refused; the others are the shipped pane's own: where the replies
 * leave from, a change on its way and its answers, an unsaved edit and a held leave, a passed end date, an unread row.
 */
export function awayStates(world: { readonly body: string; readonly date: string; readonly host: string }) {
  const row: AwayRow = {
    enabled: false,
    body: world.body,
    startsAt: null,
    endsAt: null,
    audience: "screened_in",
    throttle: "per_day",
    piles: ["INBOX"],
  };
  const on: AwayRow = { ...row, enabled: true, endsAt: "2026-11-20T22:59:59.000Z" };
  const at = (state: Partial<AwayState>, more: Partial<AwayModel> = {}): AwayModel => {
    const s: AwayState = { ...AWAY_START, saved: row, draft: row, ...state };
    return {
      state: s,
      piles: s.draft ? awayPileChoices(AWAY_STATE_PILES, s.draft, AWAY_STATE_RULES) : [],
      runsOn: "service",
      endsSaid: { draft: s.draft?.endsAt ? world.date : null, saved: s.saved?.endsAt ? world.date : null },
      savedEnded: false,
      leaving: false,
      edit: () => {},
      pickEnd: () => {},
      save: () => {},
      discard: () => {},
      keep: () => {},
      ...more,
    };
  };
  return {
    rest: { address: "screen=settings&sec=away", model: at({}) },
    refused: {
      address: "screen=settings&sec=away&state=refused",
      model: at({ draft: { ...row, enabled: true }, outcome: { kind: "failed" } }),
    },
    local: { address: "screen=settings&sec=away&state=local", model: at({}, { runsOn: "thisComputer" }) },
    host: { address: "screen=settings&sec=away&state=host", model: at({}, { runsOn: { host: world.host } }) },
    asked: { address: "screen=settings&sec=away&state=asked", model: at({ outcome: { kind: "asked" } }) },
    applied: {
      address: "screen=settings&sec=away&state=applied",
      model: at({ saved: on, draft: on, outcome: { kind: "applied" } }),
    },
    changed: {
      address: "screen=settings&sec=away&state=changed",
      model: at({ outcome: { kind: "changedElsewhere" } }),
    },
    failedon: {
      address: "screen=settings&sec=away&state=failedon",
      model: at({ saved: on, draft: row, outcome: { kind: "failed" } }),
    },
    failedoff: {
      address: "screen=settings&sec=away&state=failedoff",
      model: at({ draft: on, outcome: { kind: "failed" } }),
    },
    unread: {
      address: "screen=settings&sec=away&state=unread",
      model: at({ saved: null, draft: null, unreachable: true }),
    },
    past: {
      address: "screen=settings&sec=away&state=past",
      model: at({ saved: on, draft: on }, { savedEnded: true }),
    },
    unsavedon: {
      address: "screen=settings&sec=away&state=unsavedon",
      model: at({ saved: on, draft: { ...on, body: `${world.body}!` } }),
    },
    unsavedoff: {
      address: "screen=settings&sec=away&state=unsavedoff",
      model: at({ draft: { ...row, enabled: true } }),
    },
    leave: {
      address: "screen=settings&sec=away&state=leave",
      model: at({ draft: { ...row, enabled: true } }, { leaving: true }),
    },
  } as const satisfies Record<string, AwayPaneState>;
}
