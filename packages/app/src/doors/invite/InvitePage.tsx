/**
 * THE HOUSEHOLD INVITE. The page an invite link opens on a server someone runs for their household: it reads the
 * link, asks who the person is and makes the account in one press. The account's three blanks stand in one sentence,
 * under the invite's tag, at the first of the account's steps, as the design draws it. Everything the ceremony does is
 * the door's, and the link's secret never reaches the page. It is opened cold, from a message, so it carries the small
 * mark where a way back would stand. Its words are the `joinInvite` namespace's.
 */
import type { ReactNode } from "react";
import { Button, Page, Tag } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText, type Text } from "../../text/index.js";
import { AccountSentence, accountWanted, useWanted } from "../stage/AccountSentence.js";
import { ColdMark } from "../stage/ColdMark.js";
import { DoorForm } from "../stage/DoorForm.js";
import { refusalOf, SignOutAgain } from "../stage/pending.js";
import { Said } from "../../text/Said.js";
import { Steps } from "../stage/Steps.js";
import type { InviteDoor, InviteField, InviteState } from "./door.js";

export function InvitePage({ door }: { door: InviteDoor | None }): ReactNode {
  const invite = useText("joinInvite");
  const state: InviteState = door === NONE ? { at: "unavailable" } : door.state;
  switch (state.at) {
    case "unavailable":
      return (
        <Page back={<ColdMark />} line={[{ note: invite("unavailableBody") }]} acts={null}>
          <Said text={invite("unavailableTitle")} dot="ink" />
        </Page>
      );
    case "opening":
      return (
        <div className="way-live" aria-busy="true" aria-live="polite">
          <Page back={<ColdMark />} acts={null}>
            <Said text={invite("reading")} />
          </Page>
        </div>
      );
    case "missing": {
      const { pending } = door as InviteDoor;
      return (
        <Page
          back={<ColdMark />}
          refusal={refusalOf(pending, null)}
          line={invite("missingLine")}
          note={invite("missingNote")}
          acts={<SignOutAgain pending={pending} busy={false} />}
        >
          <Said text={invite("missingTitle")} />
        </Page>
      );
    }
    case "form":
      return <InviteForm door={door as InviteDoor} state={state} invite={invite} />;
  }
}

const BLANKS: readonly InviteField[] = ["name", "email", "password"];

function InviteForm(p: {
  door: InviteDoor;
  state: Extract<InviteState, { at: "form" }>;
  invite: Text;
}): ReactNode {
  const { door, state, invite } = p;
  const { fields, pending } = door;
  /* The blank a press found not ready says it is wanted, as the old form's own checks held a press. */
  const { wanted, want, typed, at } = useWanted(BLANKS);
  const type = (field: InviteField, value: string): void => {
    typed(field);
    door.type(field, value);
  };
  const press = (): void => {
    if (state.busy || pending.signingOut) return;
    const missing = accountWanted(fields);
    want(missing);
    if (missing === null) door.submit();
  };
  return (
    <DoorForm onSubmit={press}>
      <Page
        back={<ColdMark />}
        aside={<Steps said={invite("progress")} part="1/3" />}
        smaller
        refusal={refusalOf(pending, state.refusal)}
        line={invite("signInHere")}
        acts={
          <>
            <Button type="submit" size="l" keyHint="↵" disabled={state.busy || pending.signingOut}>
              {state.busy ? invite("working") : invite("createAccount")}
            </Button>
            <SignOutAgain pending={pending} busy={state.busy} />
          </>
        }
      >
        <p className="way-pre">
          <Tag>{invite("invited")}</Tag>
        </p>
        <AccountSentence
          t={invite}
          passwordHint="minimum"
          fields={fields}
          wanted={wanted}
          at={at}
          type={type}
        />
      </Page>
    </DoorForm>
  );
}
