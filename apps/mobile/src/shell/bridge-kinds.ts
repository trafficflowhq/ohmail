/**
 * THE BRIDGE BETWEEN THE PHONE'S WEB VIEW AND ITS NATIVE SIDE, as types. Both sides import this
 * file: the page under `web/`, and the native side under `src/shell/`. It holds one value, the
 * guard {@link readRequest}, which native runs on every message before anything else reads it.
 *
 * The page is the less trusted side: it draws letters, which are hostile content. So no kind
 * takes an address, a host, a file path, SQL or a keystore name; a request names a root-relative
 * path and native composes the origin, the base and the bearer. A link leaves only as the web
 * view's own navigation (native then asks, `linkAsk`), never as an address the page hands over.
 *
 * ENVELOPE. Page to native: `{ id, epoch, kind, ... }`, one answer per id. Native to page: answers
 * `{ id, epoch, ok, ... }` and events `{ type, epoch, ... }`. Native mints the epoch per web view
 * instance; each side drops a message of another epoch, and native aborts every request of an
 * epoch that ended. The page owns request ids and their deadlines; an abort sends `cancel`.
 * Native owns `ask` ids and their one deadline ({@link ASK_DEADLINE_MS}).
 *
 * A message over {@link PIECE_BYTES} crosses as pieces: its text in pieces of at most that size,
 * then a head naming how many there were ({@link Piece}, {@link Joined}). The receiver joins them
 * and parses the whole once. Page to native, the native module joins them before anything else
 * reads the message, so the guard only ever sees whole requests.
 *
 * The facts that cross have the bridge's own shapes below, not an import of the host contract: the
 * contract's door reaches the kit, which the app's own program (Expo's lib) does not type. The page
 * holds each shape equal to the contract's (`web/src/signals.ts`), so the two cannot drift. This
 * file imports nothing but the switch's place (`../switch/place`), which imports nothing.
 *
 * THE SWITCH BETWEEN THE TWO APPS crosses as three closed kinds and one event, and none of them carries an address,
 * an account, a code or the other app's sign-in: the page asks whether the other app is here, asks native to open
 * it at a place, or to open its store page. Native does every part of it; the page only asks.
 */
import { isSwitchPlace, type SwitchPlace } from "../switch/place";

/** The permission to post notices, as the system reads it. */
export type NoticePermission = "granted" | "denied" | "default" | "unsupported";

/** One fold, as the platform states it, in window coordinates (CSS px). */
export interface FoldFeature {
  readonly bounds: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly state: "flat" | "half";
  readonly orientation: "horizontal" | "vertical";
  readonly occlusion: "none" | "full";
}
/** The folds crossing the window now, and whether the device has a fold at all. */
export interface FoldReading {
  readonly folds: readonly FoldFeature[];
  readonly hasFold: boolean;
}
/** What the system draws over the window's edges, in CSS px. */
export interface SafeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}
/** How much of the window the keyboard covers, in CSS px; 0 while it is down. */
export interface KeyboardReading {
  readonly height: number;
}
/** A letter to write, handed in from outside. */
export interface LinkedDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/** The largest piece of a body that crosses in one message. */
export const PIECE_BYTES = 256 * 1024;
/** How long native waits for the page's answer to an `ask`; no answer is "not taken". */
export const ASK_DEADLINE_MS = 700;
/** The longest path a request may name, checked before anything else reads it. */
export const PATH_MAX = 2048;

/** A body as it crosses: text for text and JSON, base64 for bytes only. */
export type Body = { readonly as: "text"; readonly text: string } | { readonly as: "b64"; readonly b64: string };

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
/** Header names lower-cased, in order. */
export type Headers = readonly (readonly [string, string])[];

/**
 * Which of the four settings this page runs in. The first three are a paired phone, by the
 * profile's flavor; the last is a phone whose own engine organizes its mailbox.
 */
export type ShellSetting = "managed" | "selfHosted" | "desktopHost" | "standalone";

/** Which of the two apps this page runs in: the mail or the calendar. */
export type ShellApp = "ohmail" | "ohcal";

/**
 * Whether the other app is on this phone, as the system says it now. `unknown` where the system cannot say before a
 * press (the iPhone): a press then tries, and reads a refusal as `absent`.
 */
export type OtherAppState = "here" | "absent" | "unknown";

export type { SwitchPlace };

