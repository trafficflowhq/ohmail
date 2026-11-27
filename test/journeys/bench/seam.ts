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

export interface Found { named?: string; sender?: string; args?: Record<string, string | number> }

/** What a control says of itself to a screen reader. */
export interface Spoken {
  description: string; pressed: string | null; selected: string | null; current: string | null;
  expanded: string | null; checked: string | null; disabled: boolean; editable: boolean;
}

/** One request the API answered: the route's own pattern, never the address that reached it. */
export interface Heard { method: string; pattern: string; status: number }

/**
 * What a door does with a request: answer as the route does, refuse it at the wire, or hold it,
 * asked and unanswered, until the bench lets go (`release`).
 */
export type DoorFault = (method: string, pattern: string) => "refuse" | "hold" | "hold-answer" | null;

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
  reload(): Promise<void>;
  /** Restart through the app's own notice after the server starts reporting a different build. */
  restartForNewBuild(): Promise<void>;
  /** Close this tab and let the browser run pagehide. */
  closeTab(): Promise<void>;
  /** Take this window offline after its current requests settle. */
  goOffline(): Promise<void>;
  goOnline(): Promise<void>;
  /** Open Settings with its script response held and return to the previous place offline. */
  goOfflineWhileOpeningSettings(): Promise<void>;
  /** Wait for the language the window declares to its screen reader. */
  hearsLanguage(lang: Language): Promise<void>;
  /** Wait for a particular tag's own route. */
  inTag(): Promise<void>;
  /** Make any attempt to request browser notification permission fail. */
  refuseNotificationPrompt(): Promise<void>;
  /** Open a link someone handed this person (an invite's), as they open it; the answer's status where the window shows it. */
  follow(link: string): Promise<{ status: number | null }>;
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
  reads(key: string | readonly string[], args?: Record<string, string | number>, ms?: number): Promise<void>;
  /** Wait for the catalogue sentence whose closing stop is drawn as a dot. */
  readsWithDot(key: string, ms?: number): Promise<void>;
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
  /**
   * WHAT THIS BROWSER KEEPS: each entry its stored keys hold, by key, with the marker words of the walk (`marks`'s
   * matches) its value holds; a value itself is never handed out. The far end of "nothing of A's is kept under B".
   */
  kept(marks: RegExp): Promise<Record<string, string[]>>;
  storedWriting(words: string, draftSubject?: string): Promise<string[]>;
  holdMirrorWrites(): Promise<void>;
  /**
   * An entry another tab of this browser left, as it left it (a closed tab's letter, under its own account's key):
   * written from a tab of this browser that is opened on the install's name for it and closed again, so it stands
   * before this window's first page as well as under a page on screen.
   */
  keep(key: string, value: string): Promise<void>;
  /** Does anything this window draws show these words (a letter's words that must not reach another account)? */
  shows(words: string): Promise<boolean>;
  /**
   * TIME PASSES FOR THIS WINDOW: its clock moves `ms` forward at once and every timer due in that span runs (an
   * autosave's delay, a window that closes). Never a wait. Refused where the window's clock is not driven
   * (`person({ clock: "driven" })`).
   */
  later(ms: number): Promise<void>;
  /** What breaks the bench's promises: page errors, console errors, requests that tried to leave. */
  problems(tolerated?: RegExp[]): string[];
}

/** An account made at the API and not yet signed in anywhere: what its person knows, and their authenticator. */
export interface Registered {
  email: string;
  password: string;
  /** The authenticator's next code: one per time step, never a step the server has already taken. */
  code(): Promise<string>;
}

/** What the self-hosted stack gives beyond a window; null on every other bench. */
export interface Stack {
  /** The install's origin under a name it was not set up for, resolved to this machine by the bench's browser. */
  elsewhere: string;
  /** An account registered at the API, with its second factor, signed in nowhere. */
  registered(): Promise<Registered>;
  /** An invite's link, as the person who made it would send it. */
  invite(): string;
  /** A new container for the service, as a deploy or a move of the host makes one. */
  recreate(service: "api"): Promise<void>;
  /** The API asked inside its container, under a Host of the journey's choosing. */
  inside(ask: { host: string; path: string; account: Account }): Promise<{ status: number; user: boolean }>;
  /** The address of the mailbox the bench connected for the account, on the stack's own mail server. */
  mailbox(account: Account): string;
  /**
   * A letter from an invented sender, delivered to the account's mailbox through the stack's mail server and
   * brought in by its organizer: resolves with the letter's message ids once /sync names it.
   */
  deliver(account: Account, letter: { from: { name: string; address: string }; subject: string; text: string }): Promise<string[]>;
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
  /** Let held requests through and stop intercepting. A held request is tracked until it finishes. */
  release(): void;
  /** The demo's read-only world; null where the world is planted per account. */
  fixtures: ReturnType<typeof fixturesPlanter> | null;
  has(need: Need): boolean;
  /**
   * One request to the API as the account's own browser would make it; the far end of a journey. `fresh`: from a
   * session of the account's own made for this one request, for the far end after the account signed out of the
   * browser (its server still keeps its letters); refused on a bench that cannot make one.
   */
  ask(a: Account, method: string, path: string, o?: { session?: "fresh"; body?: unknown }): Promise<{ status: number; body: unknown }>;
  /** A new account with a live session. Not on the demo. */
  account(): Promise<Account>;
  /**
   * A new window for a person; signed in when an account is given. `door` is the demo's second way in; `host` the
   * name the account's cookies are put under (the stack's foreign name), the install's own when not given.
   */
  person(o?: { account?: Account; door?: "/demo" | "/?demo=1"; lang?: Language; host?: string; clock?: "driven" }): Promise<Person>;
  /**
   * ANOTHER TAB OF THIS BROWSER SIGNED IN AS `account`: the jar this window shares now names that account, as a
   * completed sign-in leaves it, and the page on screen is left as it stands (nothing is loaded again). Refused on
   * a bench that cannot hand a jar another account's session.
   */
  signedInElsewhere(person: Person, account: Account): Promise<void>;
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
/** This machine's loopback, each way an address names it: the only place a bench's browser and its far end may reach. */
export const LOOPBACK: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

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
