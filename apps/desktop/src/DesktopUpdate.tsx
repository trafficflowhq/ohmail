/**
 * SETTINGS → ABOUT → UPDATES — the app's own update, where a person can find it. On a tiling
 * Wayland compositor this app draws no menu bar (`src-tauri/src/frame.rs`), so "Check for
 * Updates…" was unreachable there — an update affordance that exists on some desktops is not
 * one. THE SAME FLOW, NOT A SECOND ONE: everything reads the shell's `report` and every press
 * goes to `update_press`, the menu item's own function, so the pane cannot offer a press the
 * bar has disabled, install anything unverified, or name a feed, a version or a file; the
 * button's enablement is the shell's `Flow::press`, carried over verbatim. IT SAYS THE TRUE
 * THING: an up-to-date client and one that REFUSED an update whose version it could not
 */

/*
 * confirm are both idle, and "ohmail is up to date" is a lie in the second case — precisely
 * the refusal that must not read as "you're fine". It renders as a subhead plus ONE row
 * inside the About pane (`SettingsSubhead`, `SettingsRow`, `Button`), no layout of its own;
 * the copy is its own namespace (`update`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsRow, SettingsSubhead } from "@ohmail/ui";

import { agoStamp } from "../../webapp/app/shell/format.js";
import {
  onUpdateState,
  updateButtonKey,
  updateManagedElsewhere,
  updatePress,
  updateSentenceKey,
  updateState,
  type UpdateReport,
} from "./update.js";

/**
 * Follow the update flow: ask at mount, then listen — and let go on unmount. BOTH halves, for
 * `mailto_claim`'s cold-start reason: the launch check runs before this bundle's scripts do,
 * so a pane that only listened would open blank after the one transition it cared about.
 * THIS COMPONENT MOUNTS MANY TIMES — Settings → About opens and closes freely — so the
 * subscription must be releasable; `update.ts` keeps the SHELL-side registration to one for
 * the process's life and hands back an ordinary unsubscribe. The `alive` flag guards a
 * different window: the pull that may still be in flight when the pane closes.
 */
function useUpdateReport(): { report: UpdateReport | null; press: () => Promise<void> } {
  const [report, setReport] = useState<UpdateReport | null>(null);
  /* Is this component still on screen? For the PRESS only — the subscription below tracks its own
     cancellation per effect run, for the reason that comment gives. */
  const mounted = useRef(true);
  /* HOW MANY PUSHED REPORTS HAVE LANDED. The pull and the push race, and the push can win:
     `update_state` snapshots the flow when the command runs in the shell, and a transition
     emitted a moment later can be delivered to this window BEFORE the invoke's response comes
     back. Applying that response then puts a state the app has already left back on screen — and
     since the newer state was the last one announced, nothing would correct it. So a pull applies
     only if no event arrived while it was in flight. A counter and not a timestamp: the question
     is "did anything land", and clocks are not needed to answer it. */
  const pushes = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    /* CANCELLATION IS PER EFFECT RUN, and a shared ref will not do — this was a real defect
       rather than a precaution. `StrictMode` (this app's root, `main.tsx`) replays the effect:
       setup, cleanup, setup. With a shared "am I mounted" flag the SECOND setup sets it back to
       true, so the FIRST setup's continuation — still awaiting its registration — believes it is
       live, stores its release in a closure whose cleanup has already run, and leaves a
       subscriber nothing will ever remove. One leaked setter per visit to Settings, in the exact
       build a developer is looking at. A local `let` belongs to one run and cannot be revived by
       the next. */
    let cancelled = false;
    let off: (() => void) | null = null;
    void (async () => {
      // Listen FIRST, then ask: a transition between the two is then heard through the listener
      // instead of falling between them. `omarchy.ts` orders its own feed the same way.
      const release = await onUpdateState((next) => {
        if (cancelled) return;
        pushes.current += 1;
        setReport(next);
      });
      // Cancelled while the registration was in flight: release it here, because the cleanup that
      // would have has already run.
      if (cancelled) {
        release();
        return;
      }
      off = release;
      const at = pushes.current;
      const now = await updateState();
      if (!cancelled && now !== null && pushes.current === at) setReport(now);
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  /**
   * Press, then RE-READ — and the re-read is the important half. Two ways a press produces no
   * event at all: the invoke REJECTS (an older shell, a dropped grant), and the shell's own
   * `Press::Nothing` — a press that raced the flow moving under it, changing nothing and
   * announcing nothing. In both, the button is already marked busy and nothing would un-mark
   * it: "Working…" until the pane was closed and reopened. Asking for the state afterwards
   * answers every case and cannot go stale — it reads the flow as it is now; the report set
   * is a fresh object, so the effect that clears `busy` fires even when nothing changed.
   */
  const press = useCallback(async () => {
    const at = pushes.current;
    try {
      await updatePress();
    } catch {
      /* The shell refused the press. The re-read below is what the person sees. */
    }
    const now = await updateState();
    // …unless the shell already announced something newer while the read was in flight, in which
    // case what is on screen is ahead of what came back and must stay.
    if (mounted.current && now !== null && pushes.current === at) setReport(now);
  }, []);

  return { report, press };
}

/**
 * The pane. Renders NOTHING when the shell answered nothing — a development server, the render
 * check, or the interface-preview build whose window is granted no command at all. An update
 * control with nothing behind it is the one thing a settings surface must never be.
 */
export function DesktopUpdate() {
  const t = useTranslations("update");
  const { report, press } = useUpdateReport();
  const [busy, setBusy] = useState(false);

  // The button un-busies on the next report rather than on a timer: the shell emits on every
  // transition, so the state that arrives IS the answer to the press.
  useEffect(() => {
    setBusy(false);
  }, [report]);

  if (report === null) return null;

  const sentence = t(updateSentenceKey(report), {
    version: report.version,
    offered: report.offered ?? report.version,
  });
  const buttonKey = updateButtonKey(report);
  const checked =
    report.lastCheckedAt === null
      ? t("neverChecked")
      : t("lastChecked", { when: agoStamp(new Date(report.lastCheckedAt).toISOString(), Date.now()).rel });

  /* NO CONTROL AT ALL ON A COPY SOMETHING ELSE UPDATES. A `.deb`, an `.rpm` or a Flatpak install
     cannot replace its own files, so the shell never asks the feed for one — a "Check now" there
     would be a button whose only honest state is disabled, sitting beside a sentence that has
     already said where to go. The three that CAN install keep the control in every state,
     disabled while a check runs (`updateButtonKey`). */
  const managed = updateManagedElsewhere(report);

  return (
    <>
      <SettingsSubhead>{t("subhead")}</SettingsSubhead>
      <SettingsRow
        label={t("label")}
        description={sentence}
        value={managed ? undefined : checked}
        control={
          managed ? undefined : (
            <Button
              variant={report.canInstall ? "primary" : undefined}
              /* A BUTTON LABEL MAY NOT WRAP. The row gives the description all the width it wants
                 and squeezes the control, so a two-line sentence beside "Check now" broke the words
                 across two lines — measured, not guessed. The rule belongs on the control rather
                 than in the row's stylesheet, which is shared by every settings surface. */
              style={{ whiteSpace: "nowrap" }}
              disabled={buttonKey === null || busy}
              onClick={() => {
                setBusy(true);
                void press();
              }}
            >
              {/* A press with nothing to press is DISABLED and still says what it would do — a
                  button that changes its own words while it is unavailable reads as broken. The
                  busy word is the one exception, because that is what just happened. */}
              {busy ? t("working") : t(buttonKey ?? "check")}
            </Button>
          )
        }
      />
    </>
  );
}
