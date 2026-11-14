import type { AboutModel, AboutPublisher } from "./model.js";
import { HOSTED_POLICIES } from "./model.js";

/** A state of the About pane: its model, and its address in the comparison's registry where the design draws it. */
export interface AboutPaneState {
  readonly address: string | null;
  readonly model: AboutModel;
}

/**
 * The pane's states, over the publisher and a refused read's sentence a page hands in (both are the host's). The design's
 * `sec=about` is one mailbox synced on the managed service; the others are the shipped pane's own: reading, a failed
 * read, none, a mailbox never synced, several, a server that does not name its answers, and a self-hosted install
 * with no policies. The design's update and diagnostics states are the desktop's.
 */
export function aboutStates(publisher: AboutPublisher, failedSaid: string) {
  const at = (mailboxes: AboutModel["mailboxes"], more: Partial<AboutModel> = {}): AboutModel => ({
    mailboxes,
    version: "2.0.0",
    build: "local",
    namesAccount: true,
    publisher,
    policies: HOSTED_POLICIES,
    ...more,
  });
  const one = {
    kind: "some",
    first: "mila@example.org",
    others: 0,
    lastSyncAt: "2026-11-16T08:23:00.000Z",
  } as const;
  return {
    synced: { address: "screen=settings&sec=about", model: at(one) },
    reading: { address: null, model: at({ kind: "reading" }) },
    failed: { address: null, model: at({ kind: "failed", said: failedSaid }) },
    none: { address: null, model: at({ kind: "none" }) },
    neverSynced: { address: null, model: at({ ...one, lastSyncAt: null }) },
    several: { address: null, model: at({ ...one, others: 2 }) },
    unnamed: { address: null, model: at(one, { namesAccount: false }) },
    selfHosted: { address: null, model: at(one, { policies: null }) },
  } as const satisfies Record<string, AboutPaneState>;
}
