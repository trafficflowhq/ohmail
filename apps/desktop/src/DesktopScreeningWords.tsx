/**
 * SETTINGS → THIS INSTALL → what reaches your Ohbox, in your words — the sentence a model is
 * given when asked where mail belongs; on a standalone install that model is one you supplied
 * yourself. IT IS THE SAME EDITOR THE HOSTED CLIENT DRAWS: {@link OhboxWords}, the shared
 * control, with only the transport supplied here (`local-screening.ts`, over the shell's
 * pipe) — two editors over one column is how a prefill rule drifts on one tier. NO MODEL
 * NEEDED TO WRITE IT: this section is not gated on the pane below; the words wait for the day
 * a model exists, and gating would make the sentence look like a feature of the model rather
 * than a property of the mailbox. OFFERED ON BOTH DOORS: withholding it on the hosted door
 */

/*
 * did not avoid a second editor — the hosted client's copy cannot render in this app at all —
 * it left that door with none; the engine forwards both verbs to the account, so what this
 * box saves is what the hosted worker files by. `404` = no such setting on this door; `503` =
 * the account is out of reach — different facts, said rather than vanished.
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
