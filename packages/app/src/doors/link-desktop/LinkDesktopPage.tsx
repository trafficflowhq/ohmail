/**
 * THE APP ON A COMPUTER NEEDS A CODE. The press makes one (never the page's load); the page says it in its sentence,
 * where a person reads and carries it, says that it works once and how long it has left, and removes it at zero. Only
 * a code the app bound may be handed back to it directly. A stale second factor is asked over the page by the one
 * dialog. The code lives in the page's text and nowhere else: no title, no attribute.
 */
import type { ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText, type Text } from "../../text/index.js";
import { clock } from "../stage/clock.js";
import { Break, DoorLine, Fact, Heavy, Note } from "../stage/DoorLine.js";
import { Said, SaidWith } from "../../text/Said.js";
import { StepUpDialog } from "../step-up/StepUpDialog.js";
import type { LinkDesktopDoor, LinkDesktopPress, LinkDesktopState } from "./door.js";

/** Why the last press made no code, in the order the old card said it: its refusal, the discarded factor, sign in. */
function refusalOf(
  press: LinkDesktopPress,
  t: Text,
): readonly [string] | readonly [string, string] | undefined {
  const said = [
    press.refusal,
    press.discarded ? t("cancelledNothingMinted") : null,
    press.signIn ? t("signInFirst") : null,
  ].filter((s): s is string => s !== null);
  const [first, second] = said;
  if (first === undefined) return undefined;
  return second === undefined ? [first] : [first, second];
}

type Live = Extract<LinkDesktopState, { at: "start" | "code" }>;

/** The page's line: the code's facts or a busy server's wait as tags where there are any, then what to do with it. */
function Line({ state, t, left }: { state: Live; t: Text; left: Text }): ReactNode {
  const heavy = state.at === "code" && state.bound ? t("fallback") : t("typeIt");
  const facts = [
    ...(state.at === "code" ? [t("once"), left("left", { time: clock(state.remaining) })] : []),
    /* A busy server's wait: the button stays live meanwhile, and a press asks again now. */
    ...(state.retryIn !== null ? [t("busyRetrying", { seconds: state.retryIn })] : []),
  ];
  return (
    <DoorLine>
      {facts.map((fact) => (
        <Fact key={fact}>{fact}</Fact>
      ))}
      {facts.length > 0 ? <Break /> : null}
      <Heavy>{heavy}</Heavy>
      <Note>{t("safety")}</Note>
    </DoorLine>
  );
}

function LivePage({ door, state, t }: { door: LinkDesktopDoor; state: Live; t: Text }): ReactNode {
  const approve = useText("approve");
  const login = useText("login");
  const working = state.busy && state.retryIn === null;
  const signIn = state.signIn ? (
    <Button size="l" onPress={door.signIn}>
      {login("title")}
    </Button>
  ) : null;
  const acts =
    state.at === "code" ? (
      <>
        {state.bound ? (
          <Button size="l" onPress={door.openApp}>
            {t("openApp")}
          </Button>
        ) : null}
        <Button kind={state.bound ? "quiet" : "two"} size="l" onPress={door.press} disabled={working}>
          {working ? t("working") : t("again")}
        </Button>
      </>
    ) : (
      <>
        {signIn}
        <Button kind={state.signIn ? "two" : "ink"} size="l" onPress={door.press} disabled={working}>
          {working ? t("working") : t("mint")}
        </Button>
      </>
    );
  return (
    <>
      <Page refusal={refusalOf(state, t)} material={<Line state={state} t={t} left={approve} />} acts={acts}>
        {state.at === "code" ? (
          <SaidWith
            parts={t.rich("codeIs", {
              code: state.code,
              c: (chunks: ReactNode) => (
                <span className="way-code" aria-live="polite">
                  {chunks}
                </span>
              ),
            })}
          />
        ) : (
          <Said text={t("title")} />
        )}
      </Page>
      {/* The wait is said as it counts, as the shipped page did; the tag shows it. */}
      {state.retryIn !== null ? (
        <p className="way-unseen" role="status">
          {t("busyRetrying", { seconds: state.retryIn })}
        </p>
      ) : null}
      {state.factor ? <StepUpDialog door={door.stepUp} {...door.factor} /> : null}
    </>
  );
}

export function LinkDesktopPage({ door }: { door: LinkDesktopDoor | None }): ReactNode {
  const t = useText("linkDesktop");
  /* The sign-in's title is the way on's label; the could-not-check sentence is the approval's. */
  const login = useText("login");
  const approve = useText("approve");
  if (door === NONE)
    return (
      <Page line={t("unavailableBody")} acts={null}>
        <Said text={t("unavailableTitle")} />
      </Page>
    );
  const { state } = door;
  const title = <Said text={t("title")} />;
  switch (state.at) {
    case "checking":
      return (
        <div className="way-live" aria-busy="true" aria-live="polite">
          <Page line={t("working")} acts={null}>
            {title}
          </Page>
        </div>
      );
    case "signin":
      return (
        <Page
          refusal={[t("signInFirst")]}
          acts={
            <Button size="l" onPress={door.signIn}>
              {login("title")}
            </Button>
          }
        >
          {title}
        </Page>
      );
    case "unchecked":
      return (
        <Page refusal={[approve("signInUnchecked")]} acts={null}>
          {title}
        </Page>
      );
    case "refused":
      return (
        <Page refusal={[state.said]} acts={null}>
          {title}
        </Page>
      );
    case "start":
    case "code":
      return <LivePage door={door} state={state} t={t} />;
  }
}
