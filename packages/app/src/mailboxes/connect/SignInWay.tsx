import type { ReactNode } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingActs, SettingNote } from "@ohmail/ui/mail";
import type { ConnectForm } from "@ohmail/app-logic/mailboxes/connect/use-connect-form";
import type { Text } from "../../text/index.js";

/** The provider's sign-in press and the password alternative, when the provider's own way is available. */
export function SignInWay({
  form,
  words,
  press,
  working,
  secondWay,
}: {
  form: ConnectForm;
  words: Text;
  press: string;
  working: string;
  secondWay: boolean;
}): ReactNode {
  const { way } = form;
  const waiting = form.busy === "signIn" || form.state.leaving;
  return (
    <div className="mbx-connect-part">
      <SettingActs>
        <Button type="submit" size="l" disabled={waiting}>
          {form.busy === "signIn" ? working : press}
        </Button>
        {secondWay ? (
          <Button kind="quiet" onPress={form.byPassword}>
            {words("microsoftUseAppPassword")}
          </Button>
        ) : null}
      </SettingActs>
      {way?.by === "code" ? <SettingNote>{words("deviceOauthNote")}</SettingNote> : null}
    </div>
  );
}
