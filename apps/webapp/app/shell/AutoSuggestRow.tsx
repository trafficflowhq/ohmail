"use client";

/**
 * The auto-work opt-in — the only thing in this product that spends credits without a press. Turning it ON authorises
 * every future batch, so it is the one settings write that must name a price: a confirm, not a bare `Switch`, because
 * a switch that starts spending money on its way up is a control that cost something to discover.
 */

/**
 * The quote is the SERVER's (`control.quote`, a `dryRun` against the exact senders the next batch would take; the
 * confirm is disabled until it lands) — a number computed here would be a second implementation of the eligibility
 * rule. It automates the WORK, never the DECISION: no rule written, no contact stored, nothing moved — both automatic
 * paths only leave an advisory row, so the only thing spent is credits, which is exactly why it is worth asking about
 * (`suggest.autoDecides` says so beside the price).
 */

/**
 * The switch authorises two paths and the copy names both: the backlog batch this control prices,
 * AND server-side suggestions for senders as mail ARRIVES — a consent sentence describing half of
 * what a switch does is the kind of claim this product treats as a contract, so `suggest.autoWhat`,
 * `autoCost` and `autoOn` say new mail, the waiting queue, and the cost, in that order; the `since`
 * timestamp is the boundary — the server never reaches back past it. The switch shows the STORED
 * value, never the hoped-for one: it is the user's only record of whether their money is committed,
 * so pressing ON opens the confirm and does not move it; the flag turns on when the confirm does.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsRow, Switch } from "@ohmail/ui";
import type { AutoOptInControl } from "./screener-suggest";
import { ruleDate } from "../views/RulesView";

export function AutoSuggestRow({
  on,
  since,
  control,
  setAutoSuggest,
}: {
  /** As the SERVER answered it. The only field that says whether credits are committed. */
  on: boolean;
  /**
   * When it was turned on, or null.
   *
   * Display only IN THIS COMPONENT, which is not the same as inert: on the server the same
   * timestamp is the WATERMARK, and the automatic path suggests only for senders whose held mail
   * arrived after it. That is why the column is a timestamp rather than a boolean, and why
   * turning the switch on does not spend against a backlog that predates the press.
   */
  since: string | null;
  /** The dry-run quote for the next batch — see {@link AutoOptInControl}. */
  control: AutoOptInControl;
  /**
   * `useConsentState().setAutoSuggest` — and it must be THAT one, not `consentApi` directly.
   *
   * The hook's state is what the Screener's spender reads. A component that wrote through the
   * api client instead would leave the spender's copy stale, and the direction that costs money
   * is OFF: turn it off here, open the Screener in the same tab, and a batch is bought after the
   * user revoked permission. One writer, one value.
   */
  setAutoSuggest: (enabled: boolean) => Promise<boolean>;
}) {
  const t = useTranslations("screener");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Unmounted-after-await guard. The pane is swapped by a nav press, so this really happens. */
  const alive = useRef(true);
  useEffect(() => {
    // Re-armed on mount, not only cleared on unmount: under StrictMode the effect runs twice and
    // a ref that was only ever set to `false` would leave the second mount permanently dead —
    // every write silently dropping its result.
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const write = (next: boolean) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        await setAutoSuggest(next);
        if (!alive.current) return;
        // Closes the confirm on the way out. Left open, it would re-offer "Turn on" for a
        // setting that is now on, priced against senders whose suggestions were just bought.
        control.cancel();
      } catch {
        if (!alive.current) return;
        // ONE SENTENCE, AND IT IS ABOUT THE SETTING. `PATCH /consent/settings` is a plain
        // settings write with no AI gate in front of it, so there is no 402/409 here carrying a
        // more useful fact — unlike the QUOTE, whose refusals do, and which shows the server's
        // own sentence through `control.notice`. Inventing a taxonomy from status codes here is
        // how a user is told the wrong reason.
        setFailed(true);
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  const confirming = !on && control.phase !== "closed";
  const priced = control.quote !== null;

  return (
    <>
      <SettingsRow
        label={t("suggest.autoTitle")}
        description={
          on && since
            ? t("suggest.autoOn", { when: ruleDate(since) })
            : t("suggest.autoOff")
        }
        control={
          <Switch
            checked={on}
            disabled={pending}
            ariaLabel={t("suggest.autoTitle")}
            /* ON opens the confirm; OFF writes straight through. Turning it off spends nothing
               and removes an authorisation, so making somebody confirm that would be a dialog
               standing between a user and the brake. */
            onChange={(next) => (next ? control.open() : write(false))}
          />
        }
      />

      {confirming ? (
        <div className="set-auto-confirm">
          {/* WHAT IT WILL DO, WHAT IT COSTS, AND WHAT IT WILL NOT DECIDE — in that order,
              because that is the order the questions arrive in. `batchSize` comes from the
              constant the spender actually slices by, so the sentence cannot outlive it. */}
          <p className="set-note-inline">
            {t("suggest.autoWhat", { count: control.batchSize })}
          </p>
          <p className="set-note-inline">{t("suggest.autoCost")}</p>
          <p className="set-note-inline">{t("suggest.autoDecides")}</p>

          <div className="set-auto-quote">
            {control.phase === "pricing" ? (
              <span className="scn-sg-note">{t("suggest.pricing")}</span>
            ) : control.quote ? (
              /* THE SERVER'S FIGURE, for the senders the next batch would actually take. */
              <span className="scn-sg-price">
                {t("suggest.price", {
                  senders: control.quote.senders,
                  credits: control.quote.credits,
                })}
              </span>
            ) : null}
            {control.notice ? <span className="scn-sg-note">{control.notice}</span> : null}
            {failed ? <span className="scn-sg-note">{t("suggest.autoFailed")}</span> : null}
          </div>

          <div className="gate-actions">
            <Button
              variant="primary"
              /* NO PRICE, NO PURCHASE. `priced` is false while the dry run is in flight and
                 stays false if the server answered without `quotedCredits`, so an unknown cost
                 can never be consented to. */
              disabled={!priced || pending}
              onClick={() => write(true)}
            >
              {t("suggest.autoTurnOn")}
            </Button>
            <Button onClick={control.cancel} disabled={pending}>
              {t("suggest.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
