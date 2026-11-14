import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineMessage,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";

import { DESKTOP_WINDOW } from "@ohmail/app-logic/session/store-windows";
import {
  IMPORT_END_IDLE_MS,
  deriveMailState,
  growthStep,
  isImporting,
  pulledCount,
  seedGrowth,
  wantsImportCounts,
  type MailboxFacts,
  type MailStateInputs,
  type MirrorGrowth,
} from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ═══ THE FIRST SYNC'S PROGRESS IS NOT THE WINDOW'S SIZE ═══════════════════════════════════
 *
 * Measured on the 8 GB Windows guest, 0.17.0 rc3, over a large mailbox: the app said
 * "Syncing your mail. / N messages so far" with N exactly `DESKTOP_WINDOW.minRows` — at
 * 09:53:40Z, while the engine's own log reported the store holding far more fifty seconds later,
 * and went on to land the whole mailbox in hours. The counter crept on over the next
 * twenty-four minutes and was read as a slow ingest rate, which became a CRITICAL
 * row predicting many hours. Nothing was slow. The sentence was reading the renderer's
 * PROJECTION: `pruneToPolicy` evicts everything past `minRows` that is older than `days`, so
 * over a mailbox whose mail predates the window the row count pins at the floor for ever.
 *
 * The same number was the first-run pull stage's numerator, so its remaining count, rate and
 * ETA were wrong in the same direction — `pullRate` sees no delta and returns null, and no ETA
 * ever appears.
 *
 * The window arrived in 0.17.0 (before it the standalone door passed no `storePolicy`, which is
 * `full`), which is why this is a regression and not a standing limitation.
 *
 * ── WHAT THIS FILE ASSERTS, AND WHY THROUGH A REAL ENGINE ───────────────────────────────────
 *
 * A fixture that simply "says" the floor would pass for a mirror that was never pruned at all. The
 * pin is produced here by the real `OhmailEngine` under the real `DESKTOP_WINDOW`, drained page
 * by page exactly as the window drains, so the number under test is the one the product
 * computes.
 *
 * ── MUTATION-WATCHED ────────────────────────────────────────────────────────────────────────
 *
 * `pulledCount`'s deciding line → `return mirrored` turns cases 2 and 3 red (the numerator falls
 * back to the pinned floor). Case 1 is the control: it is what makes cases 2 and 3 mean
 * something, and it stays green under that mutation because it asserts the pin itself.
 */

const NOW = new Date("2026-09-12T09:53:40.000Z");
/** Comfortably past `minRows` AND past `maxRows`, so the floor is unambiguously what pins it. */
const CORPUS = 3 * DESKTOP_WINDOW.minRows + 17;
const PAGE = 2_500;

