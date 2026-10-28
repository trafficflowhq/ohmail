"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { fullDateTime } from "./format";
import type { ReuseSweepLine } from "./reuse-sweeps";

type ClientKey =
  | "reuseClientWeb" | "reuseClientLinux" | "reuseClientMac" | "reuseClientWindows" | "reuseClientPhone"
  | "reuseClientUnknown";

/** The device kinds (`devices.kind`) in the reader's words; anything else is "a sign-in". */
const CLIENT_KEY = new Map<string, ClientKey>([
  ["web", "reuseClientWeb"],
  ["desktop-linux", "reuseClientLinux"],
  ["desktop-macos", "reuseClientMac"],
  ["macos", "reuseClientMac"],
  ["desktop-windows", "reuseClientWindows"],
  ["mobile-android", "reuseClientPhone"],
  ["mobile-ios", "reuseClientPhone"],
]);

/**
 * THE SIGN-INS OHMAIL ENDED BECAUSE AN OLDER COPY USED THEM AGAIN (`GET /auth/session`'s
 * `reuseSweeps`), in the shell's account slot until OK. The press hides it at once; the host's
 * `onAcknowledge` (the API, or the desktop's bridge) rejecting puts it back.
 */
export function ReuseSweepNotice({ sweeps, onAcknowledge }: {
  sweeps: readonly ReuseSweepLine[];
  onAcknowledge: (ids: string[]) => Promise<unknown>;
}) {
  const t = useTranslations("settings");
  const [pressed, setPressed] = useState<ReadonlySet<string>>(() => new Set());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const shown = sweeps.filter((s) => !pressed.has(s.id));
  if (shown.length === 0) return null;

  const acknowledge = (): void => {
    const ids = shown.map((s) => s.id);
    setPressed((was) => new Set([...was, ...ids]));
    void onAcknowledge(ids).catch(() => {
      if (alive.current) setPressed((was) => new Set([...was].filter((id) => !ids.includes(id))));
    });
  };

  return (
    <div className="acct-note" role="status">
      <p className="acct-note-line"><strong>{t("reuseSweepsTitle", { count: shown.length })}</strong></p>
      <ul className="acct-note-list">
        {shown.map((s) => (
          <li key={s.id}>
            {t("reuseSweepsLine", {
              client: t(CLIENT_KEY.get(s.client ?? "") ?? "reuseClientUnknown"),
              when: fullDateTime({ date: s.at }),
            })}
          </li>
        ))}
      </ul>
      <p className="acct-note-line">{t("reuseSweepsBody", { count: shown.length })}</p>
      <button type="button" className="acct-later" onClick={acknowledge}>{t("reuseSweepsOk")}</button>
    </div>
  );
}
