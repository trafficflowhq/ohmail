import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_WINDOW, createEngine } from "../app/shell/engine-config.js";

/**
 * ═══ THE BROWSER'S MIRROR IS A WINDOW, ON THE PATH THE PRODUCT BUILDS ══════════════════════
 *
 * `StorePolicy` defaults to `full` — nothing is ever evicted — and that default is deliberate:
 * the desktop tier's whole promise is that the mail is on the device, so a host that configures
 * nothing must get today's behaviour rather than a quietly truncated mailbox. A policy that
 * pruned by omission would be data loss with no error message.
 *
 * The cost of that correct default is that the browser's window exists ONLY as one option on one
 * construction call, and **the risk it carries is one-sided and silent**. Drop the option and
 * nothing fails: the app compiles, every suite stays green, every pile renders, every drain
 * converges. The single symptom is a mirror that grows back to the whole mailbox — on somebody
 * else's machine, months later, until IndexedDB's quota refuses a write nobody is watching for.
 *
 * There is no second guard behind this file. It is the only thing that fails when the option
 * goes, so it asserts the policy BEHAVIOURALLY, through the engine `createEngine` actually
 * builds, rather than by reading a field back.
 *
 * ── MUTATION-WATCHED ────────────────────────────────────────────────────────────────────────
 *
 * Removing `storePolicy: BROWSER_WINDOW` from `createEngine`'s live branch turns the first two
 * tests red (the ancient rows survive the drain). Changing `days` to 400 turns the first red on
 * its own. Both were watched, then the implementation was restored.
 */

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;

const DAY = 86_400_000;
const originalFetch = globalThis.fetch;

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function messageChange(id: string, date: string, seq: number): unknown {
  return {
    type: "message",
    op: "create",
    id,
    seq,
    updatedAt: date,
    entity: {
      id,
      accountId: "acct",
      mailboxId: "mb",
      threadId: null,
      messageIdHeader: null,
      subject: `Subject ${id}`,
      from: { name: null, address: "sender@example.test" },
      to: [],
      cc: [],
      date,
      folder: "INBOX",
      snippet: "snippet",
      unread: false,
      hasAttachments: false,
      attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null,
      labels: [],
      remoteContent: "none",
      updatedAt: date,
    },
  };
}

/**
 * One settled `/sync` page carrying `recent` rows dated today and `ancient` rows dated 200 days
 * ago — comfortably past the ninety-day edge, so nothing here turns on arithmetic near a
 * boundary.
 */
function page(recent: number, ancient: number): unknown[] {
  const changes: unknown[] = [];
  let seq = 0;
  for (let i = 0; i < recent; i++) changes.push(messageChange(`new-${i}`, iso(DAY), ++seq));
  for (let i = 0; i < ancient; i++) changes.push(messageChange(`old-${i}`, iso(200 * DAY), ++seq));
  return changes;
}

function stubSync(changes: unknown[]): void {
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/api/sync/snapshot")) {
      // No snapshot in these cases: the point here is the PRUNE pass, which runs at the end of a
      // settled delta drain either way. 404 takes `runSnapshot`'s page-1 fallback.
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no snapshot" } }), { status: 404 });
    }
    return new Response(
      JSON.stringify({
        changes: { creates: changes, updates: [], moves: [], deletes: [] },
        cursor: "AQ",
        hasMore: false,
        serverTime: new Date().toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("the live engine keeps a window, and the demo keeps everything", () => {
  it("THE REGRESSION: a drain on the live path evicts mail older than the window", async () => {
    // `minRows` is a FLOOR, so the mirror has to hold more than it before a single row can be
    // considered — which is exactly why this test is the size it is. `minRows` recent rows fill the
    // floor; the two ancient ones sort below it and are older than `days`, so they go.
    stubSync(page(BROWSER_WINDOW.minRows, 2));
    const engine = createEngine(false, ARMED);
    await engine.syncOnce();

    const reader = engine.read();
    expect(reader.get<EngineMessage>("message", "old-0"), "the 200-day-old row survived the drain")
      .toBeUndefined();
    expect(reader.get<EngineMessage>("message", "old-1")).toBeUndefined();
    // …and the window is a window, not a wipe: everything inside it is still there.
    expect(reader.list<EngineMessage>("message").length).toBe(BROWSER_WINDOW.minRows);
  });

  it("`minRows` is a floor, not a target — a mailbox at the floor keeps every old message", async () => {
    // The half that stops a quiet mailbox evicting itself down to nothing and rendering an empty
    // app to somebody whose mail is all present on the server. Same policy, same drain, one row
    // fewer, and the opposite outcome.
    stubSync(page(BROWSER_WINDOW.minRows - 2, 2));
    const engine = createEngine(false, ARMED);
    await engine.syncOnce();

    const reader = engine.read();
    expect(reader.get<EngineMessage>("message", "old-0")?.subject).toBe("Subject old-0");
    expect(reader.list<EngineMessage>("message").length).toBe(BROWSER_WINDOW.minRows);
  });

  it("the DEMO keeps everything — its policy is absent, and absent means `full`", async () => {
    // `?demo=1` is a hand-made world with a beginning; a window over it could only delete part of
    // the story Mila is being shown. The demo also returns from `createEngine` before the live
    // branch, so this is the control that proves the eviction above is the option and not the
    // engine's own behaviour.
    const engine = createEngine(true, ARMED);
    await engine.start();
    const before = engine.read().list<EngineMessage>("message").length;
    expect(before).toBeGreaterThan(0);
    await engine.syncOnce();
    expect(engine.read().list<EngineMessage>("message").length).toBe(before);
  });

  it("the window's numbers are the ones a person would defend", () => {
    // Pinned so a change is a decision somebody takes rather than a value that drifts. Ninety
    // days is a quarter of correspondence; `minRows` is a busy mailbox's few months;
    // `maxRows` is the ceiling that keeps the window a bound on SIZE and not only on AGE, and
    // it is above the floor so both halves of the rule can still decide something.
    expect(BROWSER_WINDOW).toEqual({ mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 });
    expect(BROWSER_WINDOW.maxRows).toBeGreaterThan(BROWSER_WINDOW.minRows);
  });
});
