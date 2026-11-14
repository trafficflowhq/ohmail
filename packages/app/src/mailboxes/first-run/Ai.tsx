/**
 * THE AI QUESTION, and its answer's step. The question stops the run until it is answered (nothing is spent before):
 * "no" is a complete answer; "yes" means what this shell makes of it: a model to choose here, the plan's credits, or
 * the operator's key. On a self-hosted server with no model, "yes" is not offered.
 */
import { useState, type ReactNode } from "react";
import { Page, RadioLines, Sentence } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { NONE } from "../../host/index.js";
import { Foot, Next, StepForm, leadOf, refusalOf, type StepProps } from "./parts.js";
import { AI_YES, PROVIDER_STEP } from "./words.js";

export function Ai({ run, say, door }: StepProps): ReactNode {
  const offered = run.acts.aiOffered;
  /* `on` and `on-unconfigured` are a "yes" already given; `unset` and `off` both draw as "no". */
  const [answer, setAnswer] = useState<"yes" | "no">(() =>
    run.facts.ai === "on" || run.facts.ai === "on-unconfigured" ? "yes" : "no",
  );
  const title = say("onboarding.aiTitle");
  return (
    <StepForm run={run} submit={() => run.acts.answerAi(answer === "yes")}>
      <Page
        line={leadOf(say("onboarding.aiLead"))}
        refusal={refusalOf(run, say)}
        material={
          <div className="mbx-run-material">
            <RadioLines<"yes" | "no">
              label={title}
              value={offered ? answer : "no"}
              onChange={(v) => {
                if (!run.writes.busy) setAnswer(v);
              }}
              options={[
                { value: "no", label: say("onboarding.aiNo"), note: say("onboarding.aiNoWhy") },
                ...(offered
                  ? [{ value: "yes" as const, label: say(AI_YES[door].label), note: say(AI_YES[door].why) }]
                  : []),
              ]}
            />
            {offered ? null : <SettingNote>{say("onboarding.providerSelfhostOff")}</SettingNote>}
          </div>
        }
        acts={<Foot run={run} say={say} back primary={<Next label={say("onboarding.continue")} />} />}
      >
        <Sentence size="xl" level={1} end="hot">
          {title}
        </Sentence>
      </Page>
    </StepForm>
  );
}

/** THE ANSWER'S STEP: the shell's own model form where the install keeps its model, else the service's sentence. */
export function Provider({ run, say, door, slots }: StepProps): ReactNode {
  const step = PROVIDER_STEP[door];
  const form = "form" in step;
  return (
    <StepForm run={run} submit={run.acts.forward}>
      <Page
        {...(form ? {} : { line: say(step.body(run.operatorModel)) })}
        material={form && slots.aiProvider !== NONE ? slots.aiProvider() : undefined}
        acts={<Foot run={run} say={say} back primary={<Next label={say("onboarding.continue")} />} />}
      >
        <Sentence size="xl" level={1} end="hot">
          {say(form ? "onboarding.aiTitle" : step.title)}
        </Sentence>
      </Page>
    </StepForm>
  );
}
