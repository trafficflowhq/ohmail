import { useEffect, useState } from "react";
import { readChannels, storedCalendarChoices, useNoticesVersion, writeCalendarNotice, writeChannels } from "@ohmail/app-logic/notices/browser-channels";
import { isTextSize, readTextSize, setTextSize, TEXT_SIZES } from "@ohmail/app-logic/text/text-size";
import { useEngine } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { liveMailboxes } from "@ohmail/app-logic/mail-state/mail-state";
import type { WakePaneState } from "@ohmail/app-logic/phone/wake";
import { useFrame } from "@ohmail/app/frame";
import { NONE } from "@ohmail/app/host";
import { browserClipboard } from "@ohmail/app/host/browser";
import { NewMailPane } from "@ohmail/app/phone-settings/new-mail";
import { YourNameSheet } from "@ohmail/app/phone-settings/your-name";
import { BrowserGeneralPane, PairedScreenerSettings } from "@ohmail/app/settings/browser";
import type { PaneBodyProps } from "@ohmail/app/settings";
import { HelpContactPane } from "@ohmail/app/settings/help";
import { useText } from "@ohmail/app/text";
import { useWriting } from "@ohmail/app/write";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingActs, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import type { PhoneNameRow, ShellConfig } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import { storedNoticeChoices } from "./notices";
import { ownsStorage } from "./owner";
import { usePhoneLanguage } from "./phone-language";

const textSize = {
  read: readTextSize,
  choices: TEXT_SIZES,
  set(size: number) {
    if (isTextSize(size)) setTextSize(size, document.documentElement);
  },
};

export function phoneGeneralPane(bridge: Bridge, { scope, setting }: Pick<ShellConfig, "scope" | "setting">, calendar = false) {
  const YourName = setting === "standalone" ? phoneYourNamePane(bridge, scope) : null;
  return function PhoneGeneralPane() {
    const language = usePhoneLanguage();
    return (
      <>
        <BrowserGeneralPane
          language={language}
          showMessages={!calendar}
          captureOwner={setting !== "standalone" ? (owner) => () => owner === scope && ownsStorage(scope) : undefined}
          textSize={textSize}
        />
        {YourName ? <YourName /> : null}
      </>
    );
  };
}

export function PhoneScreenerPane() {
  return <PairedScreenerSettings />;
}

export function phoneHelpPane(os: ShellConfig["os"]) {
  return function PhoneHelpPane({ sheet }: PaneBodyProps) {
    const { host } = useFrame();
    const { mailboxes } = useMailState();
    const { writeSupport } = useWriting();
    const { version, commit } = host.device.build;
    return (
      <HelpContactPane
        host={{ surface: "phone", version, commit, accountId: null, mailtoLeaves: false }}
        mailboxes={liveMailboxes(mailboxes)}
        onWrite={writeSupport ?? null}
        os={os ?? null}
        copyText={browserClipboard(window)}
        sheet={sheet}
      />
    );
  };
}

export function phoneDevicesPane(bridge: Bridge, compact = false) {
  return function PhoneDevicesPane() {
    const t = useText("servers");
    const refusal = useText("viewError");
    const [failed, setFailed] = useState(false);
    const button = <Button kind={compact ? "quiet" : "two"} size="s" onPress={() => {
      setFailed(false);
      void bridge.request("act", { act: "openServers" }).catch(() => setFailed(true));
    }}>{t("title")}</Button>;
    if (compact) return <SettingActs>{button}{failed ? <SettingNote warn>{refusal("loadFailed")}</SettingNote> : null}</SettingActs>;
    return (
      <SettingsSheet sign="phone">
        <SettingLine label={t("title")}>{button}</SettingLine>
        {failed ? <SettingNote warn>{refusal("loadFailed")}</SettingNote> : null}
      </SettingsSheet>
    );
  };
}

export function usePhoneCalendarNotificationsSummary() {
  const { host } = useFrame();
  const t = useText("settingsNotifications");
  useNoticesVersion(0);
  const { scope } = host.session;
  const door = host.device.notifications;
  if (scope === null || door === NONE) return null;
  const on = door.permission() === "granted" && readChannels(scope).master && storedCalendarChoices(scope, true).cal_alert;
  return { value: t(on ? "calendarOn" : "calendarOff"), detail: on ? t("alert") : undefined };
}

export function PhoneCalendarNotifications() {
  const { host } = useFrame();
  const scope = host.session.scope;
  const door = host.device.notifications;
  const t = useText("settingsNotifications");
  const s = useText("settings");
  const ref = useText("viewError");
  const [permission, setPermission] = useState(() => door === NONE ? "unsupported" : door.permission());
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useNoticesVersion(0);
  if (scope === null || door === NONE) return null;
  const choices = storedCalendarChoices(scope, true);
  const channels = readChannels(scope);
  const blocked = permission === "denied" || permission === "unsupported";
  const alerts = async (on: boolean) => {
    if (pending || !ownsStorage(scope)) return;
    setPending(true);
    setFailed(false);
    try {
      const allowed = on && permission === "default" ? await door.request() : permission;
      setPermission(allowed);
      if ((!on || allowed === "granted") && ownsStorage(scope)) writeCalendarNotice("cal_alert", on, scope);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <SettingsSheet title={t("about")}>
        <SettingLine label={t("calendarOnDevice")} toggle={{ on: channels.master, onChange: (on) => {
          if (ownsStorage(scope)) writeChannels({ ...channels, master: on }, scope);
        } }} />
        <SettingLine label={t("alert")} off={pending || blocked || !channels.master}
          toggle={{ on: choices.cal_alert && permission === "granted", onChange: (on) => void alerts(on) }} />
        {permission === "denied" ? <SettingNote>{s("notifyDenied")}</SettingNote> : null}
        {failed ? <SettingNote warn>{ref("loadFailed")}</SettingNote> : null}
        <SettingNote>{t("calendarPhoneNoticeKinds")}</SettingNote>
      </SettingsSheet>
      <SettingsSheet><SettingNote>{t("calendarPhonePrivacy")}</SettingNote></SettingsSheet>
    </>
  );
}

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
