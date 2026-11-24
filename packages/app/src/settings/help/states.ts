import type { HelpModel } from "./model.js";

/** A state of the Help pane: its model, and its address in the comparison's registry where the design draws it. */
export interface HelpPaneState {
  readonly address: string | null;
  readonly model: HelpModel;
}

const facts: HelpModel["facts"] = {
  version: "2.0.0",
  commit: "localbuild-two",
  os: "linux",
  osVersion: null,
  surface: "web",
  account: null,
  mailboxes: [{ provider: "imap", lastSyncError: null }],
};

/**
 * The pane's states: the design's `sec=help` is a door with a mailbox that sends; the shipped pane's other two ways
 * (a `mailto:` link, and the copy where a link would not leave the app) are its own, with one copy taken.
 */
export const HELP_STATES = {
  compose: {
    address: "screen=settings&sec=help",
    model: { facts, write: { kind: "compose", write: () => {} } },
  },
  mailto: { address: null, model: { facts, write: { kind: "mailto", href: "mailto:?subject=Help" } } },
  copy: { address: null, model: { facts, write: { kind: "copy", copied: null, copy: () => {} } } },
  copied: { address: null, model: { facts, write: { kind: "copy", copied: "address", copy: () => {} } } },
  noBuild: {
    address: null,
    model: { facts: { ...facts, version: null, commit: null }, write: { kind: "compose", write: () => {} } },
  },
} as const satisfies Record<string, HelpPaneState>;
