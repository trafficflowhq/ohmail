/**
 * A PHONE ROW'S OWN MARK READ IS A READ IN OHMAIL (owner 2026-10-21: "should be at the top when it
 * was my last action"). A swipe or the row action on one row, folded or not, names the row
 * (`markRowSeen`), so the engine sends an open read and the row files at the top of Earlier at
 * once. No hold is taken, and a message open beside the list keeps its own. Mark all read, a
 * Receipts row and a read with no row keep arrival.
 */
import { describe, expect, it } from "vitest";

import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveOhbox, presentedOf, type WorldView } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };

async function session() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage({ ...dto("m1", { subject: "First" }), date: "2026-08-19T10:00:00Z" });
  fake.addMessage({ ...dto("m2", { subject: "Second" }), date: "2026-08-19T09:00:00Z", threadId: "T" });
  fake.addMessage({ ...dto("m2b", { subject: "Second" }), date: "2026-08-19T08:30:00Z", threadId: "T" });
  fake.addMessage({ ...dto("m3", { subject: "Third" }), date: "2026-08-19T08:00:00Z" });
  // Read already, and NEWER than m2 and m3: at arrival both file below it.
  fake.addMessage({ ...dto("m4", { subject: "Fourth", unread: false }), date: "2026-08-19T09:30:00Z" });
  fake.addMessage({ ...dto("r1", { subject: "Receipt", folder: "ohmail/Receipts" }), date: "2026-08-19T07:00:00Z" });
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const actions = liveActions({ engine: boot.engine, toast: (m) => void sayArg(m) });
  const box = () => liveOhbox(presentedOf(boot.engine.read(), view.now), view, boot.engine.openRowHeld());
  const stamp = (id: string) => fake.message(id)?.openReadAt ?? null;
  return { fake, boot, actions, box, stamp };
}
type S = Awaited<ReturnType<typeof session>>;

async function inSession(body: (s: S) => Promise<void>): Promise<void> {
  const s = await session();
  try {
    await body(s);
    s.boot.store.close();
  } finally {
    s.fake.server.close();
  }
}

describe("a phone row's own Mark read files it at the top of Earlier", () => {
  it("one row read by its swipe: the open read, top of Earlier at once, no hold", () => inSession(async (s) => {
    expect(s.box().seen.map((m) => m.id), "the premise").toEqual(["m4"]);
    expect(await s.actions.markRowSeen("m3", false)).toBe(true);
    expect(s.box().seen.map((m) => m.id)).toEqual(["m3", "m4"]);
    expect(s.boot.engine.openRowHeld()).toBeNull();
    expect(s.stamp("m3"), "the server stamped the open read").toEqual(expect.any(String));
  }));

  it("two panes: m1 open and held, m3 swiped read files first in Earlier, m1 stays held", () => inSession(async (s) => {
    expect(await s.actions.openMessage("m1")).toBe(true);
    await s.actions.markRowSeen("m3", false);
    const v = s.box();
    expect(v.seen.map((m) => m.id)[0]).toBe("m3");
    expect(s.boot.engine.openRowHeld()).toBe("m1");
    expect(v.fresh.map((m) => m.id)).toContain("m1");
    expect(s.stamp("m3")).toEqual(expect.any(String));
  }));

  it("a folded row is its conversation: both members open-read, the row first in Earlier", () => inSession(async (s) => {
    await s.actions.markRowSeen("m2", false, ["m2", "m2b"]);
    expect(s.box().seen.map((m) => m.id)[0]).toBe("m2");
    expect([s.stamp("m2"), s.stamp("m2b")]).toEqual([expect.any(String), expect.any(String)]);
  }));
});

describe("CONTROLS: these keep arrival", () => {
  it("markSeen with no row", () => inSession(async (s) => {
    await s.actions.markSeen("m3", false);
    expect(s.box().seen.map((m) => m.id)).toEqual(["m4", "m3"]);
    expect(s.stamp("m3")).toBeNull();
  }));

  it("Mark all read", () => inSession(async (s) => {
    await s.actions.markAllSeen(["m3", "m1"]);
    expect([s.stamp("m1"), s.stamp("m3")]).toEqual([null, null]);
  }));

  it("a Receipts row", () => inSession(async (s) => {
    await s.actions.markRowSeen("r1", false);
    expect(s.fake.message("r1")?.unread).toBe(false);
    expect(s.stamp("r1")).toBeNull();
  }));

  it("markRowSeen(…, true) on the lifted row clears the stamp and puts it in New", () => inSession(async (s) => {
    await s.actions.markRowSeen("m3", false);
    expect(s.stamp("m3")).toEqual(expect.any(String));
    await s.actions.markRowSeen("m3", true);
    expect(s.stamp("m3")).toBeNull();
    expect(s.box().fresh.map((m) => m.id)).toContain("m3");
  }));
});
