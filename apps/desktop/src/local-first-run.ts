/**
 * THE STANDALONE DOOR'S FIRST-RUN HOST — every call the setup flow makes, over the local pipe.
 *
 * `useCloudFirstRun` is this file's twin and the shape is deliberately its: the shared stage
 * (`app/shell/FirstRun.tsx`) knows nothing about any door and asks for one object
 * (`FirstRunHost`), so the whole difference between "setup on ohmail.app" and "setup on a laptop
 * with nobody's account behind it" lives here. The window cannot import `app/api-client` —
 * `vite.config.ts` aliases it to a stub whose value exports refuse, and the public mirror does not
 * carry the module at all — so this is where the flow's seam is bound to `bridgeFetch`.
 *
 * ── THE THREE CALLS THAT DO NOT GO WHERE THE OTHER DOOR SENDS THEM ─────────────────────────
 *
 * The shared route table is served by the engine on this machine, so most of the flow is the
 * same request one hop shorter. Three are not, and each for a stated reason:
 *
 *  1. {@link FirstRunHost.organize} → `POST /local/mailboxes/:id/organize`, not the shared
 *     `POST /mailboxes/:id/organize`. The shared one is `stepUp: true`, and on this door a step-up
 *     is not a guard but a permanent refusal: the launch session's second-factor stamp is written
 *     once at boot (`identity.ts#mintLaunchSession` — "there is no second factor on a local
 *     install"), so `withStepUp` refuses from five minutes after launch for the life of the
 *     process. Every machine that has been open longer than a coffee would be unable to finish
 *     setup. The local route's authority is the per-launch bearer, which is minted at boot, added
 *     shell-side and never reaches this window — holding it IS being the person sitting at the
 *     machine.
 *  2. {@link FirstRunHost.forgetMailbox} → `DELETE /local/mailboxes/:id`, on the identical
 *     argument; the shared `DELETE /mailboxes/:id` carries the same flag and the same consequence.
 *  3. {@link FirstRunHost.connect} → the SHELL'S DOOR, not `POST /mailboxes`. See its own note: a
 *     mailbox row created through the API would be a row the shell's settings file has never heard
 *     of, and the engine dials what the settings file says. The create is not a request here, it
 *     is a reconfiguration of the install.
 *
 * ── AND THIS DOOR CAN RECORD "ASKED, AND THE ANSWER WAS NO", WHICH CLOUD CANNOT ────────────
 *
 * `OnboardingAi` is a four-state union because "never asked" and "answered no" select opposite
 * screens, and `useCloudFirstRun` can only supply three of the four — `accounts.ai_enabled` is a
 * boolean that rests false, so that door reports `unset` for both and the stage compensates by
 * walking its own cursor past a "no".
 *
 * Here the answer is a property of the INSTALL, exactly as the model file is, so it is stored the
 * way this window stores every other per-install preference and the fourth state is real. That is
 * not a nicety: `onboardingPath` puts the provider step in the walk for `door === "local" && ai
 * !== "off"`, so without a recordable "no" somebody who declined a model would be walked straight
 * onto the form for choosing one.
 */

import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type {
  FirstRunHost, FirstRunMailboxInput, FirstRunOrganizeOutcome, FirstRunProbeOk,
} from "../../webapp/app/shell/first-run-host";
import type { OnboardingAi } from "../../webapp/app/shell/onboarding";
import { bridgeFetch, type EngineStatus } from "./bridge-fetch.js";
import { CONSENT_SETTINGS_PATH } from "./local-consent.js";
import type { LocalAiStatus } from "./local-ai.js";
import {
  enterLocalDoor, firstRunDoorFor, localProblem, standingEngine, type LocalDoorFields,
} from "./doors.js";

/** Where the engine serves the probe. Root-relative, like every path in this window. */
export const PROBE_PATH = "/mailboxes/probe";

/** The standalone consent route, for the mailbox this run is about. See the header's point 1. */
export function organizePath(mailboxId: string): string {
  return `/local/mailboxes/${mailboxId}/organize`;
}

/** The local removal route. See the header's point 2. */
export function localMailboxPath(mailboxId: string): string {
  return `/local/mailboxes/${mailboxId}`;
}

/**
 * WHERE THIS INSTALL'S ANSWER TO THE AI QUESTION IS KEPT.
 *
 * The window's own storage rather than the engine's store, and that is the honest home for it:
 * the engine records what MODEL is configured (`ai-provider.ts`), which is a different fact. "I
 * was asked and I said no" is not a model setting — writing it as one would mean inventing a
 * provider state that means "declined", and every reader of `/local/ai` would then have to know
 * about a state that is about a dialog rather than about a model.
 */
