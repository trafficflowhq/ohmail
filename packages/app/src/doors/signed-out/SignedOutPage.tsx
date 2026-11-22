/**
 * SIGNED OUT, AND COMING BACK. The page that stands where a session cannot be used: while the sign-in is renewed,
 * when the server cannot be reached, when the sign-in cannot be renewed and why, and the two cold cards (nothing was
 * loaded; the check did not finish). It asks nothing itself; every way on is the door's. No key hint stands on its
 * buttons: the page has no field, so Enter presses only the button that has the focus.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText } from "../../text/index.js";
import { ColdMark } from "../stage/ColdMark.js";
import { REASON_SAID } from "../stage/reasons.js";
import { Said } from "../stage/Said.js";
import type { SignedOutDoor } from "./door.js";
export function SignedOutPage({
  door,
  links,
}: {
  door: SignedOutDoor | None;
  links?: { signIn: string; demo?: string };
}): ReactNode {
  const resume = useText("resume");
  const session = useText("session");
  const gate = useText("gate");
  const retry = useRef<HTMLButtonElement>(null);
  const focusRetry = links !== undefined && door !== NONE && door.state.at === "unchecked";
  useEffect(() => {
    if (focusRetry) retry.current?.focus();
  }, [focusRetry]);
  /* No server behind this build: there is no sign-in to renew, and nothing to press. */
  if (door === NONE)
    return (
      <Page back={<ColdMark />} acts={null}>
        <Said text={gate("lede")} />
      </Page>
    );
  const { state } = door;
  const signIn = (words: string, kind?: "two") =>
    links === undefined ? (
      <Button size="l" kind={kind} onPress={door.signIn}>
        {words}
      </Button>
    ) : (
      <Button size="l" kind={kind} href={links.signIn}>
        {words}
      </Button>
    );
  switch (state.at) {
    case "checking":
      /* Below the loading grace the page says nothing: a sentence that flashes is worse than a quiet page. */
      return (
        <div className="way-live" aria-busy="true" aria-live="polite">
          <Page back={<ColdMark />} acts={null}>
            {state.slow ? <Said text={resume("workingBody")} /> : null}
          </Page>
        </div>
      );
    case "busy":
      return (
        <Page
          back={<ColdMark />}
          line={resume("busyBody")}
          acts={
            <Button size="l" onPress={door.tryAgain}>
              {resume("tryAgain")}
            </Button>
          }
        >
          <Said text={resume("busyTitle")} />
        </Page>
      );
    case "signedOut":
      /* A sign-in used twice is a refusal to read, not a line: it says what may have happened and what to do. */
      return state.reason === "reused" ? (
        <Page back={<ColdMark />} refusal={[resume(REASON_SAID.reused)]} acts={signIn(resume("signIn"))}>
          <Said text={resume("failedTitle")} />
        </Page>
      ) : (
        <Page back={<ColdMark />} line={resume(REASON_SAID[state.reason])} acts={signIn(resume("signIn"))}>
          <Said text={resume("failedTitle")} />
        </Page>
      );
    case "out": {
      const demo = door.demo;
      const toDemo =
        links?.demo !== undefined ? (
          <Button kind="quiet" size="l" href={links.demo}>
            {session("openDemo")}
          </Button>
        ) : demo === NONE ? null : (
          <Button kind="quiet" size="l" onPress={demo}>
            {session("openDemo")}
          </Button>
        );
      return (
        <Page
          line={session("endedLine")}
          note={session("endedNote")}
          acts={
            <>
              {signIn(session("signIn"))}
              {toDemo}
            </>
          }
        >
          <Said text={session("endedTitle")} level={1} />
        </Page>
      );
    }
    case "unchecked":
      return (
        <Page
          line={session(state.warm ? "unconfirmedBodyWarm" : "unconfirmedLine")}
          acts={
            <>
              <Button ref={retry} size="l" onPress={door.tryAgain}>
                {session("tryAgain")}
              </Button>
              {signIn(session("signIn"), "two")}
            </>
          }
        >
          <Said text={session("unconfirmedTitle")} level={1} />
        </Page>
      );
  }
}
