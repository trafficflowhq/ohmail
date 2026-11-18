import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  senderActivity,
  type EngineAdapter,
  type StorePolicy,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ THE WINDOW COVERS THE CUTLINE ═════════════════════════════════════════════════════════
 *
 * Dormancy decides whether a sender is still worth a decision: active ⇒ the Screener asks,
 * dormant ⇒ their mail is filed in History and it never does. The server measures that over the
 * WHOLE account; a windowed client measures it over its mirror. The two agree only while the
 * mirror holds every message the cutline reads.
 *
 * MEASURED: the dormancy dial offers 90, 180 and 365 days and the browser window keeps 90, so two
 * of the dial's three rungs put the cutline past the window by one click. At 180 days a sender
 * whose only mail is 120 days old reads ACTIVE on the server and is not in the windowed mirror at
 * all — their mail is in neither pile on this device while the server is still asking about them.
 *
 * The ruling: where the mirror is a window, the server's word decides, so the window is widened
 * to cover the cutline rather than the client answering a question it cannot see. `maxRows` is
 * untouched and still decides the size — which is what the ceiling is for.
 *
 * The twin here is `senderActivity` over the whole message set: it is the same rule the server
 * runs in SQL (`activeSenderExpr`), pinned to it by `apps/mobile/test/screener-server-parity.test.ts`.
 */

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = 86_400_000;
function daysAgo(n: number): string { return new Date(NOW.getTime() - n * DAY).toISOString(); }

let seq = 0;
function msg(id: string, date: string, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "s", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date, ...over,
  };
}
function from(address: string): EngineMessage["from"] { return { name: null, address }; }
function create(type: string, id: string, entity: unknown): SyncChange {
  return { type, op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity };
}
function adapterOf(): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "d2FybQ", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
}
async function seeded(messages: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(messages.map((m) => create("message", m.id, m)));
  return store;
}
function ids(store: MemoryMirrorStore): string[] {
  return store.entries<EngineMessage>("message").map((e) => e.id).sort();
}

/** Drain a windowed mirror, having told the engine the account's cutline (or not). */
async function prune(
  store: MemoryMirrorStore,
  policy: StorePolicy,
  cutline?: { dormancyDays?: number | null; scope?: string | null } | null,
): Promise<void> {
  const engine = new OhmailEngine({ adapter: adapterOf(), store, now: () => NOW, storePolicy: policy });
  if (cutline !== undefined) engine.setCutline(cutline);
  await engine.syncOnce();
}

const BROWSER: StorePolicy = { mode: "windowed", days: 90, minRows: 2, maxRows: 40 };
/** Ballast inside every window, so the floor is never what decides a case. */
const BALLAST = [msg("b0", daysAgo(1)), msg("b1", daysAgo(2)), msg("b2", daysAgo(3))];

