/**
 * PLACE SUGGESTIONS: a question about a place, asked of the geocoder this server names
 * (`PLACES_SUGGEST_URL`), answered with rows the server writes (`place-rows.ts`).
 *
 * What the person typed is made plain and goes to the geocoder alone, in the query of one request
 * through the product's one way out (`pinnedHttpRequest`): our name as its user agent, the bearer
 * where one is set, nothing of the person's own request. It is never written down: not in a log
 * line (every line here holds closed words and numbers), not in the database. A region is rounded
 * to one decimal before any use; the person's own country orders the rows here and goes to no
 * geocoder. What this keeps, all in the program's memory: the answers for ten
 * minutes, each for the account that asked it alone (no account can tell what another asked), how
 * fast each account and the whole server ask, and how long the geocoder asked to be left alone.
 * Never a retry: a question that failed is answered by its state, and the person's next keystroke
 * is the next question.
 */
import { createHash } from "node:crypto";
import type { PlaceLanguage, PlaceSuggestAnswer, PlaceSuggestBody, PlaceSuggestion, PlaceSuggestState, UntrustedBody } from "@ohmail/wire";
import { silentLogger, type Logger } from "@trafficflow/core/mail";
import { pinnedHttpRequest, privateNetworkPin, resolvePinUnchecked, type HostResolver } from "@trafficflow/core/net";
import { ServiceError } from "@trafficflow/services";
import type { PlaceQuestion, PlaceSuggester } from "../deps.js";
import { placeRowsOf } from "./place-rows.js";

export type { PlaceQuestion, PlaceSuggester } from "../deps.js";

/** Under this many characters a question is answered empty and nothing is asked. */
const PLACE_TEXT_MIN = 3;
/** Over this many, refused. The geocoder takes no more. */
const PLACE_TEXT_MAX = 200;
const PLACE_LIMIT_DEFAULT = 6;
const PLACE_LIMIT_MAX = 8;
/** The whole call, the name's lookup, the answer's head and its body. */
const PLACE_CALL_MS = 2_000;

/**
 * Rows asked beyond the field's, for the folding of two equal rows to take back and for the rows
 * in the town the person typed to be chosen from (at most 14 of the geocoder's 15).
 */
const ASK_MORE = 6;
const LANG_MAX = 35;
const LANGUAGES: ReadonlySet<string> = new Set<PlaceLanguage>(["de", "en", "fr"]);
const ANSWER_MAX_BYTES = 256 * 1024;
const USER_AGENT = "ohmail-Places/1.0";

/** Per account: a burst of ten, five a second after it, sixty in a fixed minute from its first question. */
const ACCOUNT_BURST = 10;
const ACCOUNT_PER_SECOND = 5;
const ACCOUNT_PER_MINUTE = 60;
/**
 * And one fresh call to the geocoder in any second, an answer from memory free: inside its own pace
 * one account never takes the whole program's second. A person typing loses nothing, as the field
 * shows only the answer to its newest text.
 */
const ACCOUNT_CALL_MS = 1_000;
/**
 * The whole program. The geocoder's own limits (15 a second, a burst of 30, two searches at once, a
 * waiting line of 50 for up to 1.2 s) are for all its callers together, every server of ours
 * included, and it runs about three fresh searches a second.
 */
const PROGRAM_PER_SECOND = 3;
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 500;
/** How long the geocoder is left alone: over its share, rebuilding its index, failing. */
const HOLD_BUSY_MS = 1_000;
const HOLD_REBUILD_MS = 30_000;
const HOLD_DOWN_MS = 5_000;
/** A Retry-After is honoured within these bounds. */
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 60_000;

/** Every control character, by Unicode's own class of them. */
const CONTROL = /\p{Cc}/gu;
/** A country as a row carries it: two capital letters. */
const COUNTRY = /^[A-Z]{2}$/;

function refuse(message: string): never {
  throw new ServiceError("validation_failed", 400, message);
}

const onTheGlobe = (v: unknown, bound: number): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= bound;
/** One decimal: a region of about eleven kilometres, never a position. */
const tenth = (v: number): number => Math.round(v * 10) / 10 || 0;

