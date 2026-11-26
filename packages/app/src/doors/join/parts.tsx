/** What every step of the join shares: the progress it lists, the sentences under the page's own, Sign out again. */
import type { ReactNode } from "react";
import { StepDots } from "@ohmail/ui/base";
import type { Text } from "../../text/index.js";
import type { JoinDoor, JoinState } from "./door.js";
import { WayButton } from "../stage/way.js";

export function JoinSignIn({ door, join }: { door: JoinDoor; join: Text }): ReactNode {
  return (
    <WayButton way={door.signIn} kind="quiet">
      {join("signIn")}
    </WayButton>
  );
}

export function JoinBack({
  door,
  join,
  signIn = false,
  children,
}: {
  door: JoinDoor;
  join: Text;
  signIn?: boolean;
  children?: ReactNode;
}): ReactNode {
  return (
    <span className="way-join-row">
      <WayButton way={door.leave} kind="quiet">
        {join("leave")}
      </WayButton>
      {signIn && <JoinSignIn door={door} join={join} />}
      {children}
    </span>
  );
}

export { refusalOf, SignOutAgain, type Refusal } from "../stage/pending.js";

/** The account screens share one stage dot. Connecting a mailbox moves to the next stage. */
const ACCOUNT_PART = { invite: 1, account: 1, sent: 2, verify: 2, factor: 3, codes: 4, plan: 5 } as const;
const STAGES = ["rail_account", "rail_mailbox", "rail_organize", "rail_read", "rail_decisions"] as const;

export function Progress({
  door,
  join,
  mailboxPart,
}: {
  door: JoinDoor;
  join: Text;
  mailboxPart?: number;
}): ReactNode {
  const at = door.state.at;
  const stage =
    door.state.at === "done" ? (door.state.decisionAhead ? 2 : STAGES.length) : at === "mailbox" ? 1 : 0;
  const part = stage === 0 && at in ACCOUNT_PART ? ACCOUNT_PART[at as keyof typeof ACCOUNT_PART] : null;
  if (stage === STAGES.length)
    return <StepDots label={join("progressComplete")} steps={STAGES.length} at={stage} />;
  const name = join(STAGES[stage]!);
  if (mailboxPart !== undefined) {
    return (
      <StepDots
        label={join("progressMailbox", { stage: stage + 1, name, part: mailboxPart })}
        steps={STAGES.length}
        at={stage}
        sub={`${mailboxPart}/3`}
      />
    );
  }
  const said =
    part === null
      ? join("progressStage", { stage: stage + 1, name })
      : join("progressAccount", { stage: stage + 1, name, part });
  return (
    <StepDots label={said} steps={STAGES.length} at={stage} sub={part === null ? undefined : `${part}/5`} />
  );
}

/** What each step hands its part. */
export interface StepProps<S extends JoinState["at"]> {
  readonly door: JoinDoor;
  readonly state: Extract<JoinState, { at: S }>;
  readonly join: Text;
  readonly progress: ReactNode;
}
