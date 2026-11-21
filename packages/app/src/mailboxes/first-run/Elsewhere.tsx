/**
 * THE CLAIM QUESTION: somebody else organizes this mailbox. Who, and since when, in the same sentences the Mailboxes
 * pane and the summary say; then the choice, with its consequence stated on it. Nothing is pre-selected over a live
 * holder. A holder that stopped checking in takes the stopped twin of every sentence.
 */
import type { ReactNode } from "react";
import { Page, RadioLines, Sentence, Tag } from "@ohmail/ui/base";
import { SettingLine } from "@ohmail/ui/mail";
import type { OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";
import { holderName } from "@ohmail/app-logic/mailboxes/first-run/rules";
import type { FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { holderSentence, readerHolder } from "@ohmail/app-logic/reading/reader-holder";
import { Next, StepForm, refusalOf, stepTop, type StepProps } from "./parts.js";
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
  const title = say(stopped ? "onboarding.elsewhereSayStopped" : "onboarding.elsewhereSay", { name });
  return (
    <StepForm run={run} submit={run.acts.answerClaim}>
      <Page
        {...stepTop(run, say, { back: true })}
        trail={run.mailbox === null ? undefined : <Tag>{run.mailbox.address}</Tag>}
        refusal={refusalOf(run, say)}
        material={
          <RadioLines<"here" | "read" | "">
            label={title}
            value={run.agree.choice ?? ""}
            onChange={(value) => {
              if (value !== "") run.agree.choose(value);
            }}
            options={[
              {
                value: "here",
                label: say(
                  stopped ? "onboarding.elsewhereChoiceHereStopped" : "onboarding.elsewhereChoiceHere",
                ),
              },
              { value: "read", label: say("onboarding.elsewhereChoiceRead") },
            ]}
          />
        }
        acts={<Next label={say("onboarding.continue")} disabled={run.agree.choice === null} />}
      >
        <Sentence size="xl" level={1} end="hot">
          {title}
        </Sentence>
        <SettingLine label={label} value={line} />
      </Page>
    </StepForm>
  );
}
