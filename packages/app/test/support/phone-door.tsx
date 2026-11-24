/**
 * THE FAKE DOOR OF THE PHONE'S WAYS IN: the page's contract in memory. Every request is recorded by the door's kind
 * and answered from `answers` (a request with no answer waits forever, as one native has not answered yet); a test
 * tells a state, a scan or a hardware back. The connect slot is a stand-in that records what it was asked and offers
 * one press that answers "connected": the form, its wire and the password are proven on their own
 * (`test/mailboxes/connect/standalone.test.tsx`, `apps/mobile/test/door-connect-wire.test.tsx`).
 *
 * What a fake hides, and the milestone proves on the emulator: a real key's lease and a real one-use code, the
 * camera, the recents picture and autofill, the camera's rectangle over a real web view under a keyboard or a fold,
 * and iOS entirely.
 */
import type { ReactNode } from "react";
import type {
  PhoneCamera,
  PhoneDoor,
  PhoneDoorConfig,
  PhoneDoorState,
  PhoneOffer,
  PhonePairAnswer,
  PhoneScanned,
  PhoneServerAnswer,
} from "../../src/phone-door/index.js";
import type { ConnectAsk } from "../../src/mailboxes/connect/contract.js";

export const STATE: PhoneDoorState = {
  session: "none",
  migrating: null,
  said: null,
  openId: null,
  syncing: false,
  syncSaid: null,
  syncStopped: null,
  pinned: false,
  total: null,
  paired: [],
  after: null,
};

export const CONFIG: PhoneDoorConfig = {
  app: "ohmail",
  os: "android",
  pad: false,
  language: "en",
  organizes: "offered",
  canPin: true,
};

/** A request's answer, or a thrown refusal of the bridge. */
type Answer<A, T> = (ask: A) => T | Promise<T>;
export interface FakeAnswers {
  readonly "server.ask"?: Answer<string, PhoneServerAnswer>;
  readonly "scan.start"?: Answer<unknown, PhoneCamera>;
  readonly "scan.move"?: Answer<unknown, PhoneCamera>;
  readonly "camera.allow"?: Answer<unknown, PhoneCamera>;
  readonly hand?: Answer<{ address: string | null; token: string }, PhoneOffer>;
  readonly pair?: Answer<string, PhonePairAnswer>;
}

export interface Asked {
  readonly kind: string;
  readonly ask: unknown;
}

const never = <T,>(): Promise<T> => new Promise<T>(() => {});

export function fakePhoneDoor(
  o: { config?: Partial<PhoneDoorConfig>; state?: Partial<PhoneDoorState>; answers?: FakeAnswers } = {},
) {
  const asked: Asked[] = [];
  const connects: ConnectAsk[] = [];
  let state: PhoneDoorState = { ...STATE, ...o.state };
  const stateListeners = new Set<() => void>();
  const scans = new Set<(scan: PhoneScanned) => void>();
  const backs: (() => boolean)[] = [];
  const answers = o.answers ?? {};
  const answer = <A, T>(
    kind: string,
    ask: A,
    by: Answer<A, T> | undefined,
    recorded: unknown = ask,
  ): Promise<T> => {
    asked.push({ kind, ask: recorded });
    return by ? Promise.resolve().then(() => by(ask)) : never<T>();
  };
  const door: PhoneDoor = {
    config: { ...CONFIG, ...o.config },
    state: {
      read: () => state,
      subscribe(changed) {
        stateListeners.add(changed);
        return () => stateListeners.delete(changed);
      },
    },
    ask: (address) => answer("server.ask", address, answers["server.ask"], { address }),
    scan: {
      start: (rect) =>
        answer("scan.start", rect, answers["scan.start"] ?? (() => ({ camera: "on" })), { rect }),
      move: (rect) => answer("scan.move", rect, answers["scan.move"] ?? (() => ({ camera: "on" })), { rect }),
      stop: () => void asked.push({ kind: "scan.stop", ask: {} }),
      allow: () => answer("camera.allow", {}, answers["camera.allow"]),
      listen(heard) {
        scans.add(heard);
        return () => scans.delete(heard);
      },
    },
    hand: (typed) => answer("hand", typed, answers.hand),
    pair: (ticket) => answer("pair", ticket, answers.pair, { ticket }),
    dismiss: (ticket) => void asked.push({ kind: "dismiss", ask: { ticket } }),
    connect: (ask, page): ReactNode => {
      connects.push(ask);
      return page(
        <button
          type="button"
          onClick={() =>
            ask.onDone({ kind: "connected", mailboxId: "acct-1" as never, address: null, created: true })
          }
        >
          the connect form
        </button>,
        null,
      );
    },
    go: (to) => void asked.push({ kind: "go", ask: to }),
    back: {
      subscribe(handle) {
        backs.push(handle);
        return () => void backs.splice(backs.lastIndexOf(handle), 1);
      },
    },
  };
  return {
    door,
    asked,
    connects,
    kinds: () => asked.map((a) => a.kind),
    /** Native's `state` event. */
    tell(next: Partial<PhoneDoorState>) {
      state = { ...state, ...next };
      for (const l of [...stateListeners]) l();
    },
    /** Native's `scan` event. */
    scan: (scan: PhoneScanned) => [...scans].forEach((heard) => heard(scan)),
    /** The hardware back: whether the page took it. */
    back: () => [...backs].reverse().some((h) => h()),
  };
}
