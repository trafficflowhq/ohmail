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
 * Follow the update flow: ask once at mount, then listen.
 *
 * BOTH HALVES, for `mailto_claim`'s cold-start reason — the launch check runs before this bundle's
 * scripts do, so a pane that only listened would open blank after the one transition it cared
 * about had already happened. The listener is registered once per mount and cannot be taken back
 * (`update.ts` says why), so the setter is guarded by a mounted flag rather than by unsubscribing:
 * a stale listener that fires into a dead component would otherwise warn on every settings visit.
 */
function useUpdateReport(): { report: UpdateReport | null; press: () => Promise<void> } {
  const [report, setReport] = useState<UpdateReport | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      // Listen FIRST, then ask: a transition between the two is then heard through the listener
      // instead of falling between them. `omarchy.ts` orders its own feed the same way.
      await onUpdateState((next) => {
        if (alive.current) setReport(next);
      });
      const now = await updateState();
      if (alive.current && now !== null) setReport(now);
    })();
    return () => {
      alive.current = false;
    };
  }, []);

  /* A press that the shell refuses is swallowed. The outcome of a press is not this call's return
     value — it arrives on the event — so there is nothing here to report and nothing a person
     could do about a rejected invoke. The shell says every sentence this flow has out loud. */
  const press = useCallback(async () => {
    try {
      await updatePress();
    } catch {
      /* deliberate */
    }
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
