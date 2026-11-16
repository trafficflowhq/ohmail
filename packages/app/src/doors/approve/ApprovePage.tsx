/**
 * A COMPUTER ASKS TO BE SIGNED IN. The page names it in its sentence, in the words it gave for itself; under it, as
 * small facts, what it runs, when and from where it asked, and the account the confirm binds; then the one line that
 * matters and the server's own countdown; Confirm and Not me. A stale second factor is asked over the page by the one
 * dialog, and the confirm runs once it verifies. It holds no address and no request id: every press is the door's.
 */
import type { ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText, type Text } from "../../text/index.js";
import { clock } from "../stage/clock.js";
import { ColdMark } from "../stage/ColdMark.js";
import { Break, DoorLine, Fact, Heavy, Note } from "../stage/DoorLine.js";
import { Said, SaidWith } from "../stage/Said.js";
import { StepUpDialog } from "../step-up/StepUpDialog.js";
import type { ApproveAsked, ApproveDoor, ApproveState } from "./door.js";

/** When and from where it asked: a network class, never an address, and nothing where the server named none. */
function whenOf(asked: ApproveAsked, t: Text): string {
  if (asked.network === null)
    return asked.minutes < 1
      ? t("requestedJustNowNoNetwork")
      : t("requestedMinutesAgoNoNetwork", { minutes: asked.minutes });
  return asked.minutes < 1
    ? t("requestedJustNow", { network: asked.network })
    : t("requestedMinutesAgo", { minutes: asked.minutes, network: asked.network });
}

/** One or two sentences under the page's sentence, as the kit's page takes them. */
const refusalOf = (said: (string | null)[]): readonly [string] | readonly [string, string] | undefined => {
  const [first, second] = said.filter((s): s is string => s !== null);
  if (first === undefined) return undefined;
  return second === undefined ? [first] : [first, second];
};

/** The page's line where there is a computer to confirm: its facts, the line that matters, and the time left. */
function AskLine({ state, t }: { state: Extract<ApproveState, { at: "ask" }>; t: Text }): ReactNode {
  const { asked } = state;
  return (
    <DoorLine>
      {asked.platform !== null ? <Fact>{asked.platform}</Fact> : null}
      <Fact>{whenOf(asked, t)}</Fact>
      {asked.account !== null ? <Fact>{t("signsIn", { email: asked.account })}</Fact> : null}
      <Break />
      <Heavy>{t("onlyYours")}</Heavy>
      <Break />
      {/* A busy server's wait stands where the time left stands: Confirm stays live meanwhile. */}
      <Fact>
        {state.retryIn !== null
          ? t("busyRetrying", { seconds: state.retryIn })
          : t("left", { time: clock(asked.remaining) })}
      </Fact>
    </DoorLine>
  );
}

function Ask({
  door,
  state,
  t,
}: {
  door: ApproveDoor;
  state: Extract<ApproveState, { at: "ask" }>;
  t: Text;
}): ReactNode {
  const { asked } = state;
  const waiting = state.retryIn !== null;
  return (
    <>
      <Page
        back={<ColdMark />}
        refusal={refusalOf([asked.otherNetwork ? t("otherNetwork") : null, state.refusal])}
        material={<AskLine state={state} t={t} />}
        acts={
          <>
            <Button size="l" onPress={door.confirm} disabled={state.busy && !waiting}>
              {state.busy && !waiting ? t("working") : t("confirm")}
            </Button>
            <Button kind="two" size="l" onPress={door.deny} disabled={state.busy}>
              {t("deny")}
            </Button>
          </>
        }
      >
        {asked.label === null ? (
          <Said text={t("title")} />
        ) : (
          /* The computer's name stands whole, as the computer gave it: drawn as text, never as markup. */
          <SaidWith
            parts={t.rich("titleOn", {
              computer: asked.label,
              name: (chunks: ReactNode) => <span className="way-nb">{chunks}</span>,
            })}
          />
        )}
      </Page>
      {/* The wait is said as it counts, as the shipped page did; the tag shows it. */}
      {waiting ? (
        <p className="way-unseen" role="status">
          {t("busyRetrying", { seconds: state.retryIn ?? 0 })}
        </p>
      ) : null}
      {state.factor ? <StepUpDialog door={door.stepUp} {...door.factor} /> : null}
    </>
  );
}

export function ApprovePage({ door }: { door: ApproveDoor | None }): ReactNode {
  const t = useText("approve");
  const back = <ColdMark />;
  if (door === NONE)
    return (
      <Page back={back} line={t("unavailableBody")} acts={null}>
        <Said text={t("unavailableTitle")} />
      </Page>
    );
  const { state } = door;
  const title = <Said text={t("title")} />;
  switch (state.at) {
    case "closed":
      return (
        <Page back={back} material={<DoorLine>{<Note>{t("notOffered")}</Note>}</DoorLine>} acts={null}>
          <Said text={t("unavailableTitle")} dot="ink" />
        </Page>
      );
    case "bare":
      return (
        <Page back={back} line={t("missing")} acts={null}>
          {title}
        </Page>
      );
    case "checking":
      return (
        <div className="way-live" aria-busy="true" aria-live="polite">
          <Page
            back={back}
            line={state.retryIn === null ? t("working") : t("busyRetrying", { seconds: state.retryIn })}
            acts={null}
          >
            {title}
          </Page>
        </div>
      );
    case "unchecked":
      return (
        <Page back={back} refusal={[t("signInUnchecked")]} acts={null}>
          {title}
        </Page>
      );
    case "refused":
      return (
        <Page back={back} refusal={[state.said]} acts={null}>
          {title}
        </Page>
      );
    case "gone":
      return (
        <Page back={back} refusal={[state.said ?? t("expired")]} acts={null}>
          {title}
        </Page>
      );
    case "done":
      return (
        <Page back={back} line={t("doneBody")} note={t("doneNote")} acts={null}>
          <Said text={t("doneTitle")} dot="ink" />
        </Page>
      );
    case "denied":
      return (
        <Page back={back} line={t("deniedBody")} acts={null}>
          <Said text={t("deniedTitle")} dot="ink" />
        </Page>
      );
    case "ask":
      return <Ask door={door} state={state} t={t} />;
  }
}
