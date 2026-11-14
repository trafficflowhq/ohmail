/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { DRAIN_MARK_HOLD_MS, markDrain } from "@ohmail/app-logic/session/drain-mark";
import {
  deriveMailState,
  growthStep,
  seedGrowth,
  stripSpeaks,
  type MailboxFacts,
  type MailState,
  type MailStateInputs,
} from "@ohmail/app-logic/mail-state/mail-state";
import { waterlineStamp } from "../app/shell/format";

/**
 * ═══ "AS OF <TIME> · CATCHING UP" — the Freshness Contract's label (INSTANT-ARCH §6.6) ═══════
 *
 * A surface rendering non-current state SAYS so: content over a stale mirror is labeled with
 * the last completed drain's own time, quietly, and the label clears the moment a drain
 * settles. Three states stay distinct — unknown is the panes' skeleton, stale is LABELED
 * content, current is plain — and the one presentation that must be unrepresentable is stale
 * content rendered as if current.
 *
 * Half one drives the LADDER (pure); half two renders the strip per key with the provider
 * mocked, which is `sync-bar-loader.test.ts`'s division of labour for its reason: the ladder's
 * precedence and the strip's wording are separate claims. The whole-shell first-frame walk is
 * `freshness-first-frame.test.tsx`.
 *
 * Watched RED, then restored:
 *  · stale-shown-as-current — deleting the ladder's stale arm: "a stale mirror is labeled"
 *    fails (quiet), and the strip renders nothing over days-old content.
 *  · label-stuck-after-current — inverting the arm's condition to fire on `current`: the
 *    "current is plain" guard fails.
 *  · label-without-a-time — dropping the `asOf !== null` guard: the belt test fails.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const STALE_STAMP = new Date(NOW - 3 * 24 * 60 * 60_000).toISOString(); // three days closed

const mailbox = (over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb1",
  address: "me@ohmail.test",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: new Date(NOW - 30_000).toISOString(),
  initialImportCompletedAt: new Date(NOW - 86_400_000).toISOString(),
  createdAt: new Date(NOW - 7 * 86_400_000).toISOString(),
  ...over,
});

/** The resting mirror size. Named so the `pulled` default below cannot drift from it. */
const MIRRORED_DEFAULT = 495;

const inputs = (over: Partial<MailStateInputs> = {}): MailStateInputs => ({
  sync: { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false },
  failureStreak: 3,
  freshness: { state: "stale", asOf: STALE_STAMP },
  engineFreshness: { state: "stale", asOf: STALE_STAMP },
  mailboxes: [mailbox()],
  mirrored: MIRRORED_DEFAULT,
  growth: seedGrowth(MIRRORED_DEFAULT),
  now: NOW,
  demo: false,
  ...over,
  /* `pulled` follows `mirrored` unless a case names it: that is the shape wherever no producer
     answered a count, which is every test here but the import numerator's own. */
  pulled: over.pulled ?? over.mirrored ?? MIRRORED_DEFAULT,
});

