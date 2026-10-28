import { describe, expect, it } from "vitest";
import { SyncRunner, type DrainEngine } from "../src/net/drain";

/**
 * THE PHONE'S ROUND ASKS WHAT WAITS ON THE ORGANIZER, after its sync and on its cadence: the
 * engine owns no timer, so a quiet mailbox's applied request clears only because the round polls
 * (`pollWaitingOnOrganizer`, floor-bounded inside the engine). A failed sync polls nothing.
 */
function counting(fail = false) {
  const n = { syncs: 0, polls: 0, reasks: 0 };
  const engine: DrainEngine = {
    start: async () => { n.syncs++; if (fail) throw new Error("the round failed"); },
    syncOnce: async () => { n.syncs++; if (fail) throw new Error("the round failed"); },
    hydrate: async () => undefined,
    pollWaitingOnOrganizer: () => { n.polls++; },
    reaskDueParts: () => { n.reasks++; },
  };
  return { engine, n };
}
const runner = () => new SyncRunner({ syncing: () => undefined, error: () => undefined });

describe("the phone's drain round polls what waits", () => {
  it("each round that syncs polls once and asks the due picture re-asks, after the sync", async () => {
    const { engine, n } = counting();
    const r = runner();
    await r.request(engine);
    await r.request(engine);
    expect(n).toEqual({ syncs: 2, polls: 2, reasks: 2 });
  });

  it("CONTROL: a round whose sync failed polls nothing, and an engine with no poll is a plain round", async () => {
    const failing = counting(true);
    await runner().request(failing.engine);
    expect(failing.n).toEqual({ syncs: 1, polls: 0, reasks: 0 });
    const plain: DrainEngine = { start: async () => undefined, syncOnce: async () => undefined, hydrate: async () => undefined };
    await expect(runner().request(plain)).resolves.toBeUndefined();
  });
});
