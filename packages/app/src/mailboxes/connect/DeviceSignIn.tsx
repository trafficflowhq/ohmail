import { useEffect, useState, type ReactNode } from "react";
import { Button, RefusalLine } from "@ohmail/ui/base";
import { SettingActs, SettingNote } from "@ohmail/ui/mail";
import { deviceSignInFailureKey } from "@ohmail/app-logic/mailboxes/connect/sign-in";
import type { CodeCeremony } from "@ohmail/app-logic/mailboxes/connect/types";
import { useText } from "../../text/index.js";

export function DeviceSignIn({ result, stop }: { result: CodeCeremony; stop(): void }): ReactNode {
  const words = useText("mailboxes");
  if (result.kind === "connected") return null;
  if (result.kind === "ended") {
    return result.why === "refused" ? (
      <RefusalLine alert>{words(deviceSignInFailureKey(result.refusal?.code))}</RefusalLine>
    ) : (
      <div role="status">
        <SettingNote>{words(`device_${result.why}`)}</SettingNote>
      </div>
    );
  }
  const openAt = result.kind === "shown" ? verificationLink(result.openAt) : null;
  return (
    <>
      <div role="status">
        {result.kind === "checking" ? (
          <SettingNote>{words("oauthFinishing")}</SettingNote>
        ) : (
          <>
            <SettingNote>{words("deviceGoTo")}</SettingNote>
            {openAt === null ? (
              <SettingNote>{result.openAt ?? ""}</SettingNote>
            ) : (
              <SettingActs>
                <Button kind="quiet" href={openAt} outside icon="go">
                  {openAt}
                </Button>
              </SettingActs>
            )}
            <SettingNote>{words("deviceEnterCode")}</SettingNote>
            <SettingNote>{[{ strong: result.code }]}</SettingNote>
            <SettingNote>{words("deviceWaiting")}</SettingNote>
          </>
        )}
        {result.refusal ? (
          <SettingNote>{words(deviceSignInFailureKey(result.refusal.code, true))}</SettingNote>
        ) : null}
      </div>
      {result.kind === "shown" ? <Deadline until={result.until} /> : null}
      <SettingActs>
        <Button kind="two" onPress={stop}>
          {words("deviceStopWaiting")}
        </Button>
      </SettingActs>
    </>
  );
}

function Deadline({ until }: { until: number }): ReactNode {
  const words = useText("mailboxes");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <SettingNote>
      {words("deviceExpiresIn", { minutes: Math.max(0, Math.ceil((until - now) / 60_000)) })}
    </SettingNote>
  );
}

function verificationLink(openAt: string | null): string | null {
  if (openAt === null) return null;
  try {
    const url = new URL(openAt);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : null;
  } catch {
    return null;
  }
}
