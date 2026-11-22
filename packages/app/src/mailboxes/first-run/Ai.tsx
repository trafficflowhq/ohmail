import { useRef, useState, type ReactNode } from "react";
import { Menu, MenuItem, Page, Sentence, Slot, Tag } from "@ohmail/ui/base";
import { SaidWith } from "../../doors/stage/Said.js";
import { NONE } from "../../host/index.js";
import { useText } from "../../text/index.js";
import { Next, StepForm, refusalOf, stepTop, type StepProps } from "./parts.js";

export function Ai({ run, say, door }: StepProps): ReactNode {
  const offered = run.acts.aiOffered;
  const onboarding = useText("onboarding");
  const [answer, setAnswer] = useState(() => run.facts.ai === "on" || run.facts.ai === "on-unconfigured");
  const enabled = offered && answer;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const mode = say(enabled ? "onboarding.aiOn" : "onboarding.aiOff");
  return (
    <StepForm run={run} submit={() => run.acts.answerAi(enabled)}>
      <Page
        {...stepTop(run, say, { back: true })}
        line={
          enabled
            ? [
                { note: say("onboarding.aiSends") },
                ...(door === "cloud" ? [{ note: say("onboarding.aiDraftSends") }] : []),
                {
                  tag: say(
                    door === "cloud"
                      ? "onboarding.aiCloudTag"
                      : door === "selfhost"
                        ? "onboarding.aiServerTag"
                        : "onboarding.aiKeyTag",
                  ),
                },
              ]
            : [{ tag: say("onboarding.aiRulesOnly") }]
        }
        refusal={refusalOf(run, say)}
        acts={<Next label={say("onboarding.continue")} />}
      >
        <SaidWith
          level={1}
          parts={onboarding.rich("aiSay", {
            on: () =>
              offered ? (
                <Slot
                  kind="fill"
                  ref={anchor}
                  expanded={open}
                  disabled={run.writes.busy}
                  onPress={() => setOpen(!open)}
                >
                  {mode}
                </Slot>
              ) : (
                <Tag>{mode}</Tag>
              ),
          })}
        />
        <Menu anchor={anchor} open={open} label={say("onboarding.aiTitle")} onClose={() => setOpen(false)}>
          {[true, false].map((value) => (
            <MenuItem
              key={String(value)}
              checked={value === enabled}
              onPress={() => {
                if (!run.writes.busy) setAnswer(value);
                setOpen(false);
              }}
            >
              {say(value ? "onboarding.aiOn" : "onboarding.aiOff")}
            </MenuItem>
          ))}
        </Menu>
      </Page>
    </StepForm>
  );
}

/** The local model form uses the same host slot as Settings. */
export function Provider({ run, say, door, slots }: StepProps): ReactNode {
  return (
    <StepForm run={run} submit={run.acts.forward}>
      <Page
        {...stepTop(run, say, { back: true })}
        material={door === "local" && slots.aiProvider !== NONE ? slots.aiProvider() : undefined}
        acts={<Next label={say("onboarding.continue")} />}
      >
        <Sentence size="xl" level={1} end="hot">
          {say("onboarding.aiTitle")}
        </Sentence>
      </Page>
    </StepForm>
  );
}
