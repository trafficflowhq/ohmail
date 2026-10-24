import { faceOf, type FaceName } from "../theme/face.js";
import type { ConnectedSession } from "./pairing.js";
/* THE ONE BASE EVERY REQUEST IS COMPOSED OFF — see `request-base.ts`. */
import { requestBase } from "./request-base";
/**
 * Account settings over the paired server — the "Use folders" consent read and write. The
 * feature is off by default and per-account (FOLDERS-SPEC.md §6); the authority is the
 * server's consent row — `GET /consent` answers `foldersEnabledAt`, `PATCH /consent/settings`
 * moves it — the webapp Settings switch's exact route pair, so one toggle anywhere is every
 * client's answer. The same read carries the per-mailbox `signatures` map (mail 0075), riding
 * the flag's cadence (boot + after every drain). Transport: `session.fetch` only, bound to one
 * origin. `null` means "could not ask", never "off": `{ on: false }` is the server saying off,
 * and on `null` the caller keeps what it last knew (starting at off, the safe branch).
 */

/**
 * THE ACCOUNT'S CUTLINE ANSWER — the three `GET /consent` fields that decide which senders are
 * still worth a decision (mail 0056 / 0083). Measured missing: `presentedOf` ran the same rule
 * the server runs on the engine's own default window, so six waiting senders listed as two.
 *
 * `dormancyDays: null` is "no override" (the wire always sends a number, so it means unreadable);
 * `baselineAt: null` is "this account has never decided anything"; `scope` is the MODE, and
 * anything that is not exactly `all_time` reads as the window — screening everything is a lot of
 * mail to unfile by hand, so a bad value must fail narrow.
 */
export interface ScreeningAnswer {
  dormancyDays: number | null;
  baselineAt: string | null;
  scope: "window" | "all_time";
  /**
   * EACH MAILBOX'S WINDOW, and whose (`screeningByMailbox`, RULING-026), AS THE WIRE SENT IT: the
   * one reader of it is the engine package's, behind `state/live.ts`. Present, it decides the
   * partition per mailbox and the three fields above go unread; absent, an older server.
   */
  byMailbox?: unknown;
}

/** The fields this app reads off `GET /consent` today. */
export interface FoldersConsent {
  on: boolean;
  /**
   * CAN THE PAIRED DOOR STORE THE FLAG AT ALL — whether the answer CARRIES the folders axis, not
   * what it says about it. `null` and an instant both mean the door has the axis (off / on);
   * ABSENT means no folders axis at all, which is every door built from `localRoutes`: the
   * desktop host a phone pairs with, a self-host server, this app's own standalone door.
   * Measured: with the field present-and-null the phone drew "Use folders", the press wrote, the
   * PATCH echo omitted the axis, and the switch snapped back to off with no sentence at all.
   * Two states named rather than one collapsed — `on` is what the account chose, this is whether
   * choosing is a thing this door can keep.
   */
  storable: boolean;
  /**
   * The account's cutline answer, or `null` for a server that carries none of the three fields
   * (an API deployed before mail 0056). `null` here is UNSUPPLIED and never a wait: this read
   * landed, and no later one from this server is going to carry more. The world layer turns it
   * into `live.ts#SCREENING_UNSUPPLIED` for exactly that reason — the state a read still in
   * flight is in has its own name, and the two used to be one `null`. See {@link ScreeningAnswer}.
   */
  screening: ScreeningAnswer | null;
  /**
   * PER-MAILBOX SIGNATURES — `{ mailboxId: text }`, only the mailboxes that HAVE one (mail
   * 0075; the composer's signature block reads it). Server-confirmed by construction: this
   * shape exists only inside a 200 answer, so a caller holding one may render a block from
   * it — the webapp's `signaturesKnown` gate, expressed structurally. An ABSENT map (an API
   * deployed before mail 0075) reads as "no signatures", which is the picture such a server
   * actually serves — exactly `consent-state.ts`'s `wire.signatures ?? {}`.
   */
  signatures: Record<string, string>;
  /**
   * The account's appearance face (OHMARCHY-PLAN.md §3a) — `paper`, `ohmarchy`, or `null` for
   * "no preference". Rides this read for the signatures' reason: one `GET /consent` per boot
   * and per drain already exists, so a face chosen in the webapp reaches an open phone with no
   * new mechanism. One null, unlike the webapp's `themeFaceKnown` pair: here the shape carries
   * the distinction — a `FoldersConsent` exists only inside a 200 answer, so `themeFace: null`
   * always means the account really has no face, and an absent field (an older API) means the
   * same, because a server that cannot store a face has none to report.
   */
  themeFace: FaceName | null;
  /**
   * THE WALL CLOCK RESURFACED MAIL COMES BACK AT — `'HH:MM'` where the reader is, or `null` for
   * "this account has never chosen one" (mail 0110). Rides this read for the signatures'
   * reason: one `GET /consent` per boot and per drain already exists, so a time chosen in the
   * webapp reaches an open phone with no new mechanism. ONE null, like `themeFace`: a value
   * outside `'HH:MM'` is filtered to it here, and every reader resolves it to the product's
   * 09:00 — the hour this app's horizons minted before the setting existed.
   */
  resurfaceTime: string | null;
  /**
   * WILL A SCREEN-OUT ALSO SEND THE SENDER'S ONE-CLICK UNSUBSCRIBE — `blockAutoUnsubscribeAt`
   * absent or `null` (the product default, mail 0054), false only for an instant. The webapp's
   * `wire.blockAutoUnsubscribeAt == null`, for its reason: absent is an older server, which
   * still sends, so the phone still says so. It decides a sentence, never a send.
   */
  autoUnsubscribe: boolean;
  /**
   * THE ACT ON SUGGESTIONS — `autoActAt` set, or `null` where the answer carries no
   * such axis (an older server), which draws no switch. `autoSuggestOn` is what it needs.
   */
  autoAct: boolean | null;
  autoSuggestOn: boolean;
  /**
   * THE SENT-MAIL SEED — `seedConfirmedAt`, `null` while the review was never confirmed. The whole
   * field is `null` where the answer carries no `seedConfirmedAt` (an older door: nothing to offer).
   */
  seed: { confirmedAt: string | null } | null;
}

