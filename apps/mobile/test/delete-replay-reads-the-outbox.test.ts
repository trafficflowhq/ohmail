/**
 * A DELETE WHOSE COMMIT REACHED THE OUTBOX IS NOT SAID LOST AT THE NEXT LAUNCH
 * (PHONE-DELETE-REPLAY-GONE-MAY-NAME-AN-OUTBOXED-DELETE). The window commits the delete into the
 * engine's outbox and forgets its record once the dispatch settles; a kill between the two leaves the
 * record, and the launch read the message absent (its own tombstone) and said "not moved to Trash"
 * while the outbox sent it. The real engine, press and wire over one device sqlite; the kill is every
 * timer cleared with nothing flushed, the server holding the DELETE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sayArg, type RefusalArg } from "../src/refusal";
import type { MobileEngineDeps } from "../src/engine/boot";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const settle = async (n = 40): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

let uuids = 0;

async function launch(disk: ReturnType<typeof sqlWorld>, origin: string) {
  vi.resetModules();
  const { bootEngine } = await import("../src/engine/boot");
  const held = await import("../src/state/held-delete");
  const live = await import("../src/state/live");
  const deps: MobileEngineDeps = {
    openExecutor: disk.open, deleteDatabase: disk.drop,
    uuid: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`,
  };
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  let heard: () => void = () => undefined;
  const replayed = new Promise<void>((resolve) => { heard = resolve; });
  const toast = (m: RefusalArg) => { said.push(sayArg(m)); };
  const actions = live.liveActions({ engine: boot.engine, uuid: deps.uuid, zone: "UTC", toast });
  /* `world.tsx`'s delete session, as the app opens it. */
  held.openDeleteSession({
    journal: boot.store,
    dispatch: live.deleteReplayDispatch(boot.engine, (id) => actions.deleteMessage(id, { quiet: true })),
    onReplayed: (r) => { for (const s of held.sayDeleteReplay(r)) toast(s); heard(); },
  });
  return { held, actions, engine: boot.engine, said, replayed, close: () => { boot.store.close(); } };
}

const kill = (): void => { vi.clearAllTimers(); vi.useRealTimers(); };
const deletes = (fake: ReturnType<typeof mailServer>) =>
  fake.seen.filter((r) => r.method === "DELETE" && r.url.startsWith("/messages/")).map((r) => r.url);

describe("a delete killed after its commit reached the outbox", () => {
  it("is still pending at launch while the outbox carries the move", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("m1", { subject: "Old note" }));
    const disk = sqlWorld();
    try {
      const first = await launch(disk, origin);
      fake.holdNext("DELETE", "/messages/m1");
      void first.held.runDeleteCeremony({
        id: "m1", windowMs: 8000, toast: () => undefined,
        deleted: "Moved to Trash.", undone: "Not deleted.", undoLost: "Could not undo.",
        dispatchQuiet: () => first.actions.deleteMessage("m1", { quiet: true }),
      });
      await settle();
      vi.advanceTimersByTime(8001);
      await settle();
      expect(first.engine.pendingMutations().length + first.engine.inFlightMutations().length,
        "control: the commit is in the outbox").toBeGreaterThan(0);
      kill();

      const next = await launch(disk, origin);
      await next.replayed;
      await settle();
      expect(next.said.join(" | "), "a delete the outbox carries was said lost").not.toContain("not moved to Trash");
      expect(next.said).toEqual(["Moving to Trash."]);
      expect(deletes(fake).length, "the launch sent the delete a second time over the outbox's").toBeLessThanOrEqual(2);
      next.close();
    } finally { fake.server.close(); }
  }, 60_000);

  it("a message neither in the mirror nor in the outbox is still said lost (control)", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    const disk = sqlWorld();
    try {
      const first = await launch(disk, origin);
      void first.held.runDeleteCeremony({
        id: "not-here", windowMs: 8000, toast: () => undefined,
        deleted: "Moved to Trash.", undone: "Not deleted.", undoLost: "Could not undo.",
        dispatchQuiet: () => undefined,
      });
      await settle();
      kill();
      const next = await launch(disk, origin);
      await next.replayed;
      expect(next.said.join(" | ")).toContain("not moved to Trash");
      next.close();
    } finally { fake.server.close(); }
  }, 60_000);
});
