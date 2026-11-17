import type { ActId } from "../vocabulary/acts.js";
import type { Language } from "../vocabulary/catalogue.js";
import type { ControlId } from "../vocabulary/controls.js";
import type { AriaRole, PlaceId } from "../vocabulary/places.js";
import type { apiPlanter, fixturesPlanter } from "../vocabulary/world.js";

/**
 * THE DRIVER SEAM. What every bench gives a journey, whatever drives the window: the web's Chromium, the
 * self-hosted stack's, the desktop's window driver or the phone's web view. A journey speaks only these
 * words (arrive, act, see, plant, faults), by place and control id. Types and the setting's reader only:
 * this file loads no browser, no test runner and no server.
 */

/**
 * Where a journey runs. W-m, W-s, W-d: the web against the managed server, a self-hosted one, or the demo;
 * W-i: the self-hosted web from its images, as an operator runs it; D-l, D-m, D-s, D-p: the desktop on its
 * own engine, against the managed server, against a self-hosted one, and paired; H: the page a desktop serves
 * to a phone's browser; P-p, P-o: the phone paired, and on its own.
 */
export type Setting = "W-m" | "W-s" | "W-d" | "W-i" | "D-l" | "D-m" | "D-s" | "D-p" | "H" | "P-p" | "P-o";
export type BenchId = "web" | "stack" | "desktop" | "android";
/** What a journey needs of its bench beyond a window: a real Postgres, a mail server, the stack's own containers, native doors. */
export type Need = "pg" | "mail" | "stack" | "native";
/** The window's size class (`TF_JOURNEYS_SIZE`); expanded unless named. */
export type Size = "expanded" | "medium" | "compact";
export const SIZES: readonly Size[] = ["expanded", "medium", "compact"];

export interface Guard {
  title: string;
  /** The fault index's rows this journey stands for. */
  rows: string[];
  surfaces: Setting[];
  needs: Need[];
  /** An open row: the fault stands today, so the journey is expected to fail. */
  open?: boolean;
  /** Console lines this journey expects, as patterns (a refused door logs its status). */
  tolerates?: RegExp[];
}

export interface Found { named?: string; args?: Record<string, string | number> }

/** What a control says of itself to a screen reader. */
export interface Spoken {
  description: string; pressed: string | null; selected: string | null; current: string | null;
  expanded: string | null; disabled: boolean;
}

/** One request the API answered: the route's own pattern, never the address that reached it. */
export interface Heard { method: string; pattern: string; status: number }

/**
 * What a door does with a request: answer as the route does, refuse it at the wire, or hold it,
 * asked and unanswered, until the bench lets go (`release`).
 */
export type DoorFault = (method: string, pattern: string) => "refuse" | "hold" | null;

/** A person's session, as the sign-in ceremony leaves it. */
export interface Account {
  accountId: string; userId: string; email: string; access: string; refresh: string; familyId: string;
  planter: ReturnType<typeof apiPlanter>;
}

/** What only a phone or a desktop window does: outside every page, so outside the vocabulary of controls. */
export type NativeActId = "back" | "background" | "foreground" | "open-link" | "end-process";

/** One person at one window. Everything they do and see goes through the vocabulary. */
export interface Person {
  /** The language the app speaks to this person; English until they choose another (`speak`). */
  lang: Language;
  /** Go to a place and wait for the thing that says you are there. */
  arrive(place: PlaceId): Promise<void>;
  /** Wait for a place's landmark without going anywhere. */
  here(place: PlaceId, ms?: number): Promise<void>;
  /** Go to the install's front door, as a person who types its name does. */
  front(): Promise<void>;
  act(act: ActId, id: ControlId, found?: Found & { value?: string }): Promise<void>;
  /** Wait until the control is on screen. */
  see(id: ControlId, found?: Found, ms?: number): Promise<void>;
  /** Wait until the control is not on screen. */
  gone(id: ControlId, found?: Found, ms?: number): Promise<void>;
  /** Is the control on screen now? No waiting: for "it is not offered here". */
  offered(id: ControlId, found?: Found): Promise<boolean>;
  spoken(id: ControlId, found?: Found): Promise<Spoken>;
  /** The words a box holds now. */
  holds(id: ControlId, found?: Found): Promise<string>;
  /** The words inside the control, as a person reads them. */
  text(id: ControlId, found?: Found): Promise<string>;
  /** The names of the controls of `role` inside `id`, as a screen reader lists them. */
  listed(id: ControlId, role: AriaRole): Promise<string[]>;
  /** The controls of `role` inside `id`, each with its name and what it says of itself. */
  rows(id: ControlId, role: AriaRole): Promise<Array<{ name: string; description: string }>>;
  /** Wait until the page says the catalogue's sentence for `key`. */
  reads(key: string, args?: Record<string, string | number>, ms?: number): Promise<void>;
  /** Wait for a sight. Never for time: `sight` is asked until it holds. */
  until(sight: () => Promise<boolean>, what: string, ms?: number): Promise<void>;
  /** A native door: refused on a bench that has none. */
  native(act: NativeActId, value?: string): Promise<void>;
  /** A second tab of the same window: the same cookies and storage, its own page. */
  tab(): Promise<Person>;
  /** Choose the app's language as a person does. */
  speak(lang: Language): Promise<void>;
  /** Every address this window asked for, the refused ones included. */
  requests(): string[];
  /** What breaks the bench's promises: page errors, console errors, requests that tried to leave. */
  problems(tolerated?: RegExp[]): string[];
}

