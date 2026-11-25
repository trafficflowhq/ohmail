/**
 * THE BRIDGE BETWEEN THE PHONE'S WEB VIEW AND ITS NATIVE SIDE, as types. Both sides import this
 * file: the page under `web/`, and the native side under `src/shell/`. It holds one value, the
 * guard {@link readRequest}, which native runs on every message before anything else reads it.
 *
 * The page draws untrusted letters. HTTP requests carry a root-relative path; native composes
 * the origin, the base and the bearer. Only a standalone mailbox edit can name its mail server.
 * No kind takes a file path, SQL or a keystore name, and a link leaves through the view's own navigation.
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
 * file reads the switch's place and the calendar's closed snapshot.
 *
 * THE SWITCH BETWEEN THE TWO APPS crosses as three closed kinds and one event, and none of them carries an address,
 * an account, a code or the other app's sign-in: the page asks whether the other app is here, asks native to open
 * it at a place, or to open its store page. Native does every part of it; the page only asks.
 *
 * A NOTICE crosses as the act `notices.post` with a {@link BridgeNotice}: a kind, and with it a whole number or
 * words of a closed list. The page hands over no title, no sentence and no name; native writes every word a
 * notice shows from its own string resources ({@link readNotice}).
 */
import { isWidgetGeneration, type WidgetTarget } from "../calendar/opened";
import { readCalendarSnapshot, type CalendarSnapshot } from "../calendar/record";
import { isSwitchPlace, type SwitchPlace } from "../switch/place";
import { cleanNoticeText, type MailNoticeDetails } from "../state/surface";
import type { MailboxRow } from "@ohmail/app-logic/mailboxes/pane-contract";
import type { Answered } from "@ohmail/app-logic/mailboxes/connect/types";
import type { PhoneDiagnosticRequest } from "./phone-diagnostics";
import type { WakePaneState } from "@ohmail/app-logic/phone/wake";

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
export { PIECE_BYTES } from "./framing";
/** How long native waits for the page's answer to an `ask`; no answer is "not taken". */
export { ASK_DEADLINE_MS } from "./framing";
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

/** The largest count a notice says: the shared kinds' own bound, held equal to it by the page (`web/src/signals.ts`). */
export const NOTICE_COUNT_MAX = 9999;

/**
 * A MAIL NOTICE AS IT CROSSES TO NATIVE: one of the kinds this phone draws, with exactly its own members. A count
 * is a whole number from 1 to {@link NOTICE_COUNT_MAX}; every other member is a word of a closed list, and the
 * device of a pairing is the server's own word for its kind, never the name a device gave itself. No member can
 * hold a letter's sender, subject or words, or an address: a notice is read on a locked screen by whoever stands
 * there. A send that waited for its time is not carried on the phone.
 */
export type BridgeNotice =
  | { readonly kind: "ohbox"; readonly count: number }
  | { readonly kind: "screener"; readonly count: number }
  | {
    readonly kind: "pairing"; readonly change: "paired" | "revoked";
    readonly device: "desktop" | "phone" | "browser" | null;
  };
export type BridgeNoticeKind = BridgeNotice["kind"];

/**
 * What native did with a notice it was handed. `unsupported`: this app on this system draws none (the iPhone, the
 * calendar's app, a build without the native poster). `inFront`: the app is the one being looked at. `denied`: the
 * system does not let this app post, or its session is not the live one.
 */
export type NoticePosted = "posted" | "unsupported" | "inFront" | "denied";

/**
 * What native did with the calendar's record. `kept`: written for this session's pairing, and its alerts set.
 * `unsupported`: a build without the calendar's native side. `denied`: the session no longer stands, the record is
 * another account's, or native refused it.
 */
