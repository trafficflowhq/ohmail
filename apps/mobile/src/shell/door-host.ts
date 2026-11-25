/**
 * THE DOOR'S HOST: what the native side does for the door page, one handler per kind of its closed table
 * (`door-kinds.ts`), over the connection layer's own verbs. Nothing here dials, stores or signs in by itself: a probe,
 * a redeem, a switch and a forget are the connection's, and opening a mailbox on this phone is the engine's.
 *
 * WHAT STAYS ON THIS SIDE. A pairing code (scanned, typed or inside a pasted link) is held under a ticket
 * (`door-tickets.ts`) and reaches the redeem only through {@link DoorHost.pair}, the one call site of the
 * connection's `pairConfirmed`. A mailbox's password is read once, into the engine's own open. No answer, event or
 * state names either, and a refusal's argument that repeats one crosses empty ({@link said}).
 */
import {
  armConsentPress, holdStandaloneDoor, organizerSettingsLeftOnlyHere, releaseStandaloneLaunch, sayOrganizerRestricted,
  standaloneLaunchGeneration, takeStandaloneLaunch,
} from "../engine/organizer-session";
import { openStandaloneMailbox, organizesHere, type StandaloneDeps, type StandaloneEngine } from "../engine/standalone-door";
import { canPin } from "../net/host-pinning";
import {
  MANAGED_ORIGIN, discardAdmission, nextStep, parsePairLink, pendingPairOrigin, stashPairOrigin, type PairLink,
} from "../net/pairing";
import { addressProblem, parseServerAddress } from "../net/server-base";
import { refuse, type Refusal } from "../refusal";
import { gateFor } from "../state/gate";
import { refusalField } from "../ui/standalone-form";
import { BridgeEnd } from "./bridge-end";
import {
  readDoorRequest, type DoorAt, type DoorConfig, type DoorEvent, type DoorKind, type DoorRequest, type DoorRequests,
  type Offer, type OpenInput, type Rect, type SaidRefusal,
} from "./door-kinds";
import {
  doorAtOf, doorStateOf, factsOf, fieldsOf, heldTokens, leavesNothingHere, negotiationSaid, said, type DoorConnection,
} from "./door-state";
import { DoorTickets, type DoorTicketsDeps } from "./door-tickets";
import type { PageMessage } from "./shell-port";

export type { DoorConnection };

/** What opening a mailbox on this phone needs of the platform. */
export interface StandaloneWay {
  /** Whether this build offers the way at all: an engine is in it, and the app is one that organizes. */
  readonly offered: () => boolean;
  /** What `openStandaloneMailbox` is handed: the engine's start, its store and keys, this install's name. */
  readonly deps: () => StandaloneDeps;
  /** Raises the organizer's session for this launch; rejects in a build that cannot reach its background half. */
  readonly startSession: (door: StandaloneEngine, address: string, launch: number) => Promise<void>;
  /** The notice permission, asked once organizing has begun; resolves when there is nothing left to ask. */
  readonly noticeGate: () => Promise<void>;
}

export interface DoorHostDeps {
  /** Posts text to the page of `epoch`; the native view drops it if that page is gone. */
  readonly post: (epoch: string, text: string) => void;
  /** The connection as it stands now. */
  readonly conn: () => DoorConnection;
  /** What the page is told of the app and the device. */
  readonly facts: () => Pick<DoorConfig, "app" | "os" | "pad" | "language" | "build" | "facts">;
  /** The page the door was asked to open at, or null where the connection's state decides. */
  readonly asked: DoorAt | null;
  readonly tickets: Pick<DoorTicketsDeps, "mint" | "now" | "later">;
  readonly standalone: StandaloneWay;
  readonly camera: {
    /** Whether the system lets this app use the camera now. */
    permitted(): boolean;
    /** Asks the system; answers whether it does now. */
    allow(): Promise<boolean>;
    /** Shows the camera over the page at `rect`, or puts it away. */
    show(rect: Rect | null): void;
  };
  /** A mailbox was opened from the door: the app shows it. */
  readonly entered: () => void;
  /** Out of a door that stands over an open mailbox. */
  readonly back: () => void;
  /** The page drew its first frame. */
  readonly ready: (calendarPrepared?: false) => void;
  /** Wakes the open mailbox's page, which holds the mail under the shell. */
  readonly wake: () => void;
  readonly openSettings: (what: "notifications") => Promise<void>;
  readonly count?: (what: string) => void;
}

/** How long the camera ignores frames after one that was no pairing code. */
export const SCAN_REARM_MS = 1200;

type Answered<K extends DoorKind> = DoorRequests[K]["answer"];
/** A kind's handler. `signal` is aborted once the page stops waiting (its deadline, an abort) or ends. */
type Handler<K extends DoorKind> = (ask: DoorRequests[K]["ask"], signal: AbortSignal) => Promise<Answered<K>> | Answered<K>;

