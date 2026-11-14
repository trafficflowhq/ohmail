/**
 * THE STAGE'S SMALL PARTS, composed from the kit: how far the run is, the foot's verbs and the two questions, which
 * are the kit's dialog. A page's sentence is the kit's `Sentence` handed whole. No look of their own; their placement
 * is `placement.css`.
 */
import type { ReactNode } from "react";
import { Button, Dialog, StepDots } from "@ohmail/ui/base";
import type { OnboardingDoor } from "@ohmail/app-logic/doors/onboarding";
import type { Said as SaidLine } from "@ohmail/app-logic/mailboxes/connect/refusal";
import type { FirstRun } from "@ohmail/app-logic/mailboxes/first-run/use-first-run";
import type { ConnectWire, HostCapabilities, None } from "../../host/index.js";
import type { FirstRunSlots } from "./slots.js";
import type { Say } from "./words.js";

/** What every step is handed: the run's model, the reader, and the host's answers it draws by. */
export interface StepProps {
  readonly run: FirstRun;
  readonly say: Say;
  readonly door: OnboardingDoor;
  readonly service: HostCapabilities["service"];
  readonly slots: FirstRunSlots;
  /** The connect form's wire: the host's `wires.connect`. */
  readonly connect: ConnectWire | None;
}

/**
 * A step's lead, as the page's line in its plain part: what explains the step, under what it needs. The kit's page
 * draws a note only under a line, so a lead that stands alone is handed as the line's own plain part.
 */
export const leadOf = (text: string): readonly [{ readonly note: string }] => [{ note: text }];

/** A refusal or a sentence of the one table, in words: the catalogue's, or the server's own. */
export function wordsOf(said: SaidLine, say: Say): string {
  return "server" in said
    ? said.server
    : say(`${said.ns}.${said.key}`, said.values ? { ...said.values } : undefined);
}

/** How far the run is: the kit's dots, a dot a phase, said as one sentence ("Step 2 of 5, Mailbox"). */
export function Progress({ run, say }: { run: FirstRun; say: Say }): ReactNode {
  const { rail, railAt } = run.cursor;
  const phase = say(`onboarding.rail_${rail[railAt]?.id ?? "mailbox"}`);
  return (
    <StepDots
      label={say("onboarding.railSaid", { n: railAt + 1, total: rail.length, phase })}
      steps={rail.length}
      at={railAt}
    />
  );
}

/** The step's refusal lines: its own write's, or a factor that landed after Cancel and ran nothing. */
export function refusalOf(run: FirstRun, say: Say): readonly [string] | undefined {
  if (run.gated.state.nothingRan) return [say("mailboxes.cancelledNothingChanged")];
  const problem = run.confirm === "restart" && run.forgetRefused ? null : run.writes.problem;
  return problem === null ? undefined : [wordsOf(problem, say)];
}

/**
 * THE FOOT, the same on every screen: the step's one forward verb, Back where the walk has one, and the two verbs that
 * ask before they act (Close setup, Start over). `cancel: false` where leaving is the step's own verb.
 */
export function Foot(p: {
  run: FirstRun;
  say: Say;
  primary?: ReactNode;
  back?: boolean;
  cancel?: boolean;
}): ReactNode {
  const { run, say } = p;
  const busy = run.writes.busy;
  return (
    <div className="mbx-run-acts">
      {p.primary}
      {p.back && run.cursor.back ? (
        <Button kind="two" disabled={busy} onPress={() => run.acts.goTo(run.cursor.back!)}>
          {say("onboarding.back")}
        </Button>
      ) : null}
      {p.cancel === false ? null : (
        <Button kind="quiet" disabled={busy} keyHint="esc" onPress={() => run.setConfirm("cancel")}>
          {say("onboarding.cancel")}
        </Button>
      )}
      <Button kind="quiet" disabled={busy} onPress={run.acts.restart}>
        {say("onboarding.restart")}
      </Button>
    </div>
  );
}

/**
 * A STEP'S BODY IS A FORM so ↵ submits it: every screen has exactly one forward verb, and it is this one. No step's
 * verb runs while a write is on its way or while a question stands over the step.
 */
export function StepForm({
  run,
  submit,
  children,
}: {
  run: FirstRun;
  submit: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <form
      className="mbx-run-step"
      tabIndex={-1}
      onSubmit={(event) => {
        event.preventDefault();
        if (!run.writes.busy && run.confirm === null) submit();
      }}
    >
      {children}
    </form>
  );
}

/** The step's one forward verb: it submits the step's form, so ↵ presses it. */
export function Next({ label, disabled }: { label: string; disabled?: boolean }): ReactNode {
  return (
    <Button kind="ink" size="l" type="submit" keyHint="↵" disabled={disabled}>
      {label}
    </Button>
  );
}

/**
 * Both destructive verbs ask first, as the kit's dialog: the question by its name, what it does in one line, the
 * answer that does it, Forget where the door can forget, and Back. Asked, it takes the keys on its first answer that
 * can be pressed and keeps them; Escape and Back take it back, and the keys go back to where the person was. Keyed
 * by the question, so one that gives way to the other is asked anew. Nothing agreed is not "what you agreed to stays
 * agreed".
 */
export function Confirms({ run, say }: { run: FirstRun; say: Say }): ReactNode {
  const busy = run.writes.busy;
  const back = { label: say("onboarding.back"), keyHint: "Esc" };
  const takeBack = (): void => run.setConfirm(null);
  if (run.confirm === "cancel") {
    const mb = run.facts.mailbox;
    return (
      <Dialog
        key="cancel"
        open
        onClose={takeBack}
        title={say("onboarding.cancel")}
        hot
        line={say(
          mb && !mb.organizeConsentedAt ? "onboarding.cancelWhatNothingAgreed" : "onboarding.cancelWhat",
        )}
        confirm={{
          label: say("onboarding.cancelConfirm"),
          onPress: run.acts.close,
          disabled: busy,
          keyHint: "↵",
        }}
        cancel={back}
      />
    );
  }
  if (run.confirm !== "restart") return null;
  const problem = run.forgetRefused ? run.writes.problem : null;
  return (
    <Dialog
      key="restart"
      open
      onClose={takeBack}
      title={say("onboarding.restart")}
      hot
      line={say("onboarding.restartWhat")}
      confirm={{ label: say("onboarding.restartKeep"), onPress: run.acts.keep, disabled: busy, keyHint: "↵" }}
      {...(run.mailbox !== null && run.acts.canForget
        ? { second: { label: say("onboarding.restartForget"), onPress: run.acts.forget, disabled: busy } }
        : {})}
      {...(problem ? { said: { line: wordsOf(problem, say), refused: true } } : {})}
      cancel={back}
    />
  );
}
