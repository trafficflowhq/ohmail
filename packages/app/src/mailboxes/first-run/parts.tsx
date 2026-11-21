/**
 * THE STAGE'S SMALL PARTS, composed from the kit: how far the run is, the foot's verbs and the two questions, which
 * are the kit's dialog. A page's sentence is the kit's `Sentence` handed whole. No look of their own; their placement
 * is `placement.css`.
 */
import { useRef, useState, type ReactNode } from "react";
import { Button, Dialog, Menu, MenuItem, StepDots, type PageProps } from "@ohmail/ui/base";
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
  readonly onCodeStarted?: () => void;
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

const STAGES = [
  { id: "mailbox", steps: ["mailbox", "elsewhere"] },
  { id: "organize", steps: ["consent", "window", "ai", "provider"] },
  { id: "pull", steps: ["pull"] },
  { id: "decide", steps: ["decide", "summary", "pair"] },
] as const;

function Progress({ run, say }: { run: FirstRun; say: Say }): ReactNode {
  const { step, path } = run.cursor;
  const stage = Math.max(
    0,
    STAGES.findIndex(({ steps }) => steps.some((screen) => screen === step)),
  );
  const current = STAGES[stage]!;
  const screens = path.filter((screen) => current.steps.some((candidate) => candidate === screen));
  const screen = step === null ? 0 : screens.indexOf(step) + 1;
  const hasCount = screens.length > 1 && screen > 0;
  const values = { n: stage + 1, total: STAGES.length, phase: say(`onboarding.rail_${current.id}`) };
  return (
    <StepDots
      label={
        hasCount
          ? say("onboarding.railSaidSub", { ...values, screen, screens: screens.length })
          : say("onboarding.railSaid", values)
      }
      steps={STAGES.length}
      at={stage}
      sub={hasCount ? `${screen}/${screens.length}` : undefined}
    />
  );
}

function SetupMenu({ run, say, cancel }: { run: FirstRun; say: Say; cancel: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const setup = say("onboarding.setupMenu");
  return (
    <span className="mbx-run-row">
      <Progress run={run} say={say} />
      <Button
        kind="quiet"
        size="s"
        icon="more"
        label={setup}
        ref={anchor}
        opens="menu"
        expanded={open}
        disabled={run.writes.busy}
        onPress={() => setOpen(!open)}
      />
      <Menu open={open} anchor={anchor} label={setup} onClose={() => setOpen(false)} right>
        <MenuItem
          onPress={() => {
            setOpen(false);
            run.acts.restart();
          }}
        >
          {say("onboarding.restart")}
        </MenuItem>
        {cancel ? (
          <MenuItem
            keyHint="Esc"
            onPress={() => {
              setOpen(false);
              run.setConfirm("cancel");
            }}
          >
            {say("onboarding.cancel")}
          </MenuItem>
        ) : null}
      </Menu>
    </span>
  );
}

export function stepTop(
  run: FirstRun,
  say: Say,
  { back = false, cancel = true }: { back?: boolean; cancel?: boolean } = {},
): Pick<PageProps, "back" | "aside"> {
  const previous = run.cursor.back;
  return {
    back:
      back && previous !== undefined ? (
        <Button
          kind="quiet"
          icon="back"
          label={say("onboarding.back")}
          disabled={run.writes.busy}
          onPress={() => run.acts.goTo(previous)}
        />
      ) : undefined,
    aside: <SetupMenu run={run} say={say} cancel={cancel} />,
  };
}

/** The step's refusal lines: its own write's, or a factor that landed after Cancel and ran nothing. */
export function refusalOf(run: FirstRun, say: Say): readonly [string] | undefined {
  if (run.gated.state.nothingRan) return [say("mailboxes.cancelledNothingChanged")];
  const problem = run.confirm === "restart" && run.forgetRefused ? null : run.writes.problem;
  return problem === null ? undefined : [wordsOf(problem, say)];
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
  const takeBack = (): void => {
    if (run.confirm === "restart") run.gated.withdraw("forget");
    run.setConfirm(null);
  };
  if (run.confirm === "cancel") {
    return (
      <Dialog
        key="cancel"
        open
        onClose={takeBack}
        title={say("onboarding.cancel")}
        hot
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