function msg(i: number): EngineMessage {
  // Every row older than the window, which is the guest corpus's shape (October 2024 onwards
  // against a 90-day window): only the `minRows` floor can hold anything back.
  const date = new Date(NOW.getTime() - (i + 1) * 400 * 86_400_000).toISOString();
  return {
    id: `m${i}`,
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject m${i}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: `snippet m${i}`, unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

const mailbox = (over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb",
  address: "someone@example.invalid",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  organizerRole: "organizer",
  organizedBy: null,
  organizerState: null,
  lastSyncAt: NOW.toISOString(),
  createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
  // The import is OPEN — the only state in which the count is asked for at all.
  initialImportCompletedAt: null,
  ...over,
});

/** One observation per drained page: what the store holds, and what the door says it holds. */
interface Page { applied: number; held: number }

/** Drain the corpus through an engine built the way the desktop window builds its own. */
async function drainPages(): Promise<Page[]> {
  let seq = 0;
  let served = 0;
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const creates: SyncChange[] = [];
      const upto = Math.min(served + PAGE, CORPUS);
      for (let i = served; i < upto; i++) {
        const m = msg(i);
        creates.push({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m });
      }
      served = upto;
      return {
        changes: { creates, updates: [], moves: [], deletes: [] },
        cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString(),
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async (id: string) => ({ text: `FULL ${id}`, html: null, loadedRemoteContent: false }),
  } as never;

  const engine = new OhmailEngine({
    adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: DESKTOP_WINDOW,
  });
  await engine.start();

  const pages: Page[] = [];
  while (served < CORPUS) {
    await engine.syncOnce();
    // `served` is the door's own count of what it has handed over — the store the import writes
    // into. `held` is this device's projection of it.
    pages.push({ applied: served, held: engine.read().list<EngineMessage>("message").length });
  }
  return pages;
}

describe("the first sync's progress is the import, not the window", () => {
  /**
   * THE CONTROL, and the reason the two cases below are not vacuous: the mirror really does pin.
   * Without this an assertion that the numerator equals `applied` would also pass on a client
   * that simply kept the whole mailbox, where the defect cannot occur.
   */
  it("the renderer's own row count pins at the window's floor while the import runs on", async () => {
    const pages = await drainPages();
    const past = pages.filter((p) => p.applied > DESKTOP_WINDOW.maxRows);
    expect(past.length, "the corpus must exceed the ceiling for the pin to be the subject")
      .toBeGreaterThan(0);
    for (const p of past) expect(p.held).toBe(DESKTOP_WINDOW.minRows);
    // And the gap is the whole point: by the end the projection is a small fraction of the mail.
    expect(pages.at(-1)!.applied).toBe(CORPUS);
    expect(pages.at(-1)!.held).toBeLessThan(CORPUS / 2);
  });

  /**
   * THE NUMERATOR. `messageCount` is what the door answers for the store it is filling; the
   * sentence must quote that and not the projection, at every page.
   */
  it("the numerator is what the import has pulled, at every page", async () => {
    const pages = await drainPages();
    for (const p of pages) {
      const facts = [mailbox({ messageCount: p.applied })];
      expect(pulledCount(p.held, facts), `page at ${p.applied} applied`).toBe(p.applied);
    }
    // A door that answers no count at all leaves the number exactly where it is today — the
    // fallback is a lower bound, never a regression and never a fabricated number.
    const last = pages.at(-1)!;
    expect(pulledCount(last.held, [mailbox()])).toBe(last.held);
    expect(pulledCount(last.held, null)).toBe(last.held);
  });

  /**
   * AND THE EPISODE. `importing` is keyed on the count RISING, so a pinned numerator does not
   * merely print a wrong number — it lets the strip stop calling the import an import while tens
   * of thousands of messages are still arriving.
   */
  it("the growth episode stays alive on the pulled count and dies on the pinned one", async () => {
    const pages = await drainPages();
    const fold = (pick: (p: Page) => number): MirrorGrowth => {
      let g = seedGrowth(0);
      pages.forEach((p, i) => { g = growthStep(g, pick(p), NOW.getTime() + i * 1_000); });
      return g;
    };
    const at = NOW.getTime() + (pages.length - 1) * 1_000;
    // THROUGH `pulledCount`, not past it: folding `p.applied` straight in would assert a property
    // of `growthStep` and stay green with the numerator reverted, which is the shape of a guard
    // that measures nothing.
    expect(isImporting(fold((p) => pulledCount(p.held, [mailbox({ messageCount: p.applied })])), false, at))
      .toBe(true);
    // The control: the same sequence folded through the projection stops rising at the floor,
    // and the strip loses the episode — which is the second half of the defect.
    expect(isImporting(fold((p) => p.held), false, at)).toBe(false);
  });

  /**
   * THE COMPLETION TRANSITION — the moment the counter used to read BACKWARDS.
   *
   * The door stamps `initialImportCompletedAt` when the import finishes, but the episode outlives
   * the stamp by `IMPORT_END_IDLE_MS`, so the strip is still saying "importing". Sourcing the
   * aggregate from the STAMP dropped `counts=1` inside that gap, `messageCount` went undefined,
   * and `pulledCount` fell to the pinned projection — the true count read as the floor under a screen that
   * still called it an import. Step 4 is the other half: a flag that never falls arms `count(*)`
   * for ever.
   *
   * MUTATION-WATCHED: `wantsImportCounts`'s episode arm → `return false` turns steps 2 and 3 red;
   * step 4 is the control that keeps the fix from being "always true".
   */
  it("keeps asking for the count until the strip has stopped quoting it, then stops", async () => {
    const pages = await drainPages();
    const last = pages.at(-1)!;
    let g = seedGrowth(0);
    pages.forEach((p, i) => {
      g = growthStep(g, pulledCount(p.held, [mailbox({ messageCount: p.applied })]), NOW.getTime() + i * 1_000);
    });
    const settled = NOW.getTime() + (pages.length - 1) * 1_000;

    // 1. Mid-import, nothing stamped: on, for the obvious reason.
    expect(wantsImportCounts([mailbox({ messageCount: last.applied })], g, false, settled)).toBe(true);

    // 2. THE GAP: stamped, and the strip is still calling it an import.
    const stamped = [mailbox({ messageCount: last.applied, initialImportCompletedAt: NOW.toISOString() })];
    const inGap = settled + 1_000;
    expect(isImporting(g, false, inGap), "the strip must still say importing here, or this case proves nothing")
      .toBe(true);
    expect(wantsImportCounts(stamped, g, false, inGap)).toBe(true);

    // 3. So the number does not fall. The second line is the drop that WOULD have been shown —
    //    without it, `toBe(last.applied)` would also pass on a mirror that was never pruned.
    expect(pulledCount(last.held, stamped)).toBe(last.applied);
    expect(last.held).toBeLessThan(last.applied);

    // 4. Past the episode the aggregate is released.
    const after = settled + IMPORT_END_IDLE_MS + 1_000;
    expect(isImporting(g, false, after)).toBe(false);
    expect(wantsImportCounts(stamped, g, false, after)).toBe(false);
  });

  /**
   * ═══ A RELAUNCH PART-WAY THROUGH AN IMPORT ═════════════════════════════════════════════
   *
   * Can a window reopened mid-import go quiet? The latch needs two rises inside
   * `GROWTH_WINDOW_MS` and a relaunch throws the old episode away. It cannot, and the reason is
   * DATA: both surfaces that could need the episode read the mailbox's unwritten import stamp
   * first, and every door writes that stamp for ITSELF — `sync-stamp.ts` once per drained pass,
   * `cloud-mirror.ts` deliberately not copying the hosted one. The growth below is what a
   * relaunch produces and is asserted unlatched, so no pass here is the episode in disguise.
   */
  describe("a relaunch mid-import", () => {
    const relaunchGrowth = (restored: number): MirrorGrowth => seedGrowth(restored);
    const at = NOW.getTime();
    const inputs = (facts: MailboxFacts[], growth: MirrorGrowth, held: number, pulled: number): MailStateInputs => ({
      sync: { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false },
      failureStreak: 3,
      freshness: { state: "current", asOf: new Date(at - 30_000).toISOString() },
      engineFreshness: { state: "current", asOf: new Date(at - 30_000).toISOString() },
      mailboxes: facts,
      mirrored: held,
      pulled,
      growth,
      now: at,
      demo: false,
    });

    it("says nothing through the EPISODE — the state a relaunch leaves behind is unlatched", () => {
      const g = relaunchGrowth(DESKTOP_WINDOW.minRows);
      expect(g.importing, "seeded, so the cases below cannot pass through the latch").toBe(false);
      expect(isImporting(g, false, at)).toBe(false);
    });

    it("still speaks, and still counts past the window — the floor is the evidence", () => {
      const g = relaunchGrowth(DESKTOP_WINDOW.minRows);
      const applied = CORPUS;
      const facts = [mailbox({ messageCount: applied })];
      const pulled = pulledCount(DESKTOP_WINDOW.minRows, facts);

      // The count is asked for while the stamp is unwritten, so the numerator is on the wire...
      expect(wantsImportCounts(facts, g, false, at)).toBe(true);
      expect(pulled).toBe(applied);
      // ...and the strip quotes it with no episode behind it.
      const state = deriveMailState(inputs(facts, g, DESKTOP_WINDOW.minRows, pulled));
      expect(state.key).toBe("importing");
      expect(state.count).toBe(applied);
      expect(state.count).toBeGreaterThan(DESKTOP_WINDOW.minRows);
    });

    /**
     * THE CONTROL, and it is what makes the case above evidence rather than a coincidence: with
     * the stamp WRITTEN and the same unlatched growth, both surfaces fall silent. That is the
     * state a door copying somebody else's stamp would put a mid-pull install into, and it is
     * the state `cloud-mirror.ts` refuses to create.
     */
    it("a WRITTEN stamp with the same growth is the silent state — so the stamp is what decided", () => {
      const g = relaunchGrowth(DESKTOP_WINDOW.minRows);
      const facts = [mailbox({ messageCount: CORPUS, initialImportCompletedAt: NOW.toISOString() })];
      expect(wantsImportCounts(facts, g, false, at)).toBe(false);
      expect(deriveMailState(inputs(facts, g, DESKTOP_WINDOW.minRows, CORPUS)).key).not.toBe("importing");
    });
  });
});
