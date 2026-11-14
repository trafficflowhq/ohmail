/**
 * THE PAGE'S SIDE OF A BRIDGE, whichever page it is: the scoped page's (`bridge.ts`) and the door's
 * (`door/bridge.ts`) both stand on this one. A request is posted at once, inside the call that makes it, and
 * answered once by id; the page owns its ids and its deadlines, and an abort or a deadline sends `cancel` so native
 * stops the work. Every message carries this page's epoch, and one of another epoch is dropped: an answer or an
 * event meant for a web view that ended never reaches this one.
 */
import type { Refused } from "../../src/shell/bridge-kinds";
import { framesOf, Joiner } from "../../src/shell/framing";
import type { PagePort } from "./port";

/** Native answered with a refusal, or the page stopped waiting. */
export class BridgeRefused extends Error {
  constructor(readonly refused: Refused | "deadline" | "aborted") {
    super(`the bridge refused: ${refused}`);
    this.name = "BridgeRefused";
  }
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  /** How long the page waits; past it the request is cancelled. */
  readonly deadlineMs?: number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The longest a request waits by default: a slow server answers inside it. */
export const DEFAULT_DEADLINE_MS = 60_000;

/** How a page's kinds ride beside the envelope's own fields (`id`, `epoch`, `kind`, `ok`): flat, or nested. */
export interface Envelope {
  /** A kind's fields as they are posted. */
  ask(ask: object): object;
  /** A kind's answer out of an answered message. */
  answer(message: Record<string, unknown>): unknown;
}

export interface Channel<Ev> {
  readonly epoch: string;
  request(kind: string, ask: object, opts?: RequestOptions): Promise<unknown>;
  on(handle: (e: Ev) => void): () => void;
  /** What the channel itself saw go wrong, counted: foreign epochs, unreadable frames. */
  readonly dropped: () => number;
}

export function createChannel<Ev>(
  port: PagePort,
  epoch: string,
  envelope: Envelope,
  timers: Timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as number) },
): Channel<Ev> {
  let next = 1;
  let dropped = 0;
  const pending = new Map<number, { settle: (m: Record<string, unknown>) => void; fail: (e: BridgeRefused) => void }>();
  const listeners = new Set<(e: Ev) => void>();
  const joiner = new Joiner(epoch, () => (dropped += 1));

  const post = (id: number, kind: string, ask: object): void => {
    const text = JSON.stringify({ ...envelope.ask(ask), id, epoch, kind });
    for (const frame of framesOf(text, id, epoch)) port.post(frame);
  };

  port.listen((text) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
      if (m.kind === "piece" || m.kind === "joined") {
        const whole = joiner.take(m);
        if (whole === null) return;
        m = JSON.parse(whole) as Record<string, unknown>;
      }
    } catch {
      dropped += 1;
      return;
    }
    if (m.epoch !== epoch) {
      dropped += 1;
      return;
    }
    if (typeof m.type === "string") {
      for (const handle of listeners) handle(m as unknown as Ev);
      return;
    }
    const waiting = typeof m.id === "number" ? pending.get(m.id) : undefined;
    if (!waiting) return;
    pending.delete(m.id as number);
    if (m.ok === true) waiting.settle(m);
    else waiting.fail(new BridgeRefused((m.refused as Refused) ?? "malformed"));
  });

  return {
    epoch,
    dropped: () => dropped,
    on(handle) {
      listeners.add(handle);
      return () => listeners.delete(handle);
    },
    request(kind, ask, opts = {}) {
      return new Promise((resolve, reject) => {
        if (opts.signal?.aborted) return reject(new BridgeRefused("aborted"));
        const id = next++;
        const stop = (why: "deadline" | "aborted") => {
          if (!pending.delete(id)) return;
          timers.clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          post(next++, "cancel", { of: id });
          reject(new BridgeRefused(why));
        };
        const onAbort = () => stop("aborted");
        const timer = timers.setTimeout(() => stop("deadline"), opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
        opts.signal?.addEventListener("abort", onAbort);
        pending.set(id, {
          settle: (m) => {
            timers.clearTimeout(timer);
            opts.signal?.removeEventListener("abort", onAbort);
            // An answer its envelope cannot read is a refusal, never a request left waiting.
            try {
              resolve(envelope.answer(m));
            } catch (unread) {
              reject(unread instanceof BridgeRefused ? unread : new BridgeRefused("malformed"));
            }
          },
          fail: (e) => {
            timers.clearTimeout(timer);
            opts.signal?.removeEventListener("abort", onAbort);
            reject(e);
          },
        });
        post(id, kind, ask);
      });
    },
  };
}