describe("a cutline wider than the window", () => {
  /**
   * THE MEASURED DIVERGENCE, now closed. `quiet` has one message, 120 days old: inside a 180-day
   * cutline, outside a 90-day window. Before this, the drain evicted it and the sender was in no
   * list on this device while the server queued them.
   *
   * WATCHED RED by `return windowCutoff;` as the whole body of `ageFloor` (the row is evicted and
   * the client loses the sender) and by `Math.max` for `Math.min` in `ageFloor` (same).
   */
  it("keeps the mail the account's own dormancy setting reads", async () => {
    const quiet = msg("q1", daysAgo(120), { from: from("quiet@example.test") });
    const all = [...BALLAST, quiet];
    const store = await seeded(all);
    await prune(store, BROWSER, { dormancyDays: 180 });

    expect(ids(store)).toContain("q1");
    const server = senderActivity(all, { now: NOW, dormancyDays: 180 });
    const client = senderActivity(store.list<EngineMessage>("message"), { now: NOW, dormancyDays: 180 });
    expect(server.get("quiet@example.test")).toBe("active");
    expect(client.get("quiet@example.test")).toBe(server.get("quiet@example.test"));
  });

  /**
   * THE POSITIVE CONTROL FOR THE ORDINARY CASE: a cutline NARROWER than the window widens
   * nothing. The default is 60 days against a 90-day window, which is every account that has
   * never touched the dial — a widening that fired there would change the shipped mirror for
   * everybody.
   *
   * WATCHED RED by `Math.max` for `Math.min` in `ageFloor`: the 60-day cutline then becomes the
   * floor and m120 goes, where the 90-day window is what decides and it is already gone — so the
   * arm that proves the direction is the 80-day row, which the window keeps and a 60-day floor
   * would not.
   */
  it("never narrows the window", async () => {
    const all = [...BALLAST, msg("m80", daysAgo(80)), msg("m120", daysAgo(120))];
    const store = await seeded(all);
    await prune(store, BROWSER, { dormancyDays: 60 });

    expect(ids(store)).toContain("m80");
    expect(ids(store)).not.toContain("m120");
  });

  /**
   * AN ENGINE NOBODY TOLD is today's window exactly — the desktop's door, the demo, every
   * embedder that has no cutline to pass. Absent must never mean "keep more" or "keep less".
   *
   * WATCHED RED by `if (this.cutlineDays === null) return Number.NEGATIVE_INFINITY;` in
   * `ageFloor` (m120 survives where the window says it goes).
   */
  it("is the pre-cutline window when no cutline was ever set", async () => {
    const all = [...BALLAST, msg("m80", daysAgo(80)), msg("m120", daysAgo(120))];
    const store = await seeded(all);
    await prune(store, BROWSER);

    expect(ids(store)).toEqual(["b0", "b1", "b2", "m80"]);
  });

  /**
   * `all_time` IS A MODE, NOT A NUMBER (mail 0083): the person asked for everything to be
   * screened, so nothing retires by age — and the client cannot answer a question about mail it
   * threw away. The AGE term keeps everything and the CEILING is the only bound left, which is
   * what stops this from being an unbounded mirror.
   *
   * WATCHED RED by deleting the `cutlineAllTime` branch from `ageFloor` (the old rows go), and
   * the ceiling half by `const ceiling = Number.POSITIVE_INFINITY;` in `pruneToPolicy` (44 rows
   * kept where the ceiling says 40).
   */
  it("retires nobody by age under all_time, and the ceiling still binds", async () => {
    // OLDER THAN THE WIDEST CUTLINE (365 days), so only the MODE can be what keeps them: at
    // 300 days the 365-day cutline admits them on its own and the mode decides nothing.
    const old = Array.from({ length: 41 }, (_, i) => msg(`o${i}`, daysAgo(400 + i)));
    const store = await seeded([...BALLAST, ...old]);
    await prune(store, BROWSER, { dormancyDays: 365, scope: "all_time" });

    // 44 rows in, a ceiling of 40 — nothing went for being OLD, and four went for being numerous.
    expect(ids(store)).toHaveLength(40);
    expect(ids(store)).toContain("o0");
    expect(ids(store)).toContain("o36");
    expect(ids(store)).not.toContain("o40");
  });

  /**
   * THE SIZE BOUND IS UNTOUCHED. A 365-day cutline over a 90-day window keeps four times the age
   * and not one row more than the ceiling: `days` decides nothing past `maxRows`, which is the
   * reason the ceiling exists at all.
   *
   * WATCHED RED by deleting `i < ceiling &&` from `pruneToPolicy` (every one of the rows is
   * kept once the cutline admits them).
   */
  it("keeps at most maxRows however wide the cutline is", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => msg(`d${i}`, daysAgo(i)));
    const store = await seeded(rows);
    await prune(store, BROWSER, { dormancyDays: 365 });

    expect(ids(store)).toHaveLength(40);
  });

  /**
   * A HOST THAT SAYS NOTHING USEFUL SAYS NOTHING. `null`, a missing field and a nonsense number
   * are all "no cutline" — the safe direction, because the failure to avoid is a mirror that
   * quietly grows on a value nobody can see.
   *
   * WATCHED RED by dropping the `Number.isFinite(days)` guard from `setCutline`, which reddens
   * BOTH unusable arms and in opposite directions: `NaN` makes `Math.min(windowCutoff, NaN)` NaN
   * and every comparison against it false, so the whole mirror below the floor is evicted;
   * `Infinity` puts the floor at the beginning of time and nothing is ever evicted for being old.
   *
   * The narrow values (`0`, a negative) are here as the POSITIVE control for the shape of the
   * rule rather than for a mutation: `ageFloor` takes the wider of the two, so nothing under the
   * window can change anything, and there is no condition in the code to watch fail for them.
   */
  it("treats an absent, null or unusable dormancy value as no cutline", async () => {
    for (const cutline of [
      null,
      {},
      { dormancyDays: null },
      { dormancyDays: Number.NaN },
      { dormancyDays: Number.POSITIVE_INFINITY },
      { dormancyDays: 0 },
      { dormancyDays: -5 },
    ] as Array<{ dormancyDays?: number | null; scope?: string | null } | null>) {
      const all = [...BALLAST, msg("m80", daysAgo(80)), msg("m120", daysAgo(120))];
      const store = await seeded(all);
      await prune(store, BROWSER, cutline);
      expect(ids(store), JSON.stringify(cutline)).toEqual(["b0", "b1", "b2", "m80"]);
    }
  });

  /**
   * A FULL MIRROR IS UNTOUCHED BY ANY OF IT. The desktop tier's promise is that the mail is on
   * the device; a cutline is a reason to keep MORE and can never become a reason to prune a
   * mirror that prunes nothing.
   *
   * WATCHED RED by moving the `policy.mode !== "windowed"` early return in `pruneToPolicy` below
   * the age-floor read and evicting on it (every old row goes).
   */
  it("prunes nothing on a full mirror", async () => {
    const all = [...BALLAST, msg("m900", daysAgo(900))];
    const store = await seeded(all);
    await prune(store, { mode: "full" }, { dormancyDays: 30 });

    expect(ids(store)).toHaveLength(4);
  });
});
