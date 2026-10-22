/**
 * OPENING A MESSAGE SHOWS THE MESSAGE — the phone's body hydration, end to end.
 *
 * Driven through the SAME composition the app runs (`bootEngine` over the `SqlExecutor` seam,
 * `liveActions.openMessage`, `liveMessage`) against a REAL loopback server answering the two body
 * routes in the API's own shapes. Nothing is stubbed between the wire and the row a screen reads.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT RUNS TWICE ─────────────────────────────────────────────
 *
 * Every message opened on the shipped 0.14.1 Android build rendered `Only the preview could be
 * loaded. Reopen to try again.` — the `bodyState === "failed"` arm — while the server answered
 * `GET /messages/:id/body` with HTTP 200 and the whole text. Two separate blind spots let that
 * ship past a green suite, and this file closes both:
 *
 *  1. **The fake served no body route.** Every hydration in every mobile suite ended in the 404
 *     arm, so `failed` was the only outcome any of them had ever asserted. A defect between a 200
 *     and a rendered body had nowhere to show. The routes are in `helpers/mail-server.ts` now.
 *
 *  2. **The store double could not express the failure.** `sqlWorld` drives `node:sqlite`'s
 *     `DatabaseSync`, which is fully SYNCHRONOUS: no other JS runs between its `BEGIN` and its
 *     `COMMIT`, so two mirror writes can never overlap. The device's `withExclusiveTransactionAsync`
 *     opens a second connection and awaits, so they do — and the loser aborts with `database is
 *     locked`. Every case below therefore runs over BOTH shapes; only the second one has ever
 *     been able to fail (`helpers/expo-sqlite-shape.ts`, `src/engine/sql-queue.ts`).
 *
 * The trigger is what made it total rather than occasional: opening an UNREAD message dispatches
 * `mark_seen` in the same tick as the body hydration, so the two reach the mirror together. Every
 * message is unread the first time it is opened.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { serialSqlExecutor } from "../src/engine/sql-queue";
import { liveActions, liveMessage, type WorldView } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { expoShapedWorld } from "./helpers/expo-sqlite-shape";
import { sqlWorld } from "./helpers/pair-server";
import { arrived, CASE_MS } from "./helpers/arrived";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };

const BODY =
  "Hi Mila,\n\nwould Thursday 19:00 work instead? The kiln is booked on Wednesday.\n\nNadja";

let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, "0")}`;

/**
 * The two store shapes, behind one `MobileEngineDeps`.
 *
 * The expo entry composes the REAL {@link serialSqlExecutor} — the product's own statement runner — over
 * a database with the platform's transaction semantics, so what this suite exercises is the
 * shipped code path and not a re-implementation of it.
 */
const SHAPES: Array<{ name: string; make: () => MobileEngineDeps & { cleanup: () => void } }> = [
  {
    name: "node:sqlite (synchronous batches — cannot interleave)",
    make: () => {
      const world = sqlWorld();
      return { openExecutor: world.open, deleteDatabase: world.drop, uuid, cleanup: () => undefined };
    },
  },
  {
    name: "expo-sqlite shape (a second connection per transaction — the device)",
    make: () => {
      const world = expoShapedWorld();
      return {
        openExecutor: (name): SqlExecutor => serialSqlExecutor(world.open(name)),
        deleteDatabase: world.drop,
        uuid,
        cleanup: world.cleanup,
      };
    },
  },
];

/** The `message_body` record as the mirror holds it — the failure's own words live here. */
type BodyRec = { state?: string; text?: string; error?: string } | undefined;
const bodyRecord = (engine: { read: () => { get: <T>(t: string, id: string) => T | undefined } }, id: string): BodyRec =>
  engine.read().get<NonNullable<BodyRec>>("message_body", id);

/**
 * `state`, with the recorded reason attached when there is one — so a red run PRINTS why the
 * body could not be stored instead of reporting `'failed' !== 'ready'` and leaving the next
 * reader to go and find out. That sentence is the whole diagnosis on this defect.
 */
const stateOf = (rec: BodyRec): string => `${rec?.state}${rec?.error ? ` — ${rec.error}` : ""}`;

/** `id`'s body stored as `ready`; a red names the state the record stopped at, or its absence. */
const bodyArrives = (engine: Parameters<typeof bodyRecord>[0], id: string): Promise<void> =>
  arrived(`the body of ${id}`, () => bodyRecord(engine, id)?.state === "ready", () => {
    const rec = bodyRecord(engine, id);
    return rec === undefined ? "no body record" : stateOf(rec);
  });

let closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.reverse()) close();
  closers = [];
});

