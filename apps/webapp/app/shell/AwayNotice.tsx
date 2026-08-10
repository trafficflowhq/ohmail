"use client";

/**
 * THE AWAY RESPONDER'S OHBOX NOTICE — the tell for the one thing this product does that sends
 * mail on its own.
 *
 * `AwayResponderRow` (Settings → Screener) is the control; this is its visibility. Without it,
 * the only state in which mail leaves the account unprompted was legible on exactly one settings
 * pane and nowhere else — least of all on the pane its owner spends the day on. The notice is one
 * quiet line: the fact, the audience it is true for, and the way to the control.
 *
 * ── ONE READ PER TAB, HELD BY THE SHELL ──────────────────────────────────────────────────
 *
 * The responder row is REST-only and deliberately has no `/sync` entity (see the api-client
 * note on `away`), so there is no mirror to read and none may be invented for this. Instead
 * {@link useAwayNotice} issues the same `GET /away-responder` the settings row loads — ONCE per
 * shell mount — and the SHELL holds the answer, so the Ohbox can mount and unmount all day
 * without another round trip. Same-tab edits stay honest through the settings row's `onChanged`
 * echo into {@link AwayNoticeState.update}, never through a refetch. A SECOND tab keeps its
 * stale answer until reload — the same accepted cost `consent-state.ts` states for the dormancy
 * dial, and cheaper here: the stale surface is one advisory line, not a partition.
 *
 * A failed read stays silent and the notice stays absent — the pre-notice surface, not a guess.
 * The direction matters: this line claims mail is being answered on somebody's behalf, and that
 * claim may only ever come from the server's own row. There is no path from "I do not know" to
 * "replies are going out".
 *
 * ── COPY IS A SHIM, ON PURPOSE ───────────────────────────────────────────────────────────
 *
 * Literals in {@link COPY}, exactly as `AwayResponderRow` holds its own: one object, one place,
 * ready for the i18n pass. TWO sentences and not one, because the audience is part of the claim
 * — `screened_in` answers only senders already let in, and a single sentence covering both
 * audiences would be false for one of them.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { apiConfigured, away as awayApi, type AwayResponderWire } from "../api-client";
import { go } from "./routing";

type Audience = AwayResponderWire["audience"];

/** THE COPY SHIM. One object, so the i18n pass has one thing to move. */
/**
 * THE ENGLISH SENTENCES, KEPT as the shape of these three keys and not read at render — see
 * `AwayResponderRow`'s `AWAY_COPY` for why the constant survives its own migration.
 *
 * The three live under `away.notice*` rather than in a namespace of their own: they are the same
 * feature's vocabulary as the settings row's, and a reader of `de.json` should find every sentence
 * about the responder in one place.
 */
export const AWAY_NOTICE_COPY = {
  noticeScreenedIn: "Away responder is on — people you've let in get your away note.",
  noticeEveryone: "Away responder is on — everyone who writes gets your away note.",
  noticeSettings: "Away settings",
} as const;

export interface AwayNoticeState {
  /** Is the responder ON, as the server's row last answered or echoed. Resting false. */
  on: boolean;
  /** Who gets a reply — decides which sentence the notice may truthfully say. */
  audience: Audience;
  /**
   * THE SETTINGS ROW'S ECHO. `AwayResponderRow` calls this with what the SERVER answered —
   * its mount load and every save echo, never what a click asked for — so the row and this
   * notice can only agree. It is the whole of how a same-tab edit reaches the Ohbox.
   */
  update: (next: { enabled: boolean; audience: Audience }) => void;
}

/**
 * One `GET /away-responder` per shell mount, gated like the settings row: `active` is the
 * shell's `!demo && autoOptIn.supported`, and `apiConfigured()` is re-checked here so a
 * standalone install asks nothing even if a caller ever mis-wires the flag.
 */
export function useAwayNotice(active: boolean): AwayNoticeState {
  const [state, setState] = useState<{ on: boolean; audience: Audience }>({
    on: false,
    audience: "screened_in",
  });

  useEffect(() => {
    if (!active || !apiConfigured()) return;
    let alive = true;
    void (async () => {
      try {
        const wire = await awayApi.state();
        if (alive) setState({ on: wire.enabled, audience: wire.audience });
      } catch {
        // No server, or a refused read: the notice stays absent, which is the surface this
        // slice found — never a claim the server has not made.
      }
    })();
    return () => { alive = false; };
  }, [active]);

  const update = useCallback((next: { enabled: boolean; audience: Audience }) => {
    setState({ on: next.enabled, audience: next.audience });
  }, []);

  return { on: state.on, audience: state.audience, update };
}

/**
 * The deep link `initialPaneFromUrl` reads at mount: `?settings=screener` names the pane, the
 * hash names the view. `replaceState` for the parameter (no history entry for a URL edit that
 * is half of one navigation), then the ordinary `go` for the view change itself.
 */
function openAwaySettings(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("settings", "screener");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  go("settings");
}

/**
 * The line itself. Presentational on purpose: whether there is anything to say — and on which
 * install — is the shell's call (`useAwayNotice` plus the `noticeSection` gate in `AppShell`),
 * so this component renders unconditionally what it is handed and holds no state of its own.
 *
 * `role="status"`: the responder being on is exactly the kind of ambient fact a screen reader
 * should hear once and not be interrupted by.
 */
export function AwayNotice({ audience }: { audience: Audience }) {
  const t = useTranslations("away");
  return (
    <div className="ohx-notice" role="status">
      <span>{audience === "everyone" ? t("noticeEveryone") : t("noticeScreenedIn")}</span>
      <button type="button" onClick={openAwaySettings}>
        {t("noticeSettings")}
      </button>
    </div>
  );
}
