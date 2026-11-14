/**
 * THE FIRST RUN AS A STAGE OF THE FRAME: the screens between installing ohmail and the first Screener decision, and
 * the sent-mail review when it is owed. The stage reads only the host (its first-run verbs, the connect form's wire,
 * the seed review's wire, which first run it walks and whose service it is), the route (`#/first-run`, `/again`,
 * `/add`, the mailbox it names) and the ground's facts the shell's fill hands; it holds no value of the old shell.
 * Built and held unseated: no shell registers it until its seat.
 */
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { OnboardingDoor, OnboardingStep } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunVerbs } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { useSeedOfferHere } from "@ohmail/app-logic/mailboxes/first-run/seed-offer";
import { useFirstRun } from "@ohmail/app-logic/mailboxes/first-run/use-first-run";
import type { MailboxId } from "@ohmail/app-logic/mailboxes/connect/types";
import { useModalGate } from "@ohmail/app-logic/session/modal-gate";
import type { PaneProps, Route, StageEntry } from "../../frame/contract.js";
import { useFrame } from "../../frame/index.js";
import { fragmentOf } from "../../frame/route.js";
import { NONE } from "../../host/index.js";
import { useTextLookup } from "../../text/index.js";
import { Ai, Provider } from "./Ai.js";
import { Consent } from "./Consent.js";
import { Decide } from "./Decide.js";
import { Elsewhere } from "./Elsewhere.js";
import { MailboxStep } from "./MailboxStep.js";
import { Choose, Vanished, Welcome } from "./Opening.js";
import { Confirms, Progress, type StepProps } from "./parts.js";
import { Pull } from "./Pull.js";
import { SeedReview } from "./SeedReview.js";
import type { FirstRunSlots } from "./slots.js";
import { Pair, Summary } from "./Summary.js";
import { Window } from "./Window.js";
import { sayOf, type Say } from "./words.js";
import "./placement.css";

/** One file a step; the table is total, so a step the derivation can answer always has its screen. */
const STEPS: Readonly<Record<OnboardingStep, (props: StepProps) => ReactNode>> = {
  welcome: Welcome,
  vanished: Vanished,
  choose: Choose,
  mailbox: MailboxStep,
  elsewhere: Elsewhere,
  consent: Consent,
  window: Window,
  ai: Ai,
  provider: Provider,
  pull: Pull,
  decide: Decide,
  summary: Summary,
  pair: Pair,
};

/** The screens that are no phase of the walk draw no rail. */
const NO_RAIL: ReadonlySet<OnboardingStep> = new Set(["welcome", "vanished", "choose"]);

/** The stage's registration. Made once by the shell that mounts it, never inline. */
export function firstRunStage(slots: FirstRunSlots): StageEntry {
  function Body(props: PaneProps): ReactNode {
    return <FirstRunBody {...props} slots={slots} />;
  }
  return { id: "firstRun", Body };
}

function FirstRunBody({ route, slots }: PaneProps & { slots: FirstRunSlots }): ReactNode {
  const { host } = useFrame();
  const say = sayOf(useTextLookup());
  const offer = useSeedOfferHere();
  const named = route.stage?.id === "firstRun";
  const seed = host.wires.seedReview;
  /* The review stands while it is owed; an address that names the run wins. */
  if (!named && offer !== null && offer.owed && seed !== NONE)
    return <SeedReview wire={seed} offer={offer} say={say} />;
  const verbs = host.wires.firstRun;
  const door = host.capabilities.firstRunDoor;
  if (!named || verbs === NONE || door === NONE) return null;
  return <Run route={route} slots={slots} verbs={verbs} door={door} say={say} />;
}

/** FOCUS STANDS WHERE ↵ BELONGS as a step opens: its first field, else its forward verb. A place chosen stays. */
function useFocusStep(root: RefObject<HTMLDivElement | null>, step: OnboardingStep | null): void {
  useLayoutEffect(() => {
    const at = root.current;
    if (at === null || step === null) return;
    const active = at.ownerDocument.activeElement;
    if (active !== null && active !== at && at.contains(active)) return;
    at.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), button[type="submit"]:not([disabled])',
    )?.focus({ preventScroll: true });
  }, [root, step]);
}

function Run(p: {
  route: Route;
  slots: FirstRunSlots;
  verbs: FirstRunVerbs;
  door: OnboardingDoor;
  say: Say;
}): ReactNode {
  const { route, slots, verbs, door, say } = p;
  const { host, commands } = useFrame();
  const words = route.stage?.words ?? {};
  const how = words.how === "again" ? "again" : words.how === "add" ? "add" : "run";
  const run = useFirstRun({
    verbs,
    door,
    ground: slots.ground(),
    how,
    word: words.mailbox ?? null,
    factor: slots.factor !== NONE,
    /* Leaving hands the route back to the app behind the stage. */
    leave: () => commands.go({ place: route.place }),
    /* The run's mailbox is written into its address: a REPLACE for the row an add just made (Back must not walk into
       a form for a mailbox that now exists), a step of history for one the person chose. */
    name: (id: MailboxId, mode: "replace" | "push") => {
      const stage = { id: "firstRun" as const, words: { ...(how === "run" ? {} : { how }), mailbox: id } };
      if (mode === "push") commands.go({ place: route.place, stage });
      else host.device.address.write(fragmentOf({ ...route, open: null, stage }), "replace");
    },
  });
  /* THE STAGE KEEPS FOCUS: it takes the modal gate, so no binding of the app behind it runs. */
  useModalGate(true);
  const root = useRef<HTMLDivElement | null>(null);
  useFocusStep(root, run.cursor.step);
  const step = run.cursor.step;
  if (run.rows === null || step === null) return null;
  const Step = STEPS[step];
  const ask = run.gated.ask;
  const props: StepProps = {
    run,
    say,
    door,
    service: host.capabilities.service,
    slots,
    connect: host.wires.connect,
  };
  return (
    <div
      ref={root}
      className="mbx-run"
      onKeyDown={(event) => {
        /* Escape ASKS rather than acts, heard in a field too: a form you cannot leave is a trap. */
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        run.acts.escape();
      }}
    >
      {NO_RAIL.has(step) ? null : <Progress run={run} say={say} />}
      <Step {...props} />
      <Confirms run={run} say={say} />
      {/* The second factor, asked beside the step it unblocks; a verified factor sends the parked press once more. */}
      {ask !== null && slots.factor !== NONE ? (
        <div className="mbx-run-factor">{slots.factor(ask)}</div>
      ) : null}
    </div>
  );
}
