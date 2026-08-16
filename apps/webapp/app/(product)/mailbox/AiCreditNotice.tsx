"use client";

/**
 * THE AI-CREDIT STATE, WHERE AI ACTIONS ARE ACTUALLY BOUGHT — the Screener's suggestion area.
 *
 * Settings → Subscription has shown a balance for some time, and that was the whole of it: a
 * number on a page nobody is on at the moment it matters. The moment it matters is standing in
 * front of the Screener deciding whether to ask for suggestions — where, until the trial had a
 * bounty at all, the only feedback was a purchase that got refused after the press with a
 * sentence the server wrote for the refusal.
 *
 * So this says the same thing the settings pane says, in the same words, one line under the
 * control that spends: how much of a trial's fixed pot is left, or why nothing can be spent and
 * what would change that.
 *
 * ── WHY IT IS INJECTED RATHER THAN BUILT IN THE SHELL ───────────────────────────────────────
 *
 * `app/shell` and `app/views` are shared with the desktop app and published, and they may not
 * call `app/api-client` — the mirror does not contain it. This reads
 * `GET /billing/subscription`, so it is the Cloud client's own component, handed to the shell the
 * same way the Settings panes and the (i) panel body are. A standalone install has no account, no
 * allowance and nothing to say, and gets no node at all rather than an empty one.
 *
 * ── IT NEVER RENDERS AN ERROR ───────────────────────────────────────────────────────────────
 *
 * A failed read leaves the state `null` and this draws nothing. That asymmetry is deliberate: the
 * pane's job is to explain a refusal, and a refused BILLING READ is not evidence of one. Saying
 * "AI actions come with a plan" to a paying subscriber whose request timed out is the failure this
 * surface would be most embarrassed by, and it is the one `BillingSection` already paid for once.
 * The settings pane owns reporting that the read itself failed; it has room for a sentence and a
 * retry, and this line does not.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { apiConfigured, billing, type SubscriptionStatus } from "../../api-client";
import { onCreditsSpent } from "../../shell/screener-suggest";
import { aiCreditAction, aiCreditMessageKey, aiCreditState } from "./ai-credit-state";

export function AiCreditNotice({ onStartPlan }: { onStartPlan: () => void }) {
  const t = useTranslations("aiCredits");
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await billing.subscription();
      if (alive.current) setSub(s);
    } catch {
      /* A failed read is not a claim about the account — see the header. */
      if (alive.current) setSub(null);
    }
  }, []);

  useEffect(() => { if (apiConfigured()) void load(); }, [load]);

  /**
   * ── AND RE-READ AFTER THE CONTROL BESIDE IT SPENDS ────────────────────────────────────────
   *
   * The mount fetch alone made this a SNAPSHOT of the session's opening balance. Buy suggestions
   * without leaving the Screener and the server debits the ledger, hands the purchase control the
   * new figure — and this line, which is the surface whose entire job is to say how much is left,
   * went on rendering the old one. At zero it also withheld the plan offer until the whole
   * Screener was unmounted, so the sentence contradicted both the server and the comment below it.
   *
   * The purchase machinery announces the moment the balance moved (`onCreditsSpent`), and one
   * re-read of `GET /billing/subscription` follows it. Deliberately a re-read rather than the
   * `remainingCredits` the purchase already holds: at zero the STATE changes, not only the number
   * — `entitlements.aiEnabled` flips, the sentence becomes the exhausted one and the offer
   * appears — and that verdict belongs to the server, not to arithmetic on this side.
   *
   * No poll, no focus handler, no interval: it fires only after a request that moved money.
   */
  useEffect(() => onCreditsSpent(() => { if (apiConfigured()) void load(); }), [load]);

  const state = aiCreditState(sub);
  if (!state) return null;

  const action = aiCreditAction(state);
  return (
    // `role="status"` because the line APPEARS beside a control a keyboard user may already be
    // on — a balance that reaches zero mid-session replaces "3 AI actions left" with a refusal
    // and an offer, and a surface that changes under the cursor has to say so.
    <p className="scn-ai-credits" role="status">
      <span>
        {state.kind === "trial_credits"
          ? t("trialLeft", { count: state.remaining })
          : t(aiCreditMessageKey(state) as never)}
      </span>
      {action ? (
        /* A LINK-SHAPED BUTTON, not a primary one. It sits under a control whose own button
           spends money, and the loudest thing in a spending surface must stay the thing that
           spends. It navigates — nothing is bought here — so the press is a route change and
           the plan cards, with their prices, are what the person actually decides in front of. */
        <button type="button" className="scn-ai-cta" onClick={onStartPlan}>
          {action === "start" ? t("startPlan") : t("seePlan")}
        </button>
      ) : null}
    </p>
  );
}
