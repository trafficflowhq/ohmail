import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  BODIES_IDS_MAX,
  MemoryMirrorStore,
  OhmailEngine,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ A BATCH OF BODIES COSTS ONE VERSION BUMP, NOT ONE PER BODY ══════════════════════════════
 *
 * Every `putLocal` bumps the mirror version, and the shell re-runs every whole-mirror derivation
 * whenever that number moves (`useEngineVersion` -> `useSyncExternalStore`). A body used to be
 * written TWICE per id — the `loading` marker, then the answer — so the eager pass's thousand bodies
 * handed the shell a whole-mailbox derivation per write. Measured on the large rig mailbox that is minutes of
 * one core and RSS climbing into gigabytes, which is the 0.16.2 incident's pinned core and the six
 * minutes between the first sync finishing and the machine running out of memory
 * (the project's design notes).
 *
 * So the notify COUNT is the property under test, not the bodies' contents. It is the thing that
 * scales with the mailbox, and it is invisible to every test that only asks whether a body landed.
 *
 * The bound: two commits per chunk of {@link BODIES_IDS_MAX} — one for the markers, one for the
 * answers — whatever the chunk holds. Not one per body.
 */

const NOW = new Date("2026-09-11T12:00:00.000Z");
let seq = 0;

function msg(id: string, i: number): EngineMessage {
  const date = new Date(NOW.getTime() - i * 60_000).toISOString();
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

/** A feed of `n` messages whose bodies the batch route always answers. */
function world(n: number) {
  const messages = Array.from({ length: n }, (_, i) => msg(`m${i}`, i));
  let served = false;
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const creates: SyncChange[] = served ? [] : messages.map((m, i) => ({
        type: "message", op: "create", id: `m${i}`, seq: ++seq, updatedAt: m.updatedAt, entity: m,
      }));
      served = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async (id: string) => ({ text: `FULL ${id}`, html: null, loadedRemoteContent: false }),
    fetchBodies: async (ids: string[]) =>
      ids.map((id) => ({ messageId: id, text: `FULL ${id}`, html: null, loadedRemoteContent: false })),
  } as never;
  return { adapter, store: new MemoryMirrorStore() };
}

/** Drain, then run the eager pass, counting the notifies the pass alone issues. */
async function notifiesForEagerPass(n: number): Promise<{ notifies: number; bodies: number }> {
  const { adapter, store } = world(n);
  const engine = new OhmailEngine({ adapter, store, now: () => NOW, eagerBodies: true });
  await engine.start();
  await engine.syncOnce();
  let notifies = 0;
  engine.subscribe(() => { notifies += 1; });
  engine.prefetchRecentBodies();
  await engine.eagerBodiesIdle();
  return { notifies, bodies: engine.read().list("message_body").length };
}

describe("a batch of bodies costs one version bump per commit, not one per body", () => {
  it("writes every body and bumps twice per chunk", async () => {
    const n = BODIES_IDS_MAX * 5; // five full chunks
    const { notifies, bodies } = await notifiesForEagerPass(n);

    expect(bodies).toBe(n); // the bodies still land — the batching is not a silent drop
    expect(notifies).toBe(2 * 5); // one marker commit + one answer commit, per chunk
  });

  /**
   * THE PROPERTY, NOT THE NUMBER. A guard pinned to one N passes for an implementation that is
   * linear in the bodies with a small constant. Doubling the mailbox must not move the per-body
   * cost, and the per-body cost is what the incident was.
   */
  it("does not scale with the number of bodies", async () => {
    const small = await notifiesForEagerPass(BODIES_IDS_MAX * 2);
    const large = await notifiesForEagerPass(BODIES_IDS_MAX * 8);

    expect(small.bodies).toBe(BODIES_IDS_MAX * 2);
    expect(large.bodies).toBe(BODIES_IDS_MAX * 8);
    // Four times the bodies, four times the CHUNKS, and two bumps each — never 2 per body.
    expect(small.notifies).toBe(4);
    expect(large.notifies).toBe(16);
    expect(large.notifies).toBeLessThan(large.bodies);
  });
});