/** What the page is told once, before it mounts anything. */
export interface ShellConfig {
  /** The app the page runs in, read natively from the app's own identifier. */
  readonly app: ShellApp;
  /** Whether the other app is here at the page's start; each later reading comes as the `other` event. */
  readonly other: OtherAppState;
  /** The storage partition and the copy's owner: native mints it, the page never derives one. */
  readonly scope: string;
  /** The account the server names, opaque. A page that answers for another account is refused. */
  readonly accountId: string;
  readonly setting: ShellSetting;
  /** The server's host name, for display only. Nothing dials it from the page. */
  readonly serverName: string;
  readonly build: { readonly version: string | null; readonly commit: string | null };
  readonly language: "en" | "de";
  /** Where to return to after the web view's process ended, or null for the first place. */
  readonly place: string | null;
  /** The phone's old copy of this mailbox waits to be handed across once (`oldCopy.page`). */
  readonly oldCopy: "present" | "absent";
  readonly notifications: NoticePermission;
  /** The readings as they stand now; each later change comes as its event. */
  readonly facts: {
    readonly posture: FoldReading;
    readonly insets: SafeInsets;
    readonly keyboard: KeyboardReading;
    readonly online: boolean;
  };
}

/** Device acts a page may ask for. None names an address. */
export type ShellAct =
  | { readonly act: "signOut" }
  | { readonly act: "openServers" }
  | { readonly act: "chrome"; readonly scheme: "light" | "dark" }
  | { readonly act: "notifications.permission" }
  | { readonly act: "notifications.request" }
  | { readonly act: "diagnostics.share" }
  | { readonly act: "backup.read" };

/**
 * What native was asked to keep under a word it refused: SHA-256 over the word's UTF-16 code units, each low byte
 * first, as lowercase hex; `null` for a removal.
 */
export type WordDigest = string | null;

/** One row of the queue the keeper holds, as the store persists it: a type, an id, its record. */
export interface KeptRow {
  readonly type: string;
  readonly id: string;
  readonly json: string;
}

/** What the page may note to native: a member of a closed set, and numbers. Never free text. */
export type NoteWhat =
  | "mounted" | "durabilityLost" | "keeperRefused" | "pieceDropped" | "foreignEpoch" | "deadlinePassed"
  | "consoleError" | "consoleWarn" | "copyFilled" | "copyHandedAcross" | "copyNotTaken";

/** The requests, by kind: what the page sends and what native answers. */
export interface Requests {
  readonly config: { readonly ask: Record<never, never>; readonly answer: ShellConfig };
  /** The page drew its first frame at this place. */
  readonly ready: { readonly ask: { readonly place: string }; readonly answer: Record<never, never> };
  /** The place a person is in, kept natively to return to after the web view's process ended. */
  readonly place: { readonly ask: { readonly fragment: string }; readonly answer: Record<never, never> };
  readonly http: {
    readonly ask: {
      readonly scope: string;
      readonly method: HttpMethod;
      /** Root-relative: `/` then the rest. Native adds the origin, the base and the bearer. */
      readonly path: string;
      readonly headers: Headers;
      readonly body: Body | null;
    };
    readonly answer: { readonly status: number; readonly headers: Headers; readonly body: Body | null };
  };
  readonly cancel: { readonly ask: { readonly of: number }; readonly answer: Record<never, never> };
  readonly act: {
    readonly ask: ShellAct;
    readonly answer: { readonly permission?: NoticePermission; readonly backup?: "excluded" | "included" | "unknown" };
  };
  /** A link the web view's own navigation asked to open, held natively by its token. */
  readonly linkAskOpen: { readonly ask: { readonly token: string }; readonly answer: { readonly opened: boolean } };
  /** The page's answer to an `ask` event. */
  readonly answer: {
    readonly ask:
      | { readonly askId: number; readonly what: "back"; readonly took: boolean }
      | { readonly askId: number; readonly what: "unsent"; readonly unsent: number };
    readonly answer: Record<never, never>;
  };
  /** A person's words or intent, written natively before the page's own write. `null` removes. */
  readonly keep: { readonly ask: { readonly key: string; readonly value: string | null }; readonly answer: { readonly kept: boolean } };
  /**
   * Every kept word of the live scope, read before the page mounts; and the words of the live scope native was asked
   * to keep and refused, not kept since, each with the {@link WordDigest} of what it was asked to keep there.
   */
  readonly kept: {
    readonly ask: Record<never, never>;
    readonly answer: {
      readonly words: readonly (readonly [string, string])[];
      readonly refused: readonly (readonly [string, WordDigest])[];
    };
  };
  /** The queue's rows, written natively before the store publishes them. */
  readonly keepRows: {
    readonly ask: { readonly scope: string; readonly puts: readonly KeptRow[]; readonly deletes: readonly (readonly [string, string])[] };
    readonly answer: { readonly kept: boolean };
  };
  readonly keptRows: { readonly ask: { readonly scope: string }; readonly answer: { readonly rows: readonly KeptRow[] } };
  /** The phone's old copy, read once in pages and handed across. */
  readonly "oldCopy.page": {
    readonly ask: { readonly scope: string; readonly after: string | null };
    readonly answer: { readonly entities: readonly KeptRow[]; readonly meta: readonly (readonly [string, string])[]; readonly next: string | null };
  };
  readonly "oldCopy.done": { readonly ask: { readonly scope: string }; readonly answer: Record<never, never> };
  readonly note: { readonly ask: { readonly what: NoteWhat; readonly n: number }; readonly answer: Record<never, never> };
  /** Whether the other app is on this phone now. */
  readonly "switch.read": { readonly ask: Record<never, never>; readonly answer: { readonly other: OtherAppState } };
  /**
   * Open the other app at a place: from ohmail an event or the last place, from ohcal a letter or the last place.
   * `absent` when the system took no app for it; the page then offers the store.
   */
  readonly "switch.open": {
    readonly ask: { readonly to: SwitchPlace };
    readonly answer: { readonly went: "opened" | "absent" };
  };
  /** Open the other app's store page; native composes where it goes. */
  readonly "switch.store": { readonly ask: Record<never, never>; readonly answer: { readonly opened: boolean } };
}
export type Kind = keyof Requests;

