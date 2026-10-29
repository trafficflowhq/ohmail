/**
 * MARK ALL READ ON A REAL WIRE — the webapp's `read-all.ts` contract, measured on the
 * phone's live layer against the loopback mail server: the press flips exactly the mailbox's
 * own unread (chunked at the `PATCH /messages` cap), the sentence names the count, the pill's
 * one undo takes back exactly what the press flipped — re-pinning the resurfaced pins the
 * deliberate read spent — and the streams' press commits the waterline in the same act.
 * The header sets are pinned too: `unreadIds` IS the number the control shows.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waterlineIdOf, type EngineMessage } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveActions,
  liveOhbox,
  liveReads,
  presentedOf,
  UNDO_MS,
  type LiveWorldActions,
  type ToastOpts,
  type WorldView,
} from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { arrived, CASE_MS } from "./helpers/arrived";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.join(HERE, "..", rel), "utf8");

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };

interface SaidToast extends ToastOpts { say: string }

async function scene(extra: (fake: ReturnType<typeof mailServer>) => void) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  extra(fake);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: SaidToast[] = [];
  const clock = { skew: 0 };
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m, opts) => toasts.push({ say: sayArg(m), ...(opts ?? {}) }),
    uuid,
    zone: "UTC",
    now: () => new Date(Date.now() + clock.skew),
  });
  return { fake, ...boot, actions, toasts, clock };
}

/** Every `PATCH /messages` body this server took, in order — `{ids, unread}` pairs. */
const seenPatches = (fake: ReturnType<typeof mailServer>) =>
  fake.seen
    .filter((r) => r.method === "PATCH" && r.url === "/messages")
    .map((r) => JSON.parse(r.body) as { ids: string[]; unread: boolean });

/** The server took `n` `PATCH /messages`; a red names how many it did take. */
const patchesArrive = (fake: ReturnType<typeof mailServer>, n: number, what: string) =>
  arrived(what, () => seenPatches(fake).length >= n, () => `${seenPatches(fake).length} PATCH(es)`);

/** The press's local half, read back: `id` read and the stream's waterline at it. */
const readAndLined = (live: Awaited<ReturnType<typeof scene>>, id: string) => {
  const reader = live.engine.read();
  return reader.get<EngineMessage>("message", id)?.unread === false
    && reader.get<{ newestSeenId: string }>("view_meta", waterlineIdOf("reads"))?.newestSeenId === id;
};

