/**
 * THE SCREENS BEFORE A MAILBOX: the welcome (a run with nothing behind it), the refusal of a run whose mailbox is not
 * there, and the question which mailbox a run naming none is about. Neither of the last two draws a connect form (a
 * run's mode is `seed`, which reconfigures the install) or a rail: one verb, and it leaves.
 */
import type { ReactNode } from "react";
import { Button, Page, Sentence } from "@ohmail/ui/base";
import { Next, StepForm, leadOf, type StepProps } from "./parts.js";
import { WELCOME_TITLE } from "./words.js";

export function Welcome({ run, say, door }: StepProps): ReactNode {
  return (
    <StepForm run={run} submit={run.acts.forward}>
      <Page
        line={leadOf(say("onboarding.welcomeLead"))}
        acts={<Next label={say("onboarding.welcomeStart")} />}
      >
        <Sentence size="xl" level={1} end="hot">
          {say(WELCOME_TITLE[door])}
        </Sentence>
      </Page>
    </StepForm>
  );
}

/** THE RUN'S MAILBOX IS NOT THERE: a named refusal and nothing else. */
export function Vanished({ run, say }: StepProps): ReactNode {
  return (
    <StepForm run={run} submit={run.acts.away}>
      <Page
        line={leadOf(say("onboarding.vanishedLead"))}
        acts={<Next label={say("onboarding.vanishedLeave")} />}
      >
        <Sentence size="xl" level={1} end="hot">
          {say("onboarding.vanishedTitle")}
        </Sentence>
      </Page>
    </StepForm>
  );
}

/** WHICH MAILBOX, WHEN THE RUN NAMES NONE AND THERE ARE SEVERAL: each press is that mailbox's own run. */
export function Choose({ run, say }: StepProps): ReactNode {
  return (
    <StepForm run={run} submit={run.acts.away}>
      <Page
        line={leadOf(say("onboarding.chooseLead"))}
        material={
          <div className="mbx-run-row">
            {(run.rows ?? []).map((m) => (
              <Button key={m.id} kind="two" onPress={() => run.acts.choose(m.id)}>
                {m.address}
              </Button>
            ))}
          </div>
        }
        acts={<Next label={say("onboarding.chooseLeave")} />}
      >
        <Sentence size="xl" level={1} end="hot">
          {say("onboarding.chooseTitle")}
        </Sentence>
      </Page>
    </StepForm>
  );
}