/** A request as it crosses. */
export type Request<K extends Kind = Kind> = K extends Kind
  ? { readonly id: number; readonly epoch: string; readonly kind: K } & Requests[K]["ask"]
  : never;
/**
 * A large message as it crosses: its text in pieces, then the head that names how many. Page to
 * native they carry the request's id; native to page, the answer's id or 0 for an event.
 */
export interface Piece {
  readonly id: number;
  readonly epoch: string;
  readonly kind: "piece";
  readonly seq: number;
  readonly chunk: string;
}
export interface Joined {
  readonly id: number;
  readonly epoch: string;
  readonly kind: "joined";
  readonly count: number;
}

/** Why native did not answer a request with its answer. */
export type Refused =
  | "unknownKind" | "malformed" | "foreignEpoch" | "foreignScope" | "notReady" | "notRelayed" | "tooLarge"
  | "tooMany" | "cancelled" | "unreachable" | "notKept";

export type Answer<K extends Kind = Kind> =
  | ({ readonly id: number; readonly epoch: string; readonly ok: true } & Requests[K]["answer"])
  | { readonly id: number; readonly epoch: string; readonly ok: false; readonly refused: Refused };

/** Where an incoming link leads: a closed set. The raw link never crosses. */
export type LinkInTarget =
  | { readonly to: "message"; readonly id: string }
  | { readonly to: "event"; readonly id: string }
  | { readonly to: "compose"; readonly draft: LinkedDraft };

/** Native to page, unasked. */
export type ShellEvent =
  | { readonly type: "posture"; readonly reading: FoldReading }
  | { readonly type: "insets"; readonly insets: SafeInsets }
  | { readonly type: "keyboard"; readonly reading: KeyboardReading }
  | { readonly type: "network"; readonly online: boolean }
  | { readonly type: "wake"; readonly why: "foreground" | "push" }
  | { readonly type: "linkIn"; readonly target: LinkInTarget }
  | { readonly type: "ask"; readonly askId: number; readonly what: "back" | "unsent" }
  | { readonly type: "linkAsk"; readonly token: string; readonly url: string }
  /** A `mailto:` the person pressed in the page, handed back for the page's composer to parse once. */
  | { readonly type: "mailto"; readonly url: string }
  | { readonly type: "session"; readonly state: "live" | "refused" }
  /** The other app's presence read again, at each return of this app to the front. */
  | { readonly type: "other"; readonly state: OtherAppState };
export type Event = ShellEvent & { readonly epoch: string };

/**
 * THE GUARD. Native reads nothing of a message before this has said what it is: a request of a
 * known kind whose fields have their types, or a refusal. A path is root-relative: one `/`, then
 * no second `/` at its start, no backslash, no control byte, no dot segment, no encoded slash or
 * backslash, and at most {@link PATH_MAX} characters, counted before anything else reads it.
 * What a path may reach is the door's question, not the guard's. A switch's place is judged against
 * `app`, the app the guard runs in: a place that points the other way is malformed, and with no app
 * named every place is.
 */
