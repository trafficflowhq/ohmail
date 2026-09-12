import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineMessage,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import { DESKTOP_WINDOW } from "../../webapp/app/shell/store-windows.js";

/**
 * ═══ THE DESKTOP RENDERER'S MIRROR IS BOUNDED BY A WINDOW, NOT BY THE MAILBOX ════════════════
 *
 * The standalone window passed no `storePolicy`, whose absent branch is `full`, and `full` evicts
 * nothing ever. So the renderer held every message and every hydrated body for the life of the
 * window: measured on a large mailbox, one whole-mirror derivation cost 180–236 ms, the eager
 * pass cost minutes of one core, and RSS reached 1.5 GB — on an 8 GB laptop the kernel began
 * killing other applications.
 *
 * The mail is still all on the machine. The engine's own store keeps it and the local route table
 * serves both the reach-past read and search from it, so what this bounds is the renderer's
 * projection. That is the invariant: an import of N messages costs the renderer O(window), never
 * O(N).
 *
 * Driven through a real engine over a real drain rather than by reading the source, because the
 * defect was a MISSING OPTION — a source census would have matched the constant's definition and
 * said nothing about whether the engine was handed it.
 */

const NOW = new Date("2026-09-11T20:38:00.000Z");
const HERE = dirname(fileURLToPath(import.meta.url));

function msg(id: string, i: number, daysOld?: number): EngineMessage {
  // By default every row is older than the window, so only the `minRows` floor can hold anything
  // back. `daysOld` puts the whole run INSIDE the window instead — the dense-mailbox case, where
  // the floor and `days` both admit everything and only the ceiling can decide.
  const date = daysOld === undefined
    ? new Date(NOW.getTime() - (i + 1) * 400 * 86_400_000).toISOString()
    : new Date(NOW.getTime() - daysOld * 86_400_000 - i * 60_000).toISOString();
  return {
    id,
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: `snippet ${id}`, unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

/** Drain `n` messages through an engine built the way the desktop window builds its own. */
async function mirrorAfterImport(
  n: number,
  policy: typeof DESKTOP_WINDOW | undefined,
  opts: { daysOld?: number } = {},
) {
  let seq = 0;
  let served = 0;
  const PAGE = 2000;
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const creates: SyncChange[] = [];
      const upto = Math.min(served + PAGE, n);
      for (let i = served; i < upto; i++) {
        const m = msg(`m${i}`, i, opts.daysOld);
        creates.push({ type: "message", op: "create", id: `m${i}`, seq: ++seq, updatedAt: m.updatedAt, entity: m });
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
    adapter,
    store: new MemoryMirrorStore(),
    now: () => NOW,
    ...(policy ? { storePolicy: policy } : {}),
  });
  await engine.start();
  while (served < n) await engine.syncOnce();
  await engine.syncOnce();
  return engine.read().list<EngineMessage>("message").length;
}

describe("the desktop renderer's mirror is bounded by its window", () => {
  it("is the window after an import far larger than it", async () => {
    // The incident's mailbox was far larger; 10 000 proves the bound and keeps this quick.
    const held = await mirrorAfterImport(10_000, DESKTOP_WINDOW);
    expect(held).toBe(DESKTOP_WINDOW.minRows);
  });

  /**
   * THE CONTROL FOR THE BOUND ITSELF. Without it the assertion above passes for a mailbox that
   * simply never exceeded the window, and the defect — the missing option — would read as green.
   */
  it("holds the whole mailbox when no policy is passed, which is what the defect was", async () => {
    const held = await mirrorAfterImport(10_000, undefined);
    expect(held).toBe(10_000);
    expect(held).toBeGreaterThan(DESKTOP_WINDOW.minRows);
  });

  /**
   * The option must reach the ENGINE the window runs on. The two tests above would both pass with
   * `createLocalEngine` never handed the constant, which is precisely the shape of the defect.
   */
  it("createLocalEngine hands the window to the engine it builds", () => {
    const src = readFileSync(resolve(HERE, "../src/bridge-fetch.ts"), "utf8");
    const call = src.slice(src.indexOf("export function createLocalEngine"));
    const body = call.slice(0, call.indexOf("\n}"));
    expect(body).toContain("storePolicy: DESKTOP_WINDOW");
  });

  /**
   * THE CEILING IS PART OF THE PIN. `days` with only a floor under it bounds the window by AGE and
   * not by SIZE — a mailbox dense inside ninety days sat almost entirely in a "windowed" mirror,
   * at 2.7x the floor on the rig's own large corpus. The three numbers move together or
   * the window stops being the one the changelog describes.
   */
  it("the window is a real window, floor and ceiling, and the size is the browser's", () => {
    expect(DESKTOP_WINDOW).toEqual({ mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 });
    expect(DESKTOP_WINDOW.maxRows).toBeGreaterThan(DESKTOP_WINDOW.minRows);
  });

  /**
   * AND THE CEILING BINDS ON A MAILBOX THAT IS DENSE INSIDE THE WINDOW — the case the floor and
   * `days` between them do not cover, driven through the same real drain as the guards above.
   *
   * WATCHED RED by `maxRows: 5000` (5 000 held where 10 000 is owed — the ceiling collapsing onto
   * the floor makes `days` unable to decide anything) and by removing `maxRows` (12 000 held).
   */
  it("holds the ceiling, not the mailbox, when everything is inside the window", async () => {
    const held = await mirrorAfterImport(12_000, DESKTOP_WINDOW, { daysOld: 1 });

    expect(held).toBe(DESKTOP_WINDOW.maxRows);
  });
});