export type CalendarKept = "kept" | "unsupported" | "denied";

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
  readonly build: { readonly version: string | null; readonly commit: string | null; readonly number?: string | null };
  readonly language: "en" | "de";
  readonly languageChoice?: "en" | "de" | null;
  /** Where to return to after the web view's process ended, or null for the first place. */
  readonly place: string | null;
  /** The phone's old copy of this mailbox waits to be handed across once (`oldCopy.page`). */
  readonly oldCopy: "present" | "absent";
  readonly notifications: NoticePermission;
  /**
   * The mail notices native draws here, by kind: none on the iPhone, none in the calendar's app, none in a build
   * without the poster. The page offers a switch for these only and asks for no other.
   */
  readonly notices: readonly BridgeNoticeKind[];
  /** The readings as they stand now; each later change comes as its event. */
  readonly os?: "android" | "ios";
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
  | { readonly act: "language.set"; readonly choice: ShellConfig["language"] | null }
  | { readonly act: "chrome"; readonly scheme: "light" | "dark" }
  | { readonly act: "notifications.permission" }
  | { readonly act: "notifications.request" }
  | { readonly act: "backup.read" }
  | { readonly act: "about.page"; readonly page: "privacy" | "subprocessors" | "imprint" | "support" | "deleteAccount" }
  /** Draw one mail notice. Native writes its words; what was done with it comes back as `notice`. */
  | { readonly act: "notices.post"; readonly notice: BridgeNotice; readonly details?: MailNoticeDetails }
  | { readonly act: "calendar.guests"; readonly to: readonly string[]; readonly subject: string }
  | { readonly act: "calendar.snapshot"; readonly snapshot: CalendarSnapshot; readonly publication?: string }
  | { readonly act: "calendar.clear"; readonly publication: string }
  | { readonly act: "calendar.resolve"; readonly generation: string }
  /**
   * Whether a closed app is to be woken for new mail: this device's master switch and its new-mail switch,
   * both on. One boolean and nothing else. Native keeps this pairing's wake registration while it is true, and
   * takes it down at the server and at the distributor while it is false.
   */
  | { readonly act: "wake.want"; readonly wanted: boolean };

export type BrowserAccountPane = "account" | "devices" | "invites" | "security" | "calendar";
export type PairGrant = "device-pair" | "invite";

export type PhoneAccountRequest = { readonly scope: string } & (
  | { readonly do: "pairs" }
  | { readonly do: "deletePage" }
  | { readonly do: "settingsPage"; readonly pane: BrowserAccountPane }
  | { readonly do: "mint"; readonly grant: PairGrant; readonly name: string }
  | { readonly do: "revoke"; readonly grant: PairGrant; readonly pairId: string }
  | { readonly do: "activate"; readonly code: string }
);

export type PhoneOrganizerRequest =
  | { readonly do: "read" }
  | { readonly do: "start"; readonly mailboxId: string; readonly background: boolean }
  | { readonly do: "stop" | "notifications"; readonly mailboxId: string };

export interface PhoneOrganizerRow {
  readonly id: string;
  readonly address: string;
  readonly tag: "organizing" | "starting" | "stopping" | "stopPending" | "handedBack" | "paused" | "notOrganized" | "reader" | null;
  readonly notes: readonly string[];
  readonly warnings: readonly string[];
  readonly start: boolean;
  readonly stop: boolean;
  readonly explainBackground: boolean;
  readonly notifications: boolean;
}

export interface PhoneServerPatch {
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly pass: string;
}

export interface PhoneMailboxPatch {
  readonly imap: PhoneServerPatch;
  readonly smtp?: PhoneServerPatch;
}

export type PhoneMailboxRequest =
  | { readonly do: "list"; readonly counts: boolean }
  | { readonly do: "check"; readonly mailboxId: string }
  | { readonly do: "edit"; readonly mailboxId: string; readonly patch: PhoneMailboxPatch };

export type PhoneNameRequest =
  | { readonly do: "read" }
  | { readonly do: "save"; readonly mailboxId: string; readonly name: string | null };

export interface PhoneNameRow {
  readonly id: string;
  readonly address: string;
  readonly name: string | null;
}

/**
 * What native was asked to keep under a word it refused: SHA-256 over the word's UTF-16 code units, each low byte
 * first, as lowercase hex; `null` for a removal.
 */
export type WordDigest = string | null;

