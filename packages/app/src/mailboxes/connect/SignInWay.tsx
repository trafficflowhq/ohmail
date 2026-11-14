import type { ReactNode } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingActs, SettingNote } from "@ohmail/ui/mail";
import type { ConnectForm } from "@ohmail/app-logic/mailboxes/connect/use-connect-form";
import type { Text } from "../../text/index.js";

/** An address to open is a link only as https with no user part; anything else is words. */
function linkOf(openAt: string | null): string | null {
  if (openAt === null) return null;
  try {
    const url = new URL(openAt);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * THE PROVIDER'S OWN SIGN-IN: no address, no server and no password, because the provider states the address in what
 * it issues. One press leaves for the provider, or shows a code to type there. The shell holds the ceremony; this
 * draws what it says and keeps nothing of it. The password way is a second press, for an organisation that blocks the
 * sign-in.
 */
export function SignInWay({
  form,
  words,
  press,
  working,
  secondWay,
}: {
  form: ConnectForm;
  words: Text;
  /** The press's own name: connect, or reconnect. */
  press: string;
  /** What the press says while its start runs. */
  working: string;
  /** Whether the password way is offered beside it. */
  secondWay: boolean;
}): ReactNode {
  const { code, way } = form;
  const waiting = form.busy === "signIn" || form.state.leaving;
  const shown = code?.kind === "shown" ? code : null;
  const link = linkOf(shown?.openAt ?? null);
  return (
    <div className="mbx-connect-part">
      {shown !== null ? (
        <>
          <SettingNote>{words("deviceGoTo")}</SettingNote>
          {link !== null ? (
            /* The provider's own page, opened beside the form by the person's press: the code is typed there. */
            <SettingActs>
              <Button kind="quiet" href={link} outside icon="go">
                {link}
              </Button>
            </SettingActs>
          ) : (
            <SettingNote>{shown.openAt ?? ""}</SettingNote>
          )}
          <SettingNote>{words("deviceEnterCode")}</SettingNote>
          <SettingNote>{shown.code}</SettingNote>
          <SettingNote>{words("deviceWaiting")}</SettingNote>
          <SettingActs>
            <Button kind="two" onPress={form.stopCode}>
              {words("deviceStopWaiting")}
            </Button>
          </SettingActs>
        </>
      ) : (
        <>
          {code?.kind === "ended" && code.why !== "refused" ? (
            <SettingNote>{words(`device_${code.why}`)}</SettingNote>
          ) : null}
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
        </>
      )}
      {way?.by === "code" && shown === null ? <SettingNote>{words("deviceOauthNote")}</SettingNote> : null}
    </div>
  );
}
