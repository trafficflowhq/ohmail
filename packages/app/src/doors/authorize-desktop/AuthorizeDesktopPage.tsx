/**
 * AN APP ASKS TO BE SIGNED IN. The page's sentence names the app and the account (masked by the server: the page may
 * be shared or photographed); beside it, on a sheet, what the app may do; under it the server's own countdown and the
 * line that nothing is signed in before the press. A stale second factor is asked over the page by the one dialog. It
 * holds no address and no handle: the press and the app's own address are the door's.
 */
import type { ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText, type Text } from "../../text/index.js";
import { clock } from "../stage/clock.js";
import { Facts } from "../stage/DoorSheet.js";
import { Break, DoorLine, Fact, Heavy, Note, useLinePlace } from "../stage/DoorLine.js";
import { Address, Said, SaidWith } from "../stage/Said.js";
import { StepUpDialog } from "../step-up/StepUpDialog.js";
import type { AuthorizeDesktopDoor, AuthorizeDesktopState } from "./door.js";

/** The app names this deployment has words for. Anything else is shown as the app said it. */
const KNOWN_CLIENTS = new Set(["tf-macos"]);

function Ask(p: {
  door: AuthorizeDesktopDoor;
  state: Extract<AuthorizeDesktopState, { at: "ask" }>;
  t: Text;
}): ReactNode {
  const { door, state, t } = p;
  const left = useText("approve");
  const place = useLinePlace();
  const app = KNOWN_CLIENTS.has(state.client) ? t(`client.${state.client}`) : state.client;
  const line = (
    <DoorLine place={place}>
      <Fact>{left("left", { time: clock(state.remaining) })}</Fact>
      <Break />
      <Heavy>{t("footer")}</Heavy>
      <Note>{t("safety")}</Note>
    </DoorLine>
  );
  return (
    <>
      <Page
        columns={2}
        refusal={state.refusal === null ? undefined : [state.refusal]}
        material={
          <>
            <Facts items={[t("grantsMail"), t("grantsLong"), t("grantsRevoke")]} />
            {place === "after" ? line : null}
          </>
        }
        acts={
          <>
            {place === "acts" ? line : null}
            <Button size="l" onPress={door.confirm} disabled={state.busy}>
              {state.busy ? t("working") : t("confirm")}
            </Button>
          </>
        }
      >
        <SaidWith
          parts={t.rich("titleAs", {
            app,
            address: state.address,
            a: (chunks: ReactNode) => <Address value={String(chunks)} />,
          })}
        />
      </Page>
      {state.factor ? <StepUpDialog door={door.stepUp} {...door.factor} /> : null}
    </>
  );
}

export function AuthorizeDesktopPage({ door }: { door: AuthorizeDesktopDoor | None }): ReactNode {
  const t = useText("authorizeDesktop");
  /* The sign-in's title is the way on's label; the could-not-check sentence is the approval's, signing in first the link's. */
  const login = useText("login");
  const link = useText("linkDesktop");
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
          refusal={[link("signInFirst")]}
          acts={
            <Button size="l" onPress={door.signIn}>
              {login("title")}
            </Button>
          }
        >
          <Said text={t("expiredTitle")} />
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
    case "over":
      return (
        /* Why it is over is said under its line; a sentence the shell said of its own stands above it. */
        <Page
          refusal={state.said === null || state.said === t("expired") ? undefined : [state.said]}
          line={t("expiredHint")}
          note={t("overWhy")}
          acts={null}
        >
          <Said text={t("expiredTitle")} />
        </Page>
      );
    case "done":
      return (
        <Page line={t("doneBody")} acts={null}>
          <Said text={t("doneTitle")} dot="ink" />
        </Page>
      );
    case "ask":
      return <Ask door={door} state={state} t={t} />;
  }
}
