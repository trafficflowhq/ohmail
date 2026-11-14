import { describe, it, expect } from "vitest";
import { showInboundQuiet } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * THE FORWARDING-DETECTION NOTICE's show rule (mail 0078) — the ONE rule both panes render by
 * (the Cloud client's Mailboxes pane and the desktop's), which is why it lives in the shared
 * shell and why every clause is bitten here rather than trusted.
 *
 * The server's pass owns the predicate (when an episode EXISTS); this function owns only when
 * a standing episode is SAID on screen: the row's health claims must hold (the copy opens with
 * "syncing works"), and a dismissal hides the episode it answered — for ever — while a NEW
 * episode, whose evidence postdates the press, shows again. Sameness holds; a state change
 * re-notifies.
 */

/** A row on which the notice SHOWS — each test below breaks exactly one clause of it. */
const showing = {
  status: "connected",
  lastSyncAt: "2026-08-29T11:00:00.000Z",
  syncBlockedSince: null as string | null,
  inboundQuietSince: "2026-08-08T00:00:00.000Z",
  inboundQuietDismissedAt: null as string | null,
};
/** The screen's clock: an hour after the row's last completed cycle. */
const NOW = Date.parse("2026-08-29T12:00:00.000Z");

describe("showInboundQuiet — the notice's show rule (mail 0078)", () => {
  it("shows on the incident's row: connected, freshly synced, a standing episode, never dismissed", () => {
    expect(showInboundQuiet(showing, NOW)).toBe(true);
  });

  it("no episode, nothing to say — and an OLDER build's absent fields read the same way", () => {
    expect(showInboundQuiet({ ...showing, inboundQuietSince: null }, NOW)).toBe(false);
    const { inboundQuietSince: _s, inboundQuietDismissedAt: _d, ...older } = showing;
    expect(showInboundQuiet(older, NOW)).toBe(false);
  });

  it("hides on every row whose health the copy would lie about: errored, disabled, blocked, never-synced", () => {
    expect(showInboundQuiet({ ...showing, status: "error" }, NOW)).toBe(false);
    expect(showInboundQuiet({ ...showing, status: "disabled" }, NOW)).toBe(false);
    expect(showInboundQuiet({ ...showing, syncBlockedSince: "2026-08-20T00:00:00.000Z" }, NOW)).toBe(false);
    expect(showInboundQuiet({ ...showing, lastSyncAt: null }, NOW)).toBe(false);
  });

  it("hides once the last completed cycle is STALE — 'syncing works' is a freshness claim, not a status read", () => {
    // The row still says `connected` and carries a real stamp; the stamp is simply days old —
    // the exact shape a dead worker leaves. Non-nullness alone kept the claim on screen through
    // an arbitrarily long outage (review finding, round 1); the freshness gate is the fix.
    expect(showInboundQuiet({ ...showing, lastSyncAt: "2026-08-26T11:00:00.000Z" }, NOW)).toBe(false);
    // And the boundary is the exported threshold, not a hidden constant: one minute inside
    // still shows.
    expect(showInboundQuiet(showing, Date.parse(showing.lastSyncAt) + 23 * 60 * 60 * 1000)).toBe(true);
  });

  it("a dismissal AFTER the episode's evidence hides it — sameness holds, however long the episode runs", () => {
    expect(showInboundQuiet({
      ...showing, inboundQuietDismissedAt: "2026-08-10T00:00:00.000Z",
    }, NOW)).toBe(false);
    // The boundary is strict: a dismissal stamped the same instant as the evidence still hides.
    expect(showInboundQuiet({
      ...showing, inboundQuietDismissedAt: showing.inboundQuietSince,
    }, NOW)).toBe(false);
  });

  it("a NEW episode postdating the dismissal shows again — mail flowed, silence returned, that is a state change", () => {
    expect(showInboundQuiet({
      ...showing,
      inboundQuietDismissedAt: "2026-08-10T00:00:00.000Z",
      inboundQuietSince: "2026-08-15T00:00:00.000Z",
    }, NOW)).toBe(true);
  });
});
