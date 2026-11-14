/**
 * THE STAGE'S PRESSES. Each step's one forward verb, the foot's two destructive verbs, and the three gated verbs'
 * sender: Agree, "Organize here instead" on a consented mailbox, and Start over's Forget are tried first and parked
 * behind the one dialog only on the server's refusal (`use-gated.ts`). The mode of a connect is the route's, stated.
 */
import type { OnboardingDoor, OnboardingFacts, OnboardingStep } from "../../doors/onboarding.js";
import { importOverOf } from "../../doors/onboarding.js";
import type { GatedRun } from "../connect/gate.js";
import { gateOf, signInSaid } from "../connect/refusal.js";
import { refusalOfThrown } from "../connect/thrown.js";
import type { MailboxId } from "../connect/types.js";
import { organizedOf, stepUpOf } from "./answers.js";
import type { DecideTo } from "./ground.js";
import { StageRefusal, onboarding } from "./thrown.js";
import type { Agree } from "./use-agree.js";
import type { Cursor } from "./use-cursor.js";
import type { Decide } from "./use-decide.js";
import type { FirstRunInput } from "./use-first-run.js";
import type { GatedAct, GatedOutcome, Gated } from "./use-gated.js";
import type { HolderWait } from "./use-holder-wait.js";
import type { StageFacts } from "./use-stage-facts.js";
import type { Writes } from "./use-writes.js";

/** Where "yes" to AI is a model still to choose: the door whose install keeps its own model file. */
const MODEL_STEP: Readonly<Record<OnboardingDoor, boolean>> = { local: true, cloud: false, selfhost: false };
/** Where "yes" may be said: everywhere a model can answer; on a self-hosted server, where its operator set one. */
const AI_OFFERED: Readonly<Record<OnboardingDoor, (operatorKey: boolean) => boolean>> = {
  local: () => true,
  cloud: () => true,
  selfhost: (operatorKey) => operatorKey,
};

export interface StageActionsInput {
  readonly input: FirstRunInput;
  readonly mailboxId: MailboxId | null;
  readonly facts: OnboardingFacts;
  readonly stage: StageFacts;
  readonly cursor: Cursor;
  readonly writes: Writes;
  readonly gated: Gated;
  readonly agree: Agree;
  readonly wait: HolderWait;
  readonly decide: Decide;
  setConfirm(
    next: "cancel" | "restart" | null | ((c: "cancel" | "restart" | null) => "cancel" | "restart" | null),
  ): void;
  setForgetRefused(next: boolean): void;
}

export interface StageActions {
  /** The gated verbs' sender: what the one slot sends, once a press or once after a verified factor. */
  send(run: GatedRun<GatedAct>): Promise<GatedOutcome>;
  goTo(next: OnboardingStep): void;
  forward(): void;
  /** Close setup: the stamp that closes the flow, then the route back. Cancel and finish alike. */
  close(): void;
  /** Leave the stage without ending the run ("Open ohmail meanwhile"). */
  away(): void;
  escape(): void;
  restart(): void;
  keep(): void;
  /** Leave for the page where a first mailbox is connected (the web's join). */
  resume(): void;
  /** This door can forget a mailbox: Start over then offers it. */
  readonly canForget: boolean;
  forget(): void;
  agree(): void;
  answerClaim(): void;
  /** The AI question's answer, and whether "yes" may be said here. */
  readonly aiOffered: boolean;
  answerAi(yes: boolean): void;
  decide(to: DecideTo, markRead: boolean): void;
  /** The connect form connected a mailbox: an add's route names the new row; the facts are read again. */
  connected(mailboxId: MailboxId): void;
  choose(mailboxId: MailboxId): void;
}

/**
 * WHAT THE ONE SLOT SENDS: the parked value, as it was pressed. Each verb is one call; the door's second-factor
 * refusal parks it (the first time) and is said in the step's own words; a refusal after a verified factor, or where
 * no dialog can be asked, says to sign in again.
 */
