/**
 * A MEASUREMENT, NOT A GUARD OF A FIX: green at the base it was written on. THE PHONE'S HELD DELETE,
 * UNDONE, PUTS THE OPEN ROW BACK IN ITS PLACE (measured beside the web's TRIAGE-026 fix, 2026-10-03). The reader stays over the pill for the whole window and leaves only
 * when the delete commits (`MessageActions`' `onCommitted`), so the engine's hold on the open row
 * survives the window and Undo finds the read row in New. The CONTROL is the web's old shape — the
 * reader let go at the press — which files the row under Earlier.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { hiddenMessagesReader, liveActions, liveOhbox, presentedOf, type WorldView } from "../src/state/live";
import { armHeldDelete, heldDeleteIds, undoHeldDelete } from "../src/state/held-delete";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/* @reads: apps/mobile/src/ui/MessageActions.tsx */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACTIONS = readFileSync(join(APP, "src/ui/MessageActions.tsx"), "utf8");

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
  fake.addMessage({ ...dto("m2", { subject: "Second" }), date: "2026-08-19T09:00:00Z" });
  fake.addMessage({ ...dto("m3", { subject: "Third" }), date: "2026-08-19T08:00:00Z" });
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const actions = liveActions({ engine: boot.engine, toast: (m) => void sayArg(m) });
  const box = () => liveOhbox(
    presentedOf(hiddenMessagesReader(boot.engine.read(), heldDeleteIds()), view.now),
    view, boot.engine.openRowHeld(),
  );
  return { fake, boot, actions, box };
}

describe("the phone's held delete, undone", () => {
  it("opened and read, deleted, undone: m2 is back in New at its place, the read standing", async () => {
    const s = await session();
    try {
      expect(await s.actions.openMessage("m2")).toBe(true);
      await s.actions.markGlanced(["m2"]);   // the reader's rule, with m2 on screen
      armHeldDelete("m2", 60_000, () => s.actions.deleteMessage("m2", { quiet: true }));
      expect(s.box().fresh.map((m) => m.id), "the press hides the row").toEqual(["m1", "m3"]);
      expect(s.boot.engine.openRowHeld(), "the reader is still over the pill").toBe("m2");
      await undoHeldDelete("m2");
      const v = s.box();
      expect(v.fresh.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(v.unreadIds, "the read stands").toEqual(["m1", "m3"]);
      s.boot.store.close();
    } finally {
      s.fake.server.close();
    }
  });

  it("CONTROL: a reader let go at the press files the undone row under Earlier", async () => {
    const s = await session();
    try {
      await s.actions.openMessage("m2");
      await s.actions.markGlanced(["m2"]);
      armHeldDelete("m2", 60_000, () => s.actions.deleteMessage("m2", { quiet: true }));
      s.actions.leaveMessage("m2");
      await undoHeldDelete("m2");
      const v = s.box();
      expect(v.fresh.map((m) => m.id)).toEqual(["m1", "m3"]);
      expect(v.seen.map((m) => m.id)).toContain("m2");
      s.boot.store.close();
    } finally {
      s.fake.server.close();
    }
  });

  it("the reader leaves at the commit, never at the press", () => {
    expect(ACTIONS).toContain("a.deleteMessage(m.id, { onCommitted: () => { if (mounted.current) onDeleted?.(); } });");
  });
});
