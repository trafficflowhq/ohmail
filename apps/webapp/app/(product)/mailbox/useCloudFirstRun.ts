"use client";

/**
 * THE CLOUD (AND SELF-HOST) DOOR'S FIRST-RUN HOST — every call the setup flow makes, over REST.
 *
 * The shared shell may not import `app/api-client` (it ships inside the standalone desktop and
 * is copied into a mirror that does not contain the module), so this is where the browser's own
 * client is bound to the flow's seam. `CloudShell` supplies the result to `AppShell`.
 *
 * ── ONE DOOR, TWO FLAVORS, AND THE DIFFERENCE IS THREE LINES ──────────────────────────────
 *
 * Managed and self-host are the SAME client talking to the same API; what differs is who pays
 * for the model. `SELF_HOST_BUILD` is a compiled constant, so the managed bundle carries no
 * `/hello` round trip for this at all, and the operator's AI state (`features.ai`, which is
 * `anthropicApiKey !== null` server-side) is read only where it is going to be shown.
 *
 * ── THE AI POSTURE SUPPLIES ALL FOUR STATES NOW, AND THE OLD NOTE HAD IT BACKWARDS ────────
 *
 * This block used to say `accounts.ai_enabled` "rests false", so the door reported `unset` for
 * both "never asked" and "answered no", and the cost was one repeated question on a resumed run.
 * **Both halves were wrong.** The column is `NOT NULL DEFAULT true` (migration 0019) and
 * `aiEnabledFor` falls back to `true` for a missing row, so a brand-new account reported `on` —
 * and `deriveOnboardingStep`'s row 5 (`facts.ai === "unset"`) therefore never fired. Measured by
 * driving the derivation with a fresh hosted account: it answers `pull`. On this door the
 * question was not asked twice; it was **not asked at all**, on an account whose AI was already
 * spending its credits.
 *
 * Migration 0084 adds `accounts.ai_answered_at` beside the switch, and `GET /account/ai` serves
 * both facts. The posture below is the whole fix: a null stamp is `unset` WHATEVER the switch
 * says, because the switch's resting value is not an answer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  FirstRunHost, FirstRunMailboxInput, FirstRunOrganizeOutcome,
} from "../../shell/first-run-host";
import type { OnboardingAi } from "../../shell/onboarding";
import {
  ApiError, aiSettings, consent as consentApi, mailboxes as mailboxApi, messageOf,
} from "../../api-client";
import { SELF_HOST_BUILD, serverHello } from "../../hello";
import { probeReasonOf } from "./MailboxSection";

/**
 * `POST /mailboxes` wants a provider id and the two transports; the flow's own shape is already
 * that, so this is a rename and not a translation. The SMTP password rides the same string the
 * IMAP one does — the connect form has always offered one field, and a mailbox whose submission
 * server wants a different password is a case neither surface has ever supported.
 */
function createBody(input: FirstRunMailboxInput) {
  return {
    provider: input.provider,
    address: input.address,
    /* THE USERNAME DEFAULTS TO THE ADDRESS, and it is defaulted HERE because the create's wire
       requires one while the probe's does not — the service fills the probe's in itself, with
       the note that says why: a test that quietly proved a DIFFERENT username than the create
       would use is worse than no test. This is the client half of that same identity. */
    imap: { ...input.imap, user: input.imap.user ?? input.address },
    ...(input.smtp ? { smtp: input.smtp } : {}),
  };
}

