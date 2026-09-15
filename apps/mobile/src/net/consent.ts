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
}

/** The five fields this app reads off `GET /consent` today. */
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
