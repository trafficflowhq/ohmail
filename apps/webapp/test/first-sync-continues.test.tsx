/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { MailState, MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { deriveMailState, growthStep, seedGrowth, type MailStateInputs } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ═══ THE STRIP SAYS WHERE A BUDGETED FIRST SYNC IS CONTINUING (mail 0115) ═══════════════════
 *
 * A first sync of a mailbox with many large-first folders runs in bounded passes: the count
 * stepped, then sat still, and nothing said why. The pass now writes down the folder its byte
 * budget stopped at, the DTO carries it, and the `importing` arm names it beside the count.
 *
 * TWO THINGS THIS FILE HOLDS. The derivation's rule — exactly one mailbox may name a folder,
 * because the sentence has no room to say whose it is — and the render, from the PERSISTED field
 * rather than any in-memory flag, which is the whole point: the case the sentence exists for is
 * the pass AFTER a restart.
 *
 * MUTATIONS WATCHED RED, RESTORED AND `cmp`-VERIFIED: see the lane's changes file.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null,
  asOf: null, address: null, minutes: null, slow: false, screenerCandidate: false,
  pending: 0, filing: null, continuesAtFolder: null, settled: true, owed: false,
};

let current: MailState = QUIET;
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: current, refresh: () => {} }),
}));

let root: Root | null = null;

beforeEach(() => { current = QUIET; });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  document.body.innerHTML = "";
});

async function render(state: MailState, locale: "en" | "de" = "en"): Promise<HTMLElement> {
  current = state;
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale, messages: locale === "en" ? en : de, timeZone: "UTC",
        now: new Date("2026-09-17T00:00:00.000Z"),
        children: h(SyncBar, null),
      }),
    );
  });
  return container;
}

const IMPORTING: MailState = {
  ...QUIET, key: "importing", clock: true, count: 120, total: 4000, settled: false,
};

describe("the import strip names the folder a budgeted first sync is continuing at", () => {
  it("renders the sentence beside the count, and the same words are spoken", async () => {
    const el = await render({ ...IMPORTING, continuesAtFolder: "Archive/2019" });
    const text = el.textContent ?? "";
    expect(text).toContain("120 of 4,000" + " messages");
    expect(text).toContain("first sync continues at Archive/2019");
    // ONE derivation for both faces — the announcer reads the same string, so no wording change
    // can reach the line and miss the sentence a screen reader hears.
    const spoken = [...el.querySelectorAll("[aria-atomic]")].map((n) => n.textContent ?? "");
    expect(spoken.some((s) => s.includes("first sync continues at Archive/2019"))).toBe(true);
  });

  it("says nothing at all when no pass stopped — the count stands alone", async () => {
    const el = await render(IMPORTING);
    const text = el.textContent ?? "";
    expect(text).toContain("120 of 4,000" + " messages");
    expect(text).not.toContain("continues at");
    expect(text).not.toContain("·");
  });

  it("is German in German", async () => {
    const el = await render({ ...IMPORTING, continuesAtFolder: "Archiv" }, "de");
    expect(el.textContent ?? "").toContain("erste Synchronisierung läuft bei Archiv weiter");
  });
});

/* ── THE DERIVATION ──────────────────────────────────────────────────────────────────────── */

const NOW = Date.parse("2026-09-17T12:00:00.000Z");

const mailbox = (over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb1",
  address: "desk@trafficflow.invalid",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: new Date(NOW - 30_000).toISOString(),
  initialImportCompletedAt: new Date(NOW - 30_000).toISOString(),
  createdAt: new Date(NOW - 60_000).toISOString(),
  ...over,
});

/** A mirror that is GROWING, which is the one shape the `importing` arm is the verdict for. */
function growingTo(to: number): MailStateInputs["growth"] {
  let g = seedGrowth(0);
  g = growthStep(g, Math.max(1, Math.floor(to / 2)), NOW - 8_000);
  return growthStep(g, to, NOW);
}

function importing(mailboxes: MailboxFacts[]): MailState {
  return deriveMailState({
    sync: { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false },
    failureStreak: 3,
    mailboxes,
    mirrored: 120,
    pulled: 120,
    growth: growingTo(120),
    freshness: { state: "current", asOf: new Date(NOW - 30_000).toISOString() },
    engineFreshness: { state: "current", asOf: new Date(NOW - 30_000).toISOString() },
    now: NOW,
    demo: false,
  });
}

describe("which mailbox may name the folder", () => {
  it("names it when exactly one mailbox says where it stopped", () => {
    const state = importing([mailbox({ firstSyncStopFolder: "Archive/2019" })]);
    expect(state.key).toBe("importing");
    expect(state.continuesAtFolder).toBe("Archive/2019");
  });

  it("names none when two mailboxes name different folders", () => {
    const state = importing([
      mailbox({ firstSyncStopFolder: "Archive/2019" }),
      mailbox({ id: "mb2", address: "two@trafficflow.invalid", firstSyncStopFolder: "Lists" }),
    ]);
    expect(state.key).toBe("importing");
    // The sentence has no room to say whose mailbox it is, so it names none rather than one.
    expect(state.continuesAtFolder).toBeNull();
  });

  it("an absent field, a null and an empty string are all silence", () => {
    expect(importing([mailbox()]).continuesAtFolder).toBeNull();
    expect(importing([mailbox({ firstSyncStopFolder: null })]).continuesAtFolder).toBeNull();
    expect(importing([mailbox({ firstSyncStopFolder: "" })]).continuesAtFolder).toBeNull();
  });

  it("no other state carries it — a settled mailbox names no folder", () => {
    const settled = deriveMailState({
      sync: { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false },
      failureStreak: 3,
      mailboxes: [mailbox({ firstSyncStopFolder: "Archive/2019" })],
      mirrored: 120,
      pulled: 120,
      growth: seedGrowth(120),
      freshness: { state: "current", asOf: new Date(NOW - 30_000).toISOString() },
      engineFreshness: { state: "current", asOf: new Date(NOW - 30_000).toISOString() },
      now: NOW,
      demo: false,
    });
    expect(settled.key).not.toBe("importing");
    expect(settled.continuesAtFolder).toBeNull();
  });
});
