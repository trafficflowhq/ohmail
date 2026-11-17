/**
 * SIGN IN. The password, then the second factor, on the kit's Page; each step is one form, so Enter in a field presses
 * its ink button. Everything the ceremony does is the door's, the blanks as typed among it: the page draws them, hands
 * each change back, and says what the door's state says. A press with a blank empty sends nothing: the first empty
 * blank takes the keys and says it is wanted. The ways to the join and to the demo are the ways the host hands, links
 * on the web. Its words are the `login` namespace's and, for a sign-out's reason, `resume`'s.
 */
import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { Button, Field, Page } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText, type Text } from "../../text/index.js";
import { useWanted } from "../stage/AccountSentence.js";
import { REASON_SAID } from "../stage/reasons.js";
import { Said } from "../stage/Said.js";
import { WayButton } from "../stage/way.js";
import { SIGN_IN_REFUSAL_SAID, type SignInDoor, type SignInFactor, type SignInRefusal } from "./door.js";
import { LOGIN_INVITE_KEY, anyoneCanSignUp } from "./invite-posture.js";
import "./placement.css";

/** The words of the toggle that turns to each factor. */
const USE_FACTOR: Readonly<Record<SignInFactor, string>> = {
  passkey: "usePasskey",
  code: "totpToggle",
  recovery: "useRecovery",
};

type Ongoing = Exclude<SignInDoor["state"], { at: "unavailable" }>;
type Refusal = readonly [string] | readonly [string, string] | undefined;

function refusalWords(refusal: SignInRefusal, login: Text): string {
  return refusal.word === "said" ? refusal.said : login(SIGN_IN_REFUSAL_SAID[refusal.word]);
}

export function SignInPage({ door }: { door: SignInDoor | None }): ReactNode {
  const login = useText("login");
  const resume = useText("resume");
  if (door === NONE || door.state.at === "unavailable") {
    const demo = door === NONE ? NONE : door.demo;
    const acts =
      demo === NONE ? null : (
        <WayButton way={demo} size="l">
          {login("betaCta")}
        </WayButton>
      );
    return (
      <Page line={login("betaBody")} acts={acts}>
        <Said text={login("betaNote")} />
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
    <PasswordStep door={door} busy={state.busy} refusal={refusal} login={login} resume={resume} />
  ) : (
    <FactorStep door={door} state={state} refusal={refusal} login={login} />
  );
}

/** The password step's blanks, in the order a press asks for them. */
const BLANKS = ["email", "password"] as const;
type Blank = (typeof BLANKS)[number];
/** Each blank's sentence when a press found it empty. */
const WANTED: Readonly<Record<Blank, string>> = { email: "emailWanted", password: "passwordWanted" };

function PasswordStep(p: {
  door: SignInDoor;
  busy: boolean;
  refusal: Refusal;
  login: Text;
  resume: Text;
}): ReactNode {
  const { door, busy, refusal, login, resume } = p;
  const { pending, fields } = door;
  /* The blank a press found empty takes the keys and says it is wanted: nothing leaves half filled. */
  const { wanted, want, typed, at } = useWanted(BLANKS);
  const type = (field: Blank, value: string): void => {
    typed(field);
    door.type(field, value);
  };
  const context = [
    door.why === null ? null : resume(REASON_SAID[door.why]),
    door.continues === null ? null : login(door.continues === "manage" ? "continueManage" : "continueJoin"),
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (busy || pending.signingOut) return;
    const missing: Blank | null =
      fields.email.trim() === "" ? "email" : fields.password === "" ? "password" : null;
    want(missing);
    if (missing === null) door.begin();
  };
  const wantedSaid = (field: Blank): string | undefined =>
    wanted === field ? login(WANTED[field]) : undefined;
  return (
    <form className="way-form" onSubmit={submit}>
      <Page
        trail={
          context === "" ? undefined : (
            <p className="way-context" role="status">
              {context}
            </p>
          )
        }
        refusal={refusal}
        material={
          <div className="way-fields">
            {/* The ids the sign-in's blanks always carried: a password manager that learned them still finds them. */}
            <Field
              ref={at.email}
              id="login-email"
              label={login("emailLabel")}
              type="email"
              autoComplete="username"
              value={fields.email}
              onChange={(v) => type("email", v)}
              refusal={wantedSaid("email")}
            />
            <Field
              ref={at.password}
              id="login-pw"
              label={login("passwordLabel")}
              type="password"
              autoComplete="current-password"
              value={fields.password}
              onChange={(v) => type("password", v)}
              refusal={wantedSaid("password")}
            />
          </div>
        }
        line={login(LOGIN_INVITE_KEY[door.note])}
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
            {anyoneCanSignUp(door.note) ? (
              <WayButton way={door.join} kind="quiet" size="l">
                {login("createAccount")}
              </WayButton>
            ) : null}
            <WayButton way={door.join} kind="quiet" size="l">
              {login("haveInvite")}
            </WayButton>
          </>
        }
      >
        <Said text={login("title")} level={1} />
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
  const { code } = door.fields;
  const codeField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  /* The code step is time-boxed: its one field takes the focus on arrival and on a change of factor. */
  useEffect(() => {
    codeField.current?.focus();
  }, [factor]);
  const others = (
    <>
      {offered
        .filter((f) => f !== factor)
        .map((f) => (
          <Button key={f} kind="quiet" size="l" onPress={() => door.use(f)}>
            {login(USE_FACTOR[f])}
          </Button>
        ))}
      <Button kind="quiet" size="l" onPress={door.restart}>
        {login("startOver")}
      </Button>
    </>
  );
  if (factor === "passkey") {
    return (
      <Page
        refusal={refusal}
        line={login("passkeyNote")}
        acts={
          <>
            <Button size="l" disabled={busy} onPress={door.passkey}>
              {busy ? login("working") : login("passkey")}
            </Button>
            {others}
          </>
        }
      >
        <Said text={login("sub")} />
      </Page>
    );
  }
  const finish = (e: FormEvent): void => {
    e.preventDefault();
    if (busy || code.trim().length === 0) return;
    door.finish();
  };
  return (
    <form className="way-form" onSubmit={finish}>
      <Page
        refusal={refusal}
        material={
          <div className="way-fields">
            {/* An authenticator's code opens the number pad on a phone; a recovery code has letters. */}
            <Field
              ref={codeField}
              id="login-code"
              label={login(factor === "recovery" ? "recoveryLabel" : "totpLabel")}
              autoComplete="one-time-code"
              inputMode={factor === "code" ? "numeric" : "text"}
              value={code}
              onChange={(v) => door.type("code", v)}
            />
          </div>
        }
        acts={
          <>
            <Button type="submit" size="l" keyHint="↵" disabled={busy || code.trim().length === 0}>
              {busy ? login("working") : login("totpVerify")}
            </Button>
            {others}
          </>
        }
      >
        <Said text={login("subCode")} />
      </Page>
    </form>
  );
}
