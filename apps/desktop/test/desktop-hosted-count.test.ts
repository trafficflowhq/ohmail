/**
 * THE ACCOUNT'S OWN MESSAGE COUNT, FROM THE ENGINE TO THE SENTENCE ON SCREEN.
 *
 * The window's strip can only say how much of the account this device is holding if a number
 * measured somewhere else survives four narrowings: the engine's `GET /mailboxes` answer, the
 * `MailboxWire` shape, the `MailboxFacts` the shell's ladder reads, and the `MailState` the strip
 * renders. Every one of them is a hand-written mapping, and a field a mapping forgets is a
 * feature that compiles, passes its own unit tests, and never appears.
 *
 * That is not hypothetical here: `smtpMaxSizeBytes` was dropped at exactly this seam and the
 * compose surface silently used the hosted constant instead of the user's own server's ceiling
 * for as long as it took somebody to notice. So this file drives the REAL `readMailboxFacts` over
 * a mocked pipe and then hands the result to the REAL ladder, and asserts the derived state —
 * not the intermediate shape. A dropped spread must fail here.
 *
 * Mutation-checked: delete the `hostedMessageCount` spread in `DesktopMailboxes.tsx` and the
 * end-to-end case goes red; make it `?? 0` and the absent case goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { deriveMailState, seedGrowth, type MailStateInputs } from "../../webapp/app/shell/mail-state";

let wireItems: unknown[] = [];

vi.mock("../src/bridge-fetch.js", () => ({
  bridgeFetch: async () =>
    new Response(JSON.stringify({ items: wireItems }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

const NOW = Date.parse("2026-08-21T17:00:00.000Z");

const WIRE_ROW = {
  id: "mbx-1",
  address: "someone@example.test",
  status: "connected",
  lastSyncAt: "2026-08-21T16:30:00.000Z",
  initialImportCompletedAt: "2026-08-10T09:00:00.000Z",
  createdAt: "2026-08-01T08:00:00.000Z",
};

/**
 * A settled, healthy window: one drain done, no failures, and a mirror that has not moved.
 * `seedGrowth` leaves `lastRiseAt` at `-Infinity`, which is exactly the tab this state is about
 * — one that opened onto a mirror that had already stopped.
 */
const inputs = (mailboxes: MailStateInputs["mailboxes"], mirrored: number): MailStateInputs => ({
  sync: { bootstrapping: false, failures: 0, terminal: false, refused: false },
  failureStreak: 3,
  mailboxes,
  mirrored,
  growth: seedGrowth(mirrored),
  // The resting freshness: current, stamped moments ago. The stale arm's own tests perturb it.
  freshness: { state: "current" as const, asOf: new Date(NOW - 30_000).toISOString() },
  engineFreshness: { state: "current" as const, asOf: new Date(NOW - 30_000).toISOString() },
  now: NOW,
  demo: false,
});

describe("the hosted count reaches the strip's sentence, or the seam is broken", () => {
  it("END TO END: an engine that reports 2,400 puts 2,400 in the derived state", async () => {
    const { readMailboxFacts } = await import("../src/DesktopMailboxes.js");
    wireItems = [{ ...WIRE_ROW, hostedMessageCount: 2_400 }];
    const facts = await readMailboxFacts();
    expect(facts[0]!.hostedMessageCount, "the narrowing dropped the account's own count").toBe(2_400);

    const state = deriveMailState(inputs(facts, 1_900));
    expect(state.key).toBe("behind");
    expect(state.count).toBe(1_900);
    expect(state.total).toBe(2_400);
  });

  it("an ABSENT count stays absent — never 0, and the strip then says nothing", async () => {
    // `0` here would not merely lose a fact, it would assert an empty account: the ladder's
    // comparison would read the device as ahead of the account and the state would flip to silence
    // for the wrong reason — or, with the clamp written the other way, announce a deficit of
    // minus a thousand. A local-only install and an engine that predates the field both land here.
    const { readMailboxFacts } = await import("../src/DesktopMailboxes.js");
    wireItems = [{ ...WIRE_ROW }];
    const facts = await readMailboxFacts();
    expect("hostedMessageCount" in facts[0]!).toBe(false);

    const state = deriveMailState(inputs(facts, 1_900));
    expect(state.total).toBeNull();
    expect(state.key).toBe("quiet");
  });

  it("one mailbox reporting and one silent is NO denominator — a partial sum is a wrong one", async () => {
    const { readMailboxFacts } = await import("../src/DesktopMailboxes.js");
    wireItems = [
      { ...WIRE_ROW, hostedMessageCount: 2_400 },
      { ...WIRE_ROW, id: "mbx-2", address: "other@example.test" },
    ];
    const facts = await readMailboxFacts();
    const state = deriveMailState(inputs(facts, 1_900));
    expect(state.total).toBeNull();
    expect(state.key).not.toBe("behind");
  });

  it("a caught-up device says nothing at all — the common case, and it must stay silent", async () => {
    const { readMailboxFacts } = await import("../src/DesktopMailboxes.js");
    wireItems = [{ ...WIRE_ROW, hostedMessageCount: 40_000 }];
    const facts = await readMailboxFacts();
    const state = deriveMailState(inputs(facts, 40_000));
    expect(state.key).toBe("quiet");
    expect(state.total).toBeNull();
  });
});
