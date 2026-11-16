import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { screenerAttemptKey } from "@trafficflow/db";
import { makeClassifierCircuit } from "../src/ai-circuit.js";
import { makeDeclineMemory, screenerAutoSuggestPass } from "@ohmail/organizer/screener-auto-suggest";
import { NOW, attemptFor, declining, gateInto, held, obligationsInto, recording, world } from "./_auto-suggest-world.js";

/**
 * THE AUTOMATIC PASS'S REFUND SURVIVES A FAILED DEBT WRITE. Composed as the worker composes it:
 * the circuit's bare `port()` and a gate. A debt write that throws still releases the refund,
 * settles nothing and is named with the account and the attempt; a settle that throws after a
 * settled refund is named, never a failed release. Mutations: let the write's throw skip the
 * release, settle an unwritten debt, rethrow the settle (all in `reverseCharge`).
 */

describe("the pass's refund survives a failed debt write", () => {
  it("a decline whose debt write THROWS: the refund is released, nothing is settled, and the line names the attempt", async () => {
    const w = await world();
    const declined = await held(w, "a@example.test", 1);
    await held(w, "b@example.test", 2);
    const events: string[] = [];
    const gate = gateInto(events);
    const obligations = obligationsInto(events, "owe");
    const log = recording();

    const r = await screenerAutoSuggestPass(w.db, {
      accountId: w.accountId, classifier: makeClassifierCircuit(declining(new Set(["a@example.test"]))).port(),
      credits: gate, obligations, log: log.logger, declines: makeDeclineMemory(), now: () => NOW,
    });

    expect(r).toMatchObject({ ran: true, bought: 1, chargedAttempts: 1 });
    expect(r.stopped).toBeUndefined();
    expect(events, "the refund was skipped when its debt could not be written").toEqual(["owe", "refund", "release"]);
    expect(gate.releases.filter((x) => x.refund)).toEqual([
      expect.objectContaining({ attemptKey: screenerAttemptKey(declined), attempt: attemptFor(gate, declined) }),
    ]);
    expect(obligations.settled, "a debt that was never written was settled").toEqual([]);
    const named = log.named("screener_auto_suggest_refund_unrecorded");
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ accountId: w.accountId, messageId: declined, attempt: attemptFor(gate, declined) });
    expect(named[0]!.droppedFields, "the log census dropped a field this line needs").toBeUndefined();
    expect(JSON.stringify(named[0]), "the line carried the sender's address").not.toContain("a@example.test");
    expect(log.named("screener_auto_suggest_release_failed")).toEqual([]);
  });

  it("a decline whose settle THROWS after a settled refund: named, and never a failed release", async () => {
    const w = await world();
    const declined = await held(w, "a@example.test", 1);
    const events: string[] = [];
    const gate = gateInto(events);
    const log = recording();

    await screenerAutoSuggestPass(w.db, {
      accountId: w.accountId, classifier: makeClassifierCircuit(declining(new Set(["a@example.test"]))).port(),
      credits: gate, obligations: obligationsInto(events, "settle"), log: log.logger,
      declines: makeDeclineMemory(), now: () => NOW,
    });

    expect(events).toEqual(["owe", "refund", "settle"]);
    const named = log.named("screener_auto_suggest_refund_settle_failed");
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ accountId: w.accountId, messageId: declined, attempt: attemptFor(gate, declined) });
    expect(named[0]!.droppedFields).toBeUndefined();
    expect(log.named("screener_auto_suggest_release_failed"), "a settled refund was reported as a failed release").toEqual([]);
  });

  it("CONTROL: a healthy decline is owed, refunded and settled, and nothing is named", async () => {
    const w = await world();
    await held(w, "a@example.test", 1);
    const events: string[] = [];
    const log = recording();
    const obligations = obligationsInto(events);

    await screenerAutoSuggestPass(w.db, {
      accountId: w.accountId, classifier: makeClassifierCircuit(declining(new Set(["a@example.test"]))).port(),
      credits: gateInto(events), obligations, log: log.logger, declines: makeDeclineMemory(), now: () => NOW,
    });

    expect(events).toEqual(["owe", "refund", "settle"]);
    expect(obligations.owed).toEqual([expect.objectContaining({ action: "screener", reason: "drafter_failed" })]);
    expect(log.named("screener_auto_suggest_refund_unrecorded")).toEqual([]);
    expect(log.named("screener_auto_suggest_refund_settle_failed")).toEqual([]);
  });
});

/* ── ONE DOOR: THE PASS CALLS THE GATE FROM ITS `releaseClaim` ONLY ────────────────────────
 * Every `release`, `owe` and `settle` (by property) and the shared `reverseCharge` (by name) in the
 * pass's file sits inside a `releaseClaim` closure: one plain release and one `reverseCharge`, and
 * no debt written beside it. Read from CALL expressions, proved on a planted fixture first.
 */
interface GateReading { inDoor: number; outside: string[] }

function readTheGateCalls(src: string, verbs: readonly string[]): GateReading {
  const sf = ts.createSourceFile("subject.ts", src, ts.ScriptTarget.Latest, true);
  const doors: ts.Node[] = [];
  const findDoors = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "releaseClaim" && n.initializer) {
      doors.push(n.initializer);
    }
    ts.forEachChild(n, findDoors);
  };
  findDoors(sf);
  const reading: GateReading = { inDoor: 0, outside: [] };
  const walk = (x: ts.Node): void => {
    if (ts.isCallExpression(x)) {
      const callee = x.expression;
      const verb = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null;
      if (verb !== null && verbs.includes(verb)) {
        if (doors.some((d) => x.pos >= d.pos && x.end <= d.end)) reading.inDoor++;
        else reading.outside.push(`${String(sf.getLineAndCharacterOfPosition(x.getStart(sf)).line + 1)}: ${callee.getText(sf)}`);
      }
    }
    ts.forEachChild(x, walk);
  };
  walk(sf);
  return reading;
}

const GATE_VERBS = ["release", "owe", "settle", "reverseCharge"] as const;

describe("one door: the pass's gate calls sit in its `releaseClaim`", () => {
  it("reads a call beside the door, by property and by name, and not a comment or a string", () => {
    const planted = `
      const pass = async (gate: G, o: O): Promise<void> => {
        const releaseClaim = async (): Promise<void> => { await gate.release(); await reverseCharge(); };
        // await o.owe() used to live here
        const s = "reverseCharge()"; void s;
        await o.settle();
        await releaseClaim();
      };`;
    expect(readTheGateCalls(planted, GATE_VERBS)).toEqual({ inDoor: 2, outside: ["6: o.settle"] });
  });

  it("the pass: one plain release and one `reverseCharge` inside the door, and no debt written beside it", () => {
    const src = readFileSync(fileURLToPath(new URL("../../../packages/organizer/src/screener-auto-suggest.ts", import.meta.url)), "utf8");
    expect(readTheGateCalls(src, GATE_VERBS)).toEqual({ inDoor: 2, outside: [] });
    expect(readTheGateCalls(src, ["reverseCharge"])).toEqual({ inDoor: 1, outside: [] });
    expect(readTheGateCalls(src, ["owe", "settle"]), "the pass writes a debt beside `reverseCharge`")
      .toEqual({ inDoor: 0, outside: [] });
  });
});
