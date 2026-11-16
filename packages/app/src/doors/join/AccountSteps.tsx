/**
 * The join's first steps: the invite code where the deployment asks for one, the account, the mail sent on the public
 * path, and the address confirmed. Each is one form or one sentence on the stage; every press is the door's.
 */
import { useState, type ReactNode } from "react";
import { Button, Field, Page } from "@ohmail/ui/base";
import { JOIN_INVITE_KEY } from "../sign-in/invite-posture.js";
import { DoorFields, DoorForm } from "../stage/DoorForm.js";
import { accountReady } from "../stage/fields.js";
import { Said } from "../stage/Said.js";
import { WayButton } from "../stage/way.js";
import { refusalOf, SignOutAgain, type StepProps } from "./parts.js";

export function InviteStep({ door, join, progress }: StepProps<"invite">): ReactNode {
  const { fields, pending } = door;
  return (
    <DoorForm onSubmit={door.redeem}>
      <Page
        aside={progress}
        refusal={refusalOf(pending, door.refusal)}
        material={
          <DoorFields>
            <Field
              id="join-code"
              label={join("inviteLabel")}
              hint={join("inviteHint")}
              value={fields.code}
              onChange={(v) => door.type("code", v)}
            />
          </DoorFields>
        }
        line={join(JOIN_INVITE_KEY[door.note])}
        acts={
          <>
            <Button type="submit" size="l" keyHint="↵" disabled={door.busy || pending.signingOut}>
              {join("continue")}
            </Button>
            <SignOutAgain pending={pending} busy={door.busy} />
          </>
        }
      >
        <Said text={join("step_invite_title")} level={1} />
      </Page>
    </DoorForm>
  );
}

/**
 * The account: the address, the name and the password, and an invite code where the deployment does not ask for one
 * (a person sent one may still redeem it; it is one press away, so the open path stays three blanks).
 */
export function AccountStep({ door, join, progress }: StepProps<"account">): ReactNode {
  const { fields, pending, busy } = door;
  const [withCode, setWithCode] = useState(fields.code.trim() !== "");
  return (
    <DoorForm onSubmit={door.register}>
      <Page
        aside={progress}
        refusal={refusalOf(pending, door.refusal)}
        material={
          <DoorFields>
            <Field
              id="join-email"
              label={join("emailLabel")}
              type="email"
              autoComplete="email"
              hint={join(door.invited ? "emailHint" : "emailHintOpen")}
              value={fields.email}
              onChange={(v) => door.type("email", v)}
            />
            {door.suggestion === null ? null : (
              <span>
                <Button kind="two" size="s" onPress={door.takeSuggestion}>
                  {join("didYouMean", { address: door.suggestion })}
                </Button>
              </span>
            )}
            <Field
              id="join-name"
              label={join("nameLabel")}
              autoComplete="name"
              value={fields.name}
              onChange={(v) => door.type("name", v)}
            />
            <Field
              id="join-pw"
              label={join("passwordLabel")}
              type="password"
              autoComplete="new-password"
              hint={join("passwordHint")}
              value={fields.password}
              onChange={(v) => door.type("password", v)}
            />
            {door.invited ? null : (
              <span>
                <Button kind="quiet" size="s" pressed={withCode} onPress={() => setWithCode(!withCode)}>
                  {join("inviteOptional")}
                </Button>
              </span>
            )}
            {door.invited || !withCode ? null : (
              <Field
                id="join-code-opt"
                label={join("inviteLabel")}
                hint={join("inviteOptionalHint")}
                value={fields.code}
                onChange={(v) => door.type("code", v)}
              />
            )}
          </DoorFields>
        }
        line={join("step_account_lead")}
        acts={
          <>
            <Button
              type="submit"
              size="l"
              keyHint="↵"
              disabled={busy || pending.signingOut || !accountReady(fields)}
            >
              {busy ? join("working") : join("createAccount")}
            </Button>
            {door.invited ? (
              <Button kind="quiet" size="l" onPress={door.toInvite}>
                {join("back")}
              </Button>
            ) : null}
            <SignOutAgain pending={pending} busy={busy} />
            <WayButton way={door.signIn} kind="quiet" size="l">
              {join("accountSignIn")}
            </WayButton>
          </>
        }
      >
        <Said text={join("step_account_title")} level={1} />
      </Page>
    </DoorForm>
  );
}

/**
 * The public path's last screen: true whether or not the address already had an account. It says a mail went to
 * the address and what to do with it, never that an account was made; the tab goes on when the link is opened.
 */
export function SentStep({ door, state, join, progress }: StepProps<"sent">): ReactNode {
  const { pending } = door;
  return (
    <Page
      aside={progress}
      refusal={refusalOf(pending, door.refusal)}
      material={
        state.continuing ? (
          <p className="way-join-status" role="status">
            {join("sentContinuing")}
          </p>
        ) : undefined
      }
      line={join("step_sent_lead", { email: door.fields.email.trim() })}
      note={join("sentNote")}
      acts={
        <>
          <Button kind="two" size="l" onPress={door.changeAddress}>
            {join("wrongAddress")}
          </Button>
          <SignOutAgain pending={pending} busy={door.busy} />
          <WayButton way={door.signIn} kind="quiet" size="l">
            {join("signIn")}
          </WayButton>
        </>
      }
    >
      <Said text={join("step_sent_title")} level={1} />
    </Page>
  );
}

/** The address, proven before a plan or a mailbox: the link in the mail, or a new one. */
export function VerifyStep({ door, state, join, progress }: StepProps<"verify">): ReactNode {
  const { pending, busy } = door;
  return (
    <Page
      aside={progress}
      refusal={refusalOf(pending, door.refusal)}
      line={join("step_verify_lead", { email: door.fields.email })}
      note={join("verifyWhy")}
      acts={
        <>
          <Button size="l" disabled={busy} onPress={door.recheck}>
            {join("verifyRecheck")}
          </Button>
          <Button kind="quiet" size="l" disabled={busy || state.resent} onPress={door.resend}>
            {busy ? join("working") : state.resent ? join("verifyResent") : join("verifyResend")}
          </Button>
          <SignOutAgain pending={pending} busy={busy} />
        </>
      }
    >
      <Said text={join("step_verify_title")} level={1} />
    </Page>
  );
}