describe("the ladder's stale arm", () => {
  it("a stale mirror is LABELED: key `stale`, the stamp carried as the sentence's time", () => {
    const s = deriveMailState(inputs());
    expect(s.key).toBe("stale");
    expect(s.asOf).toBe(STALE_STAMP);
    // Elapsed-time-driven: the arm exits when a drain settles, and the provider's clock is
    // what re-runs the ladder on a tab where nothing else moves.
    expect(s.clock).toBe(true);
    // The strip renders every non-quiet key — staleness silent is the bug.
    expect(stripSpeaks(s.key)).toBe(true);
  });

  it("current is PLAIN and unknown is the skeleton's — neither renders the label", () => {
    expect(
      deriveMailState({ ...inputs(), freshness: { state: "current", asOf: new Date(NOW).toISOString() } }).key,
    ).toBe("quiet");
    expect(
      deriveMailState({
        ...inputs(),
        freshness: { state: "unknown", asOf: null },
        // An unknown-freshness world is one no drain has settled; keep the rest quiet-shaped.
        mirrored: 0,
        growth: seedGrowth(0),
      }).key,
    ).toBe("quiet");
  });

  it("never fires without a time — a staleness claim nobody can check is not a sentence", () => {
    const s = deriveMailState({ ...inputs(), freshness: { state: "stale", asOf: null } });
    expect(s.key).not.toBe("stale");
  });

  it("loses to the frozen-loop arms — 'catching up' over a stopped or failing loop is false", () => {
    expect(
      deriveMailState({
        ...inputs(),
        sync: { bootstrapping: false, failures: 0, terminal: true, refused: false, ownerLost: false },
      }).key,
    ).toBe("stopped");
    expect(
      deriveMailState({
        ...inputs(),
        sync: { bootstrapping: false, failures: 3, terminal: false, refused: false, ownerLost: false },
      }).key,
    ).toBe("failing");
  });

  it("speaks BEFORE the mailbox probe answers — the first seconds of a stale resume are the point", () => {
    const s = deriveMailState({ ...inputs(), mailboxes: null });
    expect(s.key).toBe("stale");
  });

  it("outranks the growth states while converging: age is the more precise sentence than motion", () => {
    let g = seedGrowth(0);
    g = growthStep(g, 200, NOW - 8_000);
    g = growthStep(g, 400, NOW);
    const s = deriveMailState({ ...inputs(), mirrored: 400, growth: g });
    expect(s.key).toBe("stale");
  });

  it("the demo has no staleness to report", () => {
    expect(deriveMailState({ ...inputs(), demo: true }).key).toBe("quiet");
  });

  /**
   * A COMPLETED DRAIN IS SETTLED EVIDENCE (review round 1). On a warm stale resume this tab's
   * own loop reports `bootstrapping: true` for the whole catch-up — and `settled` used to read
   * only that, so every zero-row pane wore a skeleton over a mirror whose freshness stamp
   * proves a drain once completed. The stamp decides (the mobile rule, promoted): stale and
   * current are settled; unknown keeps the skeleton it exists for.
   * WATCHED RED by dropping the `freshness.state !== "unknown"` clause from the wrapper.
   */
  it("a drained-once mirror is SETTLED even while this tab's first drain is still running", () => {
    const bootstrapping = { bootstrapping: true, failures: 0, terminal: false, refused: false, ownerLost: false };
    expect(deriveMailState({ ...inputs(), sync: bootstrapping }).settled).toBe(true);
    expect(
      deriveMailState({
        ...inputs(),
        sync: bootstrapping,
        freshness: { state: "current", asOf: new Date(NOW).toISOString() },
        engineFreshness: { state: "current", asOf: new Date(NOW).toISOString() },
      }).settled,
    ).toBe(true);
    // Unknown — no stamp anywhere — keeps the skeleton: `settled` stays false mid-bootstrap.
    expect(
      deriveMailState({
        ...inputs(),
        sync: bootstrapping,
        freshness: { state: "unknown", asOf: null },
        engineFreshness: { state: "unknown", asOf: null },
        mirrored: 0,
        growth: seedGrowth(0),
      }).settled,
    ).toBe(false);
  });

  /**
   * SETTLED EVIDENCE IS THE RENDERED ENGINE'S OWN STAMP, never the label's probe-overridden
   * verdict (review round 2): on the desktop the sidecar's mirror can be current or stale while
   * the WINDOW engine's in-memory store is still mid-first-snapshot and empty — the label may
   * speak (staleness is the sidecar's honest fact) but nothing may call that empty store
   * settled. WATCHED RED by pointing the settled clause at `input.freshness`.
   */
  it("an upstream verdict settles nothing while the rendered engine has never drained", () => {
    const s = deriveMailState({
      ...inputs(),
      sync: { bootstrapping: true, failures: 0, terminal: false, refused: false, ownerLost: false },
      freshness: { state: "stale", asOf: STALE_STAMP },
      engineFreshness: { state: "unknown", asOf: null },
      mirrored: 0,
      growth: seedGrowth(0),
    });
    expect(s.key, "the label still speaks — the sidecar's staleness is true").toBe("stale");
    expect(s.settled, "an empty, never-drained window store was declared settled").toBe(false);
  });

  /**
   * THE HELD ANSWERS DIE WITH THE ENGINE (review round 1) — source-pinned, the house idiom for
   * wiring no renderer drives cheaply: the provider withdraws what it is holding when the engine
   * or the probe changes, and the desktop passes the freshness probe on the CLOUD door alone — a
   * stale Cloud label must never survive onto a local door's mail.
   *
   * STRENGTHENED TWICE on 2026-08-30, never relaxed, and the shape it pins moved both times:
   *
   *  · the withdrawal now covers the MAILBOX FACTS as well as the verdict, on identical
   *    reasoning — the probe is a module function on the desktop, so its identity does not change
   *    when the engine does, the effect keyed on it never fired, and the previous account's rows
   *    (addresses and `hostedMessageCount`) stood for a whole poll interval under the new mirror;
   *  · and it happens during RENDER rather than in a passive effect, because an effect runs after
   *    the commit and left exactly one painted frame pairing the old account with the new engine.
   *
   * So the pin is now on the render-phase adjustment, and it asserts THREE things a later edit
   * could quietly drop: that the identity names all three of the things that decide whose mailbox
   * this is, and that BOTH held answers are withdrawn when it changes. The behavioural half is
   * `facts-die-with-their-engine.test.tsx`, which also covers the late-answer and no-stale-frame
   * properties this line cannot see.
   */
  it("the provider withdraws the verdict AND the mailbox facts during render when the identity changes, and the desktop scopes the probe to the cloud door", async () => {
    const { readFileSync } = await import("node:fs");
    const provider = readFileSync(`${process.cwd()}/apps/webapp/app/shell/MailStateProvider.tsx`, "utf8");
    // All three things that decide whose mailbox this is.
    expect(provider).toMatch(
      /const identity = \{ engine: probeEngine, probe, freshnessProbe \};/,
    );
    // And the withdrawal of both held answers, in the render-phase branch rather than an effect.
    expect(provider).toMatch(
      /if \(changed\) \{\s*setAdopted\(identity\);\s*setFacts\(null\);\s*setProbedFreshness\(null\);\s*\}/,
    );
    /* And the ownership ref syncs in the COMMIT phase, not passively. A passive effect is
       scheduled after the commit, so a promise settling in the gap would find the ref still naming
       the identity just left and be waved through — undoing the clear two lines above. There is no
       renderer that can drive that gap, which is exactly why it is pinned here. */
    expect(provider).toMatch(/useCommitEffect\(\(\) => \{ answering\.current = adopted; \}, \[adopted\]\);/);
    const gate = readFileSync(`${process.cwd()}/apps/desktop/src/DesktopGate.tsx`, "utf8");
    expect(gate).toMatch(/engine && status\?\.mode === "cloud" \? \{ mirrorFreshness: readMirrorFreshness \}/);
  });

  it("both catalogues carry the sentence, with the time slot in it", () => {
    const en = (messages as { sync: Record<string, string> }).sync.staleAsOf;
    const deSentence = (de as { sync: Record<string, string> }).sync.staleAsOf;
    for (const sentence of [en, deSentence]) {
      expect(sentence).toContain("{time}");
    }
    expect(en).toBe("As of {time} · catching up");
    expect(deSentence).toBe("Stand {time} · wird nachgeholt");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   HALF TWO — THE STRIP'S RENDERING OF THE KEY, provider mocked (`sync-bar-loader`'s idiom).
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const QUIET: MailState = {
  key: "quiet",
  clock: false,
  count: 0,
  total: null,
  reason: null,
  errorCode: null,
  asOf: null,
  address: null,
  minutes: null,
  slow: false,
  screenerCandidate: false,
  pending: 0,
  // The filing report — `null` is the resting value and means the arm has not fired.
  filing: null,
  continuesAtFolder: null,
  settled: true,
  owed: false,
};

let current: MailState = QUIET;
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: current, refresh: () => {} }),
}));

