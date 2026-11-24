import { describe, expect, it } from "vitest";
import { OhmailEngine, ohboxView } from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * `restoreOpenRow` RE-HOLDS ONLY THE ROW AN ACT JUST TOOK, AND ONLY UNTIL THE READER MOVES. Every
 * `holdOpenRow` or `releaseOpenRow` call after the act spends it — the no-op ones included: a release
 * with nothing held and a hold of a row outside New are both the reader moving (a review
 * finding, where a no-op left the token live and a later Undo held the row in New for ever).
 */

async function parkedAfterRead(): Promise<OhmailEngine> {
  const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
  await engine.start();
  expect(engine.holdOpenRow("petra")).toBe(true);
  await engine.mutate({ kind: "mark_seen", messageIds: ["petra"], unread: false, via: "glance" });
  await engine.mutate({ kind: "triage_set", messageId: "petra", state: "set_aside" });
  expect(engine.openRowHeld(), "the act ended the hold").toBeNull();
  return engine;
}

describe("the restore an act leaves", () => {
  it("CONTROL: straight after the act, the row is re-held and lands in New on its reversal", async () => {
    const engine = await parkedAfterRead();
    expect(engine.restoreOpenRow("petra")).toBe(true);
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "none" });
    expect(ohboxView(engine.read(), engine.openRowHeld()).newForYou.map((m) => m.id)).toContain("petra");
  });

  it("a release with nothing held spends it", async () => {
    const engine = await parkedAfterRead();
    engine.releaseOpenRow();
    expect(engine.restoreOpenRow("petra")).toBe(false);
  });

  it("a hold of a row that stands outside New spends it", async () => {
    const engine = await parkedAfterRead();
    expect(engine.holdOpenRow("petra")).toBe(false);
    expect(engine.restoreOpenRow("petra")).toBe(false);
  });

  it("a hold of another row spends it", async () => {
    const engine = await parkedAfterRead();
    engine.holdOpenRow("giulia");
    expect(engine.restoreOpenRow("petra")).toBe(false);
  });

  it("a row no act took is never re-held", async () => {
    const engine = await parkedAfterRead();
    expect(engine.restoreOpenRow("giulia")).toBe(false);
  });
});