/** `'HH:MM'`, 24-hour — the server's own shape (`RESURFACE_TIME_RE`), shared by value. */
const RESURFACE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The wire's time, kept only if it really is one — a malformed field reads as "never chosen". */
function resurfaceTimeOf(raw: unknown): string | null {
  return typeof raw === "string" && RESURFACE_TIME_RE.test(raw) ? raw : null;
}

/** The wire map, kept only if it is really `{ string: string }` — a malformed field reads as absent. */
function signaturesOf(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * The cutline answer as the wire gave it, or `null` when the answer carries none of its three
 * fields — the pre-mail-0056 server, which is a different thing from an account with no baseline.
 * Presence is tested with `in` rather than by value, because `screeningBaselineAt: null` is a real
 * answer on every current server and reads identically to an absent field otherwise.
 */
function screeningOf(body: Record<string, unknown>): ScreeningAnswer | null {
  const keys = ["dormancyDays", "screeningBaselineAt", "screeningScope"];
  if (!keys.some((k) => k in body)) return null;
  const days = body.dormancyDays;
  const base = body.screeningBaselineAt;
  return {
    dormancyDays: typeof days === "number" && Number.isFinite(days) && days > 0 ? days : null,
    baselineAt: typeof base === "string" && base !== "" ? base : null,
    scope: body.screeningScope === "all_time" ? "all_time" : "window",
    ...(body.screeningByMailbox === undefined || body.screeningByMailbox === null ? {} : { byMailbox: body.screeningByMailbox }),
  };
}

export async function readFoldersEnabled(session: ConnectedSession): Promise<FoldersConsent | null> {
  try {
    const res = await session.fetch(`${requestBase(session)}/consent`, { method: "GET" });
    if (res.status !== 200) return null;
    const body = (await res.json()) as Record<string, unknown> & {
      foldersEnabledAt?: unknown; signatures?: unknown; themeFace?: unknown;
    };
    // The wire's contract: an instant means on, `null` means off — and an ABSENT field means a
    // server too old to know about folders, which reads as off exactly like the webapp's
    // `wire.foldersEnabledAt != null` (consent-state.ts).
    return {
      on: typeof body.foldersEnabledAt === "string" && body.foldersEnabledAt !== "",
      // Presence, not value — see {@link FoldersConsent.storable}. `in` for the same reason
      // `screeningOf` uses it: `foldersEnabledAt: null` is a real answer on every door that has
      // the axis and reads identically to an absent field otherwise.
      storable: "foldersEnabledAt" in body,
      screening: screeningOf(body),
      signatures: signaturesOf(body.signatures),
      // A value this build does not know (a future face, a malformed field) reads as "no
      // preference" rather than throwing the whole read away: the other two fields on this
      // answer are unaffected by a face nobody here can draw.
      themeFace: faceOf(body.themeFace),
      // A value this build cannot use (a malformed field, a server too old to carry it) reads as
      // "never chosen" rather than throwing the whole read away — the face's rule, and here the
      // fallback is what every build did before the setting existed.
      resurfaceTime: resurfaceTimeOf(body.resurfaceTime),
      autoUnsubscribe: !(typeof body.blockAutoUnsubscribeAt === "string" && body.blockAutoUnsubscribeAt !== ""),
      autoAct: "autoActAt" in body ? typeof body.autoActAt === "string" && body.autoActAt !== "" : null,
      autoSuggestOn: typeof body.autoSuggestAt === "string" && body.autoSuggestAt !== "",
      seed: "seedConfirmedAt" in body
        ? { confirmedAt: typeof body.seedConfirmedAt === "string" && body.seedConfirmedAt !== "" ? body.seedConfirmedAt : null }
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * Write the flag. Resolves to the server-confirmed value — the Settings switch renders THIS,
 * never the optimistic pick (the webapp `FoldersRow`'s own rule: a refused write must not
 * draw a folders group the account does not have). Rejects on refusal or transport failure,
 * which the pane shows as its one failure sentence.
 */
export async function writeFoldersEnabled(session: ConnectedSession, enabled: boolean): Promise<{ on: boolean }> {
  const res = await session.fetch(`${requestBase(session)}/consent/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ foldersEnabled: enabled }),
  });
  if (res.status !== 200) throw new Error(`consent write refused (${res.status})`);
  const body = (await res.json()) as Record<string, unknown> & { foldersEnabledAt?: unknown };
  /* AN ABSENT AXIS IS NOT "OFF". The route echoes only the fields it acted on, and a door built
     from `localRoutes` drops `foldersEnabled` before the handler sees it — so the 200 comes back
     with no `foldersEnabledAt` at all. Read as `{ on: false }` that is the server calmly saying
     "off" about a write it never made, which is exactly how the switch came to flip and snap back
     in silence. It is a refusal, and the pane's one failure sentence is the honest answer. */
  if (!("foldersEnabledAt" in body)) {
    throw new Error("consent write stored nothing: this server carries no folders setting");
  }
  return { on: typeof body.foldersEnabledAt === "string" && body.foldersEnabledAt !== "" };
}

/**
 * TURN THE ACT ON SUGGESTIONS ON OR OFF — one `PATCH /consent/settings {autoAct}`,
 * one axis. Resolves to what the account stored; rejects on a refusal (400
 * `auto_suggest_required` while automatic suggestions are off) and on an echo without the axis.
 */
export async function writeAutoAct(session: ConnectedSession, enabled: boolean): Promise<{ on: boolean }> {
  const res = await session.fetch(`${requestBase(session)}/consent/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autoAct: enabled }),
  });
  if (res.status !== 200) throw new Error(`consent write refused (${res.status})`);
  const body = (await res.json()) as Record<string, unknown>;
  if (!("autoActAt" in body)) throw new Error("consent write stored nothing: no such setting here");
  return { on: typeof body.autoActAt === "string" && body.autoActAt !== "" };
}

/**
 * "Apply on all devices" for the appearance face — one `PATCH /consent/settings {themeFace}`.
 * One axis only, which is what makes sharing a row with four other controls safe: the route
 * tests presence with `in`, so an omitted key is "leave this alone" — a body carrying anything
 * else would overwrite settings this control does not own (the rule `local-consent.ts` states
 * for the desktop's bridge). Resolves to what the account stored, never to the argument: a
 * server may accept the request and hold something else, and only the echo separates "adopted"
 * from "did not" — the discipline every consent knob keeps. Rejects on refusal or transport
 * failure, which the Settings pane shows as its one failure sentence.
 */
/**
 * REMEMBER THE RESURFACE TIME — one `PATCH /consent/settings {resurfaceTime}`, `writeThemeFace`'s
 * shape and its one-axis rule: an omitted key is "leave this alone", so this control cannot
 * overwrite a setting somebody changed in a browser tab a moment ago. Resolves to what the
 * account STORED, never to the argument. Rejects on refusal or transport failure, which the
 * caller swallows: the resurface it follows has already been dispatched.
 */
export async function writeResurfaceTime(
  session: ConnectedSession, resurfaceTime: string,
): Promise<string | null> {
  const res = await session.fetch(`${requestBase(session)}/consent/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resurfaceTime }),
  });
  if (res.status !== 200) throw new Error(`consent write refused (${res.status})`);
  const body = (await res.json()) as { resurfaceTime?: unknown };
  return resurfaceTimeOf(body.resurfaceTime);
}

export async function writeThemeFace(
  session: ConnectedSession, face: FaceName,
): Promise<FaceName | null> {
  const res = await session.fetch(`${requestBase(session)}/consent/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ themeFace: face }),
  });
  if (res.status !== 200) throw new Error(`consent write refused (${res.status})`);
  const body = (await res.json()) as { themeFace?: unknown };
  return faceOf(body.themeFace);
}

