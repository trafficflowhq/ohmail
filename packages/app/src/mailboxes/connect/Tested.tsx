import type { ReactNode } from "react";
import { RefusalLine } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { sendingLine } from "@ohmail/app-logic/doors/onboarding";
import type { ConnectProbed } from "@ohmail/app-logic/mailboxes/connect/types";
import type { Text } from "../../text/index.js";

/**
 * WHAT A TEST PROVED: the server that answered, the login it took and the folders it listed; then the outgoing
 * server's own verdict, in a line of its own, because the connect dials both and refuses the mailbox when that one
 * says no. A door that did not ask about sending draws no second line.
 */
export function Tested({ ok, onboarding }: { ok: ConnectProbed; onboarding: Text }): ReactNode {
  const sending = sendingLine(ok.sending);
  return (
    <div className="mbx-connect-part">
      <SettingNote>
        {onboarding("probeOk", { host: ok.host, user: ok.user, count: ok.folders ?? 0 })}
      </SettingNote>
      <SettingNote>{onboarding("probeOkDetail")}</SettingNote>
      {sending === null ? null : sending.state === "bad" ? (
        <RefusalLine>{onboarding(sending.key, { host: sending.host })}</RefusalLine>
      ) : (
        <SettingNote>
          {sending.state === "off"
            ? onboarding(sending.key)
            : onboarding(sending.key, { host: sending.host })}
        </SettingNote>
      )}
    </div>
  );
}
