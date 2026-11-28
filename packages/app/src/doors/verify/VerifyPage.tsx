/**
 * THE EMAIL CONFIRMATION. The page the verification mail opens: the link proves the address, the password proves the
 * account, so a click alone confirms nothing and the page asks for the password, a blank in its sentence as the design
 * draws it (where the link brought no code, the code is the first sentence's blank). It says why the password is
 * asked, or it would read as a phishing page. Every dead link is one sentence, the shell's. Everything the ceremony
 * does is the door's; the link's code never reaches the page. Its words are the `verify` namespace's.
 */
import { useRef, useState, type ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText, type Text } from "../../text/index.js";
import { DoorForm } from "../stage/DoorForm.js";
import { refusalOf, SignOutAgain } from "../stage/pending.js";
import { Said, SaidWith } from "../../text/Said.js";
import { SentenceBlank } from "../../text/SentenceBlank.js";
import type { VerifyDoor, VerifyField, VerifyState } from "./door.js";

export function VerifyPage({ door }: { door: VerifyDoor | None }): ReactNode {
  const verify = useText("verify");
  const state: VerifyState = door === NONE ? { at: "unavailable" } : door.state;
  switch (state.at) {
    case "unavailable":
      return (
        <Page line={[{ note: verify("unavailableBody") }]} acts={null}>
          <Said text={verify("unavailableTitle")} dot="ink" />
        </Page>
      );
    case "done":
      return (
        <Page
          line={verify("doneBody")}
          acts={
            <Button size="l" onPress={(door as VerifyDoor).signIn}>
              {verify("signInDone")}
            </Button>
          }
        >
          <Said text={verify(state.already ? "alreadyConfirmedTitle" : "doneTitle")} dot="ink" />
        </Page>
      );
    case "handed":
      /* No control here: the setup goes on in the other tab, and a second one would start a second wizard. */
      return (
        <Page line={verify("handedOff")} note={verify("handedNote")} acts={null}>
          <Said text={verify("doneTitle")} dot="ink" />
          {/* Said as it appears, as the shipped page announced it. */}
          <p className="way-unseen" role="status">
            {verify("handedOff")}
          </p>
        </Page>
      );
    case "form":
      return <VerifyForm door={door as VerifyDoor} state={state} verify={verify} />;
  }
}

function VerifyForm(p: {
  door: VerifyDoor;
  state: Extract<VerifyState, { at: "form" }>;
  verify: Text;
}): ReactNode {
  const { door, state, verify } = p;
  const { fields, pending } = door;
  /* A dead link: its code was dropped, and the sign-in sends a new one. Confirm stays off over it, as it always has. */
  const dead = !state.asksCode && !state.codeHeld;
  /* The blank a press found empty says it is wanted: nothing leaves half filled. */
  const [wanted, setWanted] = useState<VerifyField | null>(null);
  const code = useRef<HTMLInputElement | null>(null);
  const password = useRef<HTMLInputElement | null>(null);
  const type = (field: VerifyField, value: string): void => {
    if (field === wanted) setWanted(null);
    door.type(field, value);
  };
  const press = (): void => {
    if (dead || state.busy || pending.signingOut) return;
    const missing: VerifyField | null =
      state.asksCode && fields.code.trim() === "" ? "code" : fields.password === "" ? "password" : null;
    setWanted(missing);
    if (missing === null) door.submit();
    else (missing === "code" ? code : password).current?.focus();
  };
  const passwordBlank = (
    <SentenceBlank
      ref={password}
      label={verify("passwordLabel")}
      placeholder={verify("typeIt")}
      size={verify("typeIt").length}
      type="password"
      autoComplete="current-password"
      value={fields.password}
      refused={wanted === "password" || state.passwordRefused}
      onChange={(v) => type("password", v)}
    />
  );
  return (
    <DoorForm onSubmit={press}>
      <Page
        refusal={refusalOf(pending, state.refusal)}
        line={verify("line")}
        note={state.asksCode ? verify("reopenLink") : undefined}
        acts={
          <>
            <Button type="submit" size="l" keyHint="↵" disabled={dead || state.busy || pending.signingOut}>
              {state.busy ? verify("working") : verify("confirm")}
            </Button>
            <SignOutAgain pending={pending} busy={state.busy} />
            {/* The refusal over a dead link names the sign-in as the way to a new link; this is the control for it. */}
            <Button kind="quiet" size="l" onPress={door.newLink}>
              {verify("signIn")}
            </Button>
          </>
        }
      >
        {/* Where the link brought no code: somebody typed the address by hand, or a mail client cut it. */}
        {state.asksCode ? (
          <>
            <SaidWith
              parts={verify.rich("codeIs", {
                blank: () => (
                  <SentenceBlank
                    ref={code}
                    label={verify("tokenLabel")}
                    placeholder={verify("pasteIt")}
                    size={verify("pasteIt").length}
                    value={fields.code}
                    refused={wanted === "code"}
                    onChange={(v) => type("code", v)}
                  />
                ),
              })}
            />
            <SaidWith parts={verify.rich("passwordIs", { blank: () => passwordBlank })} />
          </>
        ) : (
          <SaidWith parts={verify.rich("confirmWith", { blank: () => passwordBlank })} />
        )}
      </Page>
    </DoorForm>
  );
}