export function readRequest(
  raw: unknown, app: ShellApp | null = null,
): Request | { readonly refused: "unknownKind" | "malformed" } {
  if (typeof raw !== "object" || raw === null) return MALFORMED;
  const m = raw as Record<string, unknown>;
  if (!isId(m.id) || typeof m.epoch !== "string" || m.epoch.length === 0 || m.epoch.length > 64) return MALFORMED;
  if (typeof m.kind !== "string" || !Object.prototype.hasOwnProperty.call(FIELDS, m.kind)) return UNKNOWN;
  return FIELDS[m.kind as Kind](m, app) ? (m as unknown as Request) : MALFORMED;
}

const MALFORMED = { refused: "malformed" } as const;
const UNKNOWN = { refused: "unknownKind" } as const;
const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length <= max;
/** Each closed set once, as a record its union types: a member the guard does not list fails to compile. */
const METHODS: Record<HttpMethod, true> = { GET: true, HEAD: true, POST: true, PUT: true, PATCH: true, DELETE: true };
const ACTS: Record<ShellAct["act"], true> = {
  signOut: true, openServers: true, chrome: true, "notifications.permission": true, "notifications.request": true,
  "diagnostics.share": true, "backup.read": true,
};
const NOTES: Record<NoteWhat, true> = {
  mounted: true, durabilityLost: true, keeperRefused: true, pieceDropped: true, foreignEpoch: true, deadlinePassed: true,
  consoleError: true, consoleWarn: true, copyFilled: true, copyHandedAcross: true, copyNotTaken: true,
};
const member = (set: object, v: unknown): boolean => typeof v === "string" && Object.prototype.hasOwnProperty.call(set, v);

/** Root-relative, and nothing a URL parser could read as another place. */
export function isRootRelative(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > PATH_MAX) return false;
  if (path[0] !== "/" || path[1] === "/" || path.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const bare = path.split(/[?#]/, 1)[0]!;
  if (/%(2f|5c|2e)/i.test(bare)) return false;
  return !bare.split("/").some((seg) => seg === "." || seg === "..");
}

const isHeaders = (v: unknown): v is Headers =>
  Array.isArray(v) && v.length <= 64 &&
  v.every((h) => Array.isArray(h) && h.length === 2 && isStr(h[0], 128) && isStr(h[1], 8192));
const isBody = (v: unknown): v is Body => {
  if (v === null) return true;
  if (typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (b.as === "text" && typeof b.text === "string") || (b.as === "b64" && typeof b.b64 === "string");
};
const isRow = (v: unknown): v is KeptRow => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return isStr(r.type, 64) && isStr(r.id, 256) && typeof r.json === "string";
};
const isPairs = (v: unknown): boolean =>
  Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && isStr(p[0], 256) && isStr(p[1], 256));

const FIELDS: { readonly [K in Kind]: (m: Record<string, unknown>, app: ShellApp | null) => boolean } = {
  config: () => true,
  ready: (m) => isStr(m.place),
  place: (m) => isStr(m.fragment),
  http: (m) => isStr(m.scope, 128) && member(METHODS, m.method) && isRootRelative(m.path) &&
    isHeaders(m.headers) && isBody(m.body),
  cancel: (m) => isId(m.of),
  act: (m) => member(ACTS, m.act) && (m.act !== "chrome" || m.scheme === "light" || m.scheme === "dark"),
  linkAskOpen: (m) => isStr(m.token, 128),
  answer: (m) => isId(m.askId) &&
    ((m.what === "back" && typeof m.took === "boolean") || (m.what === "unsent" && isId(m.unsent))),
  keep: (m) => isStr(m.key, 512) && (m.value === null || typeof m.value === "string"),
  kept: () => true,
  keepRows: (m) => isStr(m.scope, 128) && Array.isArray(m.puts) && m.puts.every(isRow) && isPairs(m.deletes),
  keptRows: (m) => isStr(m.scope, 128),
  "oldCopy.page": (m) => isStr(m.scope, 128) && (m.after === null || isStr(m.after, 512)),
  "oldCopy.done": (m) => isStr(m.scope, 128),
  note: (m) => member(NOTES, m.what) && typeof m.n === "number" && Number.isFinite(m.n),
  "switch.read": () => true,
  "switch.open": (m, app) => app !== null && isSwitchPlace(m.to, app),
  "switch.store": () => true,
};
