import { useState, type ReactNode } from "react";
import { Button, Dot, Page, Tag } from "@ohmail/ui/base";
import { AccountSentence, useWanted, type AccountField } from "../stage/AccountSentence.js";
import { DoorForm } from "../stage/DoorForm.js";
import { PASSWORD_MIN, accountReady, passwordLength } from "../stage/fields.js";
import { Address, SaidWith } from "../../text/Said.js";
import { SentenceBlank } from "../../text/SentenceBlank.js";
import { WayButton } from "../stage/way.js";
import { refusalOf, SignOutAgain, JoinBack, type StepProps } from "./parts.js";

const ACCOUNT_FIELDS = ["name", "email", "password"] as const;
const ACCOUNT_IDS = { name: "join-name", email: "join-email", password: "join-pw" };

function InviteSentence({
  door,
  join,
  separate,
}: Pick<StepProps<"invite">, "door" | "join"> & { separate?: boolean }): ReactNode {
  return (
    <SaidWith
      level={separate ? 1 : undefined}
      parts={join.rich("myInvite", {
        blank: () => (
          <SentenceBlank
            id={separate ? "join-code" : "join-code-opt"}
            label={join("inviteLabel")}
            placeholder={join("inviteBlank")}
            value={door.fields.code}
            onChange={(value) => door.type("code", value)}
          />
        ),
      })}
    />
  );
}

export function InviteStep({ door, join, progress }: StepProps<"invite">): ReactNode {
  const { pending, busy } = door;
  return (
    <DoorForm onSubmit={door.redeem}>
      <Page
        back={<JoinBack door={door} join={join} signIn />}
        aside={progress}
        refusal={refusalOf(pending, door.refusal)}
        acts={
          <>
            <Button type="submit" size="l" keyHint="↵" disabled={busy || pending.signingOut}>
              {join("continue")}
            </Button>
            <SignOutAgain pending={pending} busy={busy} />
          </>
        }
      >
        <InviteSentence door={door} join={join} separate />
      </Page>
    </DoorForm>
  );
}

export function AccountStep({ door, state, join, progress }: StepProps<"account">): ReactNode {
  const { fields, pending, busy } = door;
  const { offer } = state;
  const filled = Math.min(passwordLength(fields.password), PASSWORD_MIN);
  const remaining = PASSWORD_MIN - filled;
  const lengthHintId = "join-password-length";
  const [withCode, setWithCode] = useState(fields.code.trim() !== "");
  const { at, wanted, typed } = useWanted(ACCOUNT_FIELDS);
  const type = (field: AccountField, value: string): void => {
    typed(field);
    door.type(field, value);
  };
  return (
    <DoorForm onSubmit={door.register}>
      <Page
        smaller
        aside={progress}
        trail={
          offer === undefined ? undefined : (
            <div className="way-join-row">
              {offer === "trial" ? (
                <>
                  <span>{join("planTrial", { part: "heading" })}</span>
                  <Tag>{join("planTrial", { part: "signupPayment" })}</Tag>
                </>
              ) : (
                <>
                  <Tag>{offer.name}</Tag>
                  {offer.interval === null ? null : (
                    <Tag>{join(offer.interval === "year" ? "planYearly" : "planMonthly")}</Tag>
                  )}
                  {offer.price === undefined ? null : <Tag>{offer.price}</Tag>}
                </>
              )}
            </div>
          )
        }
        back={
          <JoinBack door={door} join={join}>
            {door.invited && <Button kind="quiet" icon="back" label={join("back")} onPress={door.toInvite} />}
          </JoinBack>
        }
        refusal={refusalOf(pending, door.refusal)}
        afterLine={
          <>
            <span className="way-join-row">
              <Tag>{join(door.note === "selfhost" ? "whereServer" : "whereCloud")}</Tag>
              {door.invited ? null : (
                <Button kind="quiet" size="s" pressed={withCode} onPress={() => setWithCode(!withCode)}>
                  {join("inviteLabel")}
                </Button>
              )}
            </span>
            {door.note !== "selfhost" && (
              <div className="way-join-row way-join-legal">
                <a className="way-join-legal-link" href="/terms">
                  {join("termsOfService")}
                </a>
                <a className="way-join-legal-link" href="/privacy">
                  {join("privacyPolicy")}
                </a>
              </div>
            )}
          </>
        }
        acts={
          <>
            <Button
              type="submit"
              size="l"
              keyHint="↵"
              disabled={busy || pending.signingOut || !accountReady(fields)}
            >
              {busy ? join("working") : join("continue")}
            </Button>
            <SignOutAgain pending={pending} busy={busy} />
            <WayButton way={door.signIn} kind="quiet" size="l">
              {join("signIn")}
            </WayButton>
          </>
        }
      >
        <AccountSentence
          t={join}
          ids={ACCOUNT_IDS}
          lengthHint="minimum"
          secretFieldHintId={remaining > 0 ? lengthHintId : undefined}
          fields={fields}
          at={at}
          wanted={wanted}
          type={type}
        />
        <div className="way-join-row">
          <span
            className="oh-stepdots-mark"
            role="img"
            aria-label={join("passwordLength", { filled, minimum: PASSWORD_MIN })}
          >
            {Array.from({ length: PASSWORD_MIN }, (_, i) => (
              <Dot key={i} kind={i < filled ? "ink" : "todo"} />
            ))}
          </span>
          {remaining > 0 ? (
            <p id={lengthHintId} className="way-join-status">
              {join("passwordRemaining", { minimum: PASSWORD_MIN, remaining })}
            </p>
          ) : null}
        </div>
        {door.suggestion === null ? null : (
          <Button kind="two" size="s" onPress={door.takeSuggestion}>
            {join("didYouMean", { address: door.suggestion })}
          </Button>
        )}
        {!door.invited && withCode ? <InviteSentence door={door} join={join} /> : null}
      </Page>
    </DoorForm>
  );
}

function OpenLink({ door, join }: Pick<StepProps<"sent">, "door" | "join">): ReactNode {
  const email = door.fields.email.trim();
  return (
    <SaidWith
      level={1}
      parts={join.rich("openLink", {
        email,
        a: () =>
          door.state.at === "sent" ? (
            <Button kind="two" label={join("changeAddress")} onPress={door.changeAddress}>
              {email}
            </Button>
          ) : (
            <Address value={email} />
          ),
      })}
    />
  );
}

/** The public path sends mail for both new and existing addresses. The tab waits for the link. */
export function SentStep({ door, state, join, progress }: StepProps<"sent">): ReactNode {
  return (
    <Page
      aside={progress}
      back={<JoinBack door={door} join={join} />}
      refusal={refusalOf(door.pending, door.refusal)}
      material={
        state.continuing ? (
          <p className="way-join-status" role="status">
            {join("sentContinuing")}
          </p>
        ) : undefined
      }
      acts={
        <>
          <SignOutAgain pending={door.pending} busy={door.busy} />
          <WayButton way={door.signIn} kind="quiet" size="l">
            {join("signIn")}
          </WayButton>
        </>
      }
    >
      <OpenLink door={door} join={join} />
    </Page>
  );
}

export function VerifyStep({ door, state, join, progress }: StepProps<"verify">): ReactNode {
  const { pending, busy } = door;
  return (
    <Page
      aside={progress}
      back={<JoinBack door={door} join={join} signIn />}
      line={join("step_verify_lead", { email: door.fields.email.trim() })}
      note={join("verifyWhy")}
      refusal={refusalOf(pending, door.refusal)}
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
      <OpenLink door={door} join={join} />
    </Page>
  );
}
