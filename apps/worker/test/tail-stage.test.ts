import net from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { DatabaseFaultError } from "@ohmail/organizer/dead-letter";
import { isShardConnectionFault } from "../src/db-fault.js";
import { tailStageRunner } from "../src/tail-stage.js";
import { senderCheckRetirement } from "@ohmail/organizer/sender-check-backfill";
import { makeAwayReplySweep } from "../src/away-reply-sweep.js";

/**
 * THE TAIL RUNNER'S DECIDING LINES, in process. Only a CONNECTION fault announces the shard: a refused
 * socket under the database tag, postgres.js's closed connection, class 08, a server shutting down or
 * full. A statement timeout, a lock timeout or a serialization failure on one account is that stage's.
 * The announcement precedes the stage's own line, and the in-pass hook tags before it classifies.
 */

const coded = (code: string): Error => Object.assign(new Error(`fixture ${code}`), { code });
const tagged = (code: string): DatabaseFaultError => new DatabaseFaultError("fixture.op", coded(code));

/* Interpolated: the push gate reads a literal `user:pw@127.0.0.1:${port}` as a credential at a real host. */
const DEAD_ROLE = "nobody";
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const owned: OwnedDb[] = [];
async function deadDb(): Promise<Tx> {
  const o = makeOwnedDb(`postgres://${DEAD_ROLE}:nothing@127.0.0.1:${await closedPort()}/gone`);
  owned.push(o);
  return o.db as unknown as Tx;
}
afterAll(async () => { for (const o of owned.splice(0)) await o.close(); });

/** A runner whose announcements and stage lines land in one ordered list. */
function recorded() {
  const lines: string[] = [];
  const runner = tailStageRunner((err) => { lines.push(`announce:${(err as Error).name}`); });
  return { lines, ...runner };
}

describe("which throws announce the shard's database", () => {
  it("connection faults under the tag announce", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
      "EHOSTUNREACH", "ENETUNREACH", "EPERM", "CONNECT_TIMEOUT"]) {
      expect(isShardConnectionFault(tagged(code)), code).toBe(true);
    }
  });

  it("a raw errno untagged is any remote's and announces nothing", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]) expect(isShardConnectionFault(coded(code)), code).toBe(false);
  });

  it("postgres.js's closed connection, class 08, a server shutting down and full slots announce, tagged or not", () => {
    for (const code of ["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECTION_CONNECT_TIMEOUT",
      "08006", "08001", "57P01", "57P02", "57P03", "53300"]) {
      expect(isShardConnectionFault(coded(code)), `${code} untagged`).toBe(true);
      expect(isShardConnectionFault(tagged(code)), `${code} tagged`).toBe(true);
    }
  });

  it("CONTROL: a statement timeout, a lock timeout, a serialization failure and a refused value announce nothing", () => {
    for (const code of ["57014", "55P03", "40001", "40P01", "22021", "23505", "53100", "XX000"]) {
      expect(isShardConnectionFault(tagged(code)), `${code} tagged`).toBe(false);
      expect(isShardConnectionFault(coded(code)), `${code} untagged`).toBe(false);
    }
    expect(isShardConnectionFault(new TypeError("a bug of ours")), "a bug").toBe(false);
  });
});

describe("the tail runner", () => {
  it("tags a database-only pass, so a refused socket announces BEFORE the stage's own line", async () => {
    const r = recorded();
    await r.runTailStage("fixture.pass", "database", async () => { throw coded("ECONNREFUSED"); },
      () => { r.lines.push("stage_failed"); });
    expect(r.lines).toEqual(["announce:DatabaseFaultError", "stage_failed"]);
  });

  it("does not tag a mixed pass: its bare refused socket may be the remote's", async () => {
    const r = recorded();
    await r.runTailStage("fixture.pass", "mixed", async () => { throw coded("ECONNREFUSED"); },
      () => { r.lines.push("stage_failed"); });
    expect(r.lines).toEqual(["stage_failed"]);
  });

  it("CONTROL: a statement timeout in a database-only pass is the stage's alone", async () => {
    for (const code of ["57014", "55P03", "40001"]) {
      const r = recorded();
      await r.runTailStage("fixture.pass", "database", async () => { throw coded(code); },
        () => { r.lines.push("stage_failed"); });
      expect(r.lines, code).toEqual(["stage_failed"]);
    }
  });

  it("CONTROL: a clean pass announces nothing and logs no failure", async () => {
    const r = recorded();
    await r.runTailStage("fixture.pass", "database", async () => 1, () => { r.lines.push("stage_failed"); });
    expect(r.lines).toEqual([]);
  });

  it("the in-pass hook tags the database's origin before it classifies", () => {
    const r = recorded();
    r.tailFaultNote("fixture.unit")(coded("ECONNREFUSED"));
    r.tailFaultNote("fixture.unit")(coded("57014"));
    expect(r.lines).toEqual(["announce:DatabaseFaultError"]);
  });
});

describe("the in-pass catches hand a dead database to the hook", () => {
  it("the sender-check re-arm read", async () => {
    const r = recorded();
    const tail = senderCheckRetirement({ pass: async () => ({ done: true, contactsDone: true }) as never });
    await tail.run({} as Tx, "acct-1");
    const back = await tail.enter(await deadDb(), ["acct-1"], undefined, r.tailFaultNote("fixture.rearm"));
    expect(back, "a failed read re-armed the retired account").toEqual([]);
    expect(r.lines).toEqual(["announce:DatabaseFaultError"]);
  });

  it("the away-reply sweep's per-account catch", async () => {
    const r = recorded();
    const note = r.tailFaultNote("fixture.away");
    const run = await makeAwayReplySweep().runOnce(await deadDb(), ["acct-1", "acct-2"], {
      onError: (_a, err) => { note(err); r.lines.push("away_failed"); },
    });
    expect(run.failed, "the sweep did not go on to the second account").toBe(2);
    expect(r.lines).toEqual(["announce:DatabaseFaultError", "away_failed", "announce:DatabaseFaultError", "away_failed"]);
  });
});
