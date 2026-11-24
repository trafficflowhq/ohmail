import { useEffect, useRef, useState } from "react";
import { Avatar } from "@ohmail/ui/base";
import { SettingLine, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import type { FoldersModel } from "./model.js";

export interface FoldersPaneProps {
  readonly model: FoldersModel;
}

/**
 * Folders: the mail server's own folders in the menu, or not. Each switch draws the server's answer; one write at a
 * time, and a refused one is said on its sheet.
 */
export function FoldersPane({ model }: FoldersPaneProps) {
  const t = useText("settings");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [mbPending, setMbPending] = useState<string | null>(null);
  const [mbFailed, setMbFailed] = useState(false);

  const write = (enabled: boolean) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    model
      .set(enabled)
      .catch(() => alive.current && setFailed(true))
      .finally(() => alive.current && setPending(false));
  };
  const writeMailbox = (id: string, enabled: boolean) => {
    if (mbPending !== null) return;
    setMbPending(id);
    setMbFailed(false);
    model
      .setMailbox(id, enabled)
      .catch(() => alive.current && setMbFailed(true))
      .finally(() => alive.current && setMbPending(null));
  };
  const notSaved = { word: t("notSaved"), line: t("folders.failed") };
  const list = model.on ? model.mailboxes : null;

  return (
    <SettingsSheet wants={failed || mbFailed ? notSaved : undefined}>
      <SettingLine label={t("folders.useTitle")} off={pending} toggle={{ on: model.on, onChange: write }} />
      {list?.map((mb) => (
        <SettingLine
          key={mb.id}
          label={mb.address}
          lead={<Avatar name={mb.address} address={mb.address} size="s" />}
          off={mbPending !== null}
          toggle={{ on: mb.on, onChange: (enabled) => writeMailbox(mb.id, enabled) }}
        />
      ))}
    </SettingsSheet>
  );
}
