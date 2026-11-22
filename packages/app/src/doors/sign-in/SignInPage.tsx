/**
 * SIGN IN. The password, then the second factor, on the kit's Page; each step is one form, so Enter in a field presses
 * its ink button. Everything the ceremony does is the door's, the blanks as typed among it: the page draws them, hands
 * each change back, and says what the door's state says. A press with a blank empty sends nothing: the first empty
 * blank takes the keys and says it is wanted. The ways to the join and to the demo are the ways the host hands, links
 * on the web. Its words are the `login` namespace's.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, EndDot, Menu, MenuItem, Page, RefusalLine, Slot, Tag } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText, type Text } from "../../text/index.js";
import { useWanted } from "../stage/AccountSentence.js";
import { DoorLine } from "../stage/DoorLine.js";
import { Said, SaidWith } from "../stage/Said.js";
import { SentenceBlank } from "../stage/SentenceBlank.js";
import { WayButton } from "../stage/way.js";
import { SIGN_IN_REFUSAL_SAID, type SignInDoor, type SignInFactor, type SignInRefusal } from "./door.js";
import "./placement.css";

/** The words of the toggle that turns to each factor. */
const FACTOR_WORD: Readonly<Record<SignInFactor, string>> = {
  passkey: "factorPasskey",
  code: "factorCode",
  recovery: "factorRecovery",
};

type Ongoing = Exclude<SignInDoor["state"], { at: "unavailable" }>;
type Refusal = readonly [string] | readonly [string, string] | undefined;

function refusalWords(refusal: SignInRefusal, login: Text): string {
  return refusal.word === "said" ? refusal.said : login(SIGN_IN_REFUSAL_SAID[refusal.word]);
}

export function SignInPage({ door }: { door: SignInDoor | None }): ReactNode {
  const login = useText("login");
  const gate = useText("gate");
  if (door === NONE || door.state.at === "unavailable") {
    const demo = door === NONE ? NONE : door.demo;
    const acts =
      demo === NONE ? null : (
        <WayButton way={demo} size="l">
          {gate("openDemo")}
        </WayButton>
      );
    return (
      <Page line={gate("body")} note={gate("note")} acts={acts}>
        <Said text={gate("lede")} level={1} />
      </Page>
    );
  }
  const state = door.state as Ongoing;
  /* A sign-out that ended unconfirmed is said first, then the step's own refusal. */
  const said = [door.pending.said, state.refusal === null ? null : refusalWords(state.refusal, login)].filter(
    (s): s is string => s !== null,
  );
  const refusal: Refusal =
    said.length === 0 ? undefined : said.length === 1 ? [said[0]!] : [said[0]!, said[1]!];
  return state.at === "password" ? (
    <PasswordStep door={door} busy={state.busy} refusal={refusal} login={login} />
  ) : (
    <FactorStep door={door} state={state} refusal={refusal} login={login} />
  );
}

/** The password step's blanks, in the order a press asks for them. */
const BLANKS = ["email", "password"] as const;
type Blank = (typeof BLANKS)[number];
/** Each blank's sentence when a press found it empty. */
const WANTED: Readonly<Record<Blank, string>> = { email: "emailWanted", password: "passwordWanted" };