const AI_ANSWER_KEY = "ohmail.first-run.ai";

/** What the person answered, or `null` when nobody has been asked on this install. */
function readAiAnswer(): boolean | null {
  try {
    const raw = globalThis.localStorage?.getItem(AI_ANSWER_KEY);
    return raw === "yes" ? true : raw === "no" ? false : null;
  } catch {
    /* A window with storage denied answers "nobody has been asked", which is the safe
       direction — the flow asks again rather than silently skipping somebody. */
    return null;
  }
}

function writeAiAnswer(answer: boolean): void {
  try {
    globalThis.localStorage?.setItem(AI_ANSWER_KEY, answer ? "yes" : "no");
  } catch {
    /* Storage refused. The run in front of us still walks correctly — the state below is React's
       and does not depend on the write — and only a LATER resume re-asks. Same trade the Cloud
       door makes permanently. */
  }
}

/**
 * THE FOUR-STATE POSTURE, from what the engine reports plus what this install was told.
 *
 * The engine's answer WINS wherever it has one, because a configured provider is evidence that
 * outranks a remembered click: somebody who answered "no" a year ago and has since set up a model
 * in Settings is `on`, not `off`, and the flow must not offer to configure a model that is
 * already running.
 */
export function localAiPosture(ai: LocalAiStatus | null, answered: boolean | null): OnboardingAi {
  if (ai && ai.provider !== null) return ai.available ? "on" : "on-unconfigured";
  if (answered === true) return "on-unconfigured";
  if (answered === false) return "off";
  return "unset";
}

/** The probe taxonomy the connect form renders. One vocabulary, shared with the other door. */
const PROBE_REASONS = new Set([
  "auth", "connect", "tls", "timeout", "storage", "sync", "unknown",
]);

/**
 * A REFUSAL FROM THE ENGINE, with its code and details intact.
 *
 * `probeReasonOf` in the browser reads `ApiError`, which lives in `app/api-client` — the module
 * this build aliases to a thrower. So the classification has to be done against a shape this
 * window can construct, and the shape is the SAME error envelope the engine writes
 * (`packages/api/src/responses.ts#errorResponse`): `{ error: { code, message, details? } }`.
 */
export class LocalWireError extends Error {
  readonly code: string | null;
  readonly details: unknown;
  constructor(message: string, code: string | null, details: unknown) {
    super(message);
    this.name = "LocalWireError";
    this.code = code;
    this.details = details;
  }
}

