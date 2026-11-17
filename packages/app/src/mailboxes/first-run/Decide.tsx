/**
 * THE GUIDED DECISION: one sender, the head of this mailbox's queue, and the five places a decision files them into,
 * each with its key. The decision is the Screener's own act; the rest of the queue is the Screener's. A count with no
 * card yet says so rather than drawing nothing.
 */
import type { KeyboardEvent, ReactNode } from "react";
import { Button, Page, Seg } from "@ohmail/ui/base";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";
import { Foot, Said, StepForm, leadOf, type StepProps } from "./parts.js";
import { PLACES } from "./words.js";

export function Decide({ run, say }: StepProps): ReactNode {
  const sender = run.about.sender;
  if (sender === null)
    return (
      <StepForm run={run} submit={run.acts.away}>
        <Page
          material={
            <p className="mbx-run-status" role="status">
              {say("onboarding.decideLoading")}
            </p>
          }
          acts={
            <Foot
              run={run}
              say={say}
              primary={
                <Button kind="two" type="submit">
                  {say("onboarding.pullLeave")}
                </Button>
              }
            />
          }
        >
          <Said text={say("onboarding.decideTitle")} />
        </Page>
      </StepForm>
    );
  const { decide } = run;
  const here = decide.hereCount;
  const lead = !sender.many
    ? say("onboarding.decideLead", { count: Math.max(1, sender.waiting) })
    : here === null
      ? say("onboarding.decideLeadHereUncounted")
      : say("onboarding.decideLeadHere", { count: Math.max(1, Math.min(here, sender.waiting)) });
  /* Its five keys are the bar's own here: inside the stage there is no view under it to share them with. */
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const place = PLACES.find((p) => p.key === event.key);
    if (place === undefined) return;
    event.preventDefault();
    run.acts.decide(place.to, false);
  };
  return (
    <Page
      line={leadOf(lead)}
      material={
        <div className="mbx-run-material" role="group" aria-label={sender.name} tabIndex={0} onKeyDown={keys}>
          <SettingLine label={sender.name} value={sender.address} />
          <SettingNote>{sender.since}</SettingNote>
          {decide.sharedDomain ? null : (
            <Seg<"sender" | "domain">
              label={say("screener.barScopeAria")}
              value={decide.scope}
              onChange={decide.setScope}
              options={[
                { value: "sender", label: say("screener.barScopeSender") },
                { value: "domain", label: say("screener.barScopeDomain") },
              ]}
            />
          )}
          <div className="mbx-run-row">
            {PLACES.map((p) => (
              <Button
                key={p.to}
                kind="two"
                keyHint={p.key}
                shortcut={p.key}
                onPress={() => run.acts.decide(p.to, false)}
              >
                {say(p.name)}
              </Button>
            ))}
          </div>
          <ul className="mbx-run-legend">
            {PLACES.map((p) => (
              <li key={p.to}>{say(p.line)}</li>
            ))}
          </ul>
          <SettingNote>
            {sender.many
              ? say("onboarding.decideAfterAccount", { count: sender.waiting })
              : say("onboarding.decideAfter")}
          </SettingNote>
        </div>
      }
      acts={<Foot run={run} say={say} />}
    >
      <Said text={say("onboarding.decideTitle")} />
    </Page>
  );
}