function PasswordStep(p: { door: SignInDoor; busy: boolean; refusal: Refusal; login: Text }): ReactNode {
  const { door, busy, refusal, login } = p;
  const { pending, fields } = door;
  /* The blank a press found empty takes the keys and says it is wanted: nothing leaves half filled. */
  const { wanted, want, typed, at } = useWanted(BLANKS);
  const type = (field: Blank, value: string): void => {
    typed(field);
    door.type(field, value);
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (busy || pending.signingOut) return;
    const missing: Blank | null =
      fields.email.trim() === "" ? "email" : fields.password === "" ? "password" : null;
    want(missing);
    if (missing === null) door.begin();
  };
  const errorId = useId();
  const missing = wanted === null ? null : login(WANTED[wanted]);
  return (
    <form className="way-form" onSubmit={submit}>
      <Page
        back={
          door.back === undefined ? undefined : (
            <Button kind="quiet" icon="back" label={login("back")} href={door.back} />
          )
        }
        refusal={refusal}
        line={[{ tag: login(door.note === "selfhost" ? "whereServer" : "whereCloud") }]}
        acts={
          <>
            {/* Named by its words alone, the key it prints left out: the journeys find the sign-in's Continue by
                its exact name (login.continue), as a person's screen reader says it. */}
            <Button
              type="submit"
              size="l"
              keyHint="↵"
              label={busy ? login("working") : login("continue")}
              disabled={busy || pending.signingOut}
            >
              {busy ? login("working") : login("continue")}
            </Button>
            {pending.said === null ? null : (
              <Button kind="two" size="l" disabled={busy || pending.signingOut} onPress={pending.again}>
                {pending.act}
              </Button>
            )}
            <WayButton way={door.join} kind="quiet" size="l">
              {login("createAccount")}
            </WayButton>
          </>
        }
      >
        <SaidWith
          level={1}
          parts={login.rich("iAm", {
            email: () => (
              <SentenceBlank
                ref={at.email}
                id="login-email"
                label={login("emailLabel")}
                placeholder={login("emailBlank")}
                type="email"
                autoComplete="username"
                value={fields.email}
                onChange={(v) => type("email", v)}
                refused={wanted === "email"}
                describedBy={wanted === "email" ? errorId : undefined}
              />
            ),
            password: () => (
              <SentenceBlank
                ref={at.password}
                id="login-pw"
                label={login("passwordLabel")}
                placeholder={login("credentialPrompt")}
                type="password"
                autoComplete="current-password"
                value={fields.password}
                onChange={(v) => type("password", v)}
                refused={wanted === "password"}
                describedBy={wanted === "password" ? errorId : undefined}
              />
            ),
          })}
        />
        {missing === null ? null : (
          <RefusalLine
            alert
            start
            ref={(line) => {
              if (line) line.id = errorId;
            }}
          >
            {missing}
          </RefusalLine>
        )}
      </Page>
    </form>
  );
}

function FactorStep(p: {
  door: SignInDoor;
  state: Extract<Ongoing, { at: "factor" }>;
  refusal: Refusal;
  login: Text;
}): ReactNode {
  const { door, state, refusal, login } = p;
  const { factor, offered, busy } = state;
  const { code, email } = door.fields;
  const codeField = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    codeField.current?.focus();
  }, [factor]);
  const finish = (e: FormEvent): void => {
    e.preventDefault();
    if (!busy && code.trim() !== "") door.finish();
  };
  const page = (
    <Page
      back={<Button kind="quiet" icon="back" label={login("back")} onPress={door.restart} />}
      trail={
        <DoorLine>
          <EndDot kind="ink">{login("iAmSaid", { email: email.trim() }).replace(/\.$/, "")}</EndDot>
        </DoorLine>
      }
      refusal={refusal}
      acts={
        <>
          {factor === "passkey" ? (
            <Button size="l" disabled={busy} onPress={door.passkey}>
              {busy ? login("working") : login("passkey")}
            </Button>
          ) : (
            <Button type="submit" size="l" keyHint="↵" disabled={busy || code.trim() === ""}>
              {busy ? login("working") : login("totpVerify")}
            </Button>
          )}
          <Button kind="quiet" size="l" onPress={door.restart}>
            {login("startOver")}
          </Button>
        </>
      }
    >
      <SaidWith
        level={1}
        parts={login.rich("confirmWith", {
          how: () =>
            offered.length > 1 ? (
              <Slot ref={anchor} expanded={open} onPress={() => setOpen(!open)}>
                {login(FACTOR_WORD[factor])}
              </Slot>
            ) : (
              <Tag>{login(FACTOR_WORD[factor])}</Tag>
            ),
        })}
      />
      <Menu anchor={anchor} open={open} label={login("factorMenu")} onClose={() => setOpen(false)}>
        {offered.map((choice) => (
          <MenuItem
            key={choice}
            checked={choice === factor}
            onPress={() => {
              setOpen(false);
              if (choice !== factor) door.use(choice);
            }}
          >
            {login(FACTOR_WORD[choice])}
          </MenuItem>
        ))}
      </Menu>
      {factor === "passkey" ? null : (
        <SaidWith
          parts={login.rich("codeIs", {
            blank: () => (
              <SentenceBlank
                ref={codeField}
                id="login-code"
                label={login(factor === "recovery" ? "recoveryLabel" : "totpLabel")}
                placeholder={login(factor === "recovery" ? "recoveryBlank" : "totpBlank")}
                autoComplete="one-time-code"
                inputMode={factor === "code" ? "numeric" : "text"}
                value={code}
                onChange={(v) => door.type("code", v)}
              />
            ),
          })}
        />
      )}
    </Page>
  );
  return factor === "passkey" ? (
    page
  ) : (
    <form className="way-form" onSubmit={finish}>
      {page}
    </form>
  );
}
