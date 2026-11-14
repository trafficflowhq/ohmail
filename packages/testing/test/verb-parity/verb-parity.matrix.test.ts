import { describe, expect, it } from "vitest";
import { MUTATION_KINDS } from "@ohmail/client-engine";
import { VERB_MATRIX } from "./registry.js";
import { snapshotOf, verbWorld } from "./world.js";

/**
 * THE VERB-PARITY MATRIX — three assertions per covered scenario, one shape for all of them.
 *
 * The shape is the whole point: no verb hand-derives its own notion of "worked". Every scenario
 * runs the SAME ceremony against the real in-process API (world.ts explains the rig), so the
 * flip-under-the-eyes class — a verb whose optimistic half and wire half disagree, or whose
 * effect a worker pass later unwinds — is a red test with the verb's name on it, forever:
 *
 *   (a) LANDS    — a fresh mirror bootstrapping from nothing sees the effect (server truth);
 *   (b) STICKS   — the live mirror's next full sync cycle is byte-stable AND still shows it
 *                  (the overlay is long gone, so this is the echo agreeing with the overlay);
 *   (c) SURVIVES — the real worker pass runs, the live mirror drains, and the effect still
 *                  stands on BOTH readers (or `landedAfterPass` states the transformation the
 *                  pass was ASKED to make — a fired schedule, a due resurface).
 *   (d) DURABLE  — the verb was already on disk in the durable outbox, under its own
 *                  Idempotency-Key, at the instant the adapter was asked (world.ts'
 *                  `wireWitness`).
 *
 * Failure reads: (a) red = the wire half never happened (the tag-UI class: painted locally,
 * rejected silently); (b) red = optimistic/echo divergence (the feed_mark_seen class: a row
 * that changes under the cursor one drain later); (c) red = a pass unwinding user intent (the
 * resurface flip-back class); (d) red = the verb reached the network before it reached the disk,
 * so a process killed mid-request loses an act the user has already been told happened — the
 * "decides in memory, persists afterwards" class the closing review named as its top blocker.
 * Each is a distinct defect family, which is why the legs are asserted separately instead of one
 * final read.
 *
 * Leg (d) is asserted for EVERY covered scenario and carries no per-verb opt-out, which is the
 * point of putting it here rather than in a surface's own file: the two instances the review
 * found — a Screener decision living in a `setTimeout`, a send lock living in a React ref — were
 * both surfaces deferring a verb the engine would have persisted the moment it was handed one.
 * The census cannot see a surface that never calls `mutate`, but it can make the engine's half of
 * the contract un-regressable for every verb in the vocabulary at once.
 */
describe("verb-parity matrix (real API, real passes, PGlite)", () => {
  for (const kind of MUTATION_KINDS) {
    const entry = VERB_MATRIX[kind];
    if (entry.coverage !== "covered") continue;

    describe(kind, () => {
      for (const sc of entry.scenarios) {
        it(sc.name, async () => {
          const w = await verbWorld();
          await w.engine.start();
          const ctx = await sc.seed(w);
          await w.engine.syncOnce(); // every seed is on the mirror before the verb fires

          // THE VERB, through the engine's own front door — enrichment, overlay, wire, echo.
          const pending = w.engine.mutate(sc.mutation(w, ctx));

          // (o) THE OPTIMISTIC ORACLE — read in the SAME TICK, before the promise is awaited:
          // the engine applies `mutationEffects` synchronously before its first await, so this
          // is the pure overlay. An overlay painting the wrong entity while the server stores
          // the right one is exactly the flip legs (a)–(c) cannot see (a review finding).
          if (typeof sc.optimistic === "function") {
            sc.optimistic(w.engine.read(), ctx, w);
          } else if (sc.optimistic === "landed") {
            const sync = sc.landed(w.engine.read(), ctx, w, undefined as never);
            expect(sync, "a 'landed'-reused optimistic oracle must assert synchronously").toBeUndefined();
          } // else: { none } — the reason is census-checked, never silently absent.

          const res = await pending;
          expect(res.status, `the verb was refused: ${res.error?.message ?? "(no error)"}`).toBe("confirmed");

          // (d) DURABLE BEFORE THE WIRE. `asked` guards the assertion against vacuity — a verb
          // that reached no keyed request would satisfy "never volatile" by never happening, which
          // is the `vitest run <missing-path>` shape one layer down.
          const witness = w.durableAtWire(res.key);
          expect(witness.asked, "no keyed request carried this verb — leg (d) would be vacuous")
            .toBeGreaterThan(0);
          expect(
            witness.volatile,
            "the verb reached the network before it reached the durable outbox — a kill mid-request loses it",
          ).toBe(0);

          // (a) LANDS — a second engine bootstrapping from nothing. Nothing optimistic can
          // survive into this mirror, so what it shows is what the server holds.
          await sc.landed(await w.freshStore(), ctx, w, res);

          // (b) STICKS — the flip-under-the-eyes check. The confirm already reconciled, so the
          // next full cycle must be a byte-stable no-op that still shows the effect, with no
          // mutation left pending and no overlay standing in for the mirror.
          const settled = snapshotOf(w.store);
          await w.engine.syncOnce();
          expect(snapshotOf(w.store), "the next drain changed its mind — the echo disagrees with the overlay")
            .toBe(settled);
          await sc.landed(w.store, ctx, w, res);
          expect(w.engine.pendingMutations()).toHaveLength(0);
          if (sc.local) await sc.local(w, ctx);

          // (c) SURVIVES THE WORKER — the real pass, then both readers again.
          if ("run" in sc.pass) {
            await sc.pass.run(w, ctx);
            await w.engine.syncOnce();
            const after = sc.landedAfterPass ?? sc.landed;
            await after(w.store, ctx, w, res);
            await after(await w.freshStore(), ctx, w, res);
          }
        });
      }
    });
  }
});
