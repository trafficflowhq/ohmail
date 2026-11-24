/**
 * THE NATIVE END OF A PAGE'S BRIDGE, whichever page is at the other end: the scoped page's (`bridge-host.ts`) and the
 * door page's (`door-host.ts`) both stand on this one. The native module has already joined a message's pieces and
 * checked its origin and frame; this re-checks both (`admit.ts`), drops another web view's epoch, reads the message
 * through the page's own guard before anything else touches it, and hands it to that page's handlers. An unknown
 * kind or a field of the wrong type runs nothing. Each request is answered once; an epoch that ended takes its
 * requests and its asks with it.
 */
import { admitBridgeMessage } from "./admit";
import type { Refused } from "./bridge-kinds";
import { ASK_DEADLINE_MS, framesOf } from "./framing";
import type { PageMessage } from "./shell-port";

/** What a handler came back with: the kind's answer, or why the bridge gives none. */
export type Ran = { readonly answer: object } | { readonly refused: Refused };

export interface BridgeEndDeps<Req extends { readonly id: number; readonly kind: string }> {
  /** Posts text to the page of `epoch`; the native view drops it if that page is gone. */
  readonly post: (epoch: string, text: string) => void;
  /** The page's guard: what the message is, or why it is refused. */
  readonly read: (raw: unknown) => Req | { readonly refused: "unknownKind" | "malformed" };
  readonly run: (req: Req, signal: AbortSignal) => Promise<Ran> | Ran;
  /** How a kind's answer crosses beside the envelope's `ok`, `id` and `epoch`. */
  readonly wrap: (answer: object) => object;
  /** Counts of what the bridge refused, by name. */
  readonly count?: (what: string) => void;
}

export class BridgeEnd<Req extends { readonly id: number; readonly kind: string }, Ev extends object> {
  private epoch = "";
  private readonly working = new Map<number, AbortController>();
  private readonly asked = new Map<number, { what: string; physical: boolean; stage: "open" | "held" | "prepare" | "confirmed"; settle(value: object | null): void; hold(): void }>();
  private nextAsk = 1;

  constructor(private readonly deps: BridgeEndDeps<Req>) {}

  /** The epoch of the page that is open now; empty with none. */
  now(): string {
    return this.epoch;
  }

  /** A new web view instance. Every request of the one before it is aborted, every ask let go. */
  begin(epoch: string): void {
    for (const c of this.working.values()) c.abort();
    this.working.clear();
    for (const ask of this.asked.values()) ask.settle(null);
    this.asked.clear();
    this.epoch = epoch;
  }

  receive(message: PageMessage): void {
    const count = this.deps.count ?? (() => {});
    if (!admitBridgeMessage(message)) return count("notAdmitted");
    if (message.epoch !== this.epoch || this.epoch === "") return count("foreignEpoch");
    let raw: unknown;
    try {
      raw = JSON.parse(message.data);
    } catch {
      return count("malformed");
    }
    const req = this.deps.read(raw);
    const id = typeof (raw as { id?: unknown })?.id === "number" ? (raw as { id: number }).id : -1;
    if ("refused" in req) {
      count(req.refused);
      if (id >= 0) this.answer(id, { refused: req.refused });
      return;
    }
    const control = new AbortController();
    this.working.set(req.id, control);
    const at = this.epoch;
    Promise.resolve()
      .then((): Ran | Promise<Ran> => {
        if (at !== this.epoch || control.signal.aborted) return { refused: "cancelled" };
        return this.deps.run(req, control.signal);
      })
      .catch((): Ran => ({ refused: control.signal.aborted ? "cancelled" : "unreachable" }))
      .then((ran) => {
        if (this.working.get(req.id) === control) this.working.delete(req.id);
        if (at !== this.epoch) return;
        this.answer(req.id, control.signal.aborted && req.kind !== "cancel" ? { refused: "cancelled" } : ran);
      });
  }

  /** An event to the page that is open now. */
  send(event: Ev): void {
    if (this.epoch === "") return;
    this.postWhole(0, { ...event, epoch: this.epoch });
  }

  /** The page stopped waiting for a request: its work is told to stop. */
  cancel(of: number): void {
    this.working.get(of)?.abort();
  }

  /**
   * Asks the page, which answers within {@link ASK_DEADLINE_MS} or not at all: then, and with no page open, null.
   * The page's answer arrives as a request of its own, which the page's handlers hand to {@link settle}.
   */
  ask(what: string, signal?: AbortSignal): Promise<object | null> {
    return new Promise((resolve) => this.question(what, resolve, signal));
  }

  question(what: string, resolve: (value: object | null) => void, signal?: AbortSignal, ended?: (id: number) => void): void {
    if (this.epoch === "" || signal?.aborted) return resolve(null);
    const askId = this.nextAsk++;
    const abort = () => settle(null);
    const timer = setTimeout(abort, ASK_DEADLINE_MS);
    const settle = (value: object | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.asked.delete(askId);
      if (value === null) ended?.(askId);
      resolve(value);
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.asked.set(askId, {
      what, physical: signal !== undefined && what === "back", stage: "open", settle,
      hold: () => clearTimeout(timer),
    });
    this.send({ type: "ask", askId, what } as unknown as Ev);
  }

  settle(askId: number, value: object): boolean {
    const ask = this.asked.get(askId);
    if (!ask) return false;
    if (ask.what === "back" && "took" in value) {
      if (value.took === "held" && ask.physical && ask.stage === "open") {
        ask.hold();
        ask.stage = "held";
      } else if (value.took === "prepare" && ask.stage === "held") {
        ask.stage = "prepare";
      } else if (value.took === false && ask.stage === "prepare") {
        // Acknowledge the choice. Only the still-current page may commit it after this reply.
        ask.stage = "confirmed";
      } else if (value.took === "discard" && ask.stage === "confirmed") {
        ask.settle({ took: false });
      } else if (value.took === true || (value.took === false && !ask.physical && ask.stage === "open")) ask.settle(value);
      else return false;
    } else if (ask.what === "unsent" && "unsent" in value) ask.settle(value);
    else return false;
    return true;
  }

  private answer(id: number, ran: Ran): void {
    const body = "refused" in ran ? { ok: false, refused: ran.refused } : { ...this.deps.wrap(ran.answer), ok: true };
    this.postWhole(id, { ...body, id, epoch: this.epoch });
  }

  private postWhole(id: number, message: object): void {
    for (const frame of framesOf(JSON.stringify(message), id, this.epoch)) this.deps.post(this.epoch, frame);
  }
}