/** What the self-hosted stack gives beyond a window; null on every other bench. */
export interface Stack {
  /** A new container for the service, as a deploy or a move of the host makes one. */
  recreate(service: "api"): Promise<void>;
  /** The API asked inside its container, under a Host of the journey's choosing. */
  inside(ask: { host: string; path: string; account: Account }): Promise<{ status: number; user: boolean }>;
}

export interface Bench {
  id: BenchId;
  setting: Setting;
  size: Size;
  /** `managed`, `selfhost` or `demo`: which build of the web app the window shows. */
  flavour: "managed" | "selfhost" | "demo";
  origin: string;
  /** The API's own log of what it answered; empty where the bench cannot hear it. */
  heard: Heard[];
  faults: DoorFault[];
  /** The requests a door is holding now, as `METHOD pattern`. */
  held(): string[];
  /** Let every held request through to its route, and hold and refuse no more. */
  release(): void;
  /** The demo's read-only world; null where the world is planted per account. */
  fixtures: ReturnType<typeof fixturesPlanter> | null;
  has(need: Need): boolean;
  /** One request to the API as the account's own browser would make it; the far end of a journey. */
  ask(a: Account, method: string, path: string): Promise<{ status: number; body: unknown }>;
  /** A new account with a live session. Not on the demo. */
  account(): Promise<Account>;
  /** A new window for a person; signed in when an account is given. `door` is the demo's second way in. */
  person(o?: { account?: Account; door?: "/demo" | "/?demo=1"; lang?: Language }): Promise<Person>;
  /** Is the account's session still able to renew? (the far end of a sign-out) */
  sessionLive(a: Account): Promise<boolean>;
  stack: Stack | null;
  problems(tolerated?: RegExp[]): string[];
  /** What every open window shows and what the API heard, for a failing journey's log. */
  story(): Promise<string>;
  closePeople(): Promise<void>;
  stop(): Promise<void>;
}

/** `TF_JOURNEYS`'s words, and the bench and setting each names. `host` (H) is read by the desktop's own test file. */
export const WORDS = {
  managed: { id: "web", setting: "W-m" },
  selfhost: { id: "web", setting: "W-s" },
  demo: { id: "web", setting: "W-d" },
  stack: { id: "stack", setting: "W-i" },
  desktop: { id: "desktop", setting: "D-s" },
  android: { id: "android", setting: "P-p" },
} as const satisfies Record<string, { id: BenchId; setting: Setting }>;
export type Word = keyof typeof WORDS;
export const HOST = "host";

/** The bench `TF_JOURNEYS` names; null when unset or `host`. Any other word is refused, never read as a default. */
export function benchOf(env: NodeJS.ProcessEnv = process.env): { id: BenchId; setting: Setting; word: Word } | null {
  const raw = (env.TF_JOURNEYS ?? "").trim();
  if (raw === "" || raw === HOST) return null;
  if (Object.hasOwn(WORDS, raw)) return { ...WORDS[raw as Word], word: raw as Word };
  throw new Error(`TF_JOURNEYS must be one of ${[...Object.keys(WORDS), HOST].map((w) => JSON.stringify(w)).join(", ")}, not ${JSON.stringify(raw)}`);
}

/** The window's size class `TF_JOURNEYS_SIZE` names; expanded when unset. Any other word is refused. */
export function sizeOf(env: NodeJS.ProcessEnv = process.env): Size {
  const raw = (env.TF_JOURNEYS_SIZE ?? "").trim();
  if (raw === "") return "expanded";
  if ((SIZES as readonly string[]).includes(raw)) return raw as Size;
  throw new Error(`TF_JOURNEYS_SIZE must be one of ${SIZES.join(", ")}, not ${JSON.stringify(raw)}`);
}
