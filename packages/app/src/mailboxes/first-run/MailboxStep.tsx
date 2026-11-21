/**
 * THE MAILBOX STEP: the one connect form, opened for the first run's first mailbox (`firstRun`, connected as `seed`)
 * or for a further one (`add`). The form is the Mailboxes place's own; the stage hands it the shell's wire and the
 * second factor's dialog, and draws what the form does not know: who organizes this account's mail before a reader is
 * connected, and the password's own hint by whose service this is. Once a mailbox exists the step is a statement, not
 * a form: Back onto it must not connect a second one. Where a first mailbox is connected on a page of its own (the
 * web's join), the step hands off to it. An add whose address names a mailbox the account's rows do not hold yet waits
 * in words: the word is a claim, and until a row answers it there is no form and no verb of a mailbox.
 */
import type { ReactNode } from "react";
import { Page, Sentence } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { NONE } from "../../host/index.js";
import { ConnectForm } from "../connect/index.js";
import type { ConnectResult } from "../connect/contract.js";
import { Foot, Next, StepForm, leadOf, refusalOf, type StepProps } from "./parts.js";
import { PASSWORD_HINT } from "./words.js";

export function MailboxStep(props: StepProps): ReactNode {
  const { run, say } = props;
  const mailbox = run.facts.mailbox === null ? null : run.mailbox;
  if (mailbox !== null)
    return (
      <StepForm run={run} submit={run.acts.forward}>
        <Page
          line={say("join.mailboxConnected", { address: mailbox.address })}
          note={say("onboarding.probeOkDetail")}
          acts={<Foot run={run} say={say} back primary={<Next label={say("onboarding.continue")} />} />}
        >
          <Sentence size="xl" level={1} end="ink">
            {say("onboarding.mailboxTitle")}
          </Sentence>
        </Page>
      </StepForm>
    );
  if (run.lagging)
    return (
      <StepForm run={run} submit={run.wait.retry}>
        <Page
          line={leadOf(say("onboarding.resumeChecking"))}
          acts={
            <Foot
              run={run}
              say={say}
              primary={<Next label={say("onboarding.resumeRetry")} disabled={run.wait.retrying} />}
            />
          }
        >
          <Sentence size="xl" level={1} end="hot">
            {say("onboarding.resumeCheckingTitle")}
          </Sentence>
        </Page>
      </StepForm>
    );
  if (run.handOff)
    return (
      <StepForm run={run} submit={run.acts.resume}>
        <Page
          line={leadOf(say("onboarding.mailboxHandoffLead"))}
          acts={
            <Foot run={run} say={say} back primary={<Next label={say("onboarding.mailboxHandoffGo")} />} />
          }
        >
          <Sentence size="xl" level={1} end="hot">
            {say("onboarding.mailboxTitle")}
          </Sentence>
        </Page>
      </StepForm>
    );
  return <Connect {...props} />;
}

/** The form itself. It is its own form, so the step around it is none; its press is the step's forward verb. */
function Connect({ run, say, service, slots, connect, onCodeStarted }: StepProps): ReactNode {
  const holder = run.accountOrganizer;
  const named = holder?.name?.trim() ? holder.name : null;
  const onDone = (result: ConnectResult): void => {
    if (result.kind === "connected") run.acts.connected(result.mailboxId);
  };
  return (
    <Page
      line={leadOf(say("onboarding.mailboxLead"))}
      refusal={refusalOf(run, say)}
      material={
        <div className="mbx-run-material">
          {/* WHAT THIS CONNECTION WILL BE, BEFORE IT IS MADE: a consent-less reader while another install organizes. */}
          {holder ? <SettingNote>{say("onboarding.doorReader")}</SettingNote> : null}
          {holder ? (
            <SettingNote>
              {named
                ? say("onboarding.doorReaderWhy", { name: named })
                : say("onboarding.doorReaderWhyLegacy")}
            </SettingNote>
          ) : null}
          {connect === NONE ? null : (
            <ConnectForm
              ask={{
                purpose: { kind: run.add ? "add" : "firstRun" },
                onDone,
                ...(onCodeStarted ? { onCodeStarted } : {}),
              }}
              door={connect}
              factor={slots.factor}
            />
          )}
          <SettingNote>{say(PASSWORD_HINT[service])}</SettingNote>
        </div>
      }
      acts={<Foot run={run} say={say} back />}
    >
      <Sentence size="xl" level={1} end="hot">
        {say("onboarding.mailboxTitle")}
      </Sentence>
    </Page>
  );
}
