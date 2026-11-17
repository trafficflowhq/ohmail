/**
 * THE CLAIM QUESTION: somebody else organizes this mailbox. Who, and since when, in the same sentences the Mailboxes
 * pane and the summary say; then the choice, with its consequence stated on it. Nothing is pre-selected over a live
 * holder. A holder that stopped checking in takes the stopped twin of every sentence.
 */
import type { ReactNode } from "react";
import { Page, RadioLines } from "@ohmail/ui/base";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";
import type { OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";
import { holderName } from "@ohmail/app-logic/mailboxes/first-run/rules";
import type { FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { holderSentence, readerHolder } from "@ohmail/app-logic/reading/reader-holder";
import { Foot, Next, Said, StepForm, leadOf, refusalOf, type StepProps } from "./parts.js";
import { HOLDER_MANAGED, type Say } from "./words.js";

/** Who holds the mailbox, as a label and a sentence: the elsewhere screen's and the reader summary's, one table. */
export function holderLines(
  facts: OnboardingFacts,
  row: FirstRunRow | null,
  say: Say,
  on: {
    readonly managed: boolean;
    /** The decider's `holderStopped` for this mailbox (`use-agree.ts`). */
    readonly stopped: boolean;
  },
): { label: string; line: string } {
  const by = facts.mailbox?.organizedBy;
  const held = readerHolder(by);
  const name = holderName(facts);
  const unknown = say("mailboxes.readerHolderUnknown");
  /* NOBODY IS TESTED FIRST: every other sentence names or dates a holder, and with none there is nothing to name. */
  if (held === "nobody")
    return { label: say("mailboxes.stateNotOrganized"), line: say("mailboxes.readerNobodyReads") };
  const since = row?.holderSince ?? null;
  const said = holderSentence({
    who: {
      kind: by?.kind ?? (held === "unnamed" ? "unknown" : null),
      name,
      stopped: on.stopped,
      since,
      shown: since ?? "",
    },
    verb: "none",
    managed: on.managed,
  });
  return {
    label:
      held === "unnamed"
        ? say("mailboxes.readerLabelLegacy")
        : say("mailboxes.readerLabel", { name: name ?? unknown }),
    line: say(`mailboxes.${said.key}`, { ...said.params, name: said.params.name ?? unknown }),
  };
}

export function Elsewhere({ run, say, service }: StepProps): ReactNode {
  const stopped = run.agree.stopped;
  const name = holderName(run.facts) ?? say("mailboxes.readerHolderUnknown");
  const { label, line } = holderLines(run.facts, run.mailbox, say, {
    managed: HOLDER_MANAGED[service],
    stopped,
  });
  const title = say(stopped ? "onboarding.elsewhereTitleStopped" : "onboarding.elsewhereTitle");
  return (
    <StepForm run={run} submit={run.acts.answerClaim}>
      <Page
        line={leadOf(say(stopped ? "onboarding.elsewhereLeadStopped" : "onboarding.elsewhereLead"))}
        refusal={refusalOf(run, say)}
        material={
          <div className="mbx-run-material">
            <SettingLine label={label} />
            <SettingNote>{line}</SettingNote>
            <RadioLines<"here" | "read" | "">
              label={title}
              value={run.agree.choice ?? ""}
              onChange={(v) => {
                if (v !== "") run.agree.choose(v);
              }}
              options={[
                {
                  value: "here",
                  label: say(
                    stopped ? "onboarding.elsewhereChoiceHereStopped" : "onboarding.elsewhereChoiceHere",
                  ),
                  note: say(
                    stopped
                      ? "onboarding.elsewhereChoiceHereStoppedWhy"
                      : "onboarding.elsewhereChoiceHereWhy",
                    { name },
                  ),
                },
                {
                  value: "read",
                  label: say("onboarding.elsewhereChoiceRead"),
                  note: stopped
                    ? say("onboarding.elsewhereChoiceReadStoppedWhy")
                    : say("onboarding.elsewhereChoiceReadWhy", { name }),
                },
              ]}
            />
            {run.agree.claimed ? <SettingNote>{say("onboarding.elsewhereQueued")}</SettingNote> : null}
          </div>
        }
        acts={
          <Foot
            run={run}
            say={say}
            back
            primary={<Next label={say("onboarding.continue")} disabled={run.agree.choice === null} />}
          />
        }
      >
        <Said text={title} />
      </Page>
    </StepForm>
  );
}
