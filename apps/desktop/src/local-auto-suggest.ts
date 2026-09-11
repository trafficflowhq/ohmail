/**
 * "SUGGEST FOR NEW SENDERS AS THEY ARRIVE", IN THE DESKTOP WINDOW — the transport and nothing
 * else. The engine serves `GET/PUT /local/auto-suggest` on the STANDALONE door and no other,
 * exactly as it serves `/local/ai`: `bridgeFetch` because this window's content policy is
 * `connect-src 'none'`, and `404 ⇒ not on this door` because a hosted install arms the same
 * consent on its ACCOUNT through `/consent/settings` (`local-consent.ts`). The 404 idiom is
 * `local-screening.ts`'s, copied deliberately — an error card would lie about a working
 * mailbox. No `503 offline` arm: this route is never forwarded — it is answered out of a
 * database file in this process, so the only honest outcomes are the two below.
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
