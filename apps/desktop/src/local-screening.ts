/**
 * THE OHBOX BAR IN THE DESKTOP WINDOW — the window's half of the engine's screening preference.
 * The POSTURE and the BAR live on `account_settings`; `GET/PATCH /account/screening` is served
 * by the local engine on the standalone door and forwarded to the account on the hosted one —
 * this module never asks which. One patching function writes the three axes (`ohboxPolicy`,
 * `ohboxBar`, `screenerAutoApply`); the route tests presence with `in`: omitted = "leave this
 * alone", `null` = "revert". Posture is honoured on both doors; AUTO-APPLY is hosted-only, its
 * consumer the hosted worker's scheduled pass. `bridgeFetch`, never the sync client — a
 * preference is not sync traffic, and the route-coverage check derives the client's call list.
 */

import { bridgeFetch } from "./bridge-fetch.js";

/** Where the engine serves it. Root-relative, like every path in this window. */
const SCREENING_PATH = "/account/screening";

/**
 * `404` MEANS "NOT ON THIS DOOR", and it is a state rather than a fault.
 *
 * The same shape `local-ai.ts` uses, for a closely related reason: an engine that does not serve this
 * route is an engine this pane has nothing to show for, and an error card would be a lie about a
 * mailbox that is working perfectly well.
 */
const NOT_SERVED_HERE = 404;

/**
 * `503` MEANS "THE ACCOUNT IS OUT OF REACH", and it is NOT the same answer as 404.
 *
 * On the hosted door this route is forwarded, and the forward is refused before it is attempted
 * while the install is offline. That is a mailbox whose words exist and cannot be reached right
 * now — a different fact from "this door has no such setting", and the pane says two different
 * things about them. Collapsing both to "render nothing" is what would make a section somebody
 * has filled in vanish and come back with the network, which reads as data loss.
 */
const OFFLINE = 503;

/** What a read found. Three outcomes, because a surface that conflates them tells a lie. */
export type ScreeningRead =
  /** The preference, from wherever this door keeps it. */
  | { state: "ready"; pref: ScreeningPreference }
  /** This engine serves no such route — the door has no screening preference to show. */
  | { state: "not-served" }
  /** The hosted account holds it and cannot be reached from here at the moment. */
  | { state: "offline" };

/** What `GET /account/screening` answers. The wire shape, as the hosted client sees it too. */
export interface ScreeningPreference {
  ohboxPolicy: "people_only" | "people_and_replied" | null;
  /** The stored words, or `null` while this mailbox has never set any. */
  ohboxBar: string | null;
  /** The product default — what the editor prefills with, and what `null` resolves to. */
  defaultBar: string;
  screenerAutoApply: boolean;
}

interface WireError {
  error?: { code?: string; message?: string };
}

/** The engine's own sentence for a refusal, or a plain one when it did not compose one. */
async function refusal(res: Response): Promise<Error> {
  let said: string | undefined;
  try {
    said = ((await res.json()) as WireError).error?.message;
  } catch {
    /* Not JSON, or an empty body. The status is all there is. */
  }
  return new Error(said ?? `the mail engine answered ${res.status}`);
}

async function readPreference(res: Response): Promise<ScreeningPreference> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as ScreeningPreference;
}

/** This mailbox's screening preference, or which of the two absences applies. */
export async function readScreening(): Promise<ScreeningRead> {
  const res = await bridgeFetch(SCREENING_PATH);
  if (res.status === NOT_SERVED_HERE) return { state: "not-served" };
  if (res.status === OFFLINE) return { state: "offline" };
  return { state: "ready", pref: await readPreference(res) };
}

/**
 * Write one or more axes of the preference, leaving the others exactly as they are. The route
 * tests presence with `in`, so an omitted key means "leave this alone" and an explicit `null`
 * means "revert this one" — two controls over the same row write independently, and on the
 * hosted door this window cannot overwrite a posture set in the web client. Answers with the
 * preference now in force, so every control renders what was STORED rather than what was asked
 * for — the discipline the hosted client's copy of these controls follows.
 */
export async function saveScreening(
  patch: Partial<Pick<ScreeningPreference, "ohboxPolicy" | "ohboxBar" | "screenerAutoApply">>,
): Promise<ScreeningPreference> {
  return readPreference(
    await bridgeFetch(SCREENING_PATH, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

/** The bar, and nothing else. `null` reverts it to the product default. */
export async function saveOhboxBar(bar: string | null): Promise<ScreeningPreference> {
  return saveScreening({ ohboxBar: bar });
}
