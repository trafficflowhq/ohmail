"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsNote, SettingsRow, SettingsSection, Switch } from "@ohmail/ui";
import { aiSettings, messageOf } from "../../api-client";

/**
 * SETTINGS → AI — the account's own off switch, and nothing else.
 *
 * `GET/PATCH /account/ai` is the flag every AI call site passes through, which is what makes the
 * published sentence "you can switch the AI off entirely without losing a single feature that
 * files your mail" a property of the account rather than of a checkbox. A pane is what gives a
 * person somewhere to press it: the switch used to sit inside the subscription pane, so when that
 * pane left, the promise had no control behind it on any surface.
 *
 * ON EVERY HOST WITH AN ACCOUNT, and that is the reason it is not part of the subscription pane
 * this replaces: a self-hosted server mounts these two routes and has no subscription at all, so
 * a switch living beside a plan would be missing exactly where the operator pays the model bill
 * themselves. Nothing here reads a plan, a balance or a price.
 */
export function AiSection() {
  const t = useTranslations("settings");
  /** `null` = the server has not answered. The switch is drawn and NOT pressable until it has. */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The pane can be navigated away from mid-write; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    void aiSettings.get()
      .then(({ aiEnabled }) => { if (alive.current) setEnabled(aiEnabled); })
      /* Left UNKNOWN rather than guessed. A switch drawn OFF for an account that has it ON is a
         false statement about what that account is doing, on the one screen that exists to state
         it — so an unread flag renders as an unpressable switch and a sentence, not a position.
         The CATALOGUE's sentence, not the error's: a failed read has nothing specific to say and
         the remedy is the same either way. A refused WRITE does, and shows the server's own. */
      .catch(() => { if (alive.current) setError(t("aiUnreadable")); });
  }, [t]);

  const toggle = useCallback((next: boolean) => {
    setError(null);
    const previous = enabled;
    setEnabled(next);                 // optimistic: the switch must answer the press at once
    void (async () => {
      try {
        const { aiEnabled } = await aiSettings.set(next);
        // THE SERVER'S ANSWER WINS, not ours — it is the value every AI call site will read.
        if (alive.current) setEnabled(aiEnabled);
      } catch (err) {
        if (!alive.current) return;
        setEnabled(previous);         // …and a refusal puts the switch back where it was
        setError(messageOf(err));
      }
    })();
  }, [enabled]);

  return (
    <SettingsSection>
      {error ? <p className="acct-warn" role="alert">{error}</p> : null}
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
      {/* WHAT TURNING IT OFF ACTUALLY COSTS, said here so a rules-only result never reads as an
          outage: the deterministic rules run first and handle most mail either way. */}
      <SettingsNote icon="spark">{t("aiOffNote")}</SettingsNote>
    </SettingsSection>
  );
}