export class DoorHost {
  private readonly end: BridgeEnd<DoorRequest, DoorEvent>;
  private readonly tickets: DoorTickets;
  private readonly handlers: { readonly [K in DoorKind]: Handler<K> };
  /** What the last forget could not take back. It outlives its row, and the page, which the forget itself may rebuild. */
  private after: SaidRefusal | null = null;
  private scan: { armed: boolean; rearm: (() => void) | null } | null = null;
  private entering = 0;

  constructor(private readonly deps: DoorHostDeps) {
    this.tickets = new DoorTickets({ ...deps.tickets, epoch: () => this.end.now(), discard: discardAdmission });
    const done = async (): Promise<Record<never, never>> => ({});
    this.handlers = {
      config: () => this.config(),
      ready: (request) => (this.deps.ready(request.calendarPrepared), {}),
      leave: async () => (await this.leave(), {}),
      /* The ring is the connection's; under the shell the open mailbox's page holds the mail and drains on a wake. */
      sync: async () => (await this.deps.conn().syncNow(), this.deps.wake(), {}),
      disconnect: async () => (await this.deps.conn().disconnect(), {}),
      "server.ask": (r) => this.serverAsk(r.address),
      "sign-in": (r, signal) => this.signIn(r.address, signal),
      "scan.start": (r) => this.scanAt(r.rect, true),
      "scan.move": (r) => this.scanAt(r.rect, false),
      "scan.stop": () => (this.stopScan(), {}),
      "camera.allow": async () => ({ camera: (await this.deps.camera.allow()) ? "on" : "off" }),
      hand: (r, signal) => this.hand(r.address, r.token, signal),
      pair: (r) => this.pair(r.ticket),
      dismiss: (r) => (this.tickets.drop(r.ticket), {}),
      open: ({ input: { pass, ...typed } }) => this.open(typed, pass),
      switch: async (r) => {
        const held = heldTokens(this.deps.conn().profiles);
        const went = await this.deps.conn().switchTo(r.id);
        return went.ok ? { ok: true } : { ok: false, said: said(went.reason, [...held, ...heldTokens(this.deps.conn().profiles)]) };
      },
      "forget.ask": (r) => this.forgetAsk(r.id),
      forget: (r) => this.forget(r.id, r.anyway),
      "settings.open": (r) => this.deps.openSettings(r.what).then(done, done),
      answer: (r) => (this.end.settle(r.askId, { took: r.took }), {}),
      cancel: (r) => (this.end.cancel(r.of), {}),
    };
    this.end = new BridgeEnd<DoorRequest, DoorEvent>({
      post: (epoch, text) => this.deps.post(epoch, text),
      read: readDoorRequest,
      run: async (req, signal) => ({ answer: await (this.handlers[req.kind] as Handler<DoorKind>)(req.ask, signal) }),
      // Nested, as the page's asks are: the door's answers carry fields the envelope names too.
      wrap: (answer) => ({ answer }),
      count: (what) => this.deps.count?.(what),
    });
  }

  /** A new web view instance: the page before it ended, and with it its ticket and its camera. */
  begin(epoch: string): void {
    this.tickets.dropAll();
    this.stopScan();
    this.end.begin(epoch);
  }

  receive(message: PageMessage): void {
    this.end.receive(message);
  }

  /** A fact of the device changed. */
  send(event: Exclude<DoorEvent, { type: "state" | "scan" | "ask" }>): void {
    this.end.send(event);
  }

  /** The connection changed: the page draws the new state and nothing of the old. */
  changed(): void {
    this.end.send({ type: "state", state: doorStateOf(this.deps.conn(), this.after) });
  }

  /** Back asks the page first; not taken, the caller takes the door's own way out ({@link leave}). */
  async back(): Promise<boolean> {
    return ((await this.end.ask("back")) as { took?: unknown } | null)?.took === true;
  }

  /** A press is between its code or password and its mailbox: the door is not left under it. */
  busy(): boolean {
    return this.entering > 0;
  }

  /** The door closes: the ticket's lease goes back and the camera is put away. */
  close(): void {
    this.tickets.dropAll();
    this.stopScan();
    this.end.begin("");
  }

  /**
   * The way out. Over an open mailbox: back to it. Where the phone is held at the list with no session: this phone's
   * own mailbox opens, else a pairing that keeps its credential (the one it opens at a start first). Otherwise
   * nothing: the page's first screen is the way.
   */
  async leave(): Promise<"left" | "stayed"> {
    const conn = this.deps.conn();
    if (conn.state.k === "live" || conn.state.k === "shell") {
      this.deps.back();
      return "left";
    }
    if (gateFor(conn.state, conn.profiles.length).to !== "servers") return "stayed";
    const reopen = conn.profiles.find(organizesHere)
      ?? conn.profiles.find((p) => p.id === conn.activeId && p.refreshToken !== null)
      ?? conn.profiles.find((p) => p.refreshToken !== null)
      ?? null;
    if (reopen === null || !(await conn.switchTo(reopen.id)).ok) return "stayed";
    this.deps.entered();
    return "left";
  }

