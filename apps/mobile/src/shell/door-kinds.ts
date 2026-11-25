/**
 * THE DOOR PAGE'S BRIDGE, as types and one guard. The door page is the shell's second start page: it stands while no
 * mailbox is open (the ways in) and over an open one for the list of servers. It has no scope, no engine and no
 * storage, so its table of kinds is its own and closed: a kind of the scoped page (`bridge-kinds.ts`) is unknown
 * here, and a kind of this table is unknown there.
 *
 * WHAT NEVER CROSSES OUTWARD: a pairing code, a verifier, a refresh token or a password. A scanned code stays native;
 * the page is handed a one-use {@link Offer.ticket} and the measured {@link PairFacts}. A typed code and a mailbox's
 * password each cross inward once (`hand`, `open`) and are in no answer, no event and no state.
 *
 * ENVELOPE. A kind's own fields are NESTED both ways: a request is `{ id, epoch, kind, ask }`, an answer
 * `{ id, epoch, ok: true, answer }` or `{ id, epoch, ok: false, refused }`. Fields here are named `id` and `ok`
 * (a row's id, a press that was refused), which the scoped page's flat envelope would overwrite with its own.
 * Events are `{ type, epoch, ... }`.
 *
 * This file imports types of the scoped page's bridge and no value.
 */
import type { FoldReading, KeyboardReading, Refused, SafeInsets, ShellApp, ShellConfig } from "./bridge-kinds";

/** Which of its two pages the door opens at. */
export type DoorAt = "welcome" | "servers";

/**
 * A refusal as it crosses: the sentence's key and what it interpolates, never formatted words. An argument is a value
 * quoted as it is (an address, a platform's own words) or another refusal, at most three deep.
 */
export interface SaidRefusal {
  readonly code: string;
  readonly args: readonly (string | SaidRefusal)[];
}
/** The deepest a refusal nests, and the longest an argument is. */
export const SAID_DEPTH = 3;
export const SAID_ARG_MAX = 512;

/** What a probe measured at an address: never a field of the link that named it. */
export interface PairFacts {
  readonly what: "computer" | "server" | "hosted" | "local";
  /** Scheme, host and port, whole: where the redeem and every later request go. */
  readonly address: string;
  /** The enforced key as the twelve characters a person compares, or null where the system verifies the address. */
  readonly key: string | null;
}

/** A pairing a person may confirm, held natively under a one-use ticket; or why there is none. */
export type Offer =
  | { readonly k: "offers"; readonly ticket: string; readonly facts: PairFacts }
  | { readonly k: "refused"; readonly said: SaidRefusal };

/** One row of this phone's list. */
export interface PairedRow {
  readonly id: string;
  readonly kind: "hosted" | "server" | "computer" | "own";
  /** The server's address; empty for this phone's own mailbox, whose address nothing dials. */
  readonly address: string;
  /** The account the server named, as a label; null for this phone's own mailbox and for an ended pairing. */
  readonly account: string | null;
  /** The row this phone opens at its next start. */
  readonly open: boolean;
  /** Its credential is gone: one scan pairs it again. */
  readonly needsPair: boolean;
}

/** A store's upgrade under a connect, where there is a count to say: entries applied, of entries this open owes. */
export interface DoorMigrating {
  readonly applied: number;
  readonly pending: number;
  /** Epoch ms of the upgrade's first announcement in this connect: a second line joins a while after it. */
  readonly since: number;
}

/** The connection as the door draws it. The page keeps no row of its own: it draws the last one. */
export interface DoorState {
  readonly session: "none" | "opening" | "live" | "refused" | "ended";
  /** While opening: the phone's own store is being upgraded. Null with no upgrade, and with one nobody counts. */
  readonly migrating: DoorMigrating | null;
  /** Why the session was refused or ended. */
  readonly said: SaidRefusal | null;
  /** The row the session stands on, or null with none. */
  readonly openId: string | null;
  readonly syncing: boolean;
  /** What the last sync round failed on; null where a handshake stopped it ({@link DoorState.syncStopped}). */
  readonly syncSaid: SaidRefusal | null;
  /**
   * A sync round a handshake stopped, by which of the two it is: the key this phone agreed to changed (a pinned
   * pairing), or this phone would not accept the certificate at that address. The platform's words never cross.
   */
  readonly syncStopped: "keyChanged" | "certificate" | null;
  /** The open pairing holds a key this phone agreed to. */
  readonly pinned: boolean;
  /** Letters on this phone, where this side can count them; null under the shell, whose page holds the mail. */
  readonly total: number | null;
  readonly paired: readonly PairedRow[];
  /** What the last forget could not take back: it outlives the row it is about. */
  readonly after: SaidRefusal | null;
}

