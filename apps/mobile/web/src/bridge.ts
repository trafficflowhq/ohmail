/**
 * THE SCOPED PAGE'S SIDE OF THE BRIDGE: its closed table of kinds over the page's channel (`channel.ts`), where a
 * request is posted at once, answered once by id, cancelled past its deadline, and dropped when it is of another
 * epoch. This page's kinds cross flat, beside the envelope's own fields.
 */
import type { Kind, NoteWhat, Requests, ShellEvent } from "../../src/shell/bridge-kinds";
import { createChannel, type Envelope, type RequestOptions, type Timers } from "./channel";
import type { PagePort } from "./port";

export { BridgeRefused, DEFAULT_DEADLINE_MS, type RequestOptions } from "./channel";

export interface Bridge {
  readonly epoch: string;
  request<K extends Kind>(kind: K, ask: Requests[K]["ask"], opts?: RequestOptions): Promise<Requests[K]["answer"]>;
  on(handle: (e: ShellEvent) => void): () => void;
  /** What the bridge itself saw go wrong, counted: foreign epochs, unreadable frames. */
  readonly dropped: () => number;
}

const FLAT: Envelope = {
  ask: (ask) => ask,
  answer: ({ id: _id, epoch: _epoch, ok: _ok, ...answer }) => answer,
};

export function createBridge(port: PagePort, epoch: string, timers?: Timers): Bridge {
  const channel = createChannel<ShellEvent>(port, epoch, FLAT, timers);
  return {
    epoch,
    dropped: channel.dropped,
    on: channel.on,
    request: <K extends Kind>(kind: K, ask: Requests[K]["ask"], opts?: RequestOptions) =>
      channel.request(kind, ask, opts) as Promise<Requests[K]["answer"]>,
  };
}

/** A note to native: a member of a closed set and a number, never free text. Not awaited. */
export function note(bridge: Bridge, what: NoteWhat, n = 1): void {
  bridge.request("note", { what, n }).catch(() => {});
}
