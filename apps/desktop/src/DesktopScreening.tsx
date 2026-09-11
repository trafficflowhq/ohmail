/**
 * SETTINGS → SCREENER, on the desktop — the controls that decide what reaches the Ohbox.
 * The shared pane rendered EMPTY here (every control read the hosted API client and got a
 * refusal); the same three controls, over the engine — standalone answers its own database, hosted forwards
 * to the account, and nothing here asks which. One switch each way: AUTO-APPLY is hosted-only
 * (the hosted worker's scheduled pass consumes it); AUTOMATIC SUGGESTIONS is standalone-only
 * here — the hosted one spends an allowance through `/consent/settings`, the standalone one
 * asks the person's own model at the sync tail (`DesktopAutoSuggest`). `404` = no such
 * setting on this door; `503` = out of reach — a pane vanishing for both loses filled words.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsNote, SettingsRow, SettingsSubhead, Switch } from "@ohmail/ui";

/* THE ONE STAND-DOWN PREDICATE, aggregated over the roster — the same `readerStandDown` Settings
   → Mailboxes renders its banner from, and the same call the Screener pane itself makes. See
   `mail-state.ts#screenerReadOnly`. `useMailboxFacts` is the NON-throwing accessor: a surface
   mounted without the provider reads `null`, which answers "this install organizes" and leaves
   every sentence here exactly as it was. */
import { useMailboxFacts } from "../../webapp/app/shell/MailStateProvider";
import { readerHolder, screenerMode } from "../../webapp/app/shell/mail-state";

import { DesktopAutoSuggest } from "./DesktopAutoSuggest.js";
import { DesktopScreeningWords } from "./DesktopScreeningWords.js";
import {
  readScreening,
  saveScreening,
  type ScreeningPreference,
  type ScreeningRead,
} from "./local-screening.js";

export function DesktopScreening({
  /** Which door this install came in by. `null` while the shell has not answered yet. */
  door,
}: {
  door: "local" | "cloud" | null;
}) {
  /* See `DesktopScreeningWords` for why the namespace has to be on `vite.config.ts`'s list. */
  const t = useTranslations("desktopScreener");
  const readOnly = readerHolder(screenerMode(useMailboxFacts()));
  const [read, setRead] = useState<ScreeningRead | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (door === null) return;
    let cancelled = false;
    void readScreening().then(
      (loaded) => { if (!cancelled) setRead(loaded); },
      () => {
        /* A refusal the engine composed — a hosted door with nobody signed in answers one, and so
           does a route that failed for a reason it has already logged. Left undrawn rather than
           shown as a broken control: there is no editable value here, and an empty box over a
           mailbox that HAS a preference is the worse failure. */
        if (!cancelled) setRead(null);
      },
    );
    return () => { cancelled = true; };
  }, [door]);

  if (read === null || read.state === "not-served") return null;

  if (read.state === "offline") {
    return (
      <>
        <SettingsSubhead>{t("offlineHead")}</SettingsSubhead>
        {/* NAMED, NOT HIDDEN — see the header. */}
        <SettingsNote>{t("offlineNote")}</SettingsNote>
      </>
    );
  }

  const pref = read.pref;

  /**
   * Write one axis and render what came back.
   *
   * The switches show the STORED value, never the hoped-for one: the write is confirmed by
   * re-reading the response, so a refusal leaves the control where it was rather than showing a
   * setting that is not in force. There is no gate in front of this route with a more useful
   * reason to give, so a failure is one plain sentence.
   */
  const apply = (patch: Partial<ScreeningPreference>): void => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    void saveScreening(patch).then(
      (landed) => { setRead({ state: "ready", pref: landed }); setPending(false); },
      () => { setFailed(true); setPending(false); },
    );
  };

  return (
    <>
      <SettingsSubhead>{t("filedHead")}</SettingsSubhead>

      {/* ── A READER'S PANE SAYS SO, ABOVE THE CONTROLS. Measured on the released 0.13.7:
          an install reading a mailbox ohmail Cloud holds offered the posture, the
          automatic-suggestion consent and the dormancy window as though this install
          screened — all inert, none saying so. The controls STAY, deliberately: the values
          are stored on this computer and are what the install screens by the moment somebody
          takes the mailbox over, so removing them would make setting up ahead of a takeover
          impossible. What was missing is the sentence. `SettingsNote`, not an alarm — nothing
          is broken. Withheld where this install organizes: an ordinary pane is unchanged. */}
      {readOnly ? (
        <SettingsNote>
          {readOnly.name
            ? t("readerNote", { name: readOnly.name })
            : t("readerNoteUnknown")}
        </SettingsNote>
      ) : null}

      {/* THE POSTURE. Framed around RELEVANCE and never "only real people": the mechanism keeps
          service mail you act on — a receipt still lands in Receipts, an alert can stay in the
          Ohbox — and files the obvious bulk. */}
      <SettingsRow
        label={t("postureLabel")}
        description={t("postureWhy")}
        control={
          <Switch
            checked={pref.ohboxPolicy === "people_only"}
            ariaLabel={t("postureLabel")}
            onChange={(on) => apply({ ohboxPolicy: on ? "people_only" : "people_and_replied" })}
          />
        }
      />

      {/* SUGGEST FOR NEW SENDERS AUTOMATICALLY, ON THE STANDALONE DOOR ONLY — genuinely the
          other door's control, not the same one moved. On the HOSTED door this consent lives
          on the account (`/consent/settings` writes it, the hosted worker acts on it) and
          authorises spending an ALLOWANCE, so its control names a price and is the shared
          shell's (`AutoSuggestRow`, via `consentTransport` in `DesktopGate`); a second switch
          here would be two over one flag, disagreeing in the direction that costs money. On
          the STANDALONE door there is no ledger — a person's own model, a pass at the tail of
          this install's sync: a different control, gated the other way. It renders itself
          away when the engine answers 404, so the two conditions agree without an authority. */}
      {door === "local" ? <DesktopAutoSuggest /> : null}

      {/* AUTO-APPLY, ON THE HOSTED DOOR ONLY. See the header. */}
      {door === "cloud" ? (
        <SettingsRow
          label={t("autoApplyLabel")}
          description={t("autoApplyWhy")}
          control={
            <Switch
              checked={pref.screenerAutoApply}
              ariaLabel={t("autoApplyLabel")}
              onChange={(on) => apply({ screenerAutoApply: on })}
            />
          }
        />
      ) : null}

      {failed ? <p className="join-error">{t("saveFailed")}</p> : null}

      {/* THE BAR, still its own component. It carries its own read, its own save and its own
          failure line, and that is worth one extra read of the same row rather than one component
          with three: two controls that can each fail need two places to say so, or a stale
          "Saved." from one is taken as an answer about the other. It is also the only surface in
          this build whose copy is asserted to be absent from the preview artifact, and folding it
          in here would have moved that marker. */}
      <DesktopScreeningWords door={door} />
    </>
  );
}
