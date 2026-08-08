/**
 * THE OHBOX BAR IN THE DESKTOP WINDOW — the window's half of the engine's screening preference.
 *
 * Two facts about how this mailbox wants its Ohbox kept live on `account_settings`: the POSTURE,
 * and the BAR — your own sentence about what deserves the Ohbox. Both columns are mail-half,
 * so every standalone install's database has held them since it was created, and the engine has
 * always READ them: the bar travels in the user turn of the question a model is asked, both when
 * mail arrives and when somebody asks the Screener about a sender waiting there.
 *
 * What was missing was a way to WRITE one. `GET/PATCH /account/screening` was mounted in the hosted
 * route table only, so the words that steer this install's own model were readable and unwritable
 * on the one tier where the person reading them is the one paying for the model. The local engine
 * serves that route now, and this module is what addresses it — over {@link bridgeFetch}, the same
 * pipe every other request in this window goes down.
 *
 * ── ONE MODULE, TWO DOORS, AND THE ENGINE DECIDES WHICH ─────────────────────────────────────
 *
 * On the STANDALONE door the engine serves this route itself, out of the database on this machine.
 * On the HOSTED door it serves no such route and forwards the request to the account, bearer and
 * all — the same write-through path every other mutation in that mode takes. So one path, one
 * module, and two completely different places the value lives; nothing here has to know which,
 * which is exactly why it does not ask.
 *
 * ── IT READS AND WRITES ONE AXIS ────────────────────────────────────────────────────────────
 *
 * The route takes three (`ohboxPolicy`, `ohboxBar`, `screenerAutoApply`) and this module now writes
 * all three — through one patching function, because a PATCH that names one axis leaves the others
 * untouched. Which of them a SURFACE offers is a different question, and the answer differs by door:
 *
 *  · the POSTURE is honoured on BOTH doors — each host resolves it per account and files against
 *    it — so it is offered on both. **It genuinely was not honoured on the standalone door when an
 *    earlier version of this note was written, and the note was wrong rather than early**: the
 *    local engine passed no posture at all, so its pipeline resolved the lenient default for every
 *    install. That was fixed at the loop, and this line stays as the reminder that a claim in a
 *    comment is a claim.
 *  · AUTO-APPLY is offered on the HOSTED door only. Its consumer is the hosted worker's scheduled
 *    pass, which no standalone install runs, so a switch for it on that door would be a control
 *    that does nothing — worse than an absent one.
 *
 * A PATCH body that names one axis leaves the others untouched — the route tests presence with
 * `in`, so an omitted key is "leave this alone" and an explicit `null` is "revert this one". On the
 * hosted door that is what keeps this editor from clobbering a posture set in the web client.
 *
 * ── AND IT GOES DOWN THE BRIDGE, NOT THROUGH THE SYNC CLIENT ────────────────────────────────
 *
 * `bridgeFetch` directly, the way `local-ai.ts` addresses its own route — never the sync client's
 * own request method. That is load-bearing rather than stylistic: the engine's route-coverage check
 * DERIVES the client's call list from that client's source and holds it against both of the
 * surfaces the engine serves, so a settings call routed through it would join the list and land in
 * the hosted-mirror half of it, where this route has no local handler and would have to be declared
 * a forward. A preference is not sync traffic and has no place in the protocol that carries mail;
 * keeping it here keeps that check about mail.
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
 * Write one or more axes of the preference, leaving the others exactly as they are.
 *
 * The route tests presence with `in`, so an omitted key means "leave this alone" and an explicit
 * `null` means "revert this one". That is what lets two controls over the same row — the bar here
 * and the posture switch beside it — write independently without either clobbering the other, and
 * on the hosted door it is what stops this window overwriting a posture set in the web client.
 *
 * Answers with the preference now in force, so every control renders what was STORED rather than
 * what was asked for — the same discipline the hosted client's copy of these controls follows.
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