export type WakePaneRequest =
  | { readonly do: "read" | "off" }
  | { readonly do: "choose"; readonly distributor: string };

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
    readonly answer: {
      readonly permission?: NoticePermission; readonly backup?: "excluded" | "included" | "unknown";
      readonly notice?: NoticePosted; readonly calendar?: CalendarKept; readonly widget?: WidgetTarget;
      readonly language?: ShellConfig["language"];
    };
  };
  readonly "phone.account": {
    readonly ask: PhoneAccountRequest;
    readonly answer: { readonly result?: Requests["http"]["answer"] };
  };
  readonly "phone.wake": {
    readonly ask: WakePaneRequest;
    readonly answer: { readonly wake?: WakePaneState };
  };
  readonly "phone.name": {
    readonly ask: PhoneNameRequest;
    readonly answer: { readonly rows?: readonly PhoneNameRow[]; readonly name?: string | null };
  };
  readonly "phone.organize": {
    readonly ask: PhoneOrganizerRequest;
    readonly answer: { readonly rows: readonly PhoneOrganizerRow[] };
  };
  readonly "phone.diagnostics": {
    readonly ask: PhoneDiagnosticRequest;
    readonly answer: { readonly fileName?: string; readonly shared?: boolean };
  };
  readonly "phone.mailbox": {
    readonly ask: PhoneMailboxRequest;
    readonly answer: {
      readonly rows?: readonly MailboxRow[];
      readonly checked?: unknown;
      readonly edited?: Answered<null>;
    };
  };
  /** A link the web view's own navigation asked to open, held natively by its token. */
  readonly linkAskOpen: { readonly ask: { readonly token: string }; readonly answer: { readonly opened: boolean } };
  /** The page's answer to an `ask` event. */
  readonly answer: {
    readonly ask:
      | { readonly askId: number; readonly what: "back"; readonly took: boolean | "held" | "prepare" | "discard" }
      | { readonly askId: number; readonly what: "unsent"; readonly unsent: number };
    readonly answer: { readonly accepted: boolean };
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
  | { readonly type: "backEnded"; readonly askId: number }
  | { readonly type: "organizerChanged" }
  | { readonly type: "wakePane"; readonly wake: WakePaneState }
  | { readonly type: "calendarWidget"; readonly generation: string }
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
  raw: unknown, app: ShellApp | null = null, diagnosticCounts?: number,
): Request | { readonly refused: "unknownKind" | "malformed" } {
  if (typeof raw !== "object" || raw === null) return MALFORMED;
  const m = raw as Record<string, unknown>;
  if (!isId(m.id) || typeof m.epoch !== "string" || m.epoch.length === 0 || m.epoch.length > 64) return MALFORMED;
  if (typeof m.kind !== "string" || !Object.prototype.hasOwnProperty.call(FIELDS, m.kind)) return UNKNOWN;
  return FIELDS[m.kind as Kind](m, app, diagnosticCounts) ? (m as unknown as Request) : MALFORMED;
}

const MALFORMED = { refused: "malformed" } as const;
const UNKNOWN = { refused: "unknownKind" } as const;
const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length <= max;
/** Each closed set once, as a record its union types: a member the guard does not list fails to compile. */
const METHODS: Record<HttpMethod, true> = { GET: true, HEAD: true, POST: true, PUT: true, PATCH: true, DELETE: true };
const ACTS: Record<ShellAct["act"], true> = {
  signOut: true, openServers: true, "language.set": true, chrome: true, "notifications.permission": true, "notifications.request": true,
  "backup.read": true, "about.page": true, "notices.post": true, "calendar.guests": true, "calendar.snapshot": true, "calendar.clear": true, "calendar.resolve": true, "wake.want": true,
};
const NOTES: Record<NoteWhat, true> = {
  mounted: true, durabilityLost: true, keeperRefused: true, pieceDropped: true, foreignEpoch: true, deadlinePassed: true,
  consoleError: true, consoleWarn: true, copyFilled: true, copyHandedAcross: true, copyNotTaken: true,
};
const member = (set: object, v: unknown): boolean => typeof v === "string" && Object.prototype.hasOwnProperty.call(set, v);

/** A count a notice says. */
const isCount = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= NOTICE_COUNT_MAX;
type PairingNotice = Extract<BridgeNotice, { readonly kind: "pairing" }>;
const CHANGES: Record<PairingNotice["change"], true> = { paired: true, revoked: true };
const DEVICES: Record<NonNullable<PairingNotice["device"]>, true> = { desktop: true, phone: true, browser: true };

/**
 * Each kind with exactly its members, and what each may be. Typed over the union, so a kind or a member the
 * guard does not list fails to compile, and so does one it lists that the union does not have.
 */
