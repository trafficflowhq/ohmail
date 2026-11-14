/**
 * THE FIRST RUN, AS ONE MODEL: which mailbox the run is about (the route's word is a claim; the account's own row
 * answers it), the facts the derivation reads, the cursor, the writes, the one parked press and each step's own hook.
 * The stage draws from this and holds nothing of its own. Its inputs are an input record: the host's verbs, the
 * door's word, the ground's facts and the route's words; nothing is read from the old shell.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { OnboardingDoor, OnboardingFacts } from "../../doors/onboarding.js";
import type { FirstRunSubjectState } from "../../doors/first-run-subject.js";
import { subjectOf } from "../connect/subject.js";
import type { MailboxId } from "../connect/types.js";
import { useStageActions, type StageActions } from "./actions.js";
import type { FirstRunAbout, FirstRunGround, FirstRunRow, FirstRunVerbs } from "./ground.js";
import { useAgree, type Agree } from "./use-agree.js";
import { useCursor, type Cursor } from "./use-cursor.js";
import { useDecide, type Decide } from "./use-decide.js";
import { useGated, type Gated } from "./use-gated.js";
import { useHolderWait, type HolderWait } from "./use-holder-wait.js";
import { usePull, type Pull } from "./use-pull.js";
import { useStageFacts } from "./use-stage-facts.js";
import { useWrites, type Writes } from "./use-writes.js";

export interface FirstRunInput {
  readonly verbs: FirstRunVerbs;
  /** Which first run this shell walks: the host's own word. */
  readonly door: OnboardingDoor;
  readonly ground: FirstRunGround;
  /** The route's words: a first run, a re-run (`again`) or an add (`add`), and the mailbox it names. */
  readonly how: "run" | "again" | "add";
  readonly word: string | null;
  /** A dialog for the second factor stands here. */
  readonly factor: boolean;
  /** Leave the stage; the route goes back to the app. */
  leave(): void;
  /** Point the run at a mailbox: `replace` for the row an add just made, `push` for one the person chose. */
  name(mailboxId: MailboxId, how: "replace" | "push"): void;
}

export interface FirstRun {
  readonly rows: readonly FirstRunRow[] | null;
  readonly subject: FirstRunSubjectState;
  /** The row this run is about. */
  readonly mailbox: FirstRunRow | null;
  readonly about: FirstRunAbout;
  readonly facts: OnboardingFacts;
  readonly importReallyOver: boolean;
  readonly sweepHolding: boolean;
  readonly cursor: Cursor;
  readonly writes: Writes;
  readonly gated: Gated;
  readonly agree: Agree;
  readonly wait: HolderWait;
  readonly pull: Pull;
  readonly decide: Decide;
  readonly acts: StageActions;
  readonly rerun: boolean;
  readonly add: boolean;
  /** Which destructive verb asks in the foot, if one does. */
  readonly confirm: "cancel" | "restart" | null;
  setConfirm(next: "cancel" | "restart" | null): void;
  /** The sentence on screen is a refused Forget's: Start over's confirm carries it, not the step. */
  readonly forgetRefused: boolean;
  /** A first mailbox on a door whose connect is a page of its own: the step hands off to it. */
  readonly handOff: boolean;
  /**
   * An add whose address names a mailbox the account's rows do not hold yet: its create answered and the facts lag.
   * The word is a claim no row answers, so the step says to wait and draws no form and no verb of a mailbox.
   */
  readonly lagging: boolean;
  /** Who organizes this account's mail, for the connect step's note before a reader is connected. */
  readonly accountOrganizer: FirstRunGround["accountOrganizer"];
  /** A self-hosted server's operator set a model: the AI answer's step says so. */
  readonly operatorModel: boolean;
}

const NO_ROWS: readonly FirstRunRow[] = [];

/** One function for the life of the mount that always calls the newest one handed. */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  const [stable] = useState(
    () =>
      (...args: A) =>
        ref.current(...args),
  );
  return stable;
}

/**
 * WHATEVER CHANGES WHAT THE PARKED PRESS WOULD SEND empties the slot and closes the dialog: the step, the mailbox, the
 * window, the claim question's answer; a refused Forget's prompt lives only with Start over's confirm. And NOTHING TO
 * DRAW HANDS THE ROUTE BACK, while only a drawn step counts as the launch's organize ask.
 */
