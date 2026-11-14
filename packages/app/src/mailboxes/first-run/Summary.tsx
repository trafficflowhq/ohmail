/**
 * THE SUMMARY reports what THIS INSTALL did: an organizer reports work (what it screened, what History lists, where
 * things are), a reader reports a relationship (what it does, who organizes the mailbox and since when, where the
 * claim lives), and a takeover this run asked for is said as asked, refused or landed. "Open ohmail" ends the run;
 * the pairing is a second verb, offered where this shell pairs. The pairing step ends the run too.
 */
import type { ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";
import { holderName } from "@ohmail/app-logic/mailboxes/first-run/rules";
import { readerHolder } from "@ohmail/app-logic/reading/reader-holder";
import { NONE } from "../../host/index.js";
import { holderLines } from "./Elsewhere.js";
import { Foot, Next, Said, StepForm, leadOf, type StepProps } from "./parts.js";
import { HOLDER_MANAGED } from "./words.js";

/** Work, by an organizer; a relationship, by a reader; the takeover under way, while it is. */
function Done({ run, say, service }: StepProps): ReactNode {
  const { facts, agree, decide } = run;
  const organizing = facts.mailbox?.organizerRole !== "reader";
  const stopped = agree.stopped;
  const numbers = run.about.pull;
  if (!organizing && agree.takeover === "asked")
    return (
      <>
        <SettingLine
          label={say(
            readerHolder(facts.mailbox?.organizedBy) === "nobody"
              ? "onboarding.doneStartLands"
              : "onboarding.doneTakeoverLands",
          )}
        />
        <SettingNote>{say("onboarding.doneTakeoverLandsWhy")}</SettingNote>
        {decide.decidedName !== null ? (
          <>
            <SettingLine label={say("onboarding.doneTakeoverDecided", { name: decide.decidedName })} />
            <SettingNote>{say("onboarding.doneTakeoverDecidedWhy")}</SettingNote>
          </>
        ) : null}
      </>
    );
  if (organizing)
    return (
      <>
        <SettingLine label={say("onboarding.doneScreened", { count: numbers.screened })} />
        <SettingNote>{say("onboarding.doneScreenedWhy")}</SettingNote>
        <SettingLine label={say("onboarding.doneHistory", { count: numbers.history })} />
        <SettingNote>{say("onboarding.doneHistoryWhy")}</SettingNote>
        {/* The pull's basis, unless the store said this device holds the whole mailbox. */}
        {numbers.whole ? null : <SettingNote>{say("onboarding.counterBasis")}</SettingNote>}
        <SettingLine label={say("onboarding.doneFolders")} />
        <SettingNote>{say("onboarding.doneWhere")}</SettingNote>
      </>
    );
  const { label, line } = holderLines(facts, run.mailbox, say, {
    managed: HOLDER_MANAGED[service],
    stopped,
  });
  return (
    <>
      <SettingLine label={say("onboarding.doneReaderReads")} />
      <SettingNote>
        {say(stopped ? "onboarding.doneReaderReadsWhyStopped" : "onboarding.doneReaderReadsWhy")}
      </SettingNote>
      <SettingLine label={label} />
      <SettingNote>{line}</SettingNote>
      <SettingLine label={say("onboarding.doneReaderClaim")} />
      <SettingNote>
        {say(stopped ? "onboarding.doneReaderClaimWhyStopped" : "onboarding.doneReaderClaimWhy")}
      </SettingNote>
    </>
  );
}

export function Summary(props: StepProps): ReactNode {
  const { run, say, slots } = props;
  const organizing = run.facts.mailbox?.organizerRole !== "reader";
  const refused = run.agree.takeover === "refused";
  const name = holderName(run.facts) ?? say("mailboxes.readerHolderUnknown");
  const pairs = slots.pair !== NONE && run.cursor.path.includes("pair");
  const mailbox = run.mailbox;
  return (
    <StepForm run={run} submit={run.acts.close}>
      <Page
        refusal={refused ? ([say("onboarding.doneTakeoverRefused", { name })] as const) : undefined}
        material={
          <div className="mbx-run-material">
            {refused && run.decide.reasked !== null ? (
              <>
                <SettingLine label={say("onboarding.doneTakeoverReasked", { name: run.decide.reasked })} />
                <SettingNote>{say("onboarding.doneTakeoverReaskedWhy")}</SettingNote>
              </>
            ) : null}
            <Done {...props} />
            <SettingNote>{say("onboarding.doneSettings")}</SettingNote>
            {slots.calendar !== NONE && mailbox !== null
              ? slots.calendar({ mailboxId: mailbox.id, provider: mailbox.provider ?? "" })
              : null}
          </div>
        }
        acts={
          <Foot
            run={run}
            say={say}
            cancel={false}
            primary={
              <>
                <Next label={say("onboarding.doneOpen")} />
                {pairs ? (
                  <Button kind="two" disabled={run.writes.busy} onPress={() => run.acts.goTo("pair")}>
                    {say("onboarding.pairTitle")}
                  </Button>
                ) : null}
              </>
            }
          />
        }
      >
        <Said text={say(organizing ? "onboarding.doneTitle" : "onboarding.doneReaderTitle")} dot="ink" />
      </Page>
    </StepForm>
  );
}

/** THE LAST SCREEN, reached only from the summary's second verb: skipping it ends the run, as "Open ohmail" would. */
export function Pair({ run, say, slots }: StepProps): ReactNode {
  return (
    <StepForm run={run} submit={run.acts.close}>
      <Page
        line={leadOf(say("onboarding.pairLead"))}
        material={slots.pair !== NONE ? <div className="mbx-run-pair">{slots.pair()}</div> : undefined}
        acts={
          <Foot
            run={run}
            say={say}
            cancel={false}
            primary={
              <Button kind="two" type="submit">
                {say("onboarding.pairLater")}
              </Button>
            }
          />
        }
      >
        <Said text={say("onboarding.pairTitle")} dot="ink" />
      </Page>
    </StepForm>
  );
}
