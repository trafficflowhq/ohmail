/**
 * SETTINGS → AI ON THE CLOUD DOOR — the account's off switch, over the bridge. The twin of
 * the browser tab's pane, a separate file for `DesktopMailboxes`'s reason: this window cannot
 * call `app/api-client` (aliased to a refusing module), so the same two routes are reached
 * through `bridgeFetch`. Same flag, same routes, same two sentences from the `settings`
 * catalogue. NOT `DesktopAiSettings` — that is the standalone door's local-model form; this
 * is `accounts.ai_enabled` on a hosted account, and that file's header says why they are
 * different panes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsNote, SettingsRow, SettingsSection, Switch } from "@ohmail/ui";

import { bridgeFetch } from "./bridge-fetch.js";

/**
 * The hosted route this pane addresses, root-relative like every path in this window.
 *
 * Exported for the reason the panes beside it export theirs: the engine must FORWARD it on this
 * door rather than answer it from the mirror, which holds no account flag.
 */
export const ACCOUNT_AI_PATH = "/account/ai";

export function DesktopAiAccount() {
  const t = useTranslations("settings");
  /** `null` = not answered. Drawn, not pressable — never a guessed position. See the web twin. */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await bridgeFetch(ACCOUNT_AI_PATH);
        if (!alive.current) return;
        if (!res.ok) { setProblem(t("aiUnreadable")); return; }
        const body = (await res.json()) as { aiEnabled?: unknown };
        if (alive.current && typeof body.aiEnabled === "boolean") setEnabled(body.aiEnabled);
      } catch {
        if (alive.current) setProblem(t("aiUnreadable"));
      }
    })();
  }, [t]);

  const toggle = useCallback((next: boolean) => {
    setProblem(null);
    const previous = enabled;
    setEnabled(next);
    void (async () => {
      try {
        const res = await bridgeFetch(ACCOUNT_AI_PATH, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ aiEnabled: next }),
        });
        if (!alive.current) return;
        if (!res.ok) { setEnabled(previous); setProblem(t("aiUnreadable")); return; }
        const body = (await res.json()) as { aiEnabled?: unknown };
        // The SERVER's answer wins — it is what every AI call site will read.
        if (alive.current && typeof body.aiEnabled === "boolean") setEnabled(body.aiEnabled);
      } catch {
        if (!alive.current) return;
        setEnabled(previous);
        setProblem(t("aiUnreadable"));
      }
    })();
  }, [enabled, t]);

  return (
    <SettingsSection>
      {problem ? <p className="join-error" role="alert">{problem}</p> : null}
      <SettingsRow
        label={t("aiLabel")}
        description={t("aiSub")}
        control={
          <Switch
            checked={enabled === true}
            disabled={enabled === null}
            onChange={toggle}
            ariaLabel={t("aiLabel")}
          />
        }
      />
      <SettingsNote icon="spark">{t("aiOffNote")}</SettingsNote>
    </SettingsSection>
  );
}
