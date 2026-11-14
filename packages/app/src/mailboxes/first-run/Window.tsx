/**
 * THE WINDOW, AND AGREE. How far back ohmail organizes, pre-filled from what the account stored (365 days on a first
 * run, the dial a person sees being the dial that is stored); what agreeing will screen, read for the window being
 * chosen; and the one press that carries the consent, the window and the scope. It waits for the door's look as the
 * statement does.
 */
import type { ReactNode } from "react";
import { Page, RadioLines } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import {
  decisionCountSentence,
  firstSentence,
  type WindowChoice,
} from "@ohmail/app-logic/mailboxes/first-run/rules";
import { HolderWait } from "./Consent.js";
import { Foot, Next, Said, StepForm, leadOf, refusalOf, type StepProps } from "./parts.js";
import { RUNGS } from "./words.js";

export function Window({ run, say }: StepProps): ReactNode {
  const { agree, wait } = run;
  const title = say("onboarding.windowTitle");
  const count = agree.count;
  return (
    <StepForm run={run} submit={run.acts.agree}>
      <Page
        line={leadOf(say("onboarding.windowLead"))}
        refusal={refusalOf(run, say)}
        material={
          <div className="mbx-run-material">
            <RadioLines<WindowChoice>
              label={title}
              value={agree.win}
              onChange={(v) => {
                if (!run.writes.busy && !wait.awaiting) agree.setWin(v);
              }}
              options={RUNGS.map((r) => ({
                value: r.value,
                label: r.value === "365" ? `${say(r.label)} · ${say("onboarding.winDefault")}` : say(r.label),
                ...(r.value === "all" ? { note: say("onboarding.winAllWhy") } : {}),
              }))}
            />
            {/* What widening later does: senders past the old cutoff wait in the Screener; nothing moves by itself. */}
            <SettingNote>{say("onboarding.windowLater")}</SettingNote>
            {count !== null ? (
              <p className="mbx-run-status" role="status">
                {decisionCountSentence((key, values) => say(`onboarding.${key}`, values), count)}
              </p>
            ) : null}
            {run.pull.reconnecting ? <SettingNote>{say("onboarding.windowReconnecting")}</SettingNote> : null}
            <SettingNote>{firstSentence(say("onboarding.consentBody"))}</SettingNote>
            {wait.awaiting ? <HolderWait run={run} say={say} /> : null}
          </div>
        }
        acts={
          <Foot
            run={run}
            say={say}
            back
            primary={
              <Next
                label={say(run.writes.busy ? "onboarding.agreeing" : "onboarding.agree")}
                disabled={wait.awaiting || run.writes.busy}
              />
            }
          />
        }
      >
        <Said text={title} />
      </Page>
    </StepForm>
  );
}