/** The two members of a session the seed calls use — structural, like `profile-import.ts`'s. */
export interface SeedSession {
  readonly profile: { readonly origin: string; readonly apiBase: string | null };
  fetch(url: string, init?: unknown): Promise<Response>;
}

/** One person the account has written to — `GET /consent/seed`'s candidate. */
export interface SeedCandidate {
  address: string;
  name: string | null;
  messages: number;
  lastWrittenAt: string | null;
  alreadyDecided: boolean;
}

export type SeedExclusion = "robot-recipient" | "machine-sent" | "own-address";

/** The review list: shown before anything acts. */
export interface SeedReview {
  candidates: SeedCandidate[];
  excluded: Array<{ address: string; reason: SeedExclusion }>;
  scannedMessages: number;
  truncated: boolean;
}

const EXCLUSIONS: ReadonlySet<string> = new Set(["robot-recipient", "machine-sent", "own-address"]);

function candidateOf(raw: unknown): SeedCandidate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.address !== "string" || c.address === "") return null;
  if (typeof c.messages !== "number" || typeof c.alreadyDecided !== "boolean") return null;
  return {
    address: c.address,
    name: typeof c.name === "string" && c.name !== "" ? c.name : null,
    messages: c.messages,
    lastWrittenAt: typeof c.lastWrittenAt === "string" ? c.lastWrittenAt : null,
    alreadyDecided: c.alreadyDecided,
  };
}

