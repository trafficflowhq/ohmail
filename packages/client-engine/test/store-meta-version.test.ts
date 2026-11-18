import type { Cursor } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  BaseMirrorStore, LAST_DRAIN_AT_META, MemoryMirrorStore, SNAPSHOT_PREFIX_SEQ_META,
  type MirrorRecord,
} from "@ohmail/client-engine";

/**
 * A store that records what reached `persist`.
 *
 * `getMeta` alone cannot prove a meta write was PERSISTED — it reads the in-memory map, which
 * `setMeta` fills before it flushes, so a `setMeta` that dropped the flush entirely would still
 * satisfy a read-back. A review found exactly that hole in the first version of this file. The
 * durable half is what the drain's completion stamp depends on across a relaunch, so it is asserted
 * against the call that carries it.
 *
 * ── WHY IT EXTENDS THE BASE AND NOT `MemoryMirrorStore` ─────────────────────────────────────
 *
 * `MemoryMirrorStore.persist()` declares NO parameters — a legal narrowing, since it ignores them
 * — so an override that records the three the base passes is not assignable to it (TS2416), and
 * `super.persist(a, b, c)` is TS2554. The first cut of this file did exactly that and ran green,
 * because vitest only transpiles and this package's tsconfig includes `src` alone:
 * **a test file in this package that does not compile still passes.** Extending the abstract base
 * lets the override match the real signature instead of fighting a narrowed one — and the file is
 * now typechecked explicitly, see the command in this commit's message.
 */
class RecordingStore extends BaseMirrorStore {
  readonly metaWrites: Array<[string, unknown]> = [];
  protected async readPersisted(): Promise<void> {
    /* nothing to hydrate */
  }
  protected async persist(
    _dirty: MirrorRecord[], _cursor: Cursor | null, metaEntries: Array<[string, unknown]>,
  ): Promise<void> {
    this.metaWrites.push(...metaEntries);
  }
  protected async wipe(): Promise<void> {
    /* in-memory only */
  }
  protected async purge(): Promise<void> {
    /* in-memory only — the base already dropped the records from the map */
  }
  protected async transact(_puts: MirrorRecord[], _deletes: string[]): Promise<void> {
    /* In-memory only, and deliberately publishing NOTHING: the contract says the caller publishes
     * to memory and only on success, so a double that wrote here would hide a base class that
     * stopped doing it. Nothing in this file exercises `commitLocal`; it is implemented because the
     * base declares it, and a test double that cannot compile is a test that cannot fail. */
  }
}

/**
 * A META WRITE IS NOT A RECORD CHANGE, AND `version()` MUST NOT MOVE FOR ONE.
 *
 * `version()` is the stamp every derived cache keys on. The shell reads it through
 * `useEngineVersion` and rebuilds the consent partition, the presentation projection and every
 * whole-mirror pile selector when it moves. `OhmailEngine.drain()` writes the drain's completion
 * timestamp through `setMeta` at the end of EVERY successful drain, including the overwhelmingly
 * common one that carried no changes — so while `setMeta` bumped, an idle client rebuilt its whole
 * view once per poll, for ever, to record a timestamp nothing derives from
 * (the project's design notes §5).
 *
 * The meta namespace is two keys — `LAST_DRAIN_AT_META` for `freshness()` and the stale-resume
 * verdict, `SNAPSHOT_PREFIX_SEQ_META` for the bootstrap's own bookkeeping — and `bucketsOf`'s
 * per-version cache is over RECORDS, which a meta write does not touch.
 *
 * A SURFACE DOES READ IT, and this file used to claim otherwise while the production comment it
 * mirrors had already been corrected: `apps/mobile`'s `mirrorSettled` reads
 * `getMeta(LAST_DRAIN_AT_META)` directly for the phone's world memo. What makes dropping the bump
 * sound is not that nobody reads meta but that nobody derives it THROUGH `version()` — mobile
 * re-reads the store per pass, on a trigger of its own. See `store.ts`'s `setMeta` and
 * `apps/mobile/src/state/world.tsx`.
 *
 * `idle-drain-derives-nothing.test.ts` owns the same invariant through the drain; this owns it at
 * the store's own door, because that is where the rule lives and where a future edit would break it.
 *
 * Mutation watched: restore `this.ver++` inside `BaseMirrorStore.setMeta` → the first assertion
 * fails with 2 where 0 is owed.
 */
describe("setMeta", () => {
  it("persists the value without moving the entity version", async () => {
    const store = new RecordingStore();
    await store.load();

    const before = store.version();
    await store.setMeta(LAST_DRAIN_AT_META, "2026-09-06T01:00:00.000Z");
    await store.setMeta(LAST_DRAIN_AT_META, "2026-09-06T01:00:08.000Z");

    expect(store.version()).toBe(before);
    // …and it is a WRITE, not a no-op: the value is readable, and it is the newer one.
    expect(store.getMeta<string>(LAST_DRAIN_AT_META)).toBe("2026-09-06T01:00:08.000Z");
    /* AND IT REACHED THE DURABLE HALF. `getMeta` above reads the in-memory map, which `setMeta`
       fills before it flushes — so a `setMeta` that dropped the flush would satisfy every
       assertion above it and lose the stamp on the next relaunch. The stamp is what
       `OhmailEngine.freshness()`, the stale-resume verdict and the phone's settled state all read,
       so its durability is the half worth asserting. */
    expect(store.metaWrites).toEqual([
      [LAST_DRAIN_AT_META, "2026-09-06T01:00:00.000Z"],
      [LAST_DRAIN_AT_META, "2026-09-06T01:00:08.000Z"],
    ]);
    /* THE ENGINE'S OWN CONSTANTS, not string literals that look like them. The first cut of this
       file asserted durability for "ohmail.lastDrainAt" — a key nothing writes; the real one is
       `LAST_DRAIN_AT_META` ("lastDrainAt"). It would have kept passing while persistence for the
       key the drain actually stamps was lost entirely, which is the only loss that matters. */
  });

  it("still moves the version for a write that touches a record", async () => {
    const store = new MemoryMirrorStore();
    await store.load();

    const before = store.version();
    await store.setMeta(SNAPSHOT_PREFIX_SEQ_META, 41);
    expect(store.version()).toBe(before);

    // The other half of the rule, so the test cannot pass by the version being frozen outright.
    await store.putLocal("message_body", "m1", { text: "hello", state: "ready", html: null });
    expect(store.version()).toBeGreaterThan(before);
    expect(store.getMeta<number>(SNAPSHOT_PREFIX_SEQ_META)).toBe(41);
  });
});
