import { useEffect, useState } from "react";
import { useNoticesVersion, writeChannels } from "@ohmail/app-logic/notices/browser-channels";
import { useEngine } from "@ohmail/app-logic/engine";
import type { WakePaneState } from "@ohmail/app-logic/phone/wake";
import { NewMailPane } from "@ohmail/app/phone-settings/new-mail";
import { YourNameSheet } from "@ohmail/app/phone-settings/your-name";
import { useText } from "@ohmail/app/text";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingActs, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import type { PhoneNameRow } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import { storedNoticeChoices } from "./notices";

export function phoneYourNamePane(bridge: Bridge, scope: string) {
  return function PhoneYourNamePane() {
    const engine = useEngine();
    const phoneWords = useText("phoneSettings");
    const mailboxWords = useText("mailboxes");
    const refusal = useText("viewError");
    const [mailboxes, setMailboxes] = useState<readonly PhoneNameRow[] | "failed" | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
      const read = new AbortController();
      void bridge
        .request("phone.name", { do: "read" }, { signal: read.signal })
        .then(({ rows }) => {
          if (!read.signal.aborted) setMailboxes(rows ?? "failed");
        })
        .catch(() => {
          if (!read.signal.aborted) setMailboxes("failed");
        });
      return () => read.abort();
    }, [attempt]);

    if (mailboxes === "failed") {
      return (
        <SettingsSheet title={phoneWords("yourName.title")}>
          <SettingNote warn>{refusal("loadFailed")}</SettingNote>
          <SettingActs label={phoneWords("yourName.title")}>
            <Button
              kind="two"
              size="s"
              onPress={() => {
                setMailboxes(null);
                setAttempt((previous) => previous + 1);
              }}
            >
              {refusal("tryAgain")}
            </Button>
          </SettingActs>
        </SettingsSheet>
      );
    }

    if (mailboxes === null || mailboxes.length === 0) {
      const loading = mailboxes === null;
      return (
        <SettingsSheet title={phoneWords("yourName.title")}>
          <SettingNote busy={loading} said={!loading}>
            {mailboxWords(loading ? "loading" : "noneYet")}
          </SettingNote>
        </SettingsSheet>
      );
    }

    return mailboxes.map(({ id, address, name }) => (
      <YourNameSheet
        key={id}
        scope={scope}
        mailboxId={id}
        mailbox={address}
        name={name}
        save={async (next) => {
          const confirmed = await bridge.request("phone.name", { do: "save", mailboxId: id, name: next });
          if (confirmed.name === undefined) throw new Error("Sender name confirmation missing");
          void engine.syncOnce().catch(() => undefined);
          return confirmed.name;
        }}
      />
    ));
  };
}

export function phoneNewMailPane(bridge: Bridge, scope: string, showsDetails: boolean) {
  return function PhoneNewMailPane() {
    const t = useText("settingsNotifications");
    useNoticesVersion(0);
    const channels = storedNoticeChoices(localStorage, false, scope);
    const [wake, setWake] = useState<WakePaneState | null>(null);

    useEffect(() => {
      const read = new AbortController();
      let received = false;
      const unsubscribe = bridge.on((event) => {
        if (event.type !== "wakePane") return;
        received = true;
        setWake(event.wake);
      });
      void bridge
        .request("phone.wake", { do: "read" }, { signal: read.signal })
        .then(({ wake }) => {
          if (!received && !read.signal.aborted && wake) setWake(wake);
        })
        .catch(() => {});
      return () => {
        unsubscribe();
        read.abort();
      };
    }, []);

    if (wake === null) return null;
    return (
      <>
      <NewMailPane
        model={{
          ...wake,
          choose: (distributor) => void bridge.request("phone.wake", { do: "choose", distributor }).catch(() => {}),
          turnOff: () => void bridge.request("phone.wake", { do: "off" }).catch(() => {}),
        }}
      />
      {showsDetails ? <SettingsSheet>
        <SettingLine label={t("showMailDetails")} toggle={{
          on: channels.showMailDetails === true,
          onChange: (on) => writeChannels({ ...channels, showMailDetails: on }, scope),
        }} />
      </SettingsSheet> : null}
      </>
    );
  };
}
