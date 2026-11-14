/**
 * THE STAGE'S SMALL PARTS, composed from the kit: the page's sentence that ends in the dot, how far the run is, the
 * foot's verbs and the two confirms in place. No look of their own; their placement is `placement.css`.
 */
import type { ReactNode } from "react";
import { Button, Dot, EndDot, Sentence } from "@ohmail/ui/base";
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
 * A page's one sentence, ending in the dot: `hot` while something waits on the person, `ink` once it is done. The
 * catalogue's sentence keeps its own punctuation: a closing full stop becomes the dot, one that ends on a word gets
 * one, one that ends on any other mark is said as it stands.
 */
export function Said({
  text,
  dot = "hot",
  id,
}: {
  text: string;
  dot?: "hot" | "ink";
  id?: string;
}): ReactNode {
  const words = text.endsWith(".") ? text.slice(0, -1) : text;
  return (
    <Sentence size="xl" level={1} {...(id === undefined ? {} : { id })}>
      {/[\p{L}\p{N}]$/u.test(words) ? <EndDot kind={dot}>{words}</EndDot> : text}
    </Sentence>
  );
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

/** How far the run is: its phases, the one it is in, and the step named once for a narrow window. */
export function Progress({ run, say }: { run: FirstRun; say: Say }): ReactNode {
  const { rail, railAt } = run.cursor;
  const label = (id: string): string => say(`onboarding.rail_${id}`);
  return (
    <div className="mbx-run-progress">
      <ol className="mbx-run-rail" aria-label={say("onboarding.rail_mailbox")}>
        {rail.map((r, i) => (
          <li key={r.id} className="mbx-run-phase" aria-current={i === railAt ? "step" : undefined}>
            <Dot kind={i < railAt ? "ink" : i === railAt ? "hot" : "todo"} />
            <span>{label(r.id)}</span>
          </li>
        ))}
      </ol>
      <p className="mbx-run-at" aria-hidden="true">
        {`${railAt + 1} / ${rail.length} · ${label(rail[railAt]?.id ?? "mailbox")}`}
      </p>
    </div>
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

/** A STEP'S BODY IS A FORM so ↵ submits it: every screen has exactly one forward verb, and it is this one. */
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
      onSubmit={(event) => {
        event.preventDefault();
        if (!run.writes.busy) submit();
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

/** Both destructive verbs confirm IN PLACE. Nothing agreed is not "what you agreed to stays agreed". */
export function Confirms({ run, say }: { run: FirstRun; say: Say }): ReactNode {
  const busy = run.writes.busy;
  const mb = run.facts.mailbox;
  if (run.confirm === "cancel")
    return (
      <div className="mbx-run-confirm" role="group" aria-label={say("onboarding.cancel")}>
        <p>
          {say(
            mb && !mb.organizeConsentedAt ? "onboarding.cancelWhatNothingAgreed" : "onboarding.cancelWhat",
          )}
        </p>
        <div className="mbx-run-acts">
          <Button kind="ink" disabled={busy} onPress={run.acts.close}>
            {say("onboarding.cancelConfirm")}
          </Button>
          <Button kind="quiet" onPress={() => run.setConfirm(null)}>
            {say("onboarding.back")}
          </Button>
        </div>
      </div>
    );
  if (run.confirm !== "restart") return null;
  const problem = run.forgetRefused ? run.writes.problem : null;
  return (
    <div className="mbx-run-confirm" role="group" aria-label={say("onboarding.restart")}>
      <p>{say("onboarding.restartWhat")}</p>
      {problem ? <p role="alert">{wordsOf(problem, say)}</p> : null}
      <div className="mbx-run-acts">
        <Button kind="ink" disabled={busy} onPress={run.acts.keep}>
          {say("onboarding.restartKeep")}
        </Button>
        {run.mailbox !== null && run.acts.canForget ? (
          <Button kind="quiet" disabled={busy} onPress={run.acts.forget}>
            {say("onboarding.restartForget")}
          </Button>
        ) : null}
        <Button kind="quiet" onPress={() => run.setConfirm(null)}>
          {say("onboarding.back")}
        </Button>
      </div>
    </div>
  );
}
