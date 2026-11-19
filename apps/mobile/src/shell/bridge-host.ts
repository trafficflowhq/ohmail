/**
 * THE NATIVE SIDE'S END OF THE SCOPED PAGE'S BRIDGE: what React Native does with a message that page posted. The
 * message is admitted, held to its epoch and read through the one guard by the end both pages' bridges share
 * (`bridge-end.ts`); this file is the scoped page's closed table of handlers, one per kind. An unknown kind or a
 * field of the wrong type runs nothing. Each request is answered once; an epoch that ended takes its requests with it.
 */
import { BridgeEnd, type Ran } from "./bridge-end";
import {
  readRequest, type Kind, type NoteWhat, type Refused, type Request, type Requests, type ShellAct,
  type ShellApp, type ShellConfig, type ShellEvent, type SwitchPlace, type WakePaneRequest,
} from "./bridge-kinds";
import type { HttpDoor } from "./http-door";
import type { PageMessage } from "./shell-port";

export interface BridgeHostDeps {
  /** Posts text to the page of `epoch`; the native view drops it if that page is gone. */
  readonly post: (epoch: string, text: string) => void;
  /** What the page is told it is, or null when no session is entered. */
  readonly config: () => ShellConfig | null;
  readonly http: HttpDoor;
  readonly act: (act: ShellAct) => Promise<Requests["act"]["answer"] | { readonly refused: Refused }>;
  readonly wake?: (request: WakePaneRequest) => Answer<"phone.wake">;
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
  private readonly end: BridgeEnd<Request, ShellEvent>;
  private readonly handlers: { readonly [K in Kind]: Handler<K> };

  constructor(private readonly deps: BridgeHostDeps) {
    const native = (): { refused: Refused } => ({ refused: "unknownKind" });
    this.handlers = {
      config: () => this.deps.config() ?? { refused: "notReady" },
      ready: (r) => (this.deps.ready(r.place), {}),
      place: (r) => (this.deps.place(r.fragment), {}),
      http: (r, signal) => this.deps.http.request(r, signal),
      cancel: (r) => (this.end.cancel(r.of), {}),
      act: (r) => this.deps.act(r),
      "phone.wake": (r) => this.deps.wake?.(r) ?? NOT_READY,
      linkAskOpen: async (r) => ({ opened: await this.deps.openHeld(r.token) }),
      answer: (r) => (this.end.settle(r.askId, r.what === "back" ? { took: r.took } : { unsent: r.unsent }), {}),
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
    this.end = new BridgeEnd<Request, ShellEvent>({
      post: (epoch, text) => this.deps.post(epoch, text),
      read: (raw) => readRequest(raw, this.deps.app ?? null),
      run: async (req, signal): Promise<Ran> => {
        const answer: object = await (this.handlers[req.kind] as Handler<Kind>)(req, signal);
        return "refused" in answer ? (answer as { readonly refused: Refused }) : { answer };
      },
      // The scoped page's answers cross flat, beside the envelope's own fields.
      wrap: (answer) => answer,
      count: (what) => this.deps.count?.(what),
    });
  }

  /** A new web view instance. Every request of the one before it is aborted, every ask let go. */
  begin(epoch: string): void {
    this.end.begin(epoch);
  }

  receive(message: PageMessage): void {
    this.end.receive(message);
  }

  /** An event to the page that is open now. */
  send(event: ShellEvent): void {
    this.end.send(event);
  }

  /**
   * Asks the page, which answers within the bridge's deadline or not at all: back is then not
   * taken, and the unsent count is unknown (null), which a caller reads as "may hold unsent words".
   */
  ask<W extends "back" | "unsent">(what: W): Promise<W extends "back" ? boolean : number | null> {
    type Out = W extends "back" ? boolean : number | null;
    return this.end.ask(what).then((value) => {
      const said = (value ?? {}) as { took?: unknown; unsent?: unknown };
      if (what === "back") return (said.took === true) as Out;
      return (typeof said.unsent === "number" ? said.unsent : null) as Out;
    });
  }
}