/** What the door page is told once, before it draws. */
export interface DoorConfig {
  readonly app: ShellApp;
  readonly os: "android" | "ios";
  readonly pad: boolean;
  readonly language: "en" | "de";
  readonly build: { readonly version: string | null; readonly commit: string | null };
  readonly at: DoorAt;
  /** Whether this build can organize a mailbox on the phone itself. A page that cannot read it withholds the way. */
  readonly organizes: "offered" | "withheld";
  /** Whether this build can hold a computer's key; without it a same-network code is refused. */
  readonly canPin: boolean;
  readonly facts: ShellConfig["facts"];
  readonly state: DoorState;
  /** Scopes with a durable confirmation of account erasure. */
  readonly erasedCalendarScopes?: readonly string[];
}

/** Where the camera stands over the page, in CSS px of the page's window. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A mailbox as typed, for this phone to open itself. The login is the address. */
export interface OpenInput {
  readonly address: string;
  /** The password: read natively once, in no answer and no event. */
  readonly pass: string;
  /** The name its letters carry; null sends the bare address. */
  readonly name: string | null;
  readonly imap: { readonly host: string; readonly port: number | null };
  readonly smtp: { readonly host: string; readonly port: number | null } | null;
}

/** The server field a refused open is about, or null for one that belongs beside the verb. */
export type OpenField = "imapHost" | "imapPort" | "smtpHost" | "smtpPort";

type Empty = Record<never, never>;
type Done = { readonly ok: true } | { readonly ok: false; readonly said: SaidRefusal };
type Camera = { readonly camera: "on" | "off" };
/** What a removal would drop that is only on this phone. */
export type OnlyHere = "answer" | "newer" | "unsaved" | "unknown" | "none";

/** The requests, by kind: what the page sends and what native answers. */
export interface DoorRequests {
  readonly config: { readonly ask: Empty; readonly answer: DoorConfig };
  /** The page drew its first frame. */
  readonly ready: { readonly ask: { readonly calendarPrepared?: false }; readonly answer: Empty };
  /** The way back out of the door: to the open mailbox, or to one this phone can open again. */
  readonly leave: { readonly ask: Empty; readonly answer: Empty };
  readonly sync: { readonly ask: Empty; readonly answer: Empty };
  readonly disconnect: { readonly ask: Empty; readonly answer: Empty };
  /** What is at this address, spending nothing. A reached address is held natively for `hand`. */
  readonly "server.ask": {
    readonly ask: { readonly address: string };
    readonly answer:
      | { readonly k: "reached"; readonly address: string; readonly flavor: string; readonly apiUnder: string | null }
      | { readonly k: "refused"; readonly said: SaidRefusal };
  };
  readonly "scan.start": { readonly ask: { readonly rect: Rect }; readonly answer: Camera };
  readonly "scan.move": { readonly ask: { readonly rect: Rect }; readonly answer: Camera };
  readonly "scan.stop": { readonly ask: Empty; readonly answer: Empty };
  /** Ask the system for the camera. */
  readonly "camera.allow": { readonly ask: Empty; readonly answer: Camera };
  /** A code typed or a link pasted. `address: null` is the address `server.ask` reached; a pasted link names its own. */
  readonly hand: { readonly ask: { readonly address: string | null; readonly token: string }; readonly answer: Offer };
  /** The press that spends the code the ticket holds. */
  readonly pair: { readonly ask: { readonly ticket: string }; readonly answer: Done };
  /** The confirmation was left: what the probe installed is given back. */
  readonly dismiss: { readonly ask: { readonly ticket: string }; readonly answer: Empty };
  readonly open: {
    readonly ask: { readonly input: OpenInput };
    readonly answer:
      /** `mailboxId`: the id this phone's engine names the opened mailbox's account by. */
      | { readonly ok: true; readonly mailboxId: string }
      | { readonly ok: false; readonly code: string; readonly field: OpenField | null; readonly args: SaidRefusal["args"] };
  };
  readonly switch: { readonly ask: { readonly id: string }; readonly answer: Done };
  /** What a removal of this row would drop: asked before this phone's own mailbox is removed. */
  readonly "forget.ask": {
    readonly ask: { readonly id: string };
    readonly answer: { readonly drafts: number | null; readonly settings: OnlyHere };
  };
  readonly forget: {
    readonly ask: { readonly id: string; readonly anyway: boolean };
    readonly answer:
      /** Everything on this phone went; `after` says what did not (a server not told, a claim that stands). */
      | { readonly k: "gone"; readonly after: SaidRefusal | null }
      /** Something of it is still on this phone. */
      | { readonly k: "kept"; readonly said: SaidRefusal }
      /** Nothing was removed: the store holds settings the mailbox does not. Removing is the person's answer. */
      | { readonly k: "asks"; readonly settings: Exclude<OnlyHere, "none"> };
  };
  /** Open the system's own settings page. */
  readonly "settings.open": { readonly ask: { readonly what: "notifications" }; readonly answer: Empty };
  /** The bridge's own: the page's answer to an `ask` event, and a request it stopped waiting for. */
  readonly answer: { readonly ask: { readonly askId: number; readonly what: "back"; readonly took: boolean }; readonly answer: Empty };
  readonly cancel: { readonly ask: { readonly of: number }; readonly answer: Empty };
}
export type DoorKind = keyof DoorRequests;

