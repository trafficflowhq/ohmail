/**
 * THE FIRST RUN AS A STAGE OF THE FRAME: the screens between installing ohmail and the first Screener decision, and
 * the sent-mail review when it is owed. The stage reads only the host (its first-run verbs, the connect form's wire,
 * the seed review's wire, which first run it walks and whose service it is), the route (`#/first-run`, `/again`,
 * `/add`, the mailbox it names) and the ground's facts, which its registration's `ground` stands: on the mail ground
 * that is the stage's own seat (`Seat.ts`), named by the mail's stages. It holds no value of a shell.
 */
import { useRef, type ReactNode } from "react";
import type { OnboardingDoor, OnboardingStep } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunGround, FirstRunVerbs } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { useSeedOfferHere } from "@ohmail/app-logic/mailboxes/first-run/seed-offer";
import { useSeedReviewHere } from "@ohmail/app-logic/mailboxes/first-run/use-seed-review";
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
import { useStepEntry } from "./focus.js";
import { MailboxStep } from "./MailboxStep.js";
import { Choose, Vanished, Welcome } from "./Opening.js";
import { Confirms, type StepProps } from "./parts.js";
import { Pull } from "./Pull.js";
import { runWordsOf } from "./run-words.js";
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
  const review = useSeedReviewHere();
  const named = route.stage?.id === "firstRun";
  /* The review stands while it is owed, drawn from the frame's one read; an address that names the run wins. */
  if (!named && offer !== null && offer.owed && review !== null && host.wires.seedReview !== NONE)
    return <SeedReview review={review} offer={offer} say={say} />;
  const verbs = host.wires.firstRun;
  const door = host.capabilities.firstRunDoor;
  if (!named || verbs === NONE || door === NONE) return null;
  return <Run route={route} slots={slots} verbs={verbs} door={door} say={say} />;
}

interface RunProps {
  route: Route;
  slots: FirstRunSlots;
  verbs: FirstRunVerbs;
  door: OnboardingDoor;
  say: Say;
}

/**
 * A RUN STARTS ON ANSWERS, NEVER ON DEFAULTS. Until the account's mailboxes and its consent row have answered, the
 * consent row by the live read, the ground's facts rest as "nothing has happened yet" (its rows are `null`), and a run
 * that began over the resting values would keep them: what a run chooses once, as it opens (the window a re-run shows
 * is what the account stored), would be chosen from nothing. A boot cache is no answer: the device's cached row holds
 * neither the window's scope nor the stamp of setup. So the run's model is mounted only once the ground has answered,
 * and nothing is drawn before.
 */
function Run(p: RunProps): ReactNode {
  const ground = p.slots.ground();
  if (ground.rows === null) return null;
  const { how, word } = runWordsOf(p.route);
  /* A run about another mailbox is a new run: nothing chosen, asked or parked for one stands for another. */
  return <Walk key={how + "|" + (word ?? "")} {...p} ground={ground} />;
}

function Walk(p: RunProps & { ground: FirstRunGround }): ReactNode {
  const { route, slots, verbs, door, say, ground } = p;
  const { host, commands } = useFrame();
  const { how, word } = runWordsOf(route);
  const wire = host.wires.connect;
  const code = wire === NONE || wire.signIn === NONE ? NONE : wire.signIn.code;
  const mailboxes = { place: "settings", sub: "mailboxes" } as const;
  const handoff = how === "add" && code !== NONE && code.resume !== undefined;
  const run = useFirstRun({
    verbs,
    door,
    ground,
    how,
    word,
    factor: slots.factor !== NONE,
    /* Leaving hands the route back to the app behind the stage. */
    leave: () => commands.go(handoff && word === null ? mailboxes : { place: route.place }),
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
  const step = run.cursor.step;
  const ask = run.gated.ask;
  /* The keys stand in what was asked last: a step as it opens (`focus.ts`); a question is the kit's dialog, which
     takes them and gives them back (`parts.tsx`); the second factor's dialog keeps its own. */
  useStepEntry(root, run.confirm === null && ask === null ? step : null);
  if (run.rows === null || step === null) return null;
  const Step = STEPS[step];
  const props: StepProps = {
    run,
    say,
    door,
    service: host.capabilities.service,
    slots,
    connect: wire,
    ...(handoff ? { onCodeStarted: () => commands.go(mailboxes, { replace: true }) } : {}),
  };
  return (
    <div
      ref={root}
      className="mbx-run"
      tabIndex={-1}
      onKeyDown={(event) => {
        /* Escape ASKS rather than acts, heard in a field too: a form you cannot leave is a trap. */
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        run.acts.escape();
      }}
    >
      <Step {...props} />
      <Confirms run={run} say={say} />
      {/* The second factor, asked beside the step it unblocks; a verified factor sends the parked press once more. */}
      {ask !== null && slots.factor !== NONE ? (
        <div className="mbx-run-factor">{slots.factor(ask)}</div>
      ) : null}
    </div>
  );
}
