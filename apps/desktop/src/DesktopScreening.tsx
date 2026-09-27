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
import { useManagedService } from "../../webapp/app/shell/managed-service";
import { TravelledChangeNote, useTravelledChange } from "../../webapp/app/shell/travelled-change";

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
  /* The auto-apply switch's words are the web switch's own entry: one switch, one sentence. */
  const ts = useTranslations("settings");
  const readOnly = readerHolder(screenerMode(useMailboxFacts()));
  const managed = useManagedService();
  const [read, setRead] = useState<ScreeningRead | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  /** What the watcher last read, handed to the words below so an applied bar reaches the box. */
  const [watched, setWatched] = useState<ScreeningPreference | null>(null);

  /* ON A READER A CHANGE IS SENT, NOT SAVED — the shared pane's sentence and its answer. */
  const change = useTravelledChange<ScreeningPreference>({
    reread: async () => {
      const r = await readScreening();
      if (r.state !== "ready") throw new Error(r.state);
      return r.pref;
    },
    onRead: (pref) => { setRead({ state: "ready", pref }); setWatched(pref); },
  });
  const heard = change.heard;

  useEffect(() => {
    if (door === null) return;
    let cancelled = false;
    void readScreening().then(
      (loaded) => {
        if (cancelled) return;
        setRead(loaded);
        if (loaded.state === "ready") heard(loaded.pref, false);
      },
      () => {
        /* A refusal the engine composed — a hosted door with nobody signed in answers one, and so
           does a route that failed for a reason it has already logged. Left undrawn rather than
           shown as a broken control: there is no editable value here, and an empty box over a
           mailbox that HAS a preference is the worse failure. */
        if (!cancelled) setRead(null);
      },
    );
    return () => { cancelled = true; };
  }, [door, heard]);

  if (read === null || read.state === "not-served") return null;

  if (read.state === "offline") {
    return (
      <>
        <SettingsSubhead>{t("offlineHead")}</SettingsSubhead>
        {/* NAMED, NOT HIDDEN — see the header. */}
        <SettingsNote>{t(managed ? "offlineNote" : "offlineNoteServer")}</SettingsNote>
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
      (landed) => { setRead({ state: "ready", pref: landed }); heard(landed, true); setPending(false); },
      () => { change.clear(); setFailed(true); setPending(false); },
    );
  };

  return (
    <>
      <SettingsSubhead>{t("filedHead")}</SettingsSubhead>

      {/* ── A READER'S PANE SAYS SO, ABOVE THE CONTROLS. Measured on the released 0.13.7:
          the posture and the window were offered as though this install screened, none saying
          so. A filing change made here is sent to the install that organizes (mail 0094), and
          the note says that; the change's own answer is the sentence under the switches.
          `SettingsNote`, not an alarm. Withheld where this install organizes. */}
      {readOnly ? (
        <SettingsNote>
          {readOnly.nobody
            ? t("readerNoteNobody")
            : readOnly.name ? t("readerNote", { name: readOnly.name }) : t("readerNoteUnknown")}
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
      {door === "local" ? <DesktopAutoSuggest reader={readOnly !== null} /> : null}

      {/* AUTO-APPLY, ON THE HOSTED DOOR ONLY. See the header. It arms the deterministic pass and
          nothing else — the act on suggestions takes its own consent, whose switch is
          the web entry under automatic suggestions on this door and sits under
          `DesktopAutoSuggest` on the standalone one. */}
      {door === "cloud" ? (
        <SettingsRow
          label={ts("screening.autoApplyTitle")}
          description={ts("screening.autoApplyDescription")}
          control={
            <Switch
              checked={pref.screenerAutoApply}
              ariaLabel={ts("screening.autoApplyTitle")}
              onChange={(on) => apply({ screenerAutoApply: on })}
            />
          }
        />
      ) : null}

      {failed ? <p className="join-error">{t("saveFailed")}</p> : null}
      <TravelledChangeNote note={change.note} />

      {/* THE BAR, still its own component. It carries its own read, its own save and its own
          failure line, and that is worth one extra read of the same row rather than one component
          with three: two controls that can each fail need two places to say so, or a stale
          "Saved." from one is taken as an answer about the other. It is also the only surface in
          this build whose copy is asserted to be absent from the preview artifact, and folding it
          in here would have moved that marker. */}
      <DesktopScreeningWords door={door} said={(landed) => heard(landed, true)} latest={watched} />
    </>
  );
}
