import { Fragment } from "react";
import { Button } from "@ohmail/ui/base";
import { ActionPanel, SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import type { PaneSheet } from "../contract.js";
import type { HelpModel } from "./model.js";

const COMMIT_SHOWN = 9;
const PLATFORM = { linux: "Linux", macos: "macOS", windows: "Windows", ios: "iOS", android: "Android" };
const PROVIDER = {
  gmail: "Gmail",
  icloud: "iCloud",
  imap: "IMAP",
  microsoft: "Microsoft",
  microsoft_oauth: "Microsoft (OAuth)",
};

export function HelpPane({ model, sheet }: { readonly model: HelpModel; readonly sheet?: PaneSheet }) {
  const t = useText("help");
  const settings = useText("settings");
  const { write, facts } = model;
  const { os, osVersion, mailboxes, commit } = facts;
  const version = `${facts.version ?? t("dNone")}${commit === null ? "" : ` · ${t("dBuild")} ${commit.slice(0, COMMIT_SHOWN)}`}`;
  const content = (
    <>
      <SettingsSheet>
        <SettingLine label={t("versionLabel")} value={version} />
      </SettingsSheet>
      <SettingsSheet
        title={t("diag")}
        aside={
          write.kind === "copy" ? (
            <Button kind="quiet" size="s" icon="copy" onPress={() => write.copy("diag")}>
              {write.copied === "diag" ? t("copied") : t("copyDiag")}
            </Button>
          ) : undefined
        }
      >
        <SettingLine label={t("dApp")} value={`ohmail ${facts.surface} ${version}`} />
        <SettingLine
          label={t("dPlatform")}
          value={`${os === null ? t("dNone") : os === "other" ? t("dOther") : PLATFORM[os]}${os !== null && osVersion !== null ? ` ${osVersion}` : ""}`}
        />
        {facts.account !== null ? <SettingLine label={t("dAccount")} value={facts.account} /> : null}
        {mailboxes.length === 0 ? (
          <SettingLine label={t("dMailbox")} value={t("dNone")} />
        ) : (
          mailboxes.map((mailbox, index) => (
            <Fragment key={index}>
              <SettingLine label={t("dMailbox")} value={PROVIDER[mailbox.provider]} />
              <SettingLine label={t("dLastSync")} value={t(`sync_${mailbox.lastSyncError ?? "none"}`)} />
            </Fragment>
          ))
        )}
      </SettingsSheet>
      {write.kind === "copy" ? <SettingNote>{t("writeWhyCopy")}</SettingNote> : null}
    </>
  );
  const foot =
    write.kind === "mailto" ? (
      <div className="oh-actionpanel">
        <div className="oh-actionpanel-bar" role="toolbar" aria-label={settings("help")}>
          <Button kind="ink" size="s" icon="write" href={write.href}>
            {t("write")}
          </Button>
        </div>
      </div>
    ) : (
      <ActionPanel
        label={settings("help")}
        items={[
          write.kind === "compose"
            ? {
                id: "write",
                label: t("write"),
                icon: "write",
                kind: "ink",
                rank: 0,
                onPress: write.write,
              }
            : {
                id: "copy-address",
                label: write.copied === "address" ? t("copied") : t("copyAddress"),
                icon: "copy",
                kind: "ink",
                rank: 0,
                onPress: () => write.copy("address"),
              },
        ]}
      />
    );
  return sheet ? (
    sheet(content, foot)
  ) : (
    <>
      {content}
      {foot}
    </>
  );
}