const NOTICE_MEMBERS: {
  readonly [K in BridgeNoticeKind]: {
    readonly [F in Exclude<keyof Extract<BridgeNotice, { readonly kind: K }>, "kind">]: (v: unknown) => boolean
  }
} = {
  ohbox: { count: isCount },
  screener: { count: isCount },
  pairing: { change: (v) => member(CHANGES, v), device: (v) => v === null || member(DEVICES, v) },
};

/**
 * THE NOTICE, READ CLOSED. A record of a listed kind that holds exactly that kind's members, each a whole number
 * in its range or a word of its list: then a COPY of those members, and native reads the copy, never the page's
 * own object. Anything else is `null`: a string where a word belongs, a member too many (whatever its name and
 * value, a symbol too), a member missing or only inherited, a kind or a word that is not listed. Each member is
 * read once, so what was judged is what is handed on.
 */
export function readNotice(raw: unknown): BridgeNotice | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const from = raw as Record<string, unknown>;
  const own = (name: string): boolean => Object.prototype.hasOwnProperty.call(from, name);
  const kind = own("kind") ? from.kind : undefined;
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(NOTICE_MEMBERS, kind)) return null;
  const members = NOTICE_MEMBERS[kind as BridgeNoticeKind] as Readonly<Record<string, (v: unknown) => boolean>>;
  const names = Object.keys(members);
  // The kind and each of its members, and not one key more: the count says no other key stands beside them.
  if (Reflect.ownKeys(from).length !== names.length + 1) return null;
  const copy: Record<string, unknown> = { kind };
  for (const name of names) {
    if (!own(name)) return null;
    const value = from[name];
    if (!members[name]!(value)) return null;
    copy[name] = value;
  }
  return copy as unknown as BridgeNotice;
}

/** Every kind a notice crosses as, in the guard's own order. */
export const BRIDGE_NOTICE_KINDS = Object.keys(NOTICE_MEMBERS) as readonly BridgeNoticeKind[];

/** The keys the act `notices.post` crosses with: the envelope's three, the act and its notice. */
const POST_KEYS: ReadonlySet<string> = new Set(["id", "epoch", "kind", "act", "notice", "details"]);

export function readMailNoticeDetails(raw: unknown): MailNoticeDetails | null {
  if (typeof raw !== "object" || raw === null || Reflect.ownKeys(raw).length !== 2
      || !Object.hasOwn(raw, "sender") || !Object.hasOwn(raw, "subject")) return null;
  const { sender, subject } = raw as Record<string, unknown>;
  if (typeof sender !== "string" || typeof subject !== "string" ||
      sender.length > 160 || subject.length > 160) return null;
  return cleanNoticeText(sender) === sender && cleanNoticeText(subject) === subject ? { sender, subject } : null;
}

/** The paired OS can draw opt-in text for only one identified message. */
function isNoticePost(m: Record<string, unknown>): boolean {
  const notice = readNotice(m.notice);
  return notice !== null && Reflect.ownKeys(m).every((key) => typeof key === "string" && POST_KEYS.has(key))
    && (!Object.hasOwn(m, "details")
      || (notice.kind === "ohbox" && notice.count === 1 && readMailNoticeDetails(m.details) !== null));
}

/** The keys the act `calendar.snapshot` crosses with: the envelope's three, the act and its record. */
const SNAPSHOT_KEYS: ReadonlySet<string> = new Set(["id", "epoch", "kind", "act", "snapshot", "publication"]);
/** The calendar's record is as closed as a notice: no key beside its own, and a record the contract's reader reads. */
const isSnapshotPost = (m: Record<string, unknown>): boolean =>
  Reflect.ownKeys(m).every((key) => typeof key === "string" && SNAPSHOT_KEYS.has(key))
  && (m.publication === undefined || isWidgetGeneration(m.publication))
  && readCalendarSnapshot(m.snapshot) !== null;

const ACT_REQUEST_KEYS = new Set(["id", "epoch", "kind", "act"]);
function isCalendarHandle(m: Record<string, unknown>, key: "publication" | "generation"): boolean {
  return Object.prototype.hasOwnProperty.call(m, key) && isWidgetGeneration(m[key]) &&
    Reflect.ownKeys(m).every((name) => name === key || (typeof name === "string" && ACT_REQUEST_KEYS.has(name)));
}