/**
 * THE QUESTION, JUDGED: a text of at most 200 characters once trimmed; a language, read for its
 * first subtag and asked only when the geocoder has it; a limit of 1 to 8; a region of two numbers
 * on the globe; the person's own country as two capital letters. Anything else is refused as a bad
 * request, before anything is asked. Its words are never repeated in the refusal.
 */
export function readPlaceQuestion(body: unknown): PlaceQuestion {
  const b = (typeof body === "object" && body !== null ? body : {}) as UntrustedBody<PlaceSuggestBody>;
  const raw = b.text;
  if (typeof raw !== "string") refuse("text must be a string");
  const trimmed = raw.trim();
  if (trimmed.length > PLACE_TEXT_MAX) refuse(`text must be at most ${PLACE_TEXT_MAX} characters`);
  const text = trimmed.normalize("NFC").replace(CONTROL, " ").replace(/\s+/g, " ").trim().toLowerCase();
  // Made plain, a text can grow (a capital İ is two characters in lower case): judged again.
  if (text.length > PLACE_TEXT_MAX) refuse(`text must be at most ${PLACE_TEXT_MAX} characters`);

  // JSON's own nothing is no value, as an absent one is.
  let lang: PlaceLanguage | null = null;
  const tag = b.lang;
  if (tag !== undefined && tag !== null) {
    if (typeof tag !== "string" || tag.length > LANG_MAX) refuse("lang must be a language tag");
    const primary = tag.trim().split(/[-_]/)[0]!.toLowerCase();
    if (LANGUAGES.has(primary)) lang = primary as PlaceLanguage;
  }

  let limit = PLACE_LIMIT_DEFAULT;
  const asked = b.limit;
  if (asked !== undefined && asked !== null) {
    if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1 || asked > PLACE_LIMIT_MAX) {
      refuse(`limit must be a whole number from 1 to ${PLACE_LIMIT_MAX}`);
    }
    limit = asked;
  }

  let near: PlaceQuestion["near"] = null;
  if (b.near !== undefined && b.near !== null) {
    const { lat, lon } = (typeof b.near === "object" ? b.near : {}) as { lat?: unknown; lon?: unknown };
    if (!onTheGlobe(lat, 90) || !onTheGlobe(lon, 180)) refuse("near must carry a latitude and a longitude");
    near = { lat: tenth(lat), lon: tenth(lon) };
  }

  let home: string | null = null;
  if (b.home !== undefined && b.home !== null) {
    if (typeof b.home !== "string" || !COUNTRY.test(b.home)) refuse("home must be a country's code of two capital letters");
    home = b.home;
  }
  return { text, lang, limit, near, home };
}

const none = (state: PlaceSuggestState): PlaceSuggestAnswer => ({ state, places: [], credit: null });

/** The answer of a server that names no geocoder. */
export const placesOff = (): PlaceSuggestAnswer => none("off");

export interface PlaceSuggesterConfig {
  /** `PLACES_SUGGEST_URL` as the settings read it: an origin, and whether it is plain http on a private name. */
  readonly address: { readonly origin: string; readonly transport: "https" | "http-private" };
  /** `PLACES_SUGGEST_TOKEN`, the geocoder's bearer, or null for a geocoder that takes none. */
  readonly token: string | null;
}

export interface PlaceSuggesterDeps {
  /** The lookup of the geocoder's name, at every call. Required: a default would ship a branch never run. */
  readonly resolver: HostResolver;
  /** The clock of the limits, the cache and the holds, in ms. Absent: the wall clock. */
  readonly now?: () => number;
}

