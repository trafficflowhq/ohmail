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

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsNote, SettingsRow, Switch } from "@ohmail/ui";

import {
  readAutoSuggest,
  saveAutoSuggest,
  type AutoSuggestState,
} from "./local-auto-suggest.js";

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

export function DesktopAutoSuggest() {
  /* See `DesktopScreeningWords` for why the namespace has to be on `vite.config.ts`'s list. */
  const t = useTranslations("desktopScreener");
  /**
   * NULL UNTIL THE ENGINE HAS ANSWERED WITH A VALUE, and null for ever on a door that has
   * none. ONE state for three situations, deliberately, where the neighbouring panes keep
   * two: not asked yet, no such route on this door, and a refused read. They differ in cause,
   * not in what may be drawn — there is no stored value in any of them, and the only thing
   * this row can render without one is a switch showing a position nobody chose.
   * `local-screening.ts` needs the distinction because one of ITS absences (a hosted account
   * out of reach) has a sentence worth printing; this route is answered out of a database
   * file in this process, so that case does not exist here. The load-bearing half is in the
   */

  /*
   * TRANSPORT: it must never invent a value for a door that has none — see `readAutoSuggest`.
   */
  const [value, setValue] = useState<AutoSuggestState | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readAutoSuggest().then(
      (read) => { if (!cancelled && read.state === "ready") setValue(read.value); },
      () => {
        /* A refusal the engine composed, for a reason it has already logged. Left undrawn rather
           than shown broken: there is no value here to edit, and a switch in the OFF position over
           an install that has this ON would be somebody believing they had chosen the state they
           were merely shown. */
      },
    );
    return () => { cancelled = true; };
  }, []);

  if (value === null) return null;

  const write = (next: boolean): void => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    void saveAutoSuggest(next).then(
      (landed) => { setValue(landed); setPending(false); },
      () => { setFailed(true); setPending(false); },
    );
  };

  return (
    <>
      <SettingsRow
        label={t("autoSuggestLabel")}
        description={t(autoSuggestCopyKey(value))}
        control={
          <Switch
            /* The STORED value, never the hoped-for one. This is the only record the person has of
               whether their own model is being asked unprompted. */
            checked={value.on}
            ariaLabel={t("autoSuggestLabel")}
            disabled={pending}
            onChange={write}
          />
        }
      />
      {/* WHERE THE MAIL GOES, said once and only when it is actually going somewhere. The engine
          knows which provider is configured; what this row is responsible for is not letting an
          automatic path be armed without the sentence being on screen at the same moment. */}
      {value.on && value.modelReady ? (
        <SettingsNote>{t("autoSuggestPrivacy")}</SettingsNote>
      ) : null}
      {failed ? <p className="join-error">{t("saveFailed")}</p> : null}
    </>
  );
}
