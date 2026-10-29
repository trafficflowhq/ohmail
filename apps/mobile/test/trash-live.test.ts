/**
 * TRASH ON A REAL WIRE — the same `bootEngine` composition the app runs, against the loopback
 * mail server: the list answers WHAT THE SERVER HOLDS and restore MOVES IT BACK, measured on
 * the server's own trash map and the re-drained mirror. The first case is the forwarding
 * control: `accountGuarded` (engine/boot.ts) is "the whole surface the engine sees", and the
 * engine resolves `trashAvailable()` from the adapter's OPTIONAL capabilities — so dropping
 * either forward turns every arm here into `unavailable` (the `requestPull` defect shape).
 */
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import type { EngineMessage } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, type LiveWorldActions } from "../src/state/live";
import { Copy } from "../src/copy";
import { setActiveLocale } from "../src/i18n/locale";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };

async function scene(extra: (fake: ReturnType<typeof mailServer>) => void = () => undefined) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  extra(fake);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m) => toasts.push(sayArg(m)),
    uuid,
    zone: "UTC",
  });
  return { fake, origin, ...boot, actions, toasts };
}

const wire = (fake: ReturnType<typeof mailServer>, method: string, path: string) =>
  fake.seen.filter((r) => r.method === method && r.url === path);

describe("the capability pair reaches the engine through the guarded adapter", () => {
  it("trashAvailable() is true on the live path — the forwarding is the feature's gate", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    expect(live.engine.trashAvailable()).toBe(true);
    live.store.close();
    live.fake.server.close();
  });
});

describe("the page lists what the server's Trash holds", () => {
  it("a deleted message appears with its deletion stamp and the word a restore aims at", async () => {
    const live = await scene((f) => {
      f.addMessage(dto("m1", { subject: "Keep me around" }));
      f.addMessage(dto("m2", { subject: "Filed away", folder: "Projects/Q1" }));
    });
    // Nothing deleted yet: the page is READY and EMPTY — available is not "has rows".
    const before = await live.actions.trashList(null);
    expect(before).toEqual({ state: "ready", items: [], nextCursor: null });

    expect(await live.actions.deleteMessage("m1")).toBe(true);
    expect(await live.actions.deleteMessage("m2")).toBe(true);
    const page = await live.actions.trashList(null);
    if (page.state !== "ready") throw new Error(`expected ready, got ${page.state}`);
    expect(page.items.map((r) => r.mail.id).sort()).toEqual(["m1", "m2"]);
    const m1 = page.items.find((r) => r.mail.id === "m1")!;
    const m2 = page.items.find((r) => r.mail.id === "m2")!;
    // The row's time slot carries WHEN IT WAS DELETED, in the reader's clock.
    expect(m1.deletedWhen).not.toBeNull();
    expect(m1.mail.time).toBe(m1.deletedWhen);
    // The restore target as a word: the view's label for INBOX, the leaf for an own folder.
    expect(m1.restoreLabel).toBe(Copy.placeOhbox);
    expect(m2.restoreLabel).toBe("Q1");
    // The ask went over the wire with the view and the page's own limit.
    expect(live.fake.seen.some((r) => r.method === "GET" && r.url === "/messages")).toBe(true);
    live.store.close();
    live.fake.server.close();
  });
});

describe("restore moves it back", () => {
  it("the row leaves Trash, the mirror regains the message, the toast says restoring-to", async () => {
    const live = await scene((f) => f.addMessage(dto("m1", { subject: "Back soon" })));
    await live.actions.deleteMessage("m1");
    expect(live.engine.read().get<EngineMessage>("message", "m1")).toBeUndefined();

    expect(await live.actions.trashRestore("m1")).toBe(true);
    // The press carried an Idempotency-Key (a double press is one request end to end).
    const posts = wire(live.fake, "POST", "/messages/m1/restore");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.key).toMatch(/^restore:/);
    // The sentence is the PENDING one — "Restoring to …", never "restored".
    expect(live.toasts).toContain(Copy.trashToastRestoring(Copy.placeOhbox));

    // Trash no longer holds it…
    const after = await live.actions.trashList(null);
    if (after.state !== "ready") throw new Error(`expected ready, got ${after.state}`);
    expect(after.items).toEqual([]);
    // …and the next drain puts the message back in the mirror: moved back, measured.
    await live.engine.syncOnce();
    const back = live.engine.read().get<EngineMessage>("message", "m1");
    expect(back?.subject).toBe("Back soon");
    live.store.close();
    live.fake.server.close();
  });

  it("a restore the server already finished says it is done, in both languages", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    await live.actions.deleteMessage("m1");
    live.fake.answerNext("POST", "/messages/m1/restore", 200, { restoreTo: "INBOX", pending: false });
    expect(await live.actions.trashRestore("m1")).toBe(true);
    expect(live.toasts.at(-1)).toBe(Copy.trashToastRestored(Copy.placeOhbox));
    expect(Copy.trashToastRestored("Q1")).toBe("Restored to Q1.");
    setActiveLocale("de");
    expect(Copy.trashToastRestored("Q1")).toBe("In Q1 wiederhergestellt.");
    setActiveLocale("en");
    live.store.close();
    live.fake.server.close();
  });

  it("a refused restore keeps the row and says so", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    await live.actions.deleteMessage("m1");
    live.fake.failNext("POST", "/messages/m1/restore");
    expect(await live.actions.trashRestore("m1")).toBe(false);
    expect(live.toasts).toContain(Copy.trashToastRestoreFailed);
    const page = await live.actions.trashList(null);
    if (page.state !== "ready") throw new Error(`expected ready, got ${page.state}`);
    expect(page.items.map((r) => r.mail.id)).toEqual(["m1"]);
    live.store.close();
    live.fake.server.close();
  });
});