function gatedSender(a: StageActionsInput, goTo: (next: OnboardingStep) => void) {
  const { input, stage, cursor, writes, agree, wait } = a;
  const { verbs } = input;
  const rerun = input.how === "again";
  /* The door's own reader of its second-factor refusal where it hands one; the refusal's own word where it does not. */
  const isFactor = (thrown: unknown): boolean =>
    stepUpOf(verbs.stepUp)?.(thrown) ?? gateOf(refusalOfThrown(thrown)) === "factor";
  return async ({ act, afterFactor }: GatedRun<GatedAct>): Promise<GatedOutcome> => {
    let outcome: GatedOutcome = { ok: false, word: "refused" };
    /* A dialog asks once: after a verified factor, or with no dialog to ask, the remedy is to sign in again. */
    const factorOr =
      (line: string) =>
      (thrown: unknown): never => {
        if (!isFactor(thrown)) throw thrown;
        const asks = input.factor && !afterFactor;
        outcome = asks ? { ok: false, word: "factor" } : { ok: false, word: "sign_in" };
        throw new StageRefusal(asks ? onboarding(line) : signInSaid("firstRun"));
      };
    if (act.verb === "agree") {
      await writes.run(
        async () => {
          const answer = await verbs.organize(act.mailboxId, act.body).catch(factorOr("windowStepUp"));
          outcome = { ok: true };
          const done = organizedOf(answer);
          /* Refused over a live holder: nothing stored, and the run waits until a read names the holder. */
          if (done === "held") return wait.heldPress(act.mailboxId);
          /* A PRESS THAT STORED NOTHING MAY NOT LOOK LIKE ONE THAT WORKED: every reply is a 200. */
          if (done === "gone") throw new StageRefusal(onboarding("windowGone"));
          if (done !== "stored") throw new StageRefusal(onboarding("holderCheckSlow"));
          stage.agreed(act.mailboxId);
          if (act.sweeps) stage.sweep(act.mailboxId);
          /* A READER'S AGREE ASKED FOR A CLAIM the gate has still to answer: Done says so until the row answers. */
          if (act.reader) agree.asked(act.mailboxId);
        },
        rerun ? "ai" : undefined,
        { stayOnFailure: true },
      );
    } else if (act.verb === "takeover") {
      await writes.run(
        async () => {
          await verbs.organize(act.mailboxId, { intent: "takeover" }).catch(factorOr("elsewhereStepUp"));
          outcome = { ok: true };
          cursor.answerClaim();
          agree.claimedHere();
          agree.asked(act.mailboxId);
        },
        "elsewhere",
        { stayOnFailure: true },
      );
    } else {
      const forgetMailbox = verbs.forgetMailbox;
      /* Offered only where the door can forget: a door with no removal never parks one. */
      if (!forgetMailbox) return outcome;
      const first = cursor.path[0] ?? "mailbox";
      const ok = await writes.run(
        async () => {
          await forgetMailbox(act.mailboxId).catch((thrown: unknown) => {
            a.setForgetRefused(true);
            return factorOr("forgetStepUp")(thrown);
          });
          outcome = { ok: true };
        },
        undefined,
        { stayOnFailure: true },
      );
      if (ok) goTo(first);
    }
    return outcome;
  };
}

export function useStageActions(a: StageActionsInput): StageActions {
  const { input, mailboxId, facts, cursor, writes, gated, agree, wait, decide } = a;
  const { verbs, door } = input;
  const rerun = input.how === "again";
  const goTo = (next: OnboardingStep): void => {
    a.setConfirm(null);
    writes.clear();
    gated.withdraw();
    cursor.setAt(next);
  };
  const forward = (): void => {
    if (cursor.next) goTo(cursor.next);
  };
  const close = (): void => {
    void writes.run(() => verbs.complete()).then(() => input.leave());
  };
  const aiOffered = AI_OFFERED[door](verbs.selfhostAi === true);
  return {
    send: gatedSender(a, goTo),
    goTo,
    forward,
    close,
    away: () => input.leave(),
    escape: () => a.setConfirm((c) => (c === "cancel" ? null : "cancel")),
    restart: () => {
      a.setForgetRefused(false);
      if (mailboxId !== null) a.setConfirm("restart");
      else goTo(cursor.path[0] ?? "mailbox");
    },
    keep: () => goTo("mailbox"),
    resume: () => verbs.resume?.(),
    canForget: verbs.forgetMailbox !== undefined,
    forget: () => {
      if (verbs.forgetMailbox && mailboxId !== null) gated.press({ verb: "forget", mailboxId });
    },
    agree: () => {
      if (mailboxId === null || wait.awaiting) return;
      const act = agree.agreeAct();
      if (act !== null) gated.press(act);
    },
    answerClaim: () => {
      const choice = agree.choice;
      if (choice === null) return;
      /* "Just read it here" writes nothing about organizing: the run finishes on the reader's summary. */
      if (choice === "read") {
        cursor.answerClaim();
        return goTo("summary");
      }
      /* In a first run the window's press is what claims; only a consented mailbox claims at once. */
      if (!facts.mailbox?.organizeConsentedAt) {
        cursor.answerClaim();
        return forward();
      }
      /* Leave the claim question standing while the takeover waits for the door's answer. */
      const act = agree.takeoverAct();
      if (act !== null) gated.press(act);
    },
    aiOffered,
    answerAi: (yes) => {
      const on = yes && aiOffered;
      const setAi = verbs.setAiEnabled;
      if (!setAi) return forward();
      /* The one place a cursor is kept past a write: "no" on a door whose answer rests false would be asked again. */
      const keep = rerun
        ? on && MODEL_STEP[door]
          ? ("provider" as const)
          : ("summary" as const)
        : on || facts.mailbox === null || importOverOf(facts.mailbox)
          ? undefined
          : ("pull" as const);
      void writes.run(() => setAi(on), keep);
    },
    decide: (to, markRead) => {
      decide.decide(to, markRead);
      /* FORWARD, NOT RE-DERIVED: the guided step is one decision; the rest of the queue is the Screener's. */
      goTo("summary");
    },
    connected: (id) => {
      void writes.run(async () => {
        /* WHICH ROW THE REST OF AN ADD RUN IS ABOUT, and only there: a first run's new row is its only row. */
        if (input.how === "add") input.name(id, "replace");
      });
    },
    choose: (id) => input.name(id, "push"),
  };
}
