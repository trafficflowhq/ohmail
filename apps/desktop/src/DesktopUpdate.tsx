/**
 * SETTINGS → ABOUT → UPDATES — the app's own update, where a person can find it.
 *
 * ── WHY THIS EXISTS, GIVEN THE MENU BAR ALREADY HAD IT ─────────────────────────────────────
 *
 * "Check for Updates…" has always been one item in the menu bar, and on a tiling Wayland
 * compositor this app draws no menu bar at all (`src-tauri/src/frame.rs`) — so on those desktops
 * the only way to ask whether your mail client is current was gone. An update affordance that
 * exists on some desktops is not an update affordance. Settings is where an app's own facts
 * belong anyway, next to the version this pane already showed.
 *
 * ── IT IS THE SAME FLOW, NOT A SECOND ONE ──────────────────────────────────────────────────
 *
 * Everything here reads one value the shell computes (`updater.rs`'s `report`) and every press
 * goes to `update_press`, which is the same function the menu item calls. So the pane cannot
 * offer a press the bar has disabled, cannot install anything the shell has not fetched and
 * minisign-verified, and cannot name a feed, a version or a file. The button's own enablement is
 * the shell's `Flow::press`, carried over verbatim rather than re-derived here.
 *
 * ── AND IT SAYS THE TRUE THING RATHER THAN THE COMFORTABLE ONE ─────────────────────────────
 *
 * Five states and six sentences, because two facts share one state: a client that is up to date
 * and a client that REFUSED an update whose version it could not confirm are both idle, and
 * "ohmail is up to date" is a lie in the second case — an update exists and this app will not
 * install it. That refusal is also the shape of this that would be OUR fault (a release signed
 * without its version stops every client), so it is precisely the one that must not read as
 * "you're fine". A window that has not seen a check finish says that too, rather than borrowing
 * the up-to-date sentence for it.
 *
 * ── WHERE IT SITS, AND FOR WHOEVER RESTYLES THIS NEXT ──────────────────────────────────────
 *
 * It renders as a subhead plus ONE row inside the About pane's existing section, using nothing
 * but `SettingsSubhead`, `SettingsRow` and `Button`. There is no layout of its own to unpick:
 * moving it to a pane of its own is moving one JSX element and taking the subhead with it, and
 * nothing outside this file knows where it is. The copy is a namespace of its own (`update`) for
 * the same reason.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsRow, SettingsSubhead } from "@ohmail/ui";

import { agoStamp } from "../../webapp/app/shell/format.js";
import {
  onUpdateState,
  updateButtonKey,
  updatePress,
  updateSentenceKey,
  updateState,
  type UpdateReport,
} from "./update.js";

/**
 * Follow the update flow: ask at mount, then listen — and let go on unmount.
 *
 * BOTH HALVES, for `mailto_claim`'s cold-start reason — the launch check runs before this bundle's
 * scripts do, so a pane that only listened would open blank after the one transition it cared
 * about had already happened.
 *
 * THIS COMPONENT MOUNTS MANY TIMES. Settings → About is opened and closed as often as somebody
 * likes, so the subscription has to be releasable; `update.ts` keeps the SHELL-side registration
 * to one for the process's life and hands back an ordinary unsubscribe, which the cleanup calls.
 * The `alive` flag stays beside it because the two guard different windows: unsubscribing closes
 * the push, and `alive` covers the pull that may still be in flight when the pane closes.
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
   * Press, then RE-READ — and the re-read is the important half.
   *
   * A press's outcome normally arrives on the event, so this could have been fire-and-forget. It
   * cannot, because there are two ways a press produces no event at all: the invoke REJECTS (an
   * older shell, a grant that dropped the command), and the shell's own `Press::Nothing` — a press
   * that raced the flow moving under it — which changes nothing and therefore announces nothing.
   * In both cases the caller has already marked the button busy, and nothing would ever un-mark it:
   * the control would sit on "Working…" until the pane was closed and reopened.
   *
   * Asking for the state afterwards answers every one of those, and it cannot go stale — it reads
   * the flow as it is now rather than replaying a moment. The report it sets is a fresh object, so
   * the effect that clears `busy` fires even when nothing about the flow changed.
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

  return (
    <>
      <SettingsSubhead>{t("subhead")}</SettingsSubhead>
      <SettingsRow
        label={t("label")}
        description={sentence}
        value={checked}
        control={
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
        }
      />
    </>
  );
}