const roots: Root[] = [];
afterEach(() => {
  roots.forEach((r) => r.unmount());
  roots.length = 0;
  document.body.innerHTML = "";
});

async function render(state: MailState): Promise<HTMLElement> {
  current = state;
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date(NOW),
        children: h(SyncBar, null),
      }),
    );
  });
  return container;
}

describe("the strip renders the stale key", () => {
  beforeEach(() => { markDrain(true); });

  it("says the sentence with the stamp's own time, busy and calm — no warning, no link", async () => {
    const c = await render({ ...QUIET, key: "stale", clock: true, count: 495, asOf: STALE_STAMP });
    // The expected time through the SAME formatter the strip uses (system zone, app locale) —
    // the assertion pins the WIRING from `asOf` into the sentence, not Intl's output shape.
    const expected = `As of ${waterlineStamp(STALE_STAMP, new Date(), "en")} · catching up`;
    expect(c.textContent).toContain(expected);
    /* The mark means a drain IS converging, not that the state says one should be — since 0.19.2
       it is mounted by the loop's own drain (`drain-mark.ts`), so this case puts one in flight
       and the case below pins the still form. */
    expect(c.querySelector(".mbx-spin"), "the label is a busy state — a drain is converging").not.toBeNull();
    expect(c.querySelector('[role="status"]'), "calm: a status region, never an alert").not.toBeNull();
    expect(c.querySelector("a"), "nothing here is actionable — the label clears itself").toBeNull();
  });

  it("the sentence stands still between drains — the label without a mark", async () => {
    vi.useFakeTimers();
    markDrain(false);
    vi.advanceTimersByTime(DRAIN_MARK_HOLD_MS + 1);
    vi.useRealTimers();
    const c = await render({ ...QUIET, key: "stale", clock: true, count: 495, asOf: STALE_STAMP });
    expect(c.textContent, "the sentence went with the mark")
      .toContain(`As of ${waterlineStamp(STALE_STAMP, new Date(), "en")} · catching up`);
    expect(c.querySelector(".mbx-spin"), "a mark over a drain that is not running").toBeNull();
  });

  it("renders nothing once current — the resting state is plain content", async () => {
    const c = await render(QUIET);
    expect(c.textContent ?? "").not.toContain("catching up");
  });
});
