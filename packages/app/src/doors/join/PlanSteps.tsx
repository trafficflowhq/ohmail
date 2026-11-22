/**
 * The join's last steps on this page: the plan, taken on the account page the service runs, and the mailbox the shell's
 * connect form asks for; then set up, and into ohmail. The plan step has one way on: a person who leaves lands on the
 * wall's "Start your free trial" anyway, so "Later" stands only where there is no account page to open.
 */
import type { ReactNode } from "react";
import { Page, Tag } from "@ohmail/ui/base";
import { Said, SaidWith } from "../stage/Said.js";
import { WayButton } from "../stage/way.js";
import { refusalOf, SignOutAgain, type StepProps } from "./parts.js";

export function PlanStep({ door, state, join, progress }: StepProps<"plan">): ReactNode {
  const { pending, busy } = door;
  const waitLine = (words: string): ReactNode => (
    <p className="way-join-status" role="status">
      {words}
    </p>
  );
  if (state.trial === null)
    return (
      <Page
        aside={progress}
        refusal={refusalOf(pending, door.refusal)}
        material={waitLine(join("planLoading"))}
        acts={null}
      >
        <Said text={join("step_plan_title")} level={1} />
      </Page>
    );
  const trial = state.trial;
  const plan = state.chosen.name;
  const interval = state.chosen.interval;
  const material =
    state.link === "none"
      ? waitLine(join("planUnavailable"))
      : state.link === "asking"
        ? waitLine(join("planLoading"))
        : state.waiting
          ? waitLine(join(trial ? "planStarting" : "planWaiting"))
          : undefined;
  const acts =
    state.link === "ready" && door.accountPage !== null ? (
      <WayButton way={door.accountPage} size="l">
        {join(trial ? "planStartTrial" : "planContinue")}
      </WayButton>
    ) : state.link === "none" ? (
      <WayButton way={door.later} kind="quiet" size="l">
        {join("later")}
      </WayButton>
    ) : null;
  return (
    <Page
      aside={progress}
      refusal={refusalOf(pending, door.refusal)}
      material={material}
      line={[
        ...(plan !== null && !trial ? [{ tag: plan }] : []),
        ...(plan !== null && interval !== null
          ? [{ tag: join(interval === "year" ? "planYearly" : "planMonthly") }]
          : []),
        ...(trial ? [{ tag: join("planNoCard") }] : []),
      ]}
      acts={
        <>
          {acts}
          <SignOutAgain pending={pending} busy={busy} />
        </>
      }
    >
      {trial && plan !== null ? (
        <SaidWith level={1} parts={join.rich("startOn", { plan: () => <Tag>{plan}</Tag> })} />
      ) : (
        <Said text={join(trial ? "startTrialTitle" : "step_plan_title")} level={1} />
      )}
    </Page>
  );
}

/** The mailbox: the shell's connect form, as it stands, says its own refusals and has its own ways on. */
export function MailboxStep({ door, join, progress }: StepProps<"mailbox">): ReactNode {
  return (
    <Page
      aside={progress}
      refusal={refusalOf(door.pending, null)}
      material={door.slots.mailbox()}
      acts={null}
    >
      <Said text={join("step_mailbox_title")} level={1} />
    </Page>
  );
}

/**
 * Set up. "You're set up" only once organizing is agreed: before that the decision is ahead (the first run opens on
 * it), and a person who left believing setup was over would have a mailbox nothing screens.
 */
export function DoneStep({ door, state, join, progress }: StepProps<"done">): ReactNode {
  const ahead = state.decisionAhead;
  return (
    <Page
      aside={progress}
      refusal={refusalOf(door.pending, door.refusal)}
      material={
        state.mailbox === null ? undefined : (
          <p>
            <Tag>{state.mailbox}</Tag> <Tag>{join("connected")}</Tag>
          </p>
        )
      }
      acts={
        <WayButton way={door.open} size="l">
          {join(ahead ? "continue" : "openOhmail")}
        </WayButton>
      }
    >
      <Said
        text={join(ahead && state.mailbox !== null ? "myMailboxes" : "step_done_title")}
        dot="ink"
        level={1}
      />
    </Page>
  );
}
