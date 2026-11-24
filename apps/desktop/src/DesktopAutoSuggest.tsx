/**
 * SETTINGS → SCREENER → "Suggest for new senders automatically", on the STANDALONE door. The
 * hosted switch is not the same switch: there it authorises spending the account's CREDITS
 * with no press, so that control names a price (`AutoSuggestRow`); here there is no ledger —
 * the model is the person's own — so the honest thing to say is WHOSE model gets used and
 * WHEN. Its own component beside `DesktopScreening` (`DesktopScreeningWords` states the rule:
 * two controls that can each fail need two places to say so), and it reads a DIFFERENT route
 * (`/local/auto-suggest`, not `/account/screening`). With NO MODEL configured the row SAYS SO
 * — in the engine's own reading (`modelReady` comes off the read; a provider-name inference
 */

/*
 * keeps saying yes after a key is revoked) — and the switch stays live, so somebody who arms
 * it before setting up a key gets the behaviour the moment they do.
 */

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Switch } from "@ohmail/ui/base";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";

import {
  ownModelAutoSuggest,
  type AutoSuggestState,
} from "./local-auto-suggest.js";
import { AutoActRow } from "../../webapp/app/shell/AutoActRow";
import { consentOverBridgeStandalone } from "./local-consent.js";

/**
 * What the row says under its label, given what the engine answered.
 *
 * A function, and exported, so the three sentences are a thing a test can hold rather than JSX to
 * be re-read by eye. Which one is shown is the whole of this component's judgement.
 */
/**
 * WHICH OF THE THREE SENTENCES THIS STATE OWES — the KEY, not the sentence.
 *
 * It returned the English text until this slice, which is what kept this row in English on a
 * German install. Returning a key rather than taking a translator keeps this a pure function of
 * the state — which is what makes the three-arm table testable without a provider, and it is
 * tested that way (`desktop-auto-suggest.test.tsx`).
 */
export function autoSuggestCopyKey(
  value: AutoSuggestState,
): "autoSuggestNoModel" | "autoSuggestOff" | "autoSuggestOn" {
  if (!value.modelReady) return "autoSuggestNoModel";
  if (!value.on) return "autoSuggestOff";
  return "autoSuggestOn";
}

export function DesktopAutoSuggest({
  /** This install reads mail another install organizes — the act's switch is then disabled. */
  reader = false,
}: { reader?: boolean } = {}) {
  /* See `DesktopScreeningWords` for why the namespace has to be on `vite.config.ts`'s list. */
  const t = useTranslations("desktopScreener");
  const suggestionNote = useId();
  // An absent route belongs to another door. A pending or refused read shows a held Off switch.
  const [value, setValue] = useState<AutoSuggestState | null | undefined>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  /* THE ACT ON SUGGESTIONS, over this door's own consent route. `null` until the read
     answered with the axis; an engine without it draws no switch. */
  const [act, setAct] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void consentOverBridgeStandalone.state().then(
      (wire) => { if (!cancelled && "autoActAt" in wire) setAct(wire.autoActAt != null); },
      () => { /* No axis read, no switch: nothing here may show a position nobody chose. */ },
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void ownModelAutoSuggest.read().then(
      (read) => { if (!cancelled) setValue(read.state === "ready" ? read.value : undefined); },
      () => { if (!cancelled) setValue(null); },
    );
    return () => { cancelled = true; };
  }, []);

  if (value === undefined) return null;

  const write = (next: boolean): void => {
    if (value === null || pending) return;
    setPending(true);
    setFailed(false);
    void ownModelAutoSuggest.save(next).then(
      (landed) => {
        setValue(landed);
        // Suggestions off withdraws the act in the same write (`setAutoSuggest`).
        if (!landed.on) setAct((was) => (was === null ? null : false));
        setPending(false);
      },
      () => { setFailed(true); setPending(false); },
    );
  };

  return (
    <>
      <SettingLine label={t("autoSuggestLabel")} describedBy={suggestionNote}>
        <Switch on={value?.on ?? false} label={t("autoSuggestLabel")} disabled={value === null || pending} onChange={write} />
      </SettingLine>
      <SettingNote id={suggestionNote}>{t(value === null ? "autoSuggestOff" : autoSuggestCopyKey(value))}</SettingNote>
      {value?.provider === "opencode-go" ? (
        <SettingNote>{t("autoSuggestGoAllowance")}</SettingNote>
      ) : null}
      {/* WHERE THE MAIL GOES, said once and only when it is actually going somewhere. The engine
          knows which provider is configured; what this row is responsible for is not letting an
          automatic path be armed without the sentence being on screen at the same moment. */}
      {value?.on && value.modelReady ? (
        <SettingNote>{t("autoSuggestPrivacy")}</SettingNote>
      ) : null}
      {failed ? <p className="join-error">{t("saveFailed")}</p> : null}
      {value !== null && act !== null ? (
        <AutoActRow
          on={act}
          suggestOn={value.on}
          reader={reader}
          setAutoAct={async (enabled) => {
            const res = await consentOverBridgeStandalone.setAutoAct!(enabled);
            const on = res.autoActAt != null;
            setAct(on);
            return on;
          }}
        />
      ) : null}
    </>
  );
}
