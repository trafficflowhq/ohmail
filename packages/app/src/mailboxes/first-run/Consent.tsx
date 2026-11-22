/**
 * THE CONSENT STATEMENT: what organizing does, in the two sentences that name every place it files into and say that
 * History is a view. It waits for the door's look at who holds the mailbox: until that answered, what is agreed here
 * may be about a mailbox another install organizes.
 */
import type { ReactNode } from "react";
import { Button, Page, Sentence } from "@ohmail/ui/base";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";
import { DoorSheet } from "../../doors/stage/DoorSheet.js";
import { Next, StepForm, stepTop, type StepProps } from "./parts.js";
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

export function FolderMap({ say, history }: { say: Say; history: boolean }): ReactNode {
  return (
    <DoorSheet kind="facts">
      <SettingLine label={say("onboarding.mapInbox")} />
      <SettingLine sub label={say("screener.pileOhbox")} value={say("onboarding.mapOhbox")} />
      {history ? (
        <SettingLine sub label={say("onboarding.mapHistory")} value={say("onboarding.mapOlder")} />
      ) : null}
      <SettingLine label="ohmail" />
      <SettingLine sub label={say("screener.pileReads")} value={say("onboarding.mapNews")} />
      <SettingLine sub label={say("screener.pileReceipts")} value={say("onboarding.mapReceipts")} />
      <SettingLine sub label={say("onboarding.mapScreener")} value={say("onboarding.mapFirst")} />
      <SettingLine sub label={say("onboarding.mapScreened")} value={say("onboarding.mapScreenedMail")} />
      <SettingLine sub label={say("onboarding.mapQuarantine")} value={say("onboarding.mapSpam")} />
      <SettingLine label={say("onboarding.mapOther")} value={say("onboarding.mapUnchanged")} />
      <SettingNote>{say("onboarding.mapShared")}</SettingNote>
    </DoorSheet>
  );
}

export function Consent({ run, say }: StepProps): ReactNode {
  const awaiting = run.wait.awaiting;
  return (
    <StepForm
      run={run}
      submit={() => {
        if (!awaiting) run.acts.forward();
      }}
    >
      <Page
        {...stepTop(run, say, { back: true })}
        columns={awaiting ? 1 : 2}
        material={
          awaiting ? (
            <HolderWait run={run} say={say} />
          ) : (
            <FolderMap say={say} history={run.agree.win !== "all"} />
          )
        }
        acts={<Next label={say("onboarding.continue")} disabled={awaiting} />}
      >
        <Sentence size="xl" level={1} end="hot">
          {say(awaiting ? "onboarding.resumeCheckingTitle" : "onboarding.mapTitle")}
        </Sentence>
      </Page>
    </StepForm>
  );
}
