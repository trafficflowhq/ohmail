/**
 * THE NATIVE SIDE'S END OF THE BRIDGE: what React Native does with a message the page posted. The
 * native module has already joined its pieces and checked its origin and frame; this re-checks both
 * (`admit.ts`), drops another web view's epoch, reads the message through the one guard, and hands
 * it to a closed table of handlers, one per kind. An unknown kind or a field of the wrong type runs
 * nothing. Each request is answered once; an epoch that ended takes its requests with it.
 */
import { admitBridgeMessage } from "./admit";
import {
  ASK_DEADLINE_MS, readRequest, type Kind, type NoteWhat, type Refused, type Request, type Requests, type ShellAct,
  type ShellApp, type ShellConfig, type ShellEvent, type SwitchPlace,
} from "./bridge-kinds";
import { framesOf } from "./framing";
import type { HttpDoor } from "./http-door";
import type { PageMessage } from "./shell-port";

export interface BridgeHostDeps {
  /** Posts text to the page of `epoch`; the native view drops it if that page is gone. */
  readonly post: (epoch: string, text: string) => void;
  /** What the page is told it is, or null when no session is entered. */
  readonly config: () => ShellConfig | null;
  readonly http: HttpDoor;
  readonly act: (act: ShellAct) => Promise<Requests["act"]["answer"] | { readonly refused: Refused }>;
  readonly openHeld: (token: string) => Promise<boolean>;
  /** The page drew its first frame here; the place it is in now. */
  readonly ready: (place: string) => void;
  readonly place: (fragment: string) => void;
  readonly note: (what: NoteWhat, n: number) => void;
  /** The phone's old copy of the live scope, handed across once (`old-copy.ts`). */
  readonly oldCopy: {
    page(ask: Requests["oldCopy.page"]["ask"]): Promise<Requests["oldCopy.page"]["answer"] | { readonly refused: Refused }>;
    done(ask: Requests["oldCopy.done"]["ask"]): Promise<Requests["oldCopy.done"]["answer"] | { readonly refused: Refused }>;
  };
  /** Counts of what the bridge refused, by name. */
  readonly count?: (what: string) => void;
  /** The app this page runs in; the guard judges a switch's place by it, and with none refuses every place. */
  readonly app?: ShellApp;
  /** The switch to the other app, native's whole; until a build wires it, every switch kind is not ready. */
  readonly switch?: SwitchDoor;
}

/** What the switch's three kinds ask of native. The place has passed the guard, its direction this app's. */
export interface SwitchDoor {
  read(): Promise<Requests["switch.read"]["answer"] | { readonly refused: Refused }>;
  open(to: SwitchPlace): Promise<Requests["switch.open"]["answer"] | { readonly refused: Refused }>;
  store(): Promise<Requests["switch.store"]["answer"] | { readonly refused: Refused }>;
}

const NOT_READY = { refused: "notReady" } as const;

type Answer<K extends Kind> = Requests[K]["answer"] | { readonly refused: Refused };
type Handler<K extends Kind> = (req: Request<K>, signal: AbortSignal) => Promise<Answer<K>> | Answer<K>;

export class BridgeHost {
  private epoch = "";
  private readonly working = new Map<number, AbortController>();
  private readonly asked = new Map<number, (value: { took: boolean } | { unsent: number } | null) => void>();
  private nextAsk = 1;
  private readonly handlers: { readonly [K in Kind]: Handler<K> };

  constructor(private readonly deps: BridgeHostDeps) {
    const native = (): { refused: Refused } => ({ refused: "unknownKind" });
    this.handlers = {
      config: () => this.deps.config() ?? { refused: "notReady" },
      ready: (r) => (this.deps.ready(r.place), {}),
      place: (r) => (this.deps.place(r.fragment), {}),
      http: (r, signal) => this.deps.http.request(r, signal),
      cancel: (r) => (this.working.get(r.of)?.abort(), {}),
      act: (r) => this.deps.act(r),
      linkAskOpen: async (r) => ({ opened: await this.deps.openHeld(r.token) }),
      answer: (r) => {
        const settle = this.asked.get(r.askId);
        this.asked.delete(r.askId);
        settle?.(r.what === "back" ? { took: r.took } : { unsent: r.unsent });
        return {};
      },
      // The keeper's kinds are answered by the native module itself and never reach this thread.
      keep: native,
      kept: native,
      keepRows: native,
      keptRows: native,
      "oldCopy.page": (r) => this.deps.oldCopy.page(r),
      "oldCopy.done": (r) => this.deps.oldCopy.done(r),
      note: (r) => (this.deps.note(r.what, r.n), {}),
      "switch.read": () => this.deps.switch?.read() ?? NOT_READY,
      "switch.open": (r) => this.deps.switch?.open(r.to) ?? NOT_READY,
      "switch.store": () => this.deps.switch?.store() ?? NOT_READY,
    };
  }

  /** A new web view instance. Every request of the one before it is aborted, every ask let go. */
  begin(epoch: string): void {
    for (const c of this.working.values()) c.abort();
    this.working.clear();
    for (const settle of this.asked.values()) settle(null);
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
    const req = readRequest(raw, this.deps.app ?? null);
    const id = typeof (raw as { id?: unknown })?.id === "number" ? (raw as { id: number }).id : -1;
    if ("refused" in req) {
      count(req.refused);
      if (id >= 0) this.answer(id, { refused: req.refused });
      return;
    }
    const control = new AbortController();
    this.working.set(req.id, control);
    const at = this.epoch;
    const run = this.handlers[req.kind] as Handler<Kind>;
    Promise.resolve()
      .then(() => run(req, control.signal))
      .catch(() => ({ refused: control.signal.aborted ? "cancelled" : "unreachable" }) as const)
      .then((answer) => {
        this.working.delete(req.id);
        if (at !== this.epoch) return;
        this.answer(req.id, control.signal.aborted && req.kind !== "cancel" ? { refused: "cancelled" } : answer);
      });
  }

  /** An event to the page that is open now. */
  send(event: ShellEvent): void {
    if (this.epoch === "") return;
    this.postWhole(0, { ...event, epoch: this.epoch });
  }

  /**
   * Asks the page, which answers within {@link ASK_DEADLINE_MS} or not at all: back is then not
   * taken, and the unsent count is unknown (null), which a caller reads as "may hold unsent words".
   */
  ask<W extends "back" | "unsent">(what: W): Promise<W extends "back" ? boolean : number | null> {
    type Out = W extends "back" ? boolean : number | null;
    return new Promise((resolve) => {
      if (this.epoch === "") return resolve((what === "back" ? false : null) as Out);
      const askId = this.nextAsk++;
      const timer = setTimeout(() => settle(null), ASK_DEADLINE_MS);
      const settle = (value: { took: boolean } | { unsent: number } | null) => {
        clearTimeout(timer);
        this.asked.delete(askId);
        if (what === "back") resolve((value !== null && "took" in value && value.took) as Out);
        else resolve((value !== null && "unsent" in value ? value.unsent : null) as Out);
      };
      this.asked.set(askId, settle);
      this.send({ type: "ask", askId, what });
    });
  }

  private answer(id: number, answer: object): void {
    const body = "refused" in answer ? { ok: false, refused: (answer as { refused: Refused }).refused } : { ...answer, ok: true };
    this.postWhole(id, { ...body, id, epoch: this.epoch });
  }

  private postWhole(id: number, message: object): void {
    for (const frame of framesOf(JSON.stringify(message), id, this.epoch)) this.deps.post(this.epoch, frame);
  }
}