  /** A frame the camera decoded. The code in it never leaves this side: the page hears what the probe measured. */
  scanned(data: string): void {
    const scan = this.scan;
    if (scan === null || !scan.armed) return;
    scan.armed = false;
    const link = parsePairLink(data);
    if (link === null) {
      this.end.send({ type: "scan", scan: { k: "notACode" } });
      scan.rearm = this.deps.tickets.later(() => { scan.armed = true; }, SCAN_REARM_MS);
      return;
    }
    void this.measure(link, () => this.scan === scan).then((offer) => {
      if (offer === null) return;
      // The camera is put away for what the probe answered; the page asks for it again.
      this.stopScan();
      this.end.send({ type: "scan", scan: offer });
    });
  }

  private async config(): Promise<DoorConfig> {
    const conn = this.deps.conn();
    const facts = this.deps.facts();
    const erasedCalendarScopes = facts.app === "ohcal" ? await conn.erasedCalendarScopes?.() : undefined;
    return {
      ...facts,
      ...(erasedCalendarScopes?.length ? { erasedCalendarScopes } : {}),
      at: doorAtOf(this.deps.asked, conn),
      organizes: this.deps.standalone.offered() ? "offered" : "withheld",
      canPin: canPin(),
      state: doorStateOf(conn, this.after),
    };
  }

  private async serverAsk(typed: string): Promise<Answered<"server.ask">> {
    const refused = (reason: Refusal): Answered<"server.ask"> => ({ k: "refused", said: said(reason) });
    const problem = addressProblem(typed);
    if (problem !== null) return refused(problem);
    const origin = parseServerAddress(typed);
    if (origin === null) return refused(refuse("notOhmail"));
    const conn = this.deps.conn();
    const answer = await conn.ask(origin);
    if (answer.kind !== "hello") return refused(negotiationSaid(answer));
    const step = nextStep(answer.hello);
    if (step.kind !== "pair") return refused(negotiationSaid(answer, step));
    let apiUnder: string | null = null;
    // The hosted address is a constant: measuring where its API answers could only add a round trip that can fail.
    if (origin !== MANAGED_ORIGIN) {
      const base = await conn.probeBase(origin);
      if (base.kind === "refused") return refused(base.reason);
      apiUnder = base.prefixed ? base.base : null;
    }
    // Held in this process for `hand`, never in a route (`pairing.ts`, `stashPairOrigin`).
    stashPairOrigin(origin);
    return { k: "reached", address: origin, flavor: answer.hello.flavor.slice(0, 64), apiUnder };
  }

  private scanAt(rect: Rect, start: boolean): { camera: "on" | "off" } {
    if (!this.deps.camera.permitted() || (!start && this.scan === null)) {
      this.stopScan();
      return { camera: "off" };
    }
    this.scan ??= { armed: true, rearm: null };
    this.deps.camera.show(rect);
    return { camera: "on" };
  }

  private stopScan(): void {
    const scan = this.scan;
    if (scan === null) return;
    this.scan = null;
    scan.armed = false;
    scan.rearm?.();
    this.deps.camera.show(null);
  }

  /**
   * Asks what is at a link's address, spending nothing, and holds what answered under a ticket. `still` says whether
   * whoever asked is still there: an admission nobody is left to confirm is given back at once.
   */
  private async measure(link: PairLink, still: () => boolean): Promise<Offer | null> {
    const page = this.end.now();
    const outcome = await this.deps.conn().probePair(link.origin, link.pin);
    if (outcome.kind === "refused") return still() ? { k: "refused", said: said(outcome.reason, [link.token]) } : null;
    if (page === "" || page !== this.end.now() || !still()) {
      discardAdmission(outcome.admission);
      return null;
    }
    return { k: "offers", ticket: this.tickets.offer(outcome.admission, link.token), facts: factsOf(outcome.admission) };
  }

