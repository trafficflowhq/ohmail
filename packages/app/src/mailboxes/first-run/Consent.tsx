/**
 * THE CONSENT STATEMENT: what organizing does, in the two sentences that name every place it files into and say that
 * History is a view. It waits for the door's look at who holds the mailbox: until that answered, what is agreed here
 * may be about a mailbox another install organizes.
 */
import type { ReactNode } from "react";
import { Button, Counters, Dot, Page, Sentence } from "@ohmail/ui/base";
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

const folderLabel = (label: string, name: string): string => (label === name ? label : `${label} (${name})`);

export function FolderMap({ say, history }: { say: Say; history: boolean }): ReactNode {
  const folders = [
    [say("onboarding.mapScreener"), "onboarding.mapFirst"],
    [say("screener.pileReads"), "onboarding.mapNews"],
    [folderLabel(say("screener.pileReceipts"), "Receipts"), "onboarding.mapReceipts"],
    [folderLabel(say("onboarding.mapScreened"), "Screened"), "onboarding.mapScreenedMail"],
    [folderLabel(say("onboarding.mapQuarantine"), "Quarantine"), "onboarding.mapSpam"],
  ] as const;
  return (
    <div className="mbx-run-material">
      <Counters
        rows={[{ figure: String(folders.length), words: say("onboarding.mapNewFolders"), end: "none" }]}
      />
      <DoorSheet kind="facts">
        <SettingLine.Table>
          <SettingLine dense icon="ohbox" label={say("onboarding.mapInbox")} />
          <SettingLine dense sub label={say("screener.pileOhbox")} value={say("onboarding.mapOhbox")} />
          {history ? (
            <SettingLine dense sub label={say("onboarding.mapHistory")} value={say("onboarding.mapOlder")} />
          ) : null}
          <SettingLine dense icon="folder" label="ohmail" />
          {folders.map(([label, value]) => (
            <SettingLine key={value} dense sub lead={<Dot kind="hot" />} label={label} value={say(value)} />
          ))}
          <SettingLine label={say("onboarding.mapOther")} value={say("onboarding.mapUnchanged")} />
        </SettingLine.Table>
        <SettingNote>{say("onboarding.mapShared")}</SettingNote>
        {history ? <SettingNote>{say("onboarding.consentHistory")}</SettingNote> : null}
      </DoorSheet>
    </div>
  );
}

export function Consent({ run, say }: StepProps): ReactNode {
  return (
    <StepForm run={run} submit={() => undefined}>
      <Page
        {...stepTop(run, say, { back: true })}
        material={<HolderWait run={run} say={say} />}
        acts={<Next label={say("onboarding.continue")} disabled />}
      >
        <Sentence size="xl" level={1} end="hot">
          {say("onboarding.resumeCheckingTitle")}
        </Sentence>
      </Page>
    </StepForm>
  );
}
