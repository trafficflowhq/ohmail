/**
 * JOIN. The setup of an account, as steps on one stage: an invite code where the deployment asks for one, the
 * account, the address confirmed, the second factor, the recovery codes, the plan and the first mailbox (the shell's
 * connect form, drawn at its step), then into ohmail. The list of stations says how far it is. Everything the
 * ceremony does is the door's; the page draws the step it is at. Its words are the `join` namespace's, and for a setup
 * whose step is being read the first run's two sentences.
 */
import type { ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText, type Text } from "../../text/index.js";
import { Said } from "../stage/Said.js";
import { WayButton, type DoorWay } from "../stage/way.js";
import { AccountStep, InviteStep, SentStep, VerifyStep } from "./AccountSteps.js";
import type { JoinDoor } from "./door.js";
import { CodesStep, FactorStep } from "./FactorSteps.js";
import { Progress } from "./parts.js";
import { DoneStep, MailboxStep, PlanStep } from "./PlanSteps.js";
import "./placement.css";

export function JoinPage({ door }: { door: JoinDoor | None }): ReactNode {
  const join = useText("join");
  const onboarding = useText("onboarding");
  const gate = useText("gate");
  if (door === NONE) return <Unavailable gate={gate} demo={NONE} />;
  const { state } = door;
  switch (state.at) {
    case "unavailable":
      return <Unavailable gate={gate} demo={door.demo} signIn={door.signIn} />;
    case "resolving":
      return <Resolving onboarding={onboarding} />;
    case "unreachable":
      /* The first run's sentences are outside the document's first cut: no button stands without its name. */
      if (!onboarding.has("resumeUnreachableTitle")) return <Resolving onboarding={onboarding} />;
      return (
        <Page
          line={onboarding("resumeUnreachableBody")}
          acts={
            <>
              <Button size="l" onPress={door.retry}>
                {onboarding("resumeRetry")}
              </Button>
              <WayButton way={door.leave} kind="quiet" size="l">
                {onboarding("resumeLeave")}
              </WayButton>
            </>
          }
        >
          <Said text={onboarding("resumeUnreachableTitle")} level={1} />
        </Page>
      );
    case "expired":
    case "full": {
      const full = state.at === "full";
      return (
        <Page
          line={state.said}
          note={!full && state.said === join("expiredOpen") ? join("expiredNote") : undefined}
          acts={
            <WayButton way={full ? door.waitlist : door.signInAgain} size="l">
              {join(full ? "capacityCta" : "signIn")}
            </WayButton>
          }
        >
          <Said text={join(full ? "capacityTitle" : "expiredTitle")} level={1} />
        </Page>
      );
    }
    default:
      return <Steps door={door} join={join} />;
  }
}

function Steps({ door, join }: { door: JoinDoor; join: Text }): ReactNode {
  const { state } = door;
  const progress = <Progress door={door} join={join} />;
  switch (state.at) {
    case "invite":
      return <InviteStep door={door} state={state} join={join} progress={progress} />;
    case "account":
      return <AccountStep door={door} state={state} join={join} progress={progress} />;
    case "sent":
      return <SentStep door={door} state={state} join={join} progress={progress} />;
    case "verify":
      return <VerifyStep door={door} state={state} join={join} progress={progress} />;
    case "factor":
      return <FactorStep door={door} state={state} join={join} progress={progress} />;
    case "codes":
      return <CodesStep door={door} state={state} join={join} progress={progress} />;
    case "mailbox":
      return <MailboxStep door={door} state={state} join={join} progress={progress} />;
    case "plan":
      return <PlanStep door={door} state={state} join={join} progress={progress} />;
    case "done":
      return <DoneStep door={door} state={state} join={join} progress={progress} />;
    default:
      return null;
  }
}

/** No server behind this build: no account can be made here, and the demo runs the client where there is one. */
function Unavailable({
  gate,
  demo,
  signIn,
}: {
  gate: Text;
  demo: DoorWay | None;
  signIn?: DoorWay;
}): ReactNode {
  return (
    <Page
      line={gate("body")}
      note={gate("note")}
      acts={
        <>
          {demo === NONE ? null : (
            <WayButton way={demo} size="l">
              {gate("openDemo")}
            </WayButton>
          )}
          {signIn === undefined ? null : (
            <WayButton way={signIn} kind="two" size="l">
              {gate("signIn")}
            </WayButton>
          )}
        </>
      }
    >
      <Said text={gate("lede")} dot="ink" level={1} />
    </Page>
  );
}

/**
 * A signed-in account's step is being read: "One moment", and under it what is being read, as the card said them.
 * The first run's sentences are outside the document's first cut, so until they have arrived the page waits without
 * a word.
 */
function Resolving({ onboarding }: { onboarding: Text }): ReactNode {
  const said = onboarding.has("resumeCheckingTitle") && onboarding.has("resumeChecking");
  return (
    <div className="way-live" aria-busy="true" aria-live="polite">
      <Page
        acts={null}
        material={
          said ? (
            <p className="way-join-status" role="status">
              {onboarding("resumeChecking")}
            </p>
          ) : undefined
        }
      >
        {said ? <Said text={onboarding("resumeCheckingTitle")} level={1} /> : null}
      </Page>
    </div>
  );
}