  /**
   * A pasted link wins over the fields and names its own address and key; a typed code carries no key and goes to the
   * typed address as the server step reads one, else to the address that step reached. A code the page stopped
   * waiting for is offered to nobody: its key goes back as the probe answers.
   */
  private async hand(address: string | null, token: string, signal: AbortSignal): Promise<Offer> {
    const pasted = parsePairLink(token);
    // A link the grammar refuses (a newer code's, one with a query) is no code: taken as one, the whole link would be
    // sent to the typed or reached server.
    if (pasted === null && /#|:\/\//.test(token)) return { k: "refused", said: said(refuse("pairCodeRejected")) };
    let origin = pendingPairOrigin();
    if (pasted === null && address !== null) {
      // Taken as typed, a part before an "@" or a path would be shown whole and dialled elsewhere.
      const typed = parseServerAddress(address);
      if (typed === null) return { k: "refused", said: said(addressProblem(address) ?? refuse("pairBadAddress", address)) };
      origin = typed;
    }
    const link = pasted ?? { origin, token, pin: null };
    if (link.token.trim() === "") return { k: "refused", said: said(refuse("pairEmptyToken")) };
    return (await this.measure(link, () => !signal.aborted)) ?? { k: "refused", said: said(refuse("connectSuperseded")) };
  }

  private async signIn(address: string | null, signal: AbortSignal): Promise<Answered<"sign-in">> {
    this.entering += 1;
    try {
      const outcome = await this.deps.conn().signIn(address, signal);
      if (!outcome.ok) return { ok: false, said: said(outcome.reason) };
      this.deps.entered();
      return { ok: true };
    } finally {
      this.entering -= 1;
    }
  }

  /**
   * THE PRESS THAT SPENDS THE CODE, and the one call site of the connection's `pairConfirmed`: it is reached with a
   * taken ticket and nothing else, so no code redeems that a person was not shown the measured facts for.
   */
  private async pair(ticket: string): Promise<Answered<"pair">> {
    const held = this.tickets.take(ticket);
    if (held === null) return { ok: false, said: said(refuse("pairCodeRejected")) };
    this.entering += 1;
    try {
      const outcome = await this.deps.conn().pairConfirmed(held.admission, held.token);
      if (!outcome.ok) return { ok: false, said: said(outcome.reason, [held.token]) };
      this.deps.entered();
      return { ok: true };
    } finally {
      this.entering -= 1;
    }
  }

  /**
   * OPEN A MAILBOX ON THIS PHONE, in the order the engine and the connection need: the launch slot, the consent's
   * licence, the engine's open, the door held, the organizer's session for this launch, the adoption, the notice
   * permission; and the slot given back on every exit, a throw included, or the way is gone until the app is killed.
   * A refusal crosses as its code and its field: its arguments are native's words (a fault's, a server's), which no
   * reader of the page takes.
   */
  private async open(typed: Omit<OpenInput, "pass">, password: string): Promise<Answered<"open">> {
    const refused = (r: Refusal): Answered<"open"> => ({ ok: false, code: r.say, field: refusalField(r), args: [] });
    if (!this.deps.standalone.offered()) return refused(refuse("standaloneNoEngine"));
    if (takeStandaloneLaunch() === "standing") return refused(refuse("standaloneAlreadyOpen"));
    this.entering += 1;
    try {
      armConsentPress();
      const outcome = await openStandaloneMailbox(fieldsOf(typed, password), this.deps.standalone.deps());
      if (!outcome.ok) return refused(outcome.reason);
      holdStandaloneDoor(outcome.door);
      /* The session belongs to this launch: a start that settles after the launch was given up raises nothing. */
      const launch = standaloneLaunchGeneration();
      void this.deps.standalone.startSession(outcome.door, typed.address.trim(), launch).catch(() => { sayOrganizerRestricted(); });
      const adopted = await this.deps.conn().openStandalone(outcome.door);
      if (!adopted.ok) return refused(adopted.reason);
      await this.deps.standalone.noticeGate();
      this.deps.entered();
      return { ok: true, mailboxId: outcome.door.accountId };
    } finally {
      releaseStandaloneLaunch();
      this.entering -= 1;
    }
  }

  /** What removing this row would drop. Only this phone's own mailbox holds anything no server has. */
  private async forgetAsk(id: string): Promise<Answered<"forget.ask">> {
    const conn = this.deps.conn();
    const row = conn.profiles.find((p) => p.id === id);
    if (row === undefined || !organizesHere(row)) return { drafts: 0, settings: "none" };
    return { drafts: conn.unsentDraftsHere(id), settings: (await organizerSettingsLeftOnlyHere()) ?? "unknown" };
  }

  private async forget(id: string, anyway: boolean): Promise<Answered<"forget">> {
    if (this.after !== null) {
      this.after = null;
      this.changed();
    }
    // Read before the forget too: the row it removes takes its tokens out of the list.
    const held = heldTokens(this.deps.conn().profiles);
    const outcome = await this.deps.conn().forget(id, { anyway });
    if (outcome.ok) return { k: "gone", after: null };
    if ("settingsKept" in outcome) return { k: "asks", settings: outcome.settingsKept };
    this.after = said(outcome.reason, [...held, ...heldTokens(this.deps.conn().profiles)]);
    this.changed();
    return leavesNothingHere(outcome.reason) ? { k: "gone", after: this.after } : { k: "kept", said: this.after };
  }
}
