import type { ReactNode } from "react";
import { Button, Counters, Page, Tag, type Counter } from "@ohmail/ui/base";
import "../../doors/stage/placement.css";
import { useLocale } from "../../text/index.js";
import { StepForm, stepTop, type StepProps } from "./parts.js";

function durationWords(ms: number, locale: string): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = new Intl.NumberFormat(locale, { useGrouping: false }).format(Math.floor(seconds / 60));
  const tail = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(seconds % 60);
  return `${minutes}:${tail}`;
}

export function Pull({ run, say }: StepProps): ReactNode {
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale);
  const { pull, about } = run;
  const counts: Counter[] = [
    { figure: number.format(about.pull.screened), words: say("onboarding.screened") },
    { figure: number.format(about.pull.history), words: say("onboarding.history") },
  ];
  if (pull.remaining !== null) {
    counts.push({ figure: number.format(pull.remaining), words: say("onboarding.remaining"), end: "hot" });
  }
  const settling = about.queueSettling || (run.sweepHolding && run.importReallyOver);
  return (
    <StepForm run={run} submit={run.acts.away}>
      <Page
        {...stepTop(run, say)}
        line={about.pull.whole ? undefined : [{ tag: say("onboarding.pullOnDevice") }]}
        acts={
          <Button kind="two" type="submit">
            {say("onboarding.pullLeave")}
          </Button>
        }
      >
        <h1 className="way-unseen">{say("onboarding.pullTitle")}</h1>
        <div
          role="group"
          aria-label={say(about.pull.whole ? "onboarding.pullTitle" : "onboarding.pullLocal")}
        >
          <Counters size="xl" rows={counts} />
        </div>
        {pull.remaining === null ? null : (
          <progress
            className="mbx-run-track"
            max={about.pull.pulled + pull.remaining}
            value={about.pull.pulled}
            aria-label={say("onboarding.pullTitle")}
          />
        )}
        <div className="mbx-run-row" role="status">
          {pull.reconnecting ? (
            <Tag>{say("onboarding.pullReconnecting")}</Tag>
          ) : settling ? (
            <Tag>{say("onboarding.pullScreener")}</Tag>
          ) : pull.etaMs === null || pull.rate === null ? null : (
            <>
              <Tag>{say("onboarding.etaLeft", { eta: durationWords(pull.etaMs, locale) })}</Tag>
              <Tag>{say("onboarding.etaRate", { rate: Math.round(pull.rate) })}</Tag>
            </>
          )}
        </div>
      </Page>
    </StepForm>
  );
}
