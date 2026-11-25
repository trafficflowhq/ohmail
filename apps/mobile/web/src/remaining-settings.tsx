import { useEffect, useState } from "react";
import { useEngine } from "@ohmail/app-logic/engine";
import { liveMailboxes } from "@ohmail/app-logic/mail-state/mail-state";
import { useFrame } from "@ohmail/app/frame";
import { NONE } from "@ohmail/app/host";
import { type MailPaneParts } from "@ohmail/app/mail";
import { DiagnosticFileSheet } from "@ohmail/app/phone-settings/diagnostic-file";
import { ThisPhoneSheet } from "@ohmail/app/phone-settings/this-phone";
import { useText } from "@ohmail/app/text";
import { Button, EndDot } from "@ohmail/ui/base";
import { SettingActs, SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import type { PhoneOrganizerRequest, PhoneOrganizerRow, Requests, ShellConfig } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import { MIRROR_ENTITY_TYPES } from "./engine-package";

type Backup = NonNullable<Requests["act"]["answer"]["backup"]>;
const BACKUP = { excluded: "out", included: "in", unknown: "unknown" } as const;

type PhoneAboutConfig = Pick<ShellConfig, "scope" | "os" | "build" | "setting">;
type LegalPage = Extract<Requests["act"]["ask"], { act: "about.page" }>["page"];

function LegalPages({ bridge, calendar }: { bridge: Bridge; calendar?: PhoneAboutConfig }) {
  const t = useText("phoneSettings");
  const refusal = useText("viewError");
  const account = useText("account");
  const [failed, setFailed] = useState(false);
  const pages: readonly LegalPage[] = calendar ? ["privacy", "imprint", "support"] : ["privacy", "subprocessors", "imprint"];
  const title = t(calendar ? "calendarLegalTitle" : "legalTitle");
  function open(page: LegalPage) {
    setFailed(false);
    const request = page === "deleteAccount" && calendar && (calendar.setting === "managed" || calendar.setting === "selfHosted")
      ? bridge.request("phone.account", { scope: calendar.scope, do: "deletePage" })
      : bridge.request("act", { act: "about.page", page });
    void request.catch(() => setFailed(true));
  }
  return (
    <SettingsSheet>
      <SettingLine label={title} narrow="under">
        <SettingActs label={title}>{pages.map((page) => (
          <Button key={page} kind="quiet" size="s" onPress={() => open(page)}>
            {t(page === "privacy" && calendar ? "privacyPolicy" : page)}
          </Button>
        ))}</SettingActs>
      </SettingLine>
      {calendar ? (
        <SettingLine label={t("sharedAccount")} narrow="under">
          <SettingNote>{account("sharedCalendarLead")} {account("lead")}</SettingNote>
          <Button kind="quiet" size="s" onPress={() => open("deleteAccount")}>{t("deleteAccount")}</Button>
        </SettingLine>
      ) : null}
      {failed ? <SettingNote warn>{refusal("tryAgain")}</SettingNote> : null}
    </SettingsSheet>
  );
}

export function phoneCalendarAbout(bridge: Bridge, config: PhoneAboutConfig) {
  return function AboutCalendar() {
    const about = useText("about");
    const build = config.build.number;
    const version = config.build.version ?? "";
    return (
      <>
        <SettingsSheet>
          <p className="oh-text oh-display"><EndDot kind="hot">ohcal</EndDot></p>
          <SettingLine
            label={about("buildLabel")}
            value={about("build", { version: build ? version + " (" + build + ")" : version, build: config.build.commit ?? "dev" })}
          />
        </SettingsSheet>
        <LegalPages bridge={bridge} calendar={config} />
      </>
    );
  };
}

export function phoneSettingsParts(
  bridge: Bridge, config: PhoneAboutConfig,
): Pick<MailPaneParts, "about" | "mailboxes"> {
  function About() {
    const engine = useEngine();
    const { host } = useFrame();
    const t = useText("phoneSettings");
    const about = useText("about");
    const words = useText("settings");
    const roster = host.wires.mailboxes;
    const [count, setCount] = useState<number | null>(null);
    useEffect(() => {
      if (roster === NONE) return;
      let live = true;
      void roster.list({ counts: false }).then((answer) => {
        if (live && answer.ok) setCount(liveMailboxes(answer.value)?.length ?? 0);
      }, () => {});
      return () => { live = false; };
    }, [roster]);
    const [backup, setBackup] = useState<Backup | null>(null);
    useEffect(() => {
      const read = new AbortController();
      void bridge.request("act", { act: "backup.read" }, { signal: read.signal }).then(
        (answer) => { if (!read.signal.aborted) setBackup(answer.backup ?? "unknown"); },
        () => { if (!read.signal.aborted) setBackup("unknown"); },
      );
      return () => read.abort();
    }, []);
    return (
      <>
        <SettingsSheet>
          <p className="oh-text oh-display"><EndDot kind="hot">ohmail</EndDot></p>
          <SettingLine
            label={about("buildLabel")}
            value={about("build", { version: config.build.version ?? "", build: config.build.commit ?? "dev" })}
          />
          <SettingLine label={words("mailboxes")} value={count === null ? undefined : t("mailboxCount", { count })} />
        </SettingsSheet>
        <LegalPages bridge={bridge} />
        <SettingsSheet title={t("onThisPhone.title")} sign="phone">
          <SettingNote>{t("onThisPhone.forgetting")}</SettingNote>
          {config.os === "ios" ? <SettingNote>{t("onThisPhone.keychainIos")}</SettingNote> : null}
          {backup !== null ? <SettingNote>{t(`onThisPhone.backup.${BACKUP[backup]}`)}</SettingNote> : null}
        </SettingsSheet>
        <DiagnosticFileSheet actions={{
          write: async () => {
            const mirror = engine.read();
            const counts = MIRROR_ENTITY_TYPES.map((type) => mirror.list(type).length);
            return (await bridge.request("phone.diagnostics", { do: "write", counts })).fileName ?? null;
          },
          share: async () => (await bridge.request("phone.diagnostics", { do: "share" })).shared === true,
        }} />
      </>
    );
  }

  function Organizer() {
    const [rows, setRows] = useState<readonly PhoneOrganizerRow[]>([]);
    const [refresh, setRefresh] = useState(0);
    const [failure, setFailure] = useState(false);
    const words = useText("phoneSettings");
    const refusal = useText("viewError");
    useEffect(() => {
      const unsubscribe = bridge.on((event) => {
        if (event.type === "organizerChanged" || (event.type === "wake" && event.why === "foreground")) {
          setRefresh((previous) => previous + 1);
        }
      });
      return unsubscribe;
    }, []);
    useEffect(() => {
      const read = new AbortController();
      void bridge.request("phone.organize", { do: "read" }, { signal: read.signal }).then(
        (answer) => { if (!read.signal.aborted) { setRows(answer.rows); setFailure(false); } },
        () => { if (!read.signal.aborted) setFailure(true); },
      );
      return () => read.abort();
    }, [refresh]);
    function act(request: Exclude<PhoneOrganizerRequest, { do: "read" }>) {
      void bridge.request("phone.organize", request).catch(() => setFailure(true)).finally(() => {
        setRefresh((previous) => previous + 1);
      });
    }
    return (
      <>
        {rows.map((row) => (
          <ThisPhoneSheet key={row.id} model={{
            scope: config.scope, mailboxId: row.id, address: row.address, tag: row.tag,
            details: [
              ...row.notes.map((text) => ({ text })),
              ...row.warnings.map((text) => ({ text, warn: true })),
            ],
            explainBackground: row.explainBackground,
            start: row.start ? () => act({ do: "start", mailboxId: row.id, background: row.explainBackground }) : undefined,
            startWithoutPrompt: row.start ? () => act({ do: "start", mailboxId: row.id, background: false }) : undefined,
            stop: row.stop ? () => act({ do: "stop", mailboxId: row.id }) : undefined,
            openNotifications: row.notifications && row.id ? () => act({ do: "notifications", mailboxId: row.id }) : undefined,
          }} />
        ))}
        {failure ? (
          <SettingsSheet title={words("thisPhone.title")} sign="phone" hot>
            <SettingNote warn>{refusal("loadFailed")}</SettingNote>
          </SettingsSheet>
        ) : null}
      </>
    );
  }

  return {
    about: About,
    mailboxes: { factor: NONE, calendar: NONE, head: Organizer, holdEdit: config.setting === "standalone" },
  };
}