/** A request as it crosses. */
export type DoorRequest<K extends DoorKind = DoorKind> = K extends DoorKind
  ? { readonly id: number; readonly epoch: string; readonly kind: K; readonly ask: DoorRequests[K]["ask"] }
  : never;

export type DoorAnswer<K extends DoorKind = DoorKind> =
  | { readonly id: number; readonly epoch: string; readonly ok: true; readonly answer: DoorRequests[K]["answer"] }
  | { readonly id: number; readonly epoch: string; readonly ok: false; readonly refused: Refused };

/** Native to page, unasked. A scanned code never rides `scan`: only what the probe measured, under a ticket. */
export type DoorEvent =
  | { readonly type: "state"; readonly state: DoorState }
  | { readonly type: "scan"; readonly scan: { readonly k: "notACode" } | Offer }
  | { readonly type: "posture"; readonly reading: FoldReading }
  | { readonly type: "insets"; readonly insets: SafeInsets }
  | { readonly type: "keyboard"; readonly reading: KeyboardReading }
  | { readonly type: "network"; readonly online: boolean }
  | { readonly type: "ask"; readonly askId: number; readonly what: "back" };

/** A ticket's shape: 16 random bytes as lowercase hex. */
export const TICKET_SHAPE = /^[0-9a-f]{32}$/;

/**
 * THE GUARD. Native reads nothing of a message before this has said what it is: a request of a kind of this table
 * whose fields have their types and bounds, or a refusal.
 */
export function readDoorRequest(raw: unknown): DoorRequest | { readonly refused: "unknownKind" | "malformed" } {
  if (typeof raw !== "object" || raw === null) return MALFORMED;
  const m = raw as Record<string, unknown>;
  if (!isId(m.id) || typeof m.epoch !== "string" || m.epoch.length === 0 || m.epoch.length > 64) return MALFORMED;
  if (typeof m.kind !== "string" || !Object.prototype.hasOwnProperty.call(FIELDS, m.kind)) return UNKNOWN;
  return isObj(m.ask) && FIELDS[m.kind as DoorKind](m.ask) ? (m as unknown as DoorRequest) : MALFORMED;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const MALFORMED = { refused: "malformed" } as const;
const UNKNOWN = { refused: "unknownKind" } as const;
const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isTicket = (v: unknown): boolean => typeof v === "string" && TICKET_SHAPE.test(v);
const isRowId = (v: unknown): boolean => isStr(v, 128) && v.length > 0;
const isPort = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 65535);
const isLength = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000;
const isRect = (v: unknown): boolean => isObj(v) && isLength(v.x) && isLength(v.y) && isLength(v.w) && isLength(v.h);
const isServer = (v: unknown): boolean => isObj(v) && isStr(v.host, 255) && isPort(v.port);
const isOpenInput = (v: unknown): boolean =>
  isObj(v) && isStr(v.address, 320) && isStr(v.pass, 1024) && (v.name === null || isStr(v.name, 256)) &&
  isServer(v.imap) && (v.smtp === null || isServer(v.smtp));

const none = (): boolean => true;
const FIELDS: { readonly [K in DoorKind]: (m: Record<string, unknown>) => boolean } = {
  config: none,
  ready: (m) => m.calendarPrepared === undefined || m.calendarPrepared === false,
  leave: none,
  sync: none,
  disconnect: none,
  "server.ask": (m) => isStr(m.address, 2048),
  "scan.start": (m) => isRect(m.rect),
  "scan.move": (m) => isRect(m.rect),
  "scan.stop": none,
  "camera.allow": none,
  hand: (m) => (m.address === null || isStr(m.address, 2048)) && isStr(m.token, 4096),
  pair: (m) => isTicket(m.ticket),
  dismiss: (m) => isTicket(m.ticket),
  open: (m) => isOpenInput(m.input),
  switch: (m) => isRowId(m.id),
  "forget.ask": (m) => isRowId(m.id),
  forget: (m) => isRowId(m.id) && typeof m.anyway === "boolean",
  "settings.open": (m) => m.what === "notifications",
  answer: (m) => isId(m.askId) && m.what === "back" && typeof m.took === "boolean",
  cancel: (m) => isId(m.of),
};