describe("mark all read drives the wire and carries the one undo", () => {
  it("flips exactly the unread set, says the count, and the undo puts it back", async () => {
    const live = await scene((f) => {
      // A DECIDED sender, so the consent cutline leaves this mail in the Ohbox.
      f.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      f.addMessage(dto("m1", { unread: true, date: "2026-08-19T10:00:00Z" }));
      f.addMessage(dto("m2", { unread: true, date: "2026-08-19T09:00:00Z" }));
      f.addMessage(dto("m3", { unread: false, date: "2026-08-19T08:00:00Z" }));
    });
    const box = liveOhbox(presentedOf(live.engine.read(), view.now), view);
    // THE SET IS THE COUNT — the control's number and the press's ids cannot disagree.
    expect(box.unreadIds.sort()).toEqual(["m1", "m2"]);
    expect(box.unread).toBe(box.unreadIds.length);

    expect(await live.actions.markAllSeen(box.unreadIds)).toBe(true);
    const offer = live.toasts.find((t) => t.say === Copy.markAllDone(2));
    expect(offer, "the mark-all toast names the count").toBeDefined();
    expect(offer!.undo, "the pill carries the way back").toBeDefined();
    expect(offer!.holdMs).toBe(UNDO_MS);
    expect(seenPatches(live.fake)).toEqual([{ ids: ["m1", "m2"], unread: false }]);
    const reader = live.engine.read();
    expect(reader.get<EngineMessage>("message", "m1")?.unread).toBe(false);
    expect(reader.get<EngineMessage>("message", "m2")?.unread).toBe(false);

    offer!.undo!();
    await patchesArrive(live.fake, 2, "the undo's PATCH back");
    await arrived("the Undone sentence", () => live.toasts.some((t) => t.say === Copy.toastUndone));
    // The way back is exact: the two this press flipped, never the one already read.
    expect(seenPatches(live.fake)).toEqual([
      { ids: ["m1", "m2"], unread: false },
      { ids: ["m1", "m2"], unread: true },
    ]);
    expect(live.toasts.map((t) => t.say)).toContain(Copy.toastUndone);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("chunks at the PATCH cap in both directions — one past the cap is two requests, and two back", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `b${String(i).padStart(3, "0")}`);
    const live = await scene((f) => {
      f.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      for (const id of ids) f.addMessage(dto(id, { unread: true }));
    });
    expect(await live.actions.markAllSeen([...ids])).toBe(true);
    const offer = live.toasts.find((t) => t.say === Copy.markAllDone(201))!;
    const forward = seenPatches(live.fake);
    expect(forward.map((p) => p.ids.length)).toEqual([200, 1]);
    expect(forward.every((p) => p.unread === false)).toBe(true);

    offer.undo!();
    await patchesArrive(live.fake, 4, "the undo's two PATCHes back");
    const all = seenPatches(live.fake);
    expect(all.slice(2).map((p) => [p.ids.length, p.unread])).toEqual([[200, true], [1, true]]);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("a pinned row read by the press is re-pinned by the undo — and appears in the set once", async () => {
    const live = await scene((f) => {
      f.addMessage(dto("p1", { unread: true, triage: { state: "resurfaced" } }));
    });
    const box = liveOhbox(presentedOf(live.engine.read(), view.now), view);
    expect(box.unreadIds).toEqual(["p1"]);

    await live.actions.markAllSeen(box.unreadIds);
    const offer = live.toasts.find((t) => t.say === Copy.markAllDone(1))!;
    offer.undo!();
    // The deliberate read spent the pin; the undo dispatched the re-pin beside the flip.
    const repins = () => live.fake.seen
      .filter((r) => r.method === "POST" && r.url === "/messages/p1/triage")
      .map((r) => (JSON.parse(r.body) as { state: string }).state);
    await arrived("the undo's re-pin POST", () => repins().length >= 1);
    expect(repins()).toEqual(["resurfaced"]);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("the count is the web's: a resurfaced letter, New and an unread copy under Earlier, after a reload too", async () => {
    const live = await scene((f) => {
      f.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      f.addMessage(dto("p1", { unread: true, triage: { state: "resurfaced" } }));
      f.addMessage(dto("n1", { unread: true, date: "2026-08-19T10:00:00Z" }));
      f.addMessage(dto("s1", { folder: "Sent", unread: true, date: "2026-08-18T10:00:00Z" }));
    });
    const box = liveOhbox(presentedOf(live.engine.read(), view.now), view);
    expect(box.seen.map((r) => r.id)).toContain("s1");
    expect([...box.unreadIds].sort()).toEqual(["n1", "p1", "s1"]);
    expect(box.unread).toBe(3);
    // A relaunch: a fresh boot over the same server.
    live.store.close();
    const { port } = live.fake.server.address() as { port: number };
    const again = await bootEngine(deps, { origin: `http://127.0.0.1:${port}`, token: "tok-1", accountId: "acct-1" });
    if (again.kind !== "ready") throw new Error("boot refused");
    await again.verifyIdentity();
    await again.engine.start();
    expect(liveOhbox(presentedOf(again.engine.read(), view.now), view).unread).toBe(3);
    again.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("the streams' press commits the waterline in the same act — and a fresh-only press is silent", async () => {
    const live = await scene((f) => {
      // The PRE-0.22 spelling on purpose: until the organizer renames the folder the pile's rows
      // carry it, and both the partition and the waterline anchor must still find them.
      f.addMessage(dto("r1", { folder: "ohmail/Reads", unread: true, date: "2026-08-19T09:00:00Z" }));
      f.addMessage(dto("r2", { folder: "ohmail/Reads", unread: false, date: "2026-08-18T09:00:00Z" }));
    });
    const reads = liveReads(presentedOf(live.engine.read(), view.now), view);
    // The stream's own \Seen — the read row is not in the set the press flips.
    expect(reads.unreadIds).toEqual(["r1"]);

    await live.actions.markAllSeen(reads.unreadIds, { place: "reads", upToId: "r1" });
    await arrived("r1 read with the Reads waterline at it", () => readAndLined(live, "r1"));
    const reader = live.engine.read();
    expect(reader.get<EngineMessage>("message", "r1")?.unread).toBe(false);
    expect(reader.get<{ newestSeenId: string }>("view_meta", waterlineIdOf("reads"))?.newestSeenId).toBe("r1");

    // Nothing unread, line still owed (the web's fresh-only arm): the anchor moves, no sentence.
    const before = live.toasts.length;
    expect(await live.actions.markAllSeen([], { place: "reads", upToId: "r1" })).toBe(true);
    expect(live.toasts.length).toBe(before);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("the Undo of the streams' press puts the line back: the letters are new again, nothing above them seen", async () => {
    const live = await scene((f) => {
      f.addMessage(dto("n1", { folder: "ohmail/News", unread: true, date: "2026-08-19T09:00:00Z" }));
      f.addMessage(dto("n0", { folder: "ohmail/News", unread: false, date: "2026-08-18T09:00:00Z" }));
    });
    const lineAt = () => live.engine.read().get<{ newestSeenId: string }>("view_meta", waterlineIdOf("reads"))?.newestSeenId;
    await live.engine.mutate({ kind: "feed_mark_seen", view: "reads", messageIds: [], upToId: "n0" });
    await arrived("the earlier visit's line at n0", () => lineAt() === "n0");
    const news = () => liveReads(presentedOf(live.engine.read(), view.now), view);
    expect([news().newCount, news().waterlineAboveId]).toEqual([1, "n0"]);

    await live.actions.markAllSeen(news().unreadIds, { place: "reads", upToId: "n1" });
    await arrived("n1 read with the line at it", () => readAndLined(live, "n1"));
    expect(news().newCount).toBe(0);
    live.toasts.find((t) => t.say === Copy.markAllDone(1))!.undo!();
    await arrived("n1 unread and the line back at n0", () =>
      live.engine.read().get<EngineMessage>("message", "n1")?.unread === true && lineAt() === "n0");
    expect([news().newCount, news().waterlineAboveId]).toEqual([1, "n0"]);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("the same press on a mailbox the organizer HAS renamed — the canonical spelling", async () => {
    const live = await scene((f) => {
      f.addMessage(dto("n1", { folder: "ohmail/News", unread: true, date: "2026-08-19T09:00:00Z" }));
      f.addMessage(dto("n2", { folder: "ohmail/News", unread: false, date: "2026-08-18T09:00:00Z" }));
    });
    const reads = liveReads(presentedOf(live.engine.read(), view.now), view);
    expect(reads.unreadIds).toEqual(["n1"]);

    await live.actions.markAllSeen(reads.unreadIds, { place: "reads", upToId: "n1" });
    await arrived("n1 read with the Reads waterline at it", () => readAndLined(live, "n1"));
    const reader = live.engine.read();
    expect(reader.get<EngineMessage>("message", "n1")?.unread).toBe(false);
    expect(reader.get<{ newestSeenId: string }>("view_meta", waterlineIdOf("reads"))?.newestSeenId).toBe("n1");
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);
});

describe("the two headers carry the control, in the component's own grammar", () => {
  const component = read("src/ui/MarkAllRead.tsx");
  const ohbox = read("app/(tabs)/index.tsx");
  const reads = read("app/(tabs)/reads.tsx");

  it("the control renders NOTHING over a cleared list, and speaks the deck's count", () => {
    expect(component).toContain("if (unreadCount <= 0 && freshCount <= 0) return null");
    expect(component).toContain("Copy.markAll");
    expect(component).toContain("Copy.markAllAria(unreadCount)");
    expect(component).toContain("Copy.markAllAriaFresh(freshCount)");
    expect(component).toContain('accessibilityRole="button"');
  });

  it("Ohbox presses the world's set — the ids behind the number it shows", () => {
    expect(ohbox).toContain("<MarkAllRead");
    // `shown` is the Ohbox the screen draws (`held-while-hidden.ts`): the number and the press read one set.
    expect(ohbox).toContain("unread={shown.ohbox.unreadIds.length}");
    expect(ohbox).toContain("w.actions.markAllSeen(shown.ohbox.unreadIds)");
  });

  it("the stream's press carries both halves — the flip and the waterline anchor", () => {
    expect(reads).toContain("<MarkAllRead");
    expect(reads).toContain("freshCount={newCount}");
    expect(reads).toContain('place: "reads"');
    expect(reads).toContain("upToId: items[0].id");
  });
});