function useStageEffects(e: {
  readonly gated: Gated;
  readonly step: string | null;
  readonly mailboxId: MailboxId | null;
  readonly win: string;
  readonly choice: string | null;
  readonly confirm: "cancel" | "restart" | null;
  readonly open: boolean;
  leave(): void;
  drawn(): void;
}): void {
  const { withdraw, state } = e.gated;
  const { step, mailboxId, win, choice, confirm, open, leave, drawn } = e;
  useEffect(() => {
    withdraw();
  }, [withdraw, step, mailboxId, win, choice]);
  const parkedForget = state.at === "asking" && state.act.verb === "forget";
  useEffect(() => {
    if (confirm !== "restart" && parkedForget) withdraw();
  }, [confirm, parkedForget, withdraw]);
  useEffect(() => {
    if (!open) return;
    if (step === null) leave();
    else drawn();
  }, [open, step, leave, drawn]);
}

export function useFirstRun(input: FirstRunInput): FirstRun {
  const { verbs, door, ground, how } = input;
  const add = how === "add";
  const rerun = how === "again";
  const rows = ground.rows;
  const found = subjectOf(rows, input.word, add ? "add" : "run");
  const mailbox = found.mailbox;
  const mailboxId = mailbox?.id ?? null;
  const about = ground.about(mailboxId);
  const read: OnboardingFacts = useMemo(
    () => ({ door, mailbox, account: ground.account, ai: verbs.ai, queuedSenders: about.queuedSenders }),
    [door, mailbox, ground.account, verbs.ai, about.queuedSenders],
  );
  /* The ground hands fresh closures; the timers and the writes read the newest. */
  const refresh = useStable(ground.refresh);
  const rereadQueue = useStable(about.rereadQueue);
  const stage = useStageFacts({ read, mailboxId, rereadQueue });
  const facts = stage.facts;
  const cursor = useCursor({
    facts,
    mailboxId,
    rerun,
    add,
    vanished: found.state === "vanished",
    choose: found.state === "choose" && (rows ?? NO_ROWS).length > 1,
  });
  const writes = useWrites({ step: cursor.step, rerun, setAt: cursor.setAt, refresh, factor: input.factor });
  const [confirm, setConfirm] = useState<"cancel" | "restart" | null>(null);
  const [forgetRefused, setForgetRefused] = useState(false);
  const agree = useAgree({
    verbs,
    facts,
    read,
    step: cursor.step,
    mailboxId,
    claimAnswered: cursor.claimAnswered,
    rerun,
    ...(ground.screening ? { screening: ground.screening } : {}),
  });
  const wait = useHolderWait({
    facts,
    step: cursor.step,
    mailboxId,
    claimAnswered: cursor.claimAnswered,
    refresh,
  });
  const pull = usePull({
    pulled: about.pull.pulled,
    serverMessageCount: mailbox?.serverMessageCount,
    unreachable: read.mailbox?.unreachable === true,
    importOver: stage.importReallyOver,
  });
  const decide = useDecide({
    verbs,
    step: cursor.step,
    mailboxId,
    sender: about.sender,
    takeover: agree.takeover,
  });
  const sendRef = useRef<StageActions["send"] | null>(null);
  const gated = useGated((run) => sendRef.current!(run));
  const acts = useStageActions({
    input,
    mailboxId,
    facts,
    stage,
    cursor,
    writes,
    gated,
    agree,
    wait,
    decide,
    setConfirm,
    setForgetRefused,
  });
  sendRef.current = acts.send;
  useStageEffects({
    gated,
    step: cursor.step,
    mailboxId,
    win: agree.win,
    choice: agree.choice,
    confirm,
    open: rows !== null,
    leave: useStable(input.leave),
    drawn: useStable(ground.drawn),
  });

  return {
    rows,
    subject: found.state,
    mailbox,
    about,
    facts,
    importReallyOver: stage.importReallyOver,
    sweepHolding: stage.sweepHolding,
    cursor,
    writes,
    gated,
    agree,
    wait,
    pull,
    decide,
    acts,
    rerun,
    add,
    confirm,
    setConfirm,
    forgetRefused,
    handOff: verbs.setupHref !== undefined && verbs.resume !== undefined && !add && facts.mailbox === null,
    lagging: found.state === "pending" && input.word !== null,
    accountOrganizer: ground.accountOrganizer,
    operatorModel: verbs.selfhostAi === true,
  };
}
