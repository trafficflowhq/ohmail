"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { fullDateTime } from "./format";
import type { ReuseSweepLine } from "./reuse-sweeps";
import { RETURN_DEBOUNCE_MS } from "./wall-lift";

/** How often a shown notice asks the session again: OK on another device ends it here too. */
export const REUSE_RECHECK_MS = 5 * 60_000;

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
 * `reuseSweeps`), in the shell's account slot until OK: one quiet line, the list and the advice
 * under Details. OK acknowledges every listed sweep and hides it at once; the host's
 * `onAcknowledge` (the API, or the desktop's bridge) rejecting puts it back. While shown, the host's
 * `onRecheck` reads the session again on a return to the window and on {@link REUSE_RECHECK_MS}; an
 * answer listing none takes the notice away.
 */
export function ReuseSweepNotice({ sweeps, onAcknowledge, onRecheck }: {
  sweeps: readonly ReuseSweepLine[];
  onAcknowledge: (ids: string[]) => Promise<unknown>;
  onRecheck?: () => Promise<unknown>;
}) {
  const t = useTranslations("settings");
  const [pressed, setPressed] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const panel = useId();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const recheck = useRef(onRecheck);
  useEffect(() => { recheck.current = onRecheck; });
  useEffect(() => {
    let last = Date.now();
    const ask = (): void => {
      if (document.visibilityState !== "visible" || Date.now() - last < RETURN_DEBOUNCE_MS) return;
      last = Date.now();
      void recheck.current?.()?.catch(() => undefined);
    };
    const clock = setInterval(ask, REUSE_RECHECK_MS);
    window.addEventListener("focus", ask);
    document.addEventListener("visibilitychange", ask);
    return () => {
      clearInterval(clock);
      window.removeEventListener("focus", ask);
      document.removeEventListener("visibilitychange", ask);
    };
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
    <div className="acct-note acct-note-one" role="status">
      <div className={open ? "acct-note-row acct-note-row-open" : "acct-note-row"}>
        <span className="acct-note-said">{t("reuseSweepsTitle", { count: shown.length })}</span>
        <button
          type="button"
          className="acct-later"
          aria-expanded={open}
          aria-controls={open ? panel : undefined}
          onClick={() => setOpen((was) => !was)}
        >
          {t("reuseSweepsDetails")}
        </button>
        <button type="button" className="acct-later" onClick={acknowledge}>{t("reuseSweepsOk")}</button>
      </div>
      {open ? (
        <div id={panel} className="acct-note-more">
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
          <p className="acct-note-line">{t("reuseSweepsBody")}</p>
        </div>
      ) : null}
    </div>
  );
}
