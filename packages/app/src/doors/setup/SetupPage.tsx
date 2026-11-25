/**
 * SERVER SETUP. The page a server opens with while nobody has an account on it: it asks the server first, then for
 * the token the server printed in its own log and the first account, in one press: two sentences with their blanks,
 * at the first of the account's steps, as the design draws them. Where the token is read stands beside them on a
 * sheet, with the command and its Copy. Everything the ceremony does is the door's; the page draws the blanks and
 * says what the state says. Its words are the `setup` namespace's.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText, type Text } from "../../text/index.js";
import { AccountSentence, accountWanted, useWanted } from "../stage/AccountSentence.js";
import { DoorSheet } from "../stage/DoorSheet.js";
import { DoorForm } from "../stage/DoorForm.js";
import { Said, SaidWith } from "../../text/Said.js";
import { SentenceBlank } from "../../text/SentenceBlank.js";
import { Steps } from "../stage/Steps.js";
import type { SetupDoor, SetupField, SetupState } from "./door.js";
import "./placement.css";

/** Where the token is read: a command, not a sentence, so it is the same in every language. */
const LOG_COMMAND = "docker compose logs api";
/** How long Copy says it copied. */
const COPIED_MS = 1800;

/** Where the token is: the command that reads the server's log, its Copy, and how to find the token in it. */
function TokenWhere({ door, setup }: { door: SetupDoor; setup: Text }): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = (): void => {
    void door.copy(LOG_COMMAND).then((ok) => setCopied(ok));
  };
  return (
    <DoorSheet kind="facts">
      <h3 className="way-sheet-title">{setup("tokenWhere")}</h3>
      <p className="way-setup-cmd">
        <code className="way-setup-code">{LOG_COMMAND}</code>
        <Button kind="quiet" size="s" icon={copied ? "check" : undefined} onPress={copy}>
          {copied ? setup("copied") : setup("copy")}
        </Button>
      </p>
      <p className="way-fine">{setup("tokenFine")}</p>
    </DoorSheet>
  );
}

export function SetupPage({ door }: { door: SetupDoor | None }): ReactNode {
  const setup = useText("setup");
  const gate = useText("gate");
  /* No server behind this build: there is nothing to set up. */
  if (door === NONE)
    return (
      <Page acts={null}>
        <Said text={gate("lede")} />
      </Page>
    );
  const { state } = door;
  switch (state.at) {
    case "checking":
      return (
        <div className="way-live" aria-busy="true" aria-live="polite">
          <Page acts={null}>
            <Said text={setup("checking")} />
          </Page>
        </div>
      );
    case "unreachable":
      return (
        <Page
          line={setup("unreachableBody")}
          acts={
            <Button size="l" onPress={door.retry}>
              {setup("retry")}
            </Button>
          }
        >
          <Said text={setup("unreachableTitle")} />
        </Page>
      );
    case "settled":
      return (
        <Page
          line={setup("settledBody")}
          acts={
            <Button size="l" onPress={door.signIn}>
              {setup("signIn")}
            </Button>
          }
        >
          <Said text={setup("settledTitle")} dot="ink" />
        </Page>
      );
    case "form":
      return <SetupForm door={door} state={state} setup={setup} />;
  }
}

const BLANKS: readonly SetupField[] = ["token", "name", "email", "password"];

function SetupForm(p: {
  door: SetupDoor;
  state: Extract<SetupState, { at: "form" }>;
  setup: Text;
}): ReactNode {
  const { door, state, setup } = p;
  const { fields } = door;
  /* The blank a press found not ready says it is wanted, as the old form's own checks held a press. */
  const { wanted, want, typed, at } = useWanted(BLANKS);
  const type = (field: SetupField, value: string): void => {
    typed(field);
    door.type(field, value);
  };
  const press = (): void => {
    if (state.busy) return;
    const missing = fields.token.trim() === "" ? "token" : accountWanted(fields);
    want(missing);
    if (missing === null) door.submit();
  };
  return (
    <DoorForm onSubmit={press}>
      <Page
        columns={2}
        stack
        smaller
        /* The page's name, as the shipped page named it, at its top where the design leaves the room empty. */
        aside={<Steps said={setup("progress")} part="1/3" />}
        refusal={state.refusal === null ? undefined : [state.refusal]}
        material={<TokenWhere door={door} setup={setup} />}
        line={setup("signInHere")}
        acts={
          <Button type="submit" size="l" keyHint="↵" disabled={state.busy}>
            {state.busy ? setup("working") : setup("createAccount")}
          </Button>
        }
      >
        <SaidWith
          parts={setup.rich("tokenIs", {
            blank: () => (
              <SentenceBlank
                ref={at.token}
                label={setup("tokenLabel")}
                placeholder={setup("tokenBlank")}
                size={setup("tokenBlank").length}
                value={fields.token}
                refused={wanted === "token" || state.tokenRefused}
                onChange={(v) => type("token", v)}
              />
            ),
          })}
        />
        <AccountSentence t={setup} lengthHint="minimum" fields={fields} wanted={wanted} at={at} type={type} />
      </Page>
    </DoorForm>
  );
}
