/**
 * SETTINGS → SCREENER, on the desktop — the controls that decide what reaches the Ohbox.
 *
 * The shared client has this pane and it rendered EMPTY here: every control in it is built around
 * the hosted API client, which is not part of this build, so each one read its value, got a
 * refusal, and drew nothing. The nav entry was there, the pane was blank, and the one setting that
 * steers the model doing the judging — your own sentence about what belongs in your Ohbox — was
 * hidden away in the install pane instead, where nobody looking for screening would find it.
 *
 * So this is the same three controls over the same three columns, with the transport this window
 * actually has: the engine on this machine, over the shell's pipe. On the standalone door the
 * engine answers out of its own database; on the hosted door it forwards to the account, bearer and
 * all, so what is saved here is what the hosted worker files by. One module, two doors, and the
 * engine decides which — nothing here has to ask.
 *
 * ── WHAT DIFFERS BY DOOR, AND IT IS ONE SWITCH EACH WAY ─────────────────────────────────────
 *
 * AUTO-APPLY belongs to the hosted door alone. Its only consumer is the scheduled pass the hosted
 * worker runs, and a standalone install runs no such pass — a switch for it there would be a
 * control that does nothing, which is worse than an absent one. The posture and the bar are
 * honoured on both doors and are offered on both.
 *
 * AUTOMATIC SUGGESTIONS go the other way, and the asymmetry is real rather than an oversight. Both
 * doors have the feature; they do not have the same one. The hosted door's spends an account's
 * credit allowance with no press, so its control is the shared shell's priced confirm, reached over
 * `/consent/settings`. The standalone door's asks a model the person configured themselves, at the
 * tail of this install's own sync, with no ledger anywhere to price against — so it is served by a
 * route that exists on this door only and drawn by `DesktopAutoSuggest`. Two features, two consents,
 * two places they are stored; one switch each, never both on one door.
 *
 * ── THREE ABSENCES, AND ONLY ONE OF THEM IS SILENT ──────────────────────────────────────────
 *
 * The engine answers `404` on a door that keeps no such setting and `503` while a hosted account
 * cannot be reached. Those are different facts: the first is "there is nothing here to show", the
 * second is "your words exist and are out of reach right now". A pane that vanished for both would
 * make a setting somebody had filled in disappear with the network, which reads as lost writing.
 */

import { useEffect, useState } from "react";
import { SettingsNote, SettingsRow, SettingsSubhead, Switch } from "@ohmail/ui";

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
        <SettingsSubhead>What reaches your Ohbox</SettingsSubhead>
        {/* NAMED, NOT HIDDEN — see the header. */}
        <SettingsNote>
          These settings live on your ohmail Cloud account, so they can&rsquo;t be changed while
          this install is offline. Your mail keeps arriving; this comes back with the connection.
        </SettingsNote>
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
      <SettingsSubhead>How your mail is filed</SettingsSubhead>

      {/* THE POSTURE. Framed around RELEVANCE and never "only real people": the mechanism keeps
          service mail you act on — a receipt still lands in Receipts, an alert can stay in the
          Ohbox — and files the obvious bulk. */}
      <SettingsRow
        label="Keep my Ohbox for what matters"
        description={
          "On: real people, plus the service mail you act on. Obvious bulk — newsletters, " +
          "promotions — goes to Reads and Receipts. Off: anything from a sender you have written " +
          "to reaches the Ohbox. It changes how the NEXT messages are filed; mail already in your " +
          "Ohbox stays where it is."
        }
        control={
          <Switch
            checked={pref.ohboxPolicy === "people_only"}
            ariaLabel="Keep my Ohbox for what matters"
            onChange={(on) => apply({ ohboxPolicy: on ? "people_only" : "people_and_replied" })}
          />
        }
      />

      {/* SUGGEST FOR NEW SENDERS AUTOMATICALLY, ON THE STANDALONE DOOR ONLY — the mirror image of
          the switch below it, and it is genuinely the other door's rather than the same one moved.

          On the HOSTED door this consent lives on the account: `/consent/settings` writes it, the
          hosted worker's cycle acts on it, and it authorises spending an ALLOWANCE, so the control
          for it names a price and is drawn by the shared shell (`AutoSuggestRow`, reached through
          `consentTransport` in `DesktopGate`). Drawing a second one here would be two switches over
          one flag, and the direction that costs money is the one where they disagree.

          On the STANDALONE door there is no account and no ledger; there is a model the person
          configured themselves and a pass at the tail of this install's own sync. Different route,
          different consumer, nothing to price — so it is a different control, gated the other way.
          It renders itself away when the engine answers 404, so this condition and that one agree
          without either having to be the authority. */}
      {door === "local" ? <DesktopAutoSuggest /> : null}

      {/* AUTO-APPLY, ON THE HOSTED DOOR ONLY. See the header. */}
      {door === "cloud" ? (
        <SettingsRow
          label="Act on suggestions for me"
          description={
            "When your account works through the senders waiting in your Screener, file the ones " +
            "it is confident about instead of leaving them for you. You can undo any of it from " +
            "the rules list."
          }
          control={
            <Switch
              checked={pref.screenerAutoApply}
              ariaLabel="Act on suggestions for me"
              onChange={(on) => apply({ screenerAutoApply: on })}
            />
          }
        />
      ) : null}

      {failed ? <p className="join-error">That did not save. Nothing has changed.</p> : null}

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
