/**
 * A SETTINGS PANE WHOSE CONTROLS LIVE IN A BROWSER — the honest shape for a step-up ceremony.
 *
 * ── WHY THESE PANES EXIST AT ALL RATHER THAN BEING LEFT OUT ─────────────────────────────────
 *
 * An install on the hosted door HAS a password, an authenticator, recovery codes and an account
 * that can be deleted. The web client puts each of those on a named pane; this window had no
 * Security pane and no Account pane, so the whole Settings nav was shorter here than in a browser
 * tab on the same account and nothing on screen said why. An absent entry does not read as "this
 * is done elsewhere" — it reads as "this product does not have that", which for account deletion
 * is a claim the landing page contradicts.
 *
 * ── AND WHY THEY ARE A LINK AND NOT A FORM ──────────────────────────────────────────────────
 *
 * Every control behind them is STEP-UP GATED: the account demands a second factor asserted within
 * the last few minutes, and nothing this app can do re-asserts one. It holds no password, no
 * authenticator secret, and a passkey ceremony needs a real browser origin this window does not
 * have — its session was stamped with a factor exactly once, when its sign-in code was claimed. So
 * the choice is a form that would collect a password and be refused, or a door to the place where
 * the person is already signed in. `DesktopMailboxes` reached the same conclusion for the same
 * reason and this is that pane's shape, generalised.
 *
 * The copy says the page opens in the browser BEFORE the button is pressed, because a window
 * disappearing to somewhere else is a surprise worth one sentence.
 *
 * ── THE WINDOW NAMES A PLACE, NEVER A URL ───────────────────────────────────────────────────
 *
 * `openWeb` takes one of a closed set of keys and the SHELL's own table decides what each means.
 * That is the whole safety argument and it is `native.ts`'s to make: if a URL could travel from
 * here, anything that ever got a string into this page could open an arbitrary address in the
 * user's real browser, signed in to everything they are signed in to.
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
