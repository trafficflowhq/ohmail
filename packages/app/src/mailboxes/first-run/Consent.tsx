/**
 * THE CONSENT STATEMENT: what organizing does, in the two sentences that name every place it files into and say that
 * History is a view. It waits for the door's look at who holds the mailbox: until that answered, what is agreed here
 * may be about a mailbox another install organizes.
 */
import type { ReactNode } from "react";
import { Button, Page, Sentence } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { Foot, Next, StepForm, type StepProps } from "./parts.js";
import type { Say } from "./words.js";
import type { FirstRun } from "@ohmail/app-logic/mailboxes/first-run/use-first-run";

/** The wait for the door's look, in words: checking, or past its bound, slow and one more read. */
export function HolderWait({ run, say }: { run: FirstRun; say: Say }): ReactNode {
  if (!run.wait.slow) return <SettingNote>{say("onboarding.windowCheckingHolder")}</SettingNote>;
  return (
    <div className="mbx-run-row">
      <SettingNote warn>{say("onboarding.holderCheckSlow")}</SettingNote>
      <Button kind="two" disabled={run.wait.retrying} onPress={run.wait.retry}>
        {say("onboarding.resumeRetry")}
      </Button>
    </div>
  );
}

export function Consent({ run, say }: StepProps): ReactNode {
  if (run.wait.awaiting)
    return (
      <StepForm run={run} submit={() => undefined}>
        <Page
          material={<HolderWait run={run} say={say} />}
          acts={
            <Foot run={run} say={say} back primary={<Next label={say("onboarding.continue")} disabled />} />
          }
        >
          <Sentence size="xl" level={1} end="hot">
            {say("onboarding.resumeCheckingTitle")}
          </Sentence>
        </Page>
      </StepForm>
    );
  return (
    <StepForm run={run} submit={run.acts.forward}>
      <Page
        line={say("onboarding.consentBody")}
        note={say("onboarding.consentHistory")}
        material={<SettingNote>{say("onboarding.consentNothingYet")}</SettingNote>}
        acts={<Foot run={run} say={say} back primary={<Next label={say("onboarding.continue")} />} />}
      >
        <Sentence size="xl" level={1} end="hot">
          {say("onboarding.consentTitle")}
        </Sentence>
      </Page>
    </StepForm>
  );
}
