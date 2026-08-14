/**
 * "SUGGEST FOR NEW SENDERS AS THEY ARRIVE", IN THE DESKTOP WINDOW — the transport, and nothing else.
 *
 * The engine on this machine serves `GET/PUT /local/auto-suggest` on the STANDALONE door and on no
 * other, exactly as it serves `/local/ai`. Everything about the shape below follows from that:
 * `bridgeFetch` because this window's content policy is `connect-src 'none'` and the pipe to the
 * engine is the only way out of it, and `404 ⇒ not on this door` because a hosted install arms the
 * same consent on its ACCOUNT, through `/consent/settings`, where the ledger and the worker that
 * spends against it actually live (`local-consent.ts`).
 *
 * The 404 idiom is `local-screening.ts`'s and it is copied deliberately: an engine that does not
 * serve this route is an engine this control has nothing to show for, and an error card would be a
 * lie about a mailbox that is working perfectly well.
 *
 * ── WHY THERE IS NO `503 OFFLINE` ARM HERE, WHERE THE SCREENING PANE HAS ONE ────────────────
 *
 * That pane's route is FORWARDED on the hosted door, so "the account is out of reach" is a real
 * third state it has to say out loud. This route is never forwarded — it exists on one door and is
 * answered out of a database file in this same process. There is no network between the switch and
 * the value, so the only honest outcomes are the two below.
 */

import { bridgeFetch } from "./bridge-fetch.js";

/** Where the engine serves it. Root-relative, like every path in this window. */
const AUTO_SUGGEST_PATH = "/local/auto-suggest";

/** `404` means "not on this door" — a state, not a fault. See the header. */
const NOT_SERVED_HERE = 404;

/** What the engine holds. The wire shape of `auto-suggest-routes.ts`. */
export interface AutoSuggestState {
  /** As STORED. The only field that says whether this install is asking a model unprompted. */
  on: boolean;
  /** When it was turned on, or null. On the engine the same instant is the watermark. */
  since: string | null;
  /** Whether this install has a verified model right now. The ENGINE's answer, never inferred. */
  modelReady: boolean;
}

/** What a read found. Two outcomes, because a surface that conflates them tells a lie. */
export type AutoSuggestRead =
  | { state: "ready"; value: AutoSuggestState }
  /** This engine serves no such route — the door has no such setting to show. */
  | { state: "not-served" };

/** The engine's own sentence for a refusal, or the status line when it composed none. */
async function refusal(res: Response): Promise<Error> {
  let said: string | undefined;
  try {
    said = ((await res.json()) as { error?: { message?: string } }).error?.message;
  } catch {
    /* Not JSON, or an empty body. The status is all there is. */
  }
  return new Error(said ?? `the mail engine answered ${res.status}`);
}

async function readValue(res: Response): Promise<AutoSuggestState> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as AutoSuggestState;
}

/** This install's setting, or the one absence that applies. */
export async function readAutoSuggest(): Promise<AutoSuggestRead> {
  const res = await bridgeFetch(AUTO_SUGGEST_PATH);
  if (res.status === NOT_SERVED_HERE) return { state: "not-served" };
  return { state: "ready", value: await readValue(res) };
}

/**
 * Turn it on or off, and answer with what is now STORED.
 *
 * The response is re-read rather than composed from the argument, so the switch renders the value
 * in force and a refusal leaves the control where it was. A settings control that moved on a write
 * it did not land is the failure this whole family of components is written to avoid.
 */
export async function saveAutoSuggest(on: boolean): Promise<AutoSuggestState> {
  return readValue(
    await bridgeFetch(AUTO_SUGGEST_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on }),
    }),
  );
}