/** `p`, or a rejection the moment `signal` aborts: the wait ends even where the work does not hear it. */
function whileAsked<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** A body read under the byte bound, as JSON; `undefined` when it is too long or no JSON. */
async function jsonOf(stream: AsyncIterable<unknown> & { destroy(): unknown }, declared: string | undefined): Promise<unknown> {
  if (declared !== undefined && Number(declared) > ANSWER_MAX_BYTES) {
    stream.destroy();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > ANSWER_MAX_BYTES) {
      stream.destroy();
      return undefined;
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The geocoder's words this program knows (its handover's: over the share, its index rebuilding).
 * A line of ours names only these: a refusal that echoes the question as its word writes `unknown`.
 */
const GEOCODER_WORDS: ReadonlySet<string> = new Set(["busy_share", "dial"]);

/** The geocoder's own word for a refusal (`busy_share`, `dial`), held to a word's shape; never its sentence. */
function wordOf(body: unknown): string {
  const word = (body as { error?: unknown } | null | undefined)?.error;
  return typeof word === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(word) ? word : "unknown";
}

/** A Retry-After in seconds, within its bounds; `fallback` when it says none readably. */
function retryAfterMs(raw: string | string[] | undefined, fallback: number): number {
  const text = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  if (!/^\d{1,6}$/.test(text)) return fallback;
  return Math.min(Math.max(Number(text) * 1000, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

/** `calledAt`: when this account last had a call made to the geocoder (-Infinity: never). */
interface AccountPace { tokens: number; at: number; minuteFrom: number; inMinute: number; calledAt: number }

export function makePlaceSuggester(cfg: PlaceSuggesterConfig, deps: PlaceSuggesterDeps): PlaceSuggester {
  const now = deps.now ?? Date.now;
  const paces = new Map<string, AccountPace>();
  let sweptAt = 0;
  let calls: number[] = [];
  /** Keyed by a digest of the account and the question, written nowhere: an answer is the asking account's alone. */
  const kept = new Map<string, { at: number; places: PlaceSuggestion[] }>();
  let hold: { state: "busy" | "down"; until: number } | null = null;
  let settingsRefused = false;

  /** This account's pace with one more question taken, or null when it is over it. Idle accounts are let go each minute. */
  function paced(accountId: string, t: number): AccountPace | null {
    if (t - sweptAt >= 60_000) {
      for (const [id, p] of paces) if (t - p.at >= 60_000) paces.delete(id);
      sweptAt = t;
    }
    let p = paces.get(accountId);
    if (p === undefined) {
      p = { tokens: ACCOUNT_BURST, at: t, minuteFrom: t, inMinute: 0, calledAt: -Infinity };
      paces.set(accountId, p);
    }
    p.tokens = Math.min(ACCOUNT_BURST, p.tokens + ((t - p.at) / 1000) * ACCOUNT_PER_SECOND);
    p.at = t;
    if (t - p.minuteFrom >= 60_000) {
      p.minuteFrom = t;
      p.inMinute = 0;
    }
    if (p.tokens < 1 || p.inMinute >= ACCOUNT_PER_MINUTE) return null;
    p.tokens -= 1;
    p.inMinute += 1;
    return p;
  }

  /** One more call of the program's in the last second, or false at the cap. */
  function callable(t: number): boolean {
    calls = calls.filter((at) => t - at < 1000);
    if (calls.length >= PROGRAM_PER_SECOND) return false;
    calls.push(t);
    return true;
  }

  function keptFor(key: string, t: number): PlaceSuggestion[] | null {
    const k = kept.get(key);
    if (k === undefined) return null;
    kept.delete(key);
    if (t - k.at >= CACHE_MS) return null;
    kept.set(key, k);
    return k.places;
  }

  function keep(key: string, places: PlaceSuggestion[], t: number): void {
    kept.delete(key);
    kept.set(key, { at: t, places });
    while (kept.size > CACHE_MAX) kept.delete(kept.keys().next().value!);
  }

  function held(state: "busy" | "down", ms: number, why: string, log: Logger, status?: number): PlaceSuggestAnswer {
    // A later answer never shortens a hold an earlier one asked for (a busy second after a rebuild's thirty).
    const until = now() + ms;
    if (hold === null || until > hold.until) hold = { state, until };
    const line = { state, why, cooldownMs: ms, ...(status !== undefined ? { status } : {}) };
    if (state === "busy") log.info("places_held", line);
    else log.warn("places_held", line);
    return none(state);
  }

  /** The geocoder's answer, judged by its status: rows, an empty ok, a hold, or off. */
  function judged(
    status: number, retryAfter: string | string[] | undefined, body: unknown, q: PlaceQuestion, key: string, log: Logger,
  ): PlaceSuggestAnswer {
    if (status === 200) {
      if (!Array.isArray((body as { features?: unknown } | null | undefined)?.features)) return held("down", HOLD_DOWN_MS, "unreadable", log);
      const places = placeRowsOf(body, q.limit, q.text, q.home);
      keep(key, places, now());
      return { state: "ok", places, credit: "osm" };
    }
    if (status === 400) {
      const word = wordOf(body);
      log.warn("places_question_refused", { refusal: GEOCODER_WORDS.has(word) ? word : "unknown" });
      return { state: "ok", places: [], credit: null };
    }
    // Only a 401 is the settings' fault; a 403 (a filter in front of the geocoder refusing one
    // question) falls to the 5 s hold below, never turning the suggestions off for everyone.
    if (status === 401) {
      if (!settingsRefused) {
        log.warn("places_settings_refused", { status, configVar: "PLACES_SUGGEST_URL, PLACES_SUGGEST_TOKEN" });
      }
      settingsRefused = true;
      return none("off");
    }
    if (status === 429) return held("busy", retryAfterMs(retryAfter, HOLD_BUSY_MS), "throttled", log);
    if (status === 503) {
      const word = wordOf(body);
      if (word.startsWith("busy_")) return held("busy", retryAfterMs(retryAfter, HOLD_BUSY_MS), "busy", log);
      if (word === "dial") return held("down", retryAfterMs(retryAfter, HOLD_REBUILD_MS), "rebuilding", log);
      return held("down", retryAfterMs(retryAfter, HOLD_DOWN_MS), "unavailable", log);
    }
    return held("down", HOLD_DOWN_MS, "status", log, status);
  }

  async function call(q: PlaceQuestion, key: string, log: Logger, left: AbortSignal | undefined): Promise<PlaceSuggestAnswer> {
    const url = new URL("/api", cfg.address.origin);
    url.searchParams.set("q", q.text);
    url.searchParams.set("limit", String(q.limit + ASK_MORE));
    if (q.lang !== null) url.searchParams.set("lang", q.lang);
    if (q.near !== null) {
      url.searchParams.set("lat", q.near.lat.toFixed(1));
      url.searchParams.set("lon", q.near.lon.toFixed(1));
    }
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT, accept: "application/json", "accept-encoding": "identity",
      ...(cfg.token !== null ? { authorization: `Bearer ${cfg.token}` } : {}),
    };
    const ac = new AbortController();
    const end = (): void => ac.abort();
    const timer = setTimeout(end, PLACE_CALL_MS);
    left?.addEventListener("abort", end, { once: true });
    if (left?.aborted) end();
    try {
      // The name is asked again at every call; plain http goes only to addresses of a private network.
      const pin = await whileAsked(
        cfg.address.transport === "http-private" ? privateNetworkPin(url.hostname, deps.resolver) : resolvePinUnchecked(url.href, deps.resolver),
        ac.signal,
      );
      if (pin === null || pin.length === 0) return held("down", HOLD_DOWN_MS, "not_private", log);
      const res = await whileAsked(pinnedHttpRequest(url.href, { method: "GET", headers, pin, signal: ac.signal }), ac.signal);
      const body = await whileAsked(jsonOf(res.stream, res.headers["content-length"]), ac.signal);
      return judged(res.status, res.headers["retry-after"], body, q, key, log);
    } catch {
      // The person left: nothing to hold against the geocoder, and nobody reads this answer.
      if (left?.aborted) return none("down");
      return held("down", HOLD_DOWN_MS, ac.signal.aborted ? "timeout" : "connection", log);
    } finally {
      clearTimeout(timer);
      left?.removeEventListener("abort", end);
    }
  }

  return {
    async suggest(accountId, q, opts = {}) {
      const log = opts.logger ?? silentLogger;
      if (settingsRefused) return none("off");
      if (q.text.length < PLACE_TEXT_MIN) return { state: "ok", places: [], credit: null };
      const t = now();
      const pace = paced(accountId, t);
      if (pace === null) return none("busy");
      const key = createHash("sha256").update(JSON.stringify([accountId, q.text, q.lang, q.limit, q.near?.lat ?? null, q.near?.lon ?? null, q.home])).digest("base64url");
      const places = keptFor(key, t);
      if (places !== null) return { state: "ok", places, credit: "osm" };
      if (hold !== null && t < hold.until) return none(hold.state);
      // A fresh call: one of this account's in any second, and one of the program's three.
      if (t - pace.calledAt < ACCOUNT_CALL_MS || !callable(t)) return none("busy");
      pace.calledAt = t;
      return call(q, key, log, opts.signal);
    },
  };
}
