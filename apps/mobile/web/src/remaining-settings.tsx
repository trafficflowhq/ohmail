import { useEffect, useState } from "react";
import { useEngine } from "@ohmail/app-logic/engine";
import { NONE } from "@ohmail/app/host";
import { type MailPaneParts } from "@ohmail/app/mail";
import { DiagnosticFileSheet } from "@ohmail/app/phone-settings/diagnostic-file";
import { ThisPhoneSheet } from "@ohmail/app/phone-settings/this-phone";
import { useText } from "@ohmail/app/text";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import type { PhoneOrganizerRequest, PhoneOrganizerRow, Requests, ShellConfig } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import { MIRROR_ENTITY_TYPES } from "./engine-package";

type Backup = NonNullable<Requests["act"]["answer"]["backup"]>;
const BACKUP = { excluded: "out", included: "in", unknown: "unknown" } as const;

export function phoneSettingsParts(
  bridge: Bridge, config: Pick<ShellConfig, "scope" | "os" | "build" | "setting">,
): Pick<MailPaneParts, "about" | "mailboxes"> {
  function About() {
    const engine = useEngine();
    const t = useText("phoneSettings");
    const about = useText("about");
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
          <SettingLine
            label={about("buildLabel")}
            value={about("build", { version: config.build.version ?? "", build: config.build.commit ?? "dev" })}
          />
        </SettingsSheet>
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