/** The keys the act `wake.want` crosses with: the envelope's three, the act and its one boolean. */
const WANT_KEYS: ReadonlySet<string> = new Set(["id", "epoch", "kind", "act", "wanted"]);
/** As closed as the act that draws: no key beside its own, and `wanted` one of the two booleans, never a word for one. */
const isWakeWant = (m: Record<string, unknown>): boolean =>
  Reflect.ownKeys(m).every((key) => typeof key === "string" && WANT_KEYS.has(key)) &&
  Object.prototype.hasOwnProperty.call(m, "wanted") && (m.wanted === true || m.wanted === false);

function calendarGuestRequest(m: Record<string, unknown>): boolean {
  return Array.isArray(m.to) && m.to.length > 0 && m.to.length <= 64 &&
    m.to.every((v) => isStr(v, 320) && /^[^\s@,?&:]+@[^\s@,?&:]+$/.test(v)) &&
    isStr(m.subject, 998) && !/[\r\n]/.test(m.subject) &&
    Object.keys(m).every((key) => key === "to" || key === "subject" || ACT_REQUEST_KEYS.has(key));
}

const isLanguageChoice = (m: Record<string, unknown>): boolean =>
  Reflect.ownKeys(m).every((key) => key === "choice" || (typeof key === "string" && ACT_REQUEST_KEYS.has(key))) &&
  Object.prototype.hasOwnProperty.call(m, "choice") && (m.choice === null || m.choice === "en" || m.choice === "de");

const WAKE_PANE_KEYS = ["id", "epoch", "kind", "do"];
const isWakePaneRequest = (m: Record<string, unknown>, app: ShellApp | null): boolean => {
  if (app !== "ohmail" || !WAKE_PANE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(m, key))) return false;
  const size = Reflect.ownKeys(m).length;
  if (m.do === "read" || m.do === "off") return size === WAKE_PANE_KEYS.length;
  return m.do === "choose" && size === WAKE_PANE_KEYS.length + 1 &&
    Object.prototype.hasOwnProperty.call(m, "distributor") && isStr(m.distributor, 256) && m.distributor.length > 0;
};

const NAME_READ_KEYS = new Set(["id", "epoch", "kind", "do"]);
const NAME_SAVE_KEYS = new Set([...NAME_READ_KEYS, "mailboxId", "name"]);
function isPhoneNameRequest(m: Record<string, unknown>, app: ShellApp | null): boolean {
  if (app !== "ohmail") return false;
  if (m.do === "read") return Object.keys(m).every((key) => NAME_READ_KEYS.has(key));
  return m.do === "save" && isStr(m.mailboxId, 256) && m.mailboxId !== "" &&
    (m.name === null || isStr(m.name)) && Object.keys(m).every((key) => NAME_SAVE_KEYS.has(key));
}

function phoneFields(m: Record<string, unknown>, ...fields: string[]): boolean {
  return Object.keys(m).every((key) => NAME_READ_KEYS.has(key) || fields.includes(key));
}

function isPhoneAccountRequest(m: Record<string, unknown>): boolean {
  if (!isStr(m.scope, 128) || m.scope === "") return false;
  switch (m.do) {
    case "pairs":
    case "deletePage":
      return phoneFields(m, "scope");
    case "settingsPage":
      return typeof m.pane === "string" && ["account", "devices", "invites", "security", "calendar"].includes(m.pane) &&
        phoneFields(m, "scope", "pane");
    case "activate":
      return typeof m.code === "string" && /^\d{6}$/.test(m.code) && phoneFields(m, "scope", "code");
    case "mint":
      return (m.grant === "device-pair" || m.grant === "invite") &&
        isStr(m.name, 100) && phoneFields(m, "scope", "grant", "name");
    case "revoke":
      return (m.grant === "device-pair" || m.grant === "invite") &&
        typeof m.pairId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(m.pairId) &&
        phoneFields(m, "scope", "grant", "pairId");
    default:
      return false;
  }
}

function phoneMailboxId(m: Record<string, unknown>): boolean {
  return isStr(m.mailboxId, 256) && /^[a-zA-Z0-9_-]+$/.test(m.mailboxId);
}

