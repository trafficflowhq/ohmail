import type { AiModel } from "./model.js";

/** A state of the AI pane: its model, and its address in the comparison's registry where the design draws it. */
export interface AiPaneState {
  readonly address: string | null;
  readonly model: AiModel;
}

/** The sentences a state shows, from the catalogue the page reads: a failed read's, and a refused write's. */
export interface AiStateWords {
  readonly unreadable: string;
  readonly refused: string;
}

const still = (state: Omit<AiModel, "toggle">): AiModel => ({ ...state, toggle: () => {} });

/**
 * The pane's states. The design's `sec=ai` is the switch on; the others are the shipped pane's own (no design draws
 * them): the read not answered yet, a read that failed, a refused write that put the switch back, and a self-hosted
 * server with no model. The design's credits, own-key and Draft reply states draw what the shipped pane does not do.
 */
export function aiStates(words: AiStateWords) {
  return {
    on: { address: "screen=settings&sec=ai", model: still({ enabled: true, problem: null, noModel: false }) },
    off: { address: null, model: still({ enabled: false, problem: null, noModel: false }) },
    asking: { address: null, model: still({ enabled: null, problem: null, noModel: false }) },
    unreadable: { address: null, model: still({ enabled: null, problem: words.unreadable, noModel: false }) },
    refused: { address: null, model: still({ enabled: true, problem: words.refused, noModel: false }) },
    noModel: { address: null, model: still({ enabled: true, problem: null, noModel: true }) },
  } as const satisfies Record<string, AiPaneState>;
}
