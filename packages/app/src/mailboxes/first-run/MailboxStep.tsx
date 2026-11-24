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
import { Button, Dot, Page, Sentence, Tag } from "@ohmail/ui/base";
import { SettingLine } from "@ohmail/ui/mail";
import { DoorSheet } from "../../doors/stage/DoorSheet.js";
import { SaidTrail } from "../../text/Said.js";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { useLocale } from "../../text/index.js";
import { ConnectForm } from "../connect/index.js";
import type { ConnectResult } from "../connect/contract.js";
import { Next, StepForm, leadOf, refusalOf, stepTop, type StepProps } from "./parts.js";

export function MailboxStep(props: StepProps): ReactNode {
  const { run, say } = props;
  const mailbox = run.facts.mailbox === null ? null : run.mailbox;
  if (mailbox !== null)
    return (
      <StepForm run={run} submit={run.acts.forward}>
        <Page
          {...stepTop(run, say, { back: true, mailboxScreen: 3 })}
          columns={2}
          material={
            <DoorSheet kind="facts">
              {(run.rows ?? [mailbox]).map((row) => (
                <SettingLine
                  key={row.id}
                  label={row.address}
                  tag={
                    row.organizerRole === "reader"
                      ? say("onboarding.readerTag")
                      : row.id === mailbox.id && !row.unreachable
                        ? say("onboarding.connectedTag")
                        : undefined
                  }
                />
              ))}
            </DoorSheet>
          }
          acts={<Next label={say("onboarding.continue")} />}
        >
          <Sentence size="xl" level={1} end="hot">
            {say("onboarding.myMailboxes")}
          </Sentence>
        </Page>
      </StepForm>
    );
  if (run.lagging)
    return (
      <StepForm run={run} submit={run.wait.retry}>
        <Page
          line={leadOf(say("onboarding.resumeChecking"))}
          {...stepTop(run, say)}
          acts={<Next label={say("onboarding.resumeRetry")} disabled={run.wait.retrying} />}
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
          {...stepTop(run, say, { back: true })}
          acts={<Next label={say("onboarding.mailboxHandoffGo")} />}
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
function Connect({ run, say, slots, connect, onCodeStarted }: StepProps): ReactNode {
  const locale = useLocale();
  const { commands } = useFrame();
  const onDone = (result: ConnectResult): void => {
    if (result.kind === "connected") run.acts.connected(result.mailboxId);
  };
  const addresses = run.add ? (run.rows?.map((row) => row.address) ?? []) : [];
  if (connect === NONE)
    return (
      <Page {...stepTop(run, say, { back: true })} refusal={refusalOf(run, say)} acts={null}>
        <Sentence size="xl" level={1} end="hot">
          {say("onboarding.mailboxTitle")}
        </Sentence>
      </Page>
    );
  return (
    <ConnectForm
      ask={{
        purpose: { kind: run.add ? "add" : "firstRun" },
        onDone,
        setup: { restart: run.acts.restart, close: () => run.setConfirm("cancel") },
        ...(onCodeStarted ? { onCodeStarted } : {}),
      }}
      door={connect}
      factor={slots.factor}
      page={(material, backToProviders, providerBlank) => {
        const choosing = backToProviders === null;
        const top = stepTop(run, say, { back: true, mailboxScreen: choosing ? 1 : 2 });
        const back =
          backToProviders ??
          (run.add && top.back === undefined
            ? () => commands.go({ place: "settings", sub: "mailboxes" })
            : null);
        return (
          <Page
            {...top}
            back={
              back === null ? (
                top.back
              ) : (
                <Button kind="quiet" icon="back" label={say("onboarding.back")} onPress={back} />
              )
            }
            columns={choosing ? 2 : 1}
            trail={
              choosing && addresses.length > 0 ? (
                <SaidTrail
                  text={say("onboarding.providerExisting", {
                    addresses: new Intl.ListFormat(locale).format(addresses),
                  })}
                />
              ) : undefined
            }
            refusal={refusalOf(run, say)}
            material={
              <div className="mbx-run-material">
                {run.accountOrganizer ? <Tag>{say("onboarding.readerTag")}</Tag> : null}
                {material}
              </div>
            }
            acts={
              choosing && !run.add ? (
                <Button kind="quiet" onPress={() => run.setConfirm("cancel")}>
                  {say("onboarding.providerLater")}
                </Button>
              ) : null
            }
          >
            {choosing ? (
              <Sentence size="xl" level={1}>
                {say(run.add ? "onboarding.providerAnother" : "onboarding.providerFirst")}{" "}
                <span className="oh-nowrap">
                  {providerBlank}
                  <Dot kind="hot" />
                </span>
              </Sentence>
            ) : (
              <Sentence size="xl" level={1} end="hot">
                {say("onboarding.mailboxTitle")}
              </Sentence>
            )}
          </Page>
        );
      }}
    />
  );
}
