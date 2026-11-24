/**
 * THE PHONE'S WAYS IN, AS THEIR PAGE SEES THE DOOR. The door's page (the shell's second start page on a phone, while
 * no account is open) hands this page what native last said and the door's requests, and nothing else: no engine,
 * no store, no scope. The shapes below are this folder's own copies of the door's (`apps/mobile/src/shell/
 * door-kinds.ts`), since this package never imports the phone app; the door page's `pages.tsx` holds the two equal at
 * compile time, so a change to either stops the build.
 *
 * WHAT NEVER STANDS HERE: a pairing code that was scanned (native keeps it and hands a one-use ticket), a mailbox's
 * password (the one connect form's field and the body of the door's `open` alone), a typed pairing code after the
 * press that sent it.
 */
import type { ReactNode } from "react";
import type { SaidRefusal } from "@ohmail/app-logic/phone/said";
import type { BackSignal, Signal } from "../host/index.js";
import type { ConnectAsk, ConnectFormProps } from "../mailboxes/connect/contract.js";

export type { SaidRefusal } from "@ohmail/app-logic/phone/said";

/** Which of its two pages the door stands at; the steps inside the ways in are this page's own, in memory. */
export type PhoneDoorAt = "welcome" | "servers";

/** What a probe measured at an address: never a field of the link that named it. */
export interface PhonePairFacts {
  readonly what: "computer" | "server" | "hosted" | "local";
  /** Scheme, host and port, whole. */
  readonly address: string;
  /** The key as the twelve characters a person compares, or null where the system verifies the address. */
  readonly key: string | null;
}

/** A pairing a person may confirm, held natively under a one-use ticket; or why there is none. */
export type PhoneOffer =
  | { readonly k: "offers"; readonly ticket: string; readonly facts: PhonePairFacts }
  | { readonly k: "refused"; readonly said: SaidRefusal };

/** One row of this phone's list. */
export interface PhonePairedRow {
  readonly id: string;
  readonly kind: "hosted" | "server" | "computer" | "own";
  readonly address: string;
  readonly account: string | null;
  readonly open: boolean;
  readonly needsPair: boolean;
}

/** A store's upgrade under a connect, where there is a count to say. */
export interface PhoneDoorMigrating {
  readonly applied: number;
  readonly pending: number;
  /** Epoch ms of the upgrade's first announcement in this connect. */
  readonly since: number;
}

/** The connection as native last told it. The page keeps no row of its own: it draws the last one. */
export interface PhoneDoorState {
  readonly session: "none" | "opening" | "live" | "refused" | "ended";
  readonly migrating: PhoneDoorMigrating | null;
  readonly said: SaidRefusal | null;
  readonly openId: string | null;
  readonly syncing: boolean;
  readonly syncSaid: SaidRefusal | null;
  /** A sync a handshake stopped, as which of the two it is; `syncSaid` is null then. */
  readonly syncStopped: "keyChanged" | "certificate" | null;
  readonly pinned: boolean;
  readonly total: number | null;
  readonly paired: readonly PhonePairedRow[];
  readonly after: SaidRefusal | null;
}

/** What of native's word about this page the ways in read: told once. */
export interface PhoneDoorConfig {
  readonly app: "ohmail" | "ohcal";
  readonly os: "android" | "ios";
  readonly pad: boolean;
  readonly language: "en" | "de";
  /** Whether this build can organize a mailbox on the phone itself. Anything but `offered` withholds the way. */
  readonly organizes: "offered" | "withheld";
  /** Whether this build can hold a computer's key. */
  readonly canPin: boolean;
}

/** Where the camera stands over the page, in CSS px of the page's window. */
export interface PhoneRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Whether the camera runs: `off` is no permission. */
export interface PhoneCamera {
  readonly camera: "on" | "off";
}

/** What the camera read: a frame that was no pairing code, or what a probe measured under a ticket. */
export type PhoneScanned = { readonly k: "notACode" } | PhoneOffer;

/** What answers at an address. A reached address is held natively for a code typed by hand. */
export type PhoneServerAnswer =
  | {
      readonly k: "reached";
      readonly address: string;
      readonly flavor: string;
      readonly apiUnder: string | null;
    }
  | { readonly k: "refused"; readonly said: SaidRefusal };

/** The press's answer. Only `ok === true` is a yes: anything else is a refusal. */
export type PhonePairAnswer = { readonly ok: true } | { readonly ok: false; readonly said: SaidRefusal };

/** The camera's steps and what it read. Each step is one request of the door; `listen` hands on what native read. */
export interface PhoneScan {
  start(rect: PhoneRect): Promise<PhoneCamera>;
  move(rect: PhoneRect): Promise<PhoneCamera>;
  stop(): void;
  allow(): Promise<PhoneCamera>;
  listen(heard: (scan: PhoneScanned) => void): () => void;
}

/**
 * THE DOOR AS THE WAYS IN SEE IT. Every request may reject (the bridge refused it, a deadline passed): the page says
 * the unknown sentence then, never the bridge's word.
 */
export interface PhoneDoor {
  readonly config: PhoneDoorConfig;
  readonly state: Signal<PhoneDoorState>;
  /** What answers at an address (`server.ask`). */
  ask(address: string): Promise<PhoneServerAnswer>;
  readonly scan: PhoneScan;
  /** A typed code or a pasted link, measured (`hand`). `address: null` is the address `ask` reached. */
  hand(typed: { readonly address: string | null; readonly token: string }): Promise<PhoneOffer>;
  /** THE press: spends the code the ticket holds (`pair`). */
  pair(ticket: string): Promise<PhonePairAnswer>;
  /** Every way out of Confirm that is not the press (`dismiss`). */
  dismiss(ticket: string): void;
  /** The one connect form, as a slot: its wire sends the door's `open`. */
  readonly connect: (ask: ConnectAsk, page: NonNullable<ConnectFormProps["page"]>) => ReactNode;
  /** The door's route, in memory. */
  go(to: PhoneDoorAt): void;
  /** The hardware back: newest handler first; true is "taken". Not taken, native takes the door's way out. */
  readonly back: BackSignal;
}
