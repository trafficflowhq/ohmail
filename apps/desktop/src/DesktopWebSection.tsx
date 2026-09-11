/**
 * A SETTINGS PANE WHOSE CONTROLS LIVE IN A BROWSER — the honest shape for a step-up ceremony.
 * An install on the hosted door HAS a password, an authenticator, recovery codes and an
 * account that can be deleted; this window had no Security or Account pane, and an absent
 * entry reads as "this product does not have that" — for account deletion, a claim the
 * landing page contradicts. A LINK AND NOT A FORM: every control behind them is STEP-UP
 * GATED, and nothing this app can do re-asserts a factor — no password held, no authenticator
 * secret, no real browser origin for a passkey; its session was stamped exactly once, at
 * sign-in. So the door goes to the place the person is already signed in
 */

/*
 * (`DesktopMailboxes`'s conclusion, generalised). The copy says the page opens in the browser
 * BEFORE the press. The window names a PLACE, never a URL — `openWeb` takes a closed set of
 * keys and the SHELL's table decides (`native.ts` makes the argument).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsNote, SettingsRow, SettingsSection } from "@ohmail/ui";

import { openWeb, type WebPlace } from "./native.js";

export function DesktopWebSection({
  /** Which of the shell's known places this pane opens. */
  place,
  /** The `settings` catalogue keys for this pane's three sentences and its note. */
  copy,
}: {
  place: WebPlace;
  copy: { title: string; why: string; note?: string };
}) {
  const t = useTranslations("settings");
  /* The one thing that can fail here — an operating system that would not spawn a browser — said
     on the pane rather than in a toast, because the remedy (open the page yourself) is something
     the person has to read rather than glance at. */
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <SettingsSection>
      {problem ? <p className="join-error">{problem}</p> : null}
      <SettingsRow
        label={t(copy.title)}
        description={t(copy.why)}
        control={
          <Button onClick={() => void openWeb(place).catch(() => setProblem(t("webNoBrowser")))}>
            {t("webOpen")}
          </Button>
        }
      />
      {copy.note ? <SettingsNote>{t(copy.note)}</SettingsNote> : null}
    </SettingsSection>
  );
}
