import { describe, expect, it } from "vitest";
import { OhmailEngine, ohboxView } from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * OPENING A ROW RE-DERIVES NOTHING. `holdOpenRow` holds only a row already in "New for you", so the
 * Ohbox reads the same with the hold as without it; the hold keeps the reader's version, and every
 * derivation keyed on it — the phone's lists, the web shell's memos, the selectors' own caches —
 * keeps its answer. Ending or switching a hold can move a row, so those move the version.
 */

async function demoEngine(): Promise<OhmailEngine> {
  const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
  await engine.start();
  return engine;
}

describe("the open-row hold and the reader's version", () => {
  it("a hold from nothing keeps the version, the derived stamp and the Ohbox's answer", async () => {
    const engine = await demoEngine();
    const v0 = engine.read().version();
    const s0 = engine.read().stampExcept(["message_body"]);
    const view0 = ohboxView(engine.read());
    let told = 0;
    const off = engine.subscribe(() => { told += 1; });
    expect(engine.holdOpenRow("petra")).toBe(true);
    off();
    expect(engine.read().version(), "the hold moved the version").toBe(v0);
    expect(engine.read().stampExcept(["message_body"])).toBe(s0);
    expect(ohboxView(engine.read()), "the same answer object").toBe(view0);
    expect(ohboxView(engine.read(), "petra").newForYou.map((m) => m.id)).toEqual(view0.newForYou.map((m) => m.id));
    expect(told, "subscribers are still told").toBe(1);
  });

  it("ending the hold, or switching it, moves the version", async () => {
    const engine = await demoEngine();
    engine.holdOpenRow("petra");
    const v1 = engine.read().version();
    engine.holdOpenRow("giulia");
    const v2 = engine.read().version();
    expect(v2, "a switch moves it").not.toBe(v1);
    engine.releaseOpenRow("giulia");
    expect(engine.read().version(), "a release moves it").not.toBe(v2);
  });

  it("the read after the hold still keeps the row in New, and the release files it in Earlier", async () => {
    const engine = await demoEngine();
    engine.holdOpenRow("petra");
    await engine.mutate({ kind: "mark_seen", messageIds: ["petra"], unread: false, via: "glance" });
    expect(ohboxView(engine.read(), engine.openRowHeld()).newForYou.map((m) => m.id)).toContain("petra");
    engine.releaseOpenRow("petra");
    const after = ohboxView(engine.read(), engine.openRowHeld());
    expect(after.newForYou.map((m) => m.id)).not.toContain("petra");
    expect(after.previouslySeen.map((m) => m.id)).toContain("petra");
  });
});
