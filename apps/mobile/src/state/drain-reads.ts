/**
 * THE SESSION'S PER-DRAIN READS, one closure, renderer-free so a test drives the shipped cadence.
 * The flag machine calls it at boot and after every drain. The REST reads (mailboxes, the queue
 * shelf, the relayed decisions, the consent answer) go every time; the ENGINE's queue page and
 * undecided-sender offer are asked once per session here — the web's once-per-mount shape — and
 * after that by the engine's own settle when a drain touched the gate, a rule, the settings or a
 * mailbox. Asked on every drain they re-derived every list several times per poll.
 */

export interface EngineQueues {
  refreshScreenerWaiting(): Promise<void>;
  refreshUnscreened(): Promise<void>;
}

/** Ask the engine for its queue page and its offer; a refusal waits for the next ask. */
export function askEngineQueues(engine: EngineQueues): void {
  void engine.refreshScreenerWaiting().catch(() => { /* the settle or the next focus asks again */ });
  void engine.refreshUnscreened().catch(() => { /* an offer the door cannot make is absent */ });
}

export interface DrainReadDeps<C> {
  /** The fire-and-forget REST reads, in the order they leave. */
  rest: ReadonlyArray<() => void>;
  /** The consent read the flag machine awaits (stamped before it leaves — see face-scope.ts). */
  consent: () => Promise<C | null>;
  engine: EngineQueues;
}

export function drainReads<C>(deps: DrainReadDeps<C>): () => Promise<C | null> {
  let armed = false;
  return () => {
    for (const read of deps.rest) read();
    if (!armed) {
      armed = true;
      askEngineQueues(deps.engine);
    }
    return deps.consent();
  };
}