function isOrganizerRequest(m: Record<string, unknown>, app: ShellApp | null): boolean {
  if (app !== "ohmail") return false;
  if (m.do === "read") return phoneFields(m);
  if (!phoneMailboxId(m)) return false;
  if (m.do === "start") return typeof m.background === "boolean" && phoneFields(m, "mailboxId", "background");
  return (m.do === "stop" || m.do === "notifications") && phoneFields(m, "mailboxId");
}

function isDiagnosticRequest(m: Record<string, unknown>, app: ShellApp | null, diagnosticCounts?: number): boolean {
  if (app !== "ohmail") return false;
  if (m.do === "share") return phoneFields(m);
  return m.do === "write" && phoneFields(m, "counts") && Array.isArray(m.counts) &&
    m.counts.length === diagnosticCounts && m.counts.every(isId);
}

function isPhoneServerPatch(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return Object.keys(m).every((key) => ["host", "port", "user", "pass"].includes(key)) &&
    isStr(m.pass, 4096) && m.pass.length > 0 &&
    (m.host === undefined || isStr(m.host, 512)) &&
    (m.user === undefined || isStr(m.user, 512)) &&
    (m.port === undefined || (isId(m.port) && m.port > 0 && m.port <= 65535));
}

function isPhoneMailboxRequest(m: Record<string, unknown>, app: ShellApp | null): boolean {
  if (app !== "ohmail") return false;
  if (m.do === "list") return typeof m.counts === "boolean" && phoneFields(m, "counts");
  if (!phoneMailboxId(m)) return false;
  if (m.do === "check") return phoneFields(m, "mailboxId");
  if (m.do !== "edit" || !phoneFields(m, "mailboxId", "patch") ||
      typeof m.patch !== "object" || m.patch === null) return false;
  const patch = m.patch as Record<string, unknown>;
  return Object.keys(patch).every((key) => key === "imap" || key === "smtp") &&
    isPhoneServerPatch(patch.imap) && (patch.smtp === undefined || isPhoneServerPatch(patch.smtp));
}

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

const FIELDS: { readonly [K in Kind]: (m: Record<string, unknown>, app: ShellApp | null, diagnosticCounts?: number) => boolean } = {
  config: () => true,
  ready: (m) => isStr(m.place),
  place: (m) => isStr(m.fragment),
  http: (m) => isStr(m.scope, 128) && member(METHODS, m.method) && isRootRelative(m.path) &&
    isHeaders(m.headers) && isBody(m.body),
  cancel: (m) => isId(m.of),
  act: (m, app) => member(ACTS, m.act) && (m.act !== "chrome" || m.scheme === "light" || m.scheme === "dark") &&
    (m.act !== "language.set" || isLanguageChoice(m)) &&
    (m.act !== "about.page" || (
      (m.page === "privacy" || m.page === "subprocessors" || m.page === "imprint" ||
        (app === "ohcal" && (m.page === "support" || m.page === "deleteAccount"))) &&
      Object.keys(m).every((key) => key === "page" || ACT_REQUEST_KEYS.has(key))
    )) &&
    (m.act !== "calendar.guests" || (app === "ohcal" && calendarGuestRequest(m))) &&
    (m.act !== "notices.post" || isNoticePost(m)) && (m.act !== "calendar.snapshot" || isSnapshotPost(m)) &&
    (m.act !== "calendar.clear" || isCalendarHandle(m, "publication")) &&
    (m.act !== "calendar.resolve" || isCalendarHandle(m, "generation")) &&
    (m.act !== "wake.want" || isWakeWant(m)),
  "phone.account": isPhoneAccountRequest,
  "phone.wake": isWakePaneRequest,
  "phone.name": isPhoneNameRequest,
  "phone.organize": isOrganizerRequest,
  "phone.diagnostics": isDiagnosticRequest,
  "phone.mailbox": isPhoneMailboxRequest,
  linkAskOpen: (m) => isStr(m.token, 128),
  answer: (m) => isId(m.askId) &&
    ((m.what === "back" && (typeof m.took === "boolean" || m.took === "held" || m.took === "prepare" || m.took === "discard")) || (m.what === "unsent" && isId(m.unsent))),
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