describe.each(SHAPES)("a message opened on the phone renders its body [$name]", ({ make }) => {
  /** One booted live session against a fresh mail server — the live-screens helper's shape. */
  async function liveWorldOn(fake: ReturnType<typeof mailServer>, origin: string, deps: MobileEngineDeps) {
    const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
    if (boot.kind !== "ready") throw new Error(`boot refused: ${boot.kind === "refused" ? boot.reason : ""}`);
    await boot.verifyIdentity();
    await boot.engine.start();
    const actions = liveActions({ engine: boot.engine, toast: () => undefined });
    closers.push(() => boot.store.close());
    return { ...boot, actions };
  }

  async function world() {
    const deps = make();
    closers.push(deps.cleanup);
    const fake = mailServer();
    const origin = await listen(fake.server);
    closers.push(() => fake.server.close());
    fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
    return { deps, fake, origin };
  }

  it("an UNREAD message hydrates to `full` while its mark-read rides the same tick", async () => {
    const { deps, fake, origin } = await world();
    fake.addMessage(dto("m1", { subject: "Glaze evening", unread: true }));
    fake.setBody("m1", BODY);
    const live = await liveWorldOn(fake, origin, deps);

    await live.actions.openMessage("m1");
    await bodyArrives(live.engine, "m1");

    // The wire WAS asked and DID answer — this is not a test about the server.
    expect(fake.seen.some((r) => r.method === "GET" && r.url === "/messages/m1/body")).toBe(true);
    expect(stateOf(bodyRecord(live.engine, "m1"))).toBe("ready");
    expect(bodyRecord(live.engine, "m1")?.text).toBe(BODY);

    const row = liveMessage(live.engine, "m1", view);
    expect(row?.bodyState).toBe("full");
    expect(row?.body).toBe(BODY);
  }, CASE_MS);

  it("an ALREADY-READ message hydrates too — the arm that never broke, kept honest", async () => {
    const { deps, fake, origin } = await world();
    fake.addMessage(dto("m2", { subject: "Fotos vom Grat", unread: false }));
    fake.setBody("m2", BODY);
    const live = await liveWorldOn(fake, origin, deps);

    await live.actions.openMessage("m2");
    await bodyArrives(live.engine, "m2");

    expect(stateOf(bodyRecord(live.engine, "m2"))).toBe("ready");
    expect(liveMessage(live.engine, "m2", view)?.bodyState).toBe("full");
  }, CASE_MS);

  it("a whole CONVERSATION opened at once hydrates every member through the batch route", async () => {
    const { deps, fake, origin } = await world();
    for (const id of ["t1", "t2", "t3"]) {
      fake.addMessage({ ...dto(id, { subject: "Re: kiln", unread: true }), threadId: "th-1" });
      fake.setBody(id, `${BODY} (${id})`);
    }
    const live = await liveWorldOn(fake, origin, deps);

    await live.actions.openMessage("t1");
    for (const id of ["t1", "t2", "t3"]) await bodyArrives(live.engine, id);

    for (const id of ["t1", "t2", "t3"]) {
      expect(`${id}: ${stateOf(bodyRecord(live.engine, id))}`).toBe(`${id}: ready`);
    }
  }, CASE_MS);

  it("the body SURVIVES the session — it is on disk, not only in memory", async () => {
    const { deps, fake, origin } = await world();
    fake.addMessage(dto("k1", { subject: "Kiln log", unread: true }));
    fake.setBody("k1", BODY);

    const first = await liveWorldOn(fake, origin, deps);
    await first.actions.openMessage("k1");
    // A timer-driven wait sees `ready` only after the microtasks that queue its write; the close
    // is queued behind that write (`serialSqlExecutor`), so the next store reads what this one wrote.
    await bodyArrives(first.engine, "k1");
    first.store.close();

    /*
     * THE HALF A MEMORY-ONLY ASSERTION WOULD MISS, and the half the device measured. On the
     * shipped build the mirror kept the `loading` marker on disk while memory carried the
     * outcome — so the record the reader saw and the record the next launch would read were
     * different things. Reading it back through a NEW store is what makes "hydrated" mean stored.
     */
    const second = await liveWorldOn(fake, origin, deps);
    expect(stateOf(bodyRecord(second.engine, "k1"))).toBe("ready");
    expect(bodyRecord(second.engine, "k1")?.text).toBe(BODY);
  }, CASE_MS);

  it("READING the mail does not stop the reader marking it read — the write that lost", async () => {
    const { deps, fake, origin } = await world();
    fake.addMessage(dto("r1", { subject: "Order #2214", unread: true }));
    fake.setBody("r1", BODY);
    const live = await liveWorldOn(fake, origin, deps);

    // The open and the reader's read of it on screen (in the Ohbox the open reads nothing itself).
    await live.actions.openMessage("r1");
    void live.actions.markGlanced(["r1"]);
    await bodyArrives(live.engine, "r1");
    await arrived("the mark-read PATCH on the wire", () => fake.seen.some((r) => r.method === "PATCH" && r.url === "/messages"));
    await arrived("r1 read on the server", () => fake.message("r1")?.unread === false);

    // Both halves of one gesture landed: the body is stored AND the mark-read reached the wire.
    expect(stateOf(bodyRecord(live.engine, "r1"))).toBe("ready");
    expect(fake.seen.some((r) => r.method === "PATCH" && r.url === "/messages")).toBe(true);
    expect(fake.message("r1")?.unread).toBe(false);
  }, CASE_MS);
});
