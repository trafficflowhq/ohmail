/**
 * SETTINGS → THIS INSTALL → what reaches your Ohbox, in your words.
 *
 * The sentence a model is given when it is asked where mail belongs. On a standalone install the
 * model doing that judging is one you supplied yourself, which makes this the one sentence in the
 * app that changes what your own model is told — and until recently it was the one thing about
 * screening a standalone install could read and not write.
 *
 * ── IT IS THE SAME EDITOR THE HOSTED CLIENT DRAWS ───────────────────────────────────────────
 *
 * {@link OhboxWords} is the shared control, from the shared shell, exactly as every mail surface in
 * this window is. Only the transport is supplied here: the hosted client hands it its API client,
 * this hands it `local-screening.ts`, which addresses the engine over the shell's pipe. Two editors
 * over one column is how a prefill rule drifts on one tier and not the other.
 *
 * ── NO MODEL NEEDED TO WRITE IT ─────────────────────────────────────────────────────────────
 *
 * This section is NOT gated on the pane below it. Somebody who has not set up a model — which is a
 * complete, supported way to run this app — can still say what belongs in their Ohbox, and the
 * words are there waiting the day they do. Gating it would make the sentence look like a feature of
 * the model rather than a property of the mailbox.
 *
 * ── AND IT IS OFFERED ON BOTH DOORS ─────────────────────────────────────────────────────────
 *
 * It used to be withheld on the hosted door, on the reasoning that such an account already has this
 * control in the web client it signs into. That reasoning was about the wrong window. The hosted
 * client's own copy of this section cannot render inside this app at all — it reaches for an API
 * client that is not part of this build and refuses on the first call — so withholding it here did
 * not avoid a second editor, it left that door with none. The engine forwards both verbs of this
 * route to the account, so the words this box saves are the words the hosted worker files by.
 *
 * What differs between the doors is only where the value LIVES, and therefore what an absence
 * means. The engine answers `404` on a door that keeps no such setting, and `503` while a hosted
 * account cannot be reached; those are different facts and the section says so rather than
 * vanishing in both cases. A section somebody has filled in that disappears with the network reads
 * as lost words.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsNote, SettingsSubhead } from "@ohmail/ui";

import { OhboxWords } from "../../webapp/app/shell/OhboxWords";
import { readScreening, saveOhboxBar, type ScreeningRead } from "./local-screening.js";

export function DesktopScreeningWords({
  /** Which door this install came in by. `null` while the shell has not answered yet. */
  door,
}: {
  door: "local" | "cloud" | null;
}) {
  /* THE CATALOGUE, and until this slice there was none: every sentence below was an English
     literal, so a German install read this section of its Screener pane in English while the
     shared shell's own screener copy beside it translated. `desktopScreener` is registered in
     `vite.config.ts`'s namespace list — the desktop strips any namespace not on it, and a
     namespace the sources read but the list omits throws `MISSING_MESSAGE` on first render. */
  const t = useTranslations("desktopScreener");
  const [read, setRead] = useState<ScreeningRead | null>(null);

  useEffect(() => {
    if (door === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await readScreening();
        if (!cancelled) setRead(loaded);
      } catch {
        /* A refusal the engine composed — a hosted door with nobody signed in answers one, and so
           does a route that failed for a reason it has already logged. Leave the section undrawn
           rather than showing a broken box: there is no editable value here, and an empty textarea
           over a mailbox that HAS words is the worse failure. */
        if (!cancelled) setRead(null);
      }
    })();
    return () => { cancelled = true; };
  }, [door]);

  if (read === null || read.state === "not-served") return null;

  if (read.state === "offline") {
    return (
      <>
        <SettingsSubhead>{t("wordsHead")}</SettingsSubhead>
        {/* NAMED, NOT HIDDEN. The words are on the hosted account and this install cannot reach it
            — which is a sentence somebody can act on, where an absent section is one they would
            read as their writing having gone. */}
        <SettingsNote>{t("wordsOffline")}</SettingsNote>
      </>
    );
  }

  return (
    <>
      <SettingsSubhead>{t("wordsHead")}</SettingsSubhead>
      {/* WHAT THE WORDS ACTUALLY REACH, stated in full and no wider than that.
          Both places a model is asked about a sender are covered: the filing loop, which hands
          them to the classifier for mail it cannot settle by rules, and the Screener's suggestion
          path, which hands them over the moment somebody presses the button. This paragraph was
          deliberately narrowed to the second of those for as long as the first was not true on the
          standalone door, and widening it is part of the same change that made it true.
          It does NOT promise that every message meets a model: most mail is filed by rules alone,
          and mail carrying a credential is never sent anywhere. The claim is about what happens
          WHEN a model judges — which is the claim the sentence makes. */}
      {/* "the words SIMPLY wait" went with the move — a banned word, and it was doing nothing
          the sentence needed. */}
      <SettingsNote>{t("wordsWhy")}</SettingsNote>
      <OhboxWords
        bar={read.pref.ohboxBar}
        defaultBar={read.pref.defaultBar}
        onSave={async (next) => {
          const landed = await saveOhboxBar(next);
          setRead({ state: "ready", pref: landed });
          return landed.ohboxBar;
        }}
      />
    </>
  );
}