/** The wire's review, malformed entries dropped; `null` when the answer is not a review at all. */
export function seedReviewOf(raw: unknown): SeedReview | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.candidates)) return null;
  const candidates = b.candidates.map(candidateOf).filter((c): c is SeedCandidate => c !== null);
  const excluded = (Array.isArray(b.excluded) ? b.excluded : []).flatMap((e: unknown) => {
    const x = e as Record<string, unknown> | null;
    return x !== null && typeof x === "object" && typeof x.address === "string" && typeof x.reason === "string"
      && EXCLUSIONS.has(x.reason) ? [{ address: x.address, reason: x.reason as SeedExclusion }] : [];
  });
  return {
    candidates,
    excluded,
    scannedMessages: typeof b.scannedMessages === "number" ? b.scannedMessages : 0,
    truncated: b.truncated === true,
  };
}

/** Ask for the review list. Reads, writes nothing. `null` is "could not ask". */
export async function readSeedReview(session: SeedSession): Promise<SeedReview | null> {
  try {
    const res = await session.fetch(`${requestBase(session)}/consent/seed`, { method: "GET" });
    if (res.status !== 200) return null;
    return seedReviewOf(await res.json());
  } catch {
    return null;
  }
}

/** A refused confirm, carrying the door's own sentence when it wrote one. */
export class SeedRefused extends Error {
  constructor(readonly status: number | null, readonly said: string | null) {
    super("seed_refused");
  }
}

/**
 * THE CONSENT EVENT — the ticked addresses, one key per press. Resolves to what the door wrote;
 * throws {@link SeedRefused} on anything but 200.
 */
export async function confirmSeed(
  session: SeedSession, addresses: readonly string[], key: string,
): Promise<{ rulesCreated: number; contactsCreated: number }> {
  let res: Response;
  try {
    res = await session.fetch(`${requestBase(session)}/consent/seed`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ addresses }),
    });
  } catch {
    throw new SeedRefused(null, null);
  }
  if (res.status !== 200) {
    let said: string | null = null;
    try {
      const m = ((await res.json()) as { error?: { message?: unknown } }).error?.message;
      if (typeof m === "string" && m.trim() !== "") said = m;
    } catch { /* not JSON: the status is all there is */ }
    throw new SeedRefused(res.status, said);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    rulesCreated: typeof body.rulesCreated === "number" ? body.rulesCreated : 0,
    contactsCreated: typeof body.contactsCreated === "number" ? body.contactsCreated : 0,
  };
}
