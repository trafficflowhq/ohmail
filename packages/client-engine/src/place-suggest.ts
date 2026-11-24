/**
 * PLACE SUGGESTIONS ON A DEVICE: one question to the account's server for an event's place field,
 * asked at once or not at all. A newer keystroke gives the older question up through its signal;
 * nothing is queued, nothing is asked while the device is offline, and nothing is kept: no record,
 * no meta value, no outbox row. The pause after typing, the reuse of answers and the person's own
 * earlier places belong to the field.
 */
import type { PlaceSuggestAnswer, PlaceSuggestBody, PlaceSuggestion } from "@ohmail/wire";
import { knownOffline } from "./known-offline.js";

/** How a device asks its server. The engine's HTTP adapter is one. */
export interface PlaceSuggestTransport {
  /** `POST /calendar/places/suggest`. Throws on a refusal, a network fault or a question given up. */
  suggestPlaces(question: PlaceSuggestBody, signal: AbortSignal | undefined): Promise<PlaceSuggestAnswer>;
}

/**
 * The server's answer, or the device's own word for a question that got none: `offline` (not
 * asked), `stopped` (given up), `failed` (refused, unreachable, or an answer that was no answer).
 * Every state but `ok` is "no suggestions".
 */
export type PlaceSuggestOutcome =
  | PlaceSuggestAnswer
  | { state: "offline" | "stopped" | "failed"; places: []; credit: null };

const KINDS: ReadonlySet<string> = new Set(["venue", "address", "street", "town", "other"]);
const STATES: ReadonlySet<string> = new Set(["ok", "off", "busy", "down"]);

const isPlace = (p: unknown): p is PlaceSuggestion => {
  const r = p as Partial<Record<keyof PlaceSuggestion, unknown>> | null;
  return typeof r === "object" && r !== null && typeof r.kind === "string" && KINDS.has(r.kind)
    && typeof r.first === "string" && typeof r.second === "string" && (r.country === null || typeof r.country === "string")
    && typeof r.lat === "number" && typeof r.lon === "number";
};

/** The answer as the server shaped it, or null when it is not one. */
function answerOf(wire: unknown): PlaceSuggestAnswer | null {
  const a = wire as Partial<Record<keyof PlaceSuggestAnswer, unknown>> | null;
  if (typeof a !== "object" || a === null || typeof a.state !== "string" || !STATES.has(a.state)) return null;
  if (!Array.isArray(a.places) || !a.places.every(isPlace)) return null;
  return { state: a.state as PlaceSuggestAnswer["state"], places: a.places, credit: a.credit === "osm" ? "osm" : null };
}

const none = (state: "offline" | "stopped" | "failed"): PlaceSuggestOutcome => ({ state, places: [], credit: null });

/**
 * ONE QUESTION. Never rejects. `transport` null is a client with no server to ask: `off`.
 */
export async function askPlaces(
  transport: PlaceSuggestTransport | null, question: PlaceSuggestBody, opts: { signal?: AbortSignal } = {},
): Promise<PlaceSuggestOutcome> {
  if (transport === null) return { state: "off", places: [], credit: null };
  if (opts.signal?.aborted) return none("stopped");
  if (knownOffline()) return none("offline");
  try {
    return answerOf(await transport.suggestPlaces(question, opts.signal)) ?? none("failed");
  } catch {
    return none(opts.signal?.aborted ? "stopped" : "failed");
  }
}
