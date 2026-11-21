/**
 * The hand-off shows how many senders still wait, or the reader's relationship to its organizer.
 * Open ohmail and the optional pairing action still end the setup run.
 */
import type { ReactNode } from "react";
import { Button, Page, Sentence } from "@ohmail/ui/base";
import { SettingLine } from "@ohmail/ui/mail";
import { holderName } from "@ohmail/app-logic/mailboxes/first-run/rules";
import { readerHolder } from "@ohmail/app-logic/reading/reader-holder";
import { NONE } from "../../host/index.js";
import { holderLines } from "./Elsewhere.js";
import { Next, StepForm, stepTop, type StepProps } from "./parts.js";
import { HOLDER_MANAGED } from "./words.js";

/** Work, by an organizer; a relationship, by a reader; the takeover under way, while it is. */
function Done({ run, say, service }: StepProps): ReactNode {
  const { facts, agree, decide } = run;
  const organizing = facts.mailbox?.organizerRole !== "reader";
  const stopped = agree.stopped;
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
        {decide.decidedName !== null ? (
          <>
            <SettingLine label={say("onboarding.doneTakeoverDecided", { name: decide.decidedName })} />
          </>
        ) : null}
      </>
    );
  if (organizing) return null;
  const { label, line } = holderLines(facts, run.mailbox, say, {
    managed: HOLDER_MANAGED[service],
    stopped,
  });
  return (
    <>
      <SettingLine label={say("onboarding.doneReaderReads")} />
      <SettingLine label={label} value={line} />
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
  const waiting = run.about.queuedSenders;
  return (
    <StepForm run={run} submit={run.acts.close}>
      <Page
        {...stepTop(run, say, { cancel: false })}
        refusal={refused ? ([say("onboarding.doneTakeoverRefused", { name })] as const) : undefined}
        material={
          <div className="mbx-run-material">
            {refused && run.decide.reasked !== null ? (
              <>
                <SettingLine label={say("onboarding.doneTakeoverReasked", { name: run.decide.reasked })} />
              </>
            ) : null}
            <Done {...props} />
            {slots.calendar !== NONE && mailbox !== null
              ? slots.calendar({ mailboxId: mailbox.id, provider: mailbox.provider ?? "" })
              : null}
          </div>
        }
        acts={
          <>
            <Next label={say("onboarding.doneOpen")} />
            {pairs ? (
              <Button kind="two" disabled={run.writes.busy} onPress={() => run.acts.goTo("pair")}>
                {say("onboarding.pairOpen")}
              </Button>
            ) : null}
          </>
        }
      >
        <Sentence size="xl" level={1} end={organizing && waiting > 0 ? "hot" : "ink"}>
          {organizing
            ? waiting > 0
              ? say("onboarding.moreWait", { count: waiting })
              : say("onboarding.noOneWaits")
            : say("onboarding.doneReaderTitle")}
        </Sentence>
      </Page>
    </StepForm>
  );
}

/** THE LAST SCREEN, reached only from the summary's second verb: skipping it ends the run, as "Open ohmail" would. */
export function Pair({ run, say, slots }: StepProps): ReactNode {
  return (
    <StepForm run={run} submit={run.acts.close}>
      <Page
        {...stepTop(run, say, { cancel: false })}
        line={[{ tag: say("onboarding.pairOnce") }, { tag: say("onboarding.pairMinutes") }]}
        material={slots.pair !== NONE ? <div className="mbx-run-pair">{slots.pair()}</div> : undefined}
        acts={
          <Button kind="two" type="submit">
            {say("onboarding.pairLater")}
          </Button>
        }
      >
        <Sentence size="xl" level={1} end="ink">
          {say("onboarding.pairTitle")}
        </Sentence>
      </Page>
    </StepForm>
  );
}