export function useCloudFirstRun(demo: boolean, pairNode?: ReactNode): FirstRunHost | undefined {
  /**
   * IS AI ON FOR THIS ACCOUNT — read once, and re-read after the flow writes it.
   *
   * `null` while the answer is outstanding, which is NOT the same as `false`: the posture below
   * reports `unset` for a null, and `unset` is the state that stops the flow to ask. Reporting
   * `off` from an unanswered read would walk silently past the question.
   */
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  /**
   * HAS ANYBODY BEEN ASKED — `accounts.ai_answered_at IS NOT NULL`, the fact the switch cannot
   * carry (migration 0084). `null` while the read is outstanding, and the posture treats that as
   * `unset` for {@link aiEnabled}'s reason: "we could not ask" must land on the screen that asks.
   *
   * An API deployed before 0084 omits the field, which reads as `false` ⇒ `unset` ⇒ the question
   * is asked. That is the safe direction on a version skew, and the same direction the four-state
   * union was written for.
   */
  const [aiAnswered, setAiAnswered] = useState<boolean | null>(null);
  /**
   * A WRITE HAS STARTED, so the boot read no longer applies — USER-ALWAYS-WINS, and it is the
   * folders flag's own rule (`apps/mobile/src/state/folders-flag.ts`) for the same measured race.
   *
   * `aiSettings.get()` is issued at mount and can settle AFTER a PATCH the person made, carrying
   * the account as it was BEFORE their answer. Its setter was unconditional, so a late boot read
   * overwrote the answer, the posture went back to `unset`, and the AI screen reopened. Marked
   * BEFORE the request leaves, because a read that started earlier must lose whatever it answers.
   */
  const wrote = useRef(false);
  /** The operator's key, self-host only. `undefined` until `/hello` answers, and on managed. */
  const [operatorAi, setOperatorAi] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (demo) return;
    let live = true;
    void aiSettings.get()
      .then((r: { aiEnabled: boolean; aiAnswered?: boolean }) => {
        // `wrote` is the supersede check — see its own note. Not merely `live`: the component is
        // still mounted in exactly the case this is for.
        if (!live || wrote.current) return;
        setAiEnabled(r.aiEnabled);
        setAiAnswered(r.aiAnswered === true);
      })
      // A FAILED READ STAYS NULL, never false. See the state's own note: the two answers select
      // opposite screens, and "we could not ask" must land on the one that asks.
      .catch(() => {});
    return () => { live = false; };
  }, [demo]);

  useEffect(() => {
    // COMPILED AWAY ON MANAGED: `SELF_HOST_BUILD` is a build constant, so the managed bundle's
    // effect body is a constant return and no `/hello` round trip is paid — the rule
    // `useUserInvites` states, for the same reason.
    if (!SELF_HOST_BUILD || demo) return;
    let live = true;
    void serverHello().then((h) => {
      if (live && h) setOperatorAi(h.features.ai);
    });
    return () => { live = false; };
  }, [demo]);

  /**
   * THE FOUR-STATE POSTURE, from two facts.
   *
   * The stamp is asked FIRST and it outranks the switch, which is the whole correction: with no
   * stamp nobody has answered, so the flow must stop and ask — whatever `ai_enabled` happens to
   * rest at. Only once somebody HAS answered does the switch mean anything, and then it means
   * exactly what it says.
   */
  const ai: OnboardingAi = aiEnabled === null || aiAnswered === null
    ? "unset"
    : !aiAnswered
      ? "unset"
      : aiEnabled ? "on" : "off";

  const probe = useCallback(async (input: FirstRunMailboxInput) => {
    /* SENT AS TYPED, including an ABSENT username — the service defaults that to the address
       itself, with the note saying why it is defaulted there rather than at a route: so the test
       and the create that follows it dial the same identity. `createBody` applies the identical
       default because the create's wire requires the field; both land on the same string. */
    const r = await mailboxApi.probe({ address: input.address, imap: input.imap });
    return { host: r.host, user: r.user, folders: r.folders };
  }, []);

  const connect = useCallback(async (input: FirstRunMailboxInput) => {
    const dto = await mailboxApi.create(createBody(input));
    return { id: dto.id };
  }, []);

  const organize = useCallback(async (
    id: string,
    body: { imap?: { pass: string }; screening?: { dormancyDays?: number; scope?: "window" | "all_time" } },
  ): Promise<FirstRunOrganizeOutcome> => {
    /* THE OUTCOME IS READ, not discarded. All three replies are 200s: `authorized` is the first
       consent, `already_organizing` is a re-run of setup on a mailbox this account already
       organizes — the stamp is refused and the window IS written — and `disconnected` is a
       mailbox that was removed, which stores nothing at all. The stage advances on the first two
       and must not on the third. See {@link FirstRunOrganizeOutcome}. */
    const r = await mailboxApi.organize(id, body);
    return r.outcome === "disconnected" ? "gone" : "stored";
  }, []);

  const complete = useCallback(async () => {
    await consentApi.completeOnboarding();
  }, []);

  const writeAi = useCallback(async (enabled: boolean) => {
    // BEFORE the request leaves — see `wrote`. A read already in the air must lose from here on.
    wrote.current = true;
    const r = await aiSettings.set(enabled);
    /* A SUCCESSFUL WRITE IS ITSELF THE ANSWER, and reading the echo strictly was a regression.
       The posture must move off `unset` here even when the switch did not — the common case,
       since `ai_enabled` rests `true` and "Yes" writes the value the account already had.
       Against a PRE-0084 API the PATCH succeeds and omits the field, so `=== true` stored
       `false`: the flow cleared its cursor, re-derived `unset`, and returned to the question it
       had just asked, indefinitely. The old client did not have that — its posture read
       `aiEnabled ? "on" : "unset"`, so "Yes" walked past — which makes it a regression this
       change introduced rather than one it inherited.
       The person answered; that is a fact about THIS run whatever the server can store. On a
       0084 API the stamp is durable and a resumed run walks past too; on an older one it is not,
       and a later resume asks again — the pre-migration behaviour, and the safe direction. */
    setAiAnswered(true);
    // THE ECHO, NOT THE ARGUMENT. The posture the flow re-derives from must be what the server
    // stored, so a write the server clamped or refused cannot leave this client believing it
    // took — the discipline `autoSuggest` states for the one flag that authorises spending, and
    // the same reason applies to the one that spends AI credits.
    setAiEnabled(r.aiEnabled);
  }, []);

  const forgetMailbox = useCallback(async (id: string) => {
    await mailboxApi.remove(id);
  }, []);

  return useMemo(() => {
    // NO HOST ON THE DEMO, structurally: a fixture world has no account to stamp and no mailbox
    // to connect, so the stage does not exist there rather than existing with buttons that
    // refuse. `AppShell` withholds the whole overlay when this is `undefined`.
    if (demo) return undefined;
    return {
      door: SELF_HOST_BUILD ? "selfhost" : "cloud",
      ai,
      probe,
      connect,
      organize,
      complete,
      setAiEnabled: writeAi,
      forgetMailbox,
      // The connect form's own classifier, and its fallback — one vocabulary for the taxonomy,
      // and the SERVER's sentence for anything this build has no copy for.
      probeReason: probeReasonOf,
      probeMessage: (err: unknown) => (err instanceof ApiError ? messageOf(err) : null),
      ...(SELF_HOST_BUILD && operatorAi !== undefined ? { selfhostAi: operatorAi } : {}),
      ...(pairNode ? { pairNode } : {}),
    } satisfies FirstRunHost;
  }, [ai, complete, connect, demo, forgetMailbox, operatorAi, organize, pairNode, probe, writeAi]);
}
