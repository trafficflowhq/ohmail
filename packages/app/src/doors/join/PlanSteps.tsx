/**
 * The join's last steps on this page: the plan, taken on the account page the service runs, and the mailbox the shell's
 * connect form asks for; then set up, and into ohmail. The plan step has one way on: a person who leaves lands on the
 * wall's "Start your free trial" anyway, so "Later" stands only where there is no account page to open.
 */
import type { ReactNode } from "react";
import { Page } from "@ohmail/ui/base";
import { Said } from "../stage/Said.js";
import { WayButton } from "../stage/way.js";
import type { JoinPlanChosen } from "./door.js";
import { refusalOf, SignOutAgain, type StepProps } from "./parts.js";
import type { Text } from "../../text/index.js";

/** What the site's button chose, as a sentence, and the trial's term where one is offered; never a price. */
function choiceOf(chosen: JoinPlanChosen, trial: boolean, join: Text): string | undefined {
  const said = [
    chosen.name === null
      ? null
      : join(
          chosen.interval === "year"
            ? "planChosenYear"
            : chosen.interval === "month"
              ? "planChosenMonth"
              : "planChosen",
          {
            plan: chosen.name,
          },
        ),
    trial ? join("planTrial") : null,
  ].filter((s): s is string => s !== null);
  return said.length === 0 ? undefined : said.join(" ");
}

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
      line={join(trial ? "step_plan_lead" : "planLeadNoTrial")}
      note={choiceOf(state.chosen, trial, join)}
      acts={
        <>
          {acts}
          <SignOutAgain pending={pending} busy={busy} />
        </>
      }
    >
      <Said text={join("step_plan_title")} level={1} />
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
      line={join(ahead ? "step_connected_lead" : "step_done_lead")}
      note={state.mailbox === null ? undefined : join("mailboxConnected", { address: state.mailbox })}
      acts={
        <WayButton way={door.open} size="l">
          {join(ahead ? "continue" : "openOhmail")}
        </WayButton>
      }
    >
      <Said text={join(ahead ? "step_connected_title" : "step_done_title")} dot="ink" level={1} />
    </Page>
  );
}
