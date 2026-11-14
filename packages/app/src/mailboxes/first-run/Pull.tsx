/**
 * THE FIRST PULL: what this device holds of the mailbox, what is still to read once the server has counted it, and
 * "about" how long, never before two minutes of samples. Leaving it does not end the run.
 */
import type { ReactNode } from "react";
import { Button, Count, Page } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { useLocale } from "../../text/index.js";
import { Foot, Said, StepForm, leadOf, type StepProps } from "./parts.js";

/** "4 minutes" or "2 hours": the locale's own unit words; hours above ninety minutes. */
function durationWords(ms: number, locale: string): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = minutes >= 90;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: hours ? "hour" : "minute",
    unitDisplay: "long",
  }).format(hours ? Math.max(1, Math.round(minutes / 60)) : minutes);
}

export function Pull({ run, say }: StepProps): ReactNode {
  const locale = useLocale();
  const n = (v: number): string => new Intl.NumberFormat(locale).format(v);
  const { pull } = run;
  const numbers = run.about.pull;
  const eta =
    run.about.queueSettling || (run.sweepHolding && run.importReallyOver)
      ? say("onboarding.pullScreener")
      : pull.etaMs !== null && pull.rate !== null
        ? say("onboarding.eta", { eta: durationWords(pull.etaMs, locale), rate: Math.round(pull.rate) })
        : say(pull.readAll ? "onboarding.pullRead" : "onboarding.etaSoon");
  return (
    <StepForm run={run} submit={run.acts.away}>
      <Page
        line={leadOf(say("onboarding.pullLead"))}
        material={
          <div className="mbx-run-material">
            <dl className="mbx-run-counters">
              <div className="mbx-run-counter">
                <dt>{say("onboarding.screened")}</dt>
                <dd className="mbx-run-count">
                  <Count kind="point">{n(numbers.screened)}</Count>
                </dd>
              </div>
              <div className="mbx-run-counter">
                <dt>{say("onboarding.history")}</dt>
                <dd className="mbx-run-count">
                  <Count kind="point">{n(numbers.history)}</Count>
                </dd>
              </div>
              {/* THE THIRD COUNTER EXISTS ONLY WHEN THE SERVER HAS SAID: no "0 still to read" over a running pull. */}
              {pull.remaining !== null ? (
                <div className="mbx-run-counter">
                  <dt>{say("onboarding.remaining")}</dt>
                  <dd className="mbx-run-count">
                    <Count kind="point">{n(pull.remaining)}</Count>
                  </dd>
                </div>
              ) : null}
            </dl>
            <SettingNote>{say("onboarding.counterBasis")}</SettingNote>
            {pull.remaining !== null ? (
              <progress
                className="mbx-run-track"
                max={numbers.pulled + pull.remaining}
                value={numbers.pulled}
                aria-label={say("onboarding.pullTitle")}
              />
            ) : null}
            <p className="mbx-run-status" role="status">
              {eta}
            </p>
            {pull.reconnecting ? <SettingNote>{say("onboarding.pullReconnecting")}</SettingNote> : null}
            {!pull.reconnecting && pull.cameBack ? (
              <SettingNote>{say("onboarding.pullResumed")}</SettingNote>
            ) : null}
          </div>
        }
        acts={
          <Foot
            run={run}
            say={say}
            primary={
              <Button kind="two" type="submit">
                {say("onboarding.pullLeave")}
              </Button>
            }
          />
        }
      >
        <Said text={say("onboarding.pullTitle")} />
      </Page>
    </StepForm>
  );
}
