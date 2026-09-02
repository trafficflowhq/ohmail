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
 * ── THE AI POSTURE CANNOT SAY "ASKED, AND THE ANSWER WAS NO" ──────────────────────────────
 *
 * `accounts.ai_enabled` is a boolean that rests `false`, so this door reports `unset` for both
 * "never asked" and "answered no". That is a real limitation of what is stored, not a shortcut:
 * `OnboardingAi` exists as a four-state union precisely because those two need opposite
 * behaviour, and this door can only supply three of the four. The stage compensates by walking
 * its own cursor past a "no" instead of re-deriving into the same question — see the AI step in
 * `FirstRun.tsx` — and the residual cost is stated there: a run RESUMED later asks again.
 *
 * Resolving it properly needs a column (`ai_answered_at`), which is a migration and belongs to
 * whoever next opens `account_settings`. Until then the safe direction is the one taken: ask
 * twice rather than silently skip somebody who was never asked.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { FirstRunHost, FirstRunMailboxInput } from "../../shell/first-run-host";
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
  /** The operator's key, self-host only. `undefined` until `/hello` answers, and on managed. */
  const [operatorAi, setOperatorAi] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (demo) return;
    let live = true;
    void aiSettings.get()
      .then((r: { aiEnabled: boolean }) => { if (live) setAiEnabled(r.aiEnabled); })
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

  const ai: OnboardingAi = aiEnabled === null ? "unset" : aiEnabled ? "on" : "unset";

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
  ) => {
    await mailboxApi.organize(id, body);
  }, []);

  const complete = useCallback(async () => {
    await consentApi.completeOnboarding();
  }, []);

  const writeAi = useCallback(async (enabled: boolean) => {
    const r = await aiSettings.set(enabled);
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