interface WireEnvelope {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

/** The engine's own sentence for a refusal, or the status line when it composed none. */
async function refusal(res: Response): Promise<LocalWireError> {
  let envelope: WireEnvelope = {};
  try {
    envelope = (await res.json()) as WireEnvelope;
  } catch {
    /* Not JSON, or an empty body. The status is all there is. */
  }
  const said = envelope.error?.message;
  const code = envelope.error?.code;
  return new LocalWireError(
    typeof said === "string" && said ? said : `the mail engine answered ${res.status}`,
    typeof code === "string" ? code : null,
    envelope.error?.details ?? null,
  );
}

async function jsonOf<T>(res: Response): Promise<T> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

/** No body to read, and a 204 is the ordinary answer. */
async function okOf(res: Response): Promise<void> {
  if (!res.ok) throw await refusal(res);
}

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * WHICH MEMBER OF THE PROBE TAXONOMY THIS ERROR IS — `probeReasonOf`'s rule, against the envelope
 * this door can see. `null` falls back to the server's own sentence, which is always true even
 * when this build has no copy for it.
 */
export function localProbeReason(err: unknown): string | null {
  if (!(err instanceof LocalWireError) || err.code !== "mailbox_probe_failed") return null;
  const reason = (err.details as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === "string" && PROBE_REASONS.has(reason) ? reason : null;
}

/** The server's own sentence for an error, for the fallback the line above describes. */
export function localProbeMessage(err: unknown): string | null {
  return err instanceof LocalWireError ? err.message : null;
}

/**
 * THE FLOW'S MAILBOX SHAPE AS THE SHELL'S DOOR WANTS IT.
 *
 * `enterLocalDoor` derives `secure` from the PORT (`implicitTls`) rather than taking the form's
 * flag, and that narrowing is kept rather than worked around: it is the behaviour every mailbox
 * this door has ever connected was connected with, and one connect path with one rule beats two
 * paths that can disagree about what "993" means.
 */
function doorFields(input: FirstRunMailboxInput): LocalDoorFields {
  return {
    providerId: input.provider,
    address: input.address,
    /* Empty means "the login is the address", which is what `enterLocalDoor` does with it — the
       same default `createBody` applies on the other door, so both land on the same string. */
    user: input.imap.user ?? "",
    imapHost: input.imap.host,
    imapPort: input.imap.port === undefined ? "" : String(input.imap.port),
    smtpHost: input.smtp?.host ?? "",
    smtpPort: input.smtp?.port === undefined ? "" : String(input.smtp.port),
    password: input.imap.pass,
  };
}

/** The fallbacks `enterLocalDoor` reaches for when a field was left blank. */
function doorPreset(input: FirstRunMailboxInput): {
  imap: { host: string; port: number }; smtp: { host: string; port: number };
} {
  return {
    imap: { host: input.imap.host, port: input.imap.port ?? 993 },
    smtp: { host: input.smtp?.host ?? "", port: input.smtp?.port ?? 465 },
  };
}

export interface LocalFirstRunOptions {
  /** What the shell says about the engine. The door rule is `firstRunDoorFor`, not this object. */
  status: EngineStatus | null;
  /** What this install has for a model — the gate already reads it; one read, one truth. */
  ai: LocalAiStatus | null;
  /** `apps/desktop/src/AiProviderForm.tsx`, the SAME form Settings → AI mounts. */
  providerForm: ReactNode;
  /** The devices surface, where this install may pair. */
  pairNode?: ReactNode;
}

/**
 * THE STANDALONE DOOR'S HOST, or `undefined` where the stage must not exist.
 *
 * `undefined` is `AppShell`'s structural withholding: with no host the overlay is not rendered at
 * all and `#/first-run` draws nothing, which is the correct answer on the hosted door (that
 * install's setup is the account's, in a browser or in the flow the account already ran) and on a
 * window with no door chosen yet (where the DoorChooser is the screen, not this).
 */
export function useLocalFirstRun(opts: LocalFirstRunOptions): FirstRunHost | undefined {
  const { status, ai, providerForm, pairNode } = opts;
  const local = firstRunDoorFor(status) === "local";

  /**
   * The remembered answer, read ONCE into state rather than on every render.
   *
   * A render-time `localStorage` read would make the posture a value React cannot see change, so
   * `setAiEnabled`'s write would not re-render the stage and the person would press "No" and stay
   * on the question. The write below sets both.
   */
  const [answered, setAnswered] = useState<boolean | null>(() => readAiAnswer());

  const probe = useCallback(async (input: FirstRunMailboxInput): Promise<FirstRunProbeOk> => {
    /**
     * TEST THIS CONNECTION — the engine's own dial, `POST /mailboxes/probe`.
     *
     * REACHABLE ONLY WHILE THIS INSTALL HAS NO MAILBOX, and that is not a limitation of this
     * function but of where the stage puts it: the mailbox step withholds its form the moment
     * `facts.mailbox` is non-null, and `mailMount` in `doors.ts` will not mount `AppShell` at all
     * until the engine reports a `mailboxId`. So the only state in which this can be pressed is
     * one where the engine has just come up — which is also the only state in which the shared
     * route's `stepUp: true` is satisfiable on this door (the launch session's stamp is written
     * at boot and expires five minutes later, for ever). The two windows are the same window,
     * which is why this may stay on the shared route while `organize` may not.
     *
     * Sent as typed, including an ABSENT username: the service defaults that to the address, and
     * `doorFields` applies the identical default on the connect that follows, so the test and the
     * connect dial the same identity.
     */
    return jsonOf<FirstRunProbeOk>(
      await bridgeFetch(PROBE_PATH, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ address: input.address, imap: input.imap }),
      }),
    );
  }, []);

  const connect = useCallback(async (input: FirstRunMailboxInput): Promise<{ id: string }> => {
    /**
     * CONNECT IT — and on this door that is `engine_configure` plus a sealed password, never
     * `POST /mailboxes`.
     *
     * The shared create writes a row into the engine's database. It does NOT write the shell's
     * settings file, and the settings file is what the engine composes its IMAP dial from at every
     * launch — so a mailbox created through the API would be a row nothing ever connects to, on an
     * install whose door is still whatever it was. Worse, the password would have to travel to a
     * `stepUp: true` route, which on this door refuses after five minutes.
     *
     * `enterLocalDoor` is the door's real connect and is already the one `DoorChooser` presses:
     * configure, settle, seal the password through `PATCH /mailboxes/:id`, then replace the engine
     * so the adapter it built at boot is rebuilt with a password it can use. It is immune to the
     * step-up trap for a reason that is structural rather than lucky — it restarts the engine
     * immediately before it seals, so the launch session it authenticates with is seconds old.
     */
    const problem = localProblem(doorFields(input));
    if (problem) throw new LocalWireError(problem, null, null);
    const result = await enterLocalDoor(
      doorFields(input), doorPreset(input), await standingEngine(),
    );
    if (result.problem !== null) throw new LocalWireError(result.problem, null, null);
    const id = result.status?.mailboxId;
    /* A door that reported no problem and no mailbox has not connected one. Saying so beats
       returning an empty id that the consent call would then address. */
    if (!id) {
      throw new LocalWireError(
        "The mailbox was configured and this install has not been told its name yet. "
          + "Reopen ohmail and setup will continue where it left off.",
        null, null,
      );
    }
    return { id };
  }, []);

  const organize = useCallback(async (
    mailboxId: string,
    body: { imap?: { pass: string }; screening?: { dormancyDays?: number; scope?: "window" | "all_time" } },
  ): Promise<FirstRunOrganizeOutcome> => {
    /**
     * AGREE AND START ORGANIZING — consent, baseline, window and scope in one transaction.
     *
     * `body.imap` IS DELIBERATELY DROPPED. The other door sends a password here because its
     * step-up wants one; this route's authority is the per-launch bearer the shell adds, and the
     * handler reads no credential from the body. Forwarding it would put a mailbox password on a
     * wire for a handler that ignores it, which is the kind of thing that is harmless right up
     * until somebody logs a request body.
     */
    /* THE OUTCOME IS READ, not discarded. Every reply here is a 200 — `authorized` is the first
       consent, `already_organizing` is a re-run of setup on a mailbox this install already
       organizes (the stamp is refused and the window IS written), and `removed`/`no_mailbox` are
       a mailbox that is not there, which stores nothing. The stage advances on the first two and
       must not on the last two. See {@link FirstRunOrganizeOutcome}. */
    const r = await jsonOf<{ outcome?: string }>(
      await bridgeFetch(organizePath(mailboxId), {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body.screening ? { screening: body.screening } : {}),
      }),
    );
    return r.outcome === "authorized" || r.outcome === "already_organizing" ? "stored" : "gone";
  }, []);

  const complete = useCallback(async () => {
    /* LEAVE THE FLOW. `consentRoutes` are mounted on `localRoutes` (mail 0083), so this is the
       same `PATCH /consent/settings` a browser tab sends, answered out of this machine's own
       `account_settings`. It takes only `true`; nothing un-completes onboarding. */
    await jsonOf<{ onboardingCompletedAt?: string }>(
      await bridgeFetch(CONSENT_SETTINGS_PATH, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ onboardingCompleted: true }),
      }),
    );
  }, []);

  const setAiEnabled = useCallback(async (enabled: boolean) => {
    /* No round trip: there is nothing on the engine that stores this answer, and inventing one
       would be a provider state that means "declined". See {@link AI_ANSWER_KEY}. The state is
       set from the ARGUMENT rather than from an echo for the same reason — there is no server
       here to clamp it, so there is nothing for an echo to disagree with. */
    writeAiAnswer(enabled);
    setAnswered(enabled);
  }, []);

  const forgetMailbox = useCallback(async (mailboxId: string) => {
    await okOf(await bridgeFetch(localMailboxPath(mailboxId), { method: "DELETE" }));
  }, []);

  const posture = localAiPosture(ai, answered);

  return useMemo(() => {
    if (!local) return undefined;
    return {
      door: "local",
      ai: posture,
      probe,
      connect,
      organize,
      complete,
      setAiEnabled,
      forgetMailbox,
      probeReason: localProbeReason,
      probeMessage: localProbeMessage,
      providerForm,
      ...(pairNode ? { pairNode } : {}),
    } satisfies FirstRunHost;
  }, [
    complete, connect, forgetMailbox, local, organize, pairNode, posture, probe, providerForm,
    setAiEnabled,
  ]);
}
