/**
 * THE PHONE'S WAYS IN: what a person sees on the phone while no account is open. The first screen (`welcome`), a
 * server by its address, a computer, organizing on the phone itself (its terms, then the one connect form), the scan,
 * a code by hand, what answered before the code is spent, and the copy opening. Each step draws what native last said
 * and sends its one request; where the page stands is its own memory, never the route and never storage.
 *
 * Back goes to the step before; at the step the page opened at, to the door's list of servers, except on the first
 * screen and while the copy opens, where native takes it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { PhoneDoor } from "./contract.js";
import { ComputerStep } from "./ComputerStep.js";
import { Confirm } from "./Confirm.js";
import { Hand } from "./Hand.js";
import { MailboxStep } from "./MailboxStep.js";
import { Mirror } from "./Mirror.js";
import { Scan } from "./Scan.js";
import { ServerStep } from "./ServerStep.js";
import type { StepProps, WayInSeed, WayInStep } from "./states.js";
import { Terms } from "./Terms.js";
import { SignInStep } from "./SignInStep.js";
import { Welcome } from "./Welcome.js";

const STEPS: { readonly [S in WayInStep]: (props: StepProps) => ReactNode } = {
  welcome: Welcome,
  signIn: SignInStep,
  server: ServerStep,
  computer: ComputerStep,
  terms: Terms,
  mailbox: MailboxStep,
  scan: Scan,
  hand: Hand,
  confirm: Confirm,
  mirror: Mirror,
};

export function PhoneDoorPage({ door, from }: { door: PhoneDoor; from?: WayInSeed }): ReactNode {
  const [trail, setTrail] = useState<readonly WayInSeed[]>(() => [from ?? { step: "welcome" }]);
  const seed = trail[trail.length - 1]!;
  const now = useRef(trail);
  now.current = trail;
  const to = useCallback<StepProps["to"]>((next, how) => {
    setTrail((was) => (how?.replace ? [...was.slice(0, -1), next] : [...was, next]));
  }, []);
  const back = useCallback(() => {
    if (now.current.at(-1)?.step === "signIn" && door.state.read().session === "opening") return;
    if (now.current.length > 1) setTrail((was) => was.slice(0, -1));
    else door.go("servers");
  }, [door]);
  useEffect(
    () =>
      door.back.subscribe(() => {
        const at = now.current[now.current.length - 1]!.step;
        if (at === "mirror" || (at === "welcome" && now.current.length === 1)) return false;
        back();
        return true;
      }),
    [door, back],
  );
  const Step = STEPS[seed.step];
  /* Each entry of the trail is a step of its own: a step drawn again starts from its seed. */
  return <Step key={trail.length} door={door} seed={seed} to={to} back={back} />;
}
