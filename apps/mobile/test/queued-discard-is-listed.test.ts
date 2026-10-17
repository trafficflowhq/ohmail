/**
 * A QUEUED DISCARD IS LISTED ON THE PHONE, NOT ONLY TOASTED. A draft discarded while the account
 * could not be reached waits on this phone's queue, its paint takes the draft out of Drafts, and
 * the toast said so once: at the base the draft was on the server, gone from Drafts and in no
 * strip. The phone reads the engine's `queuedDiscards()` (the browser's selector) into
 * `world.queued`, and the strip gives it Try again and Discard. Driven on the app's own
 * `bootEngine` over the loopback server; the chrome is read as source (no RN renderer here).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { Copy } from "../src/copy";
import { DE } from "../src/copy.de";
import { EN } from "../src/copy.en";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { flushQueued, liveActions, liveDrafts } from "../src/state/live";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };

const draftRow = {
  id: "d-1", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
  subject: "Invoice 12", body: "the only copy", to: [{ name: "Ada", address: "ada@fake.test" }],
  cc: [], bcc: [], rationale: null, status: "draft",
  createdAt: "2026-09-01T09:00:00.000Z", updatedAt: new Date().toISOString(),
};

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m1"));
  fake.addDraft(draftRow as never);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
  const inDrafts = () => liveDrafts(boot.engine.read(), { now: new Date(), zone: "UTC", locale: "en" }).map((r) => r.id);
  const deletes = () => fake.seen.filter((r) => r.method === "DELETE" && r.url === "/drafts/d-1").length;
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, origin, ...boot, actions, toasts, inDrafts, deletes, close };
}

/** The discard, pressed while the account answers 503: queued, and toasted once. */
async function discardUnreachable(live: Awaited<ReturnType<typeof scene>>) {
  live.fake.failNextStatus("DELETE", "/drafts/d-1", 503);
  expect(await live.actions.draftDiscard("d-1")).toBe("queued");
  expect(live.toasts).toEqual([Copy.draftsDiscardQueued]);
}

describe("a draft discard that could not reach the account, on the phone", () => {
  it("is listed while it waits: gone from Drafts, still on the server, named in the strip's list", async () => {
    const live = await scene();
    await discardUnreachable(live);
    expect(live.inDrafts(), "the discard's paint left the draft in Drafts").toEqual([]);
    expect(live.fake.draftRows().map((r) => r.id), "the server lost the draft to a request that failed").toEqual(["d-1"]);
    const listed = live.engine.queuedDiscards();
    expect(
      listed.map((q) => [q.mutation.kind, (q.mutation as { draftId?: string }).draftId]),
      "the queued discard is on the outbox and listed nowhere on the phone",
    ).toEqual([["draft_discard", "d-1"]]);
    expect(live.engine.abandoned()).toEqual([]);
    live.close();
  });

  it("Try again with the account back deletes it: 204, the row leaves, no draft on the server", async () => {
    const live = await scene();
    await discardUnreachable(live);
    const [row] = live.engine.queuedDiscards();
    const res = await live.actions.retryQueued(row!.id);
    expect(res?.status, "Try again did not send the waiting discard").toBe("confirmed");
    expect(live.deletes()).toBe(2);
    expect(live.engine.queuedDiscards()).toEqual([]);
    expect(live.fake.draftRows()).toEqual([]);
    live.close();
  });

  it("Discard withdraws it: the draft is back in Drafts and on the server, and a relaunch sends nothing", async () => {
    const live = await scene();
    await discardUnreachable(live);
    const [row] = live.engine.queuedDiscards();
    expect(await live.actions.discardQueued(row!.key), "Discard did not withdraw the waiting discard").toBe("withdrawn");
    expect(live.engine.queuedDiscards()).toEqual([]);
    expect(live.inDrafts(), "the withdrawn discard left the draft out of Drafts").toEqual(["d-1"]);
    live.store.close();

    const again = await bootEngine(deps, { origin: live.origin, token: "tok-1", accountId: "acct-1" });
    if (again.kind !== "ready") throw new Error("boot refused");
    await again.verifyIdentity();
    await again.engine.start();
    await flushQueued(again.engine, liveActions({ engine: again.engine, toast: () => undefined, zone: "UTC" }).releaseConfirmed);
    expect(live.deletes(), "a relaunch sent the discard the person withdrew").toBe(1);
    expect(live.fake.draftRows().map((r) => r.id)).toEqual(["d-1"]);
    again.store.close();
    live.fake.server.close();
  });

  it("Try again on a row the drain already took answers null, and nothing throws", async () => {
    const live = await scene();
    expect(await live.actions.retryQueued("no-such-entry")).toBeNull();
    live.close();
  });
});

describe("the chrome lists world.queued with its two answers", () => {
  const src = (rel: string) => withoutComments(readFileSync(new URL(rel, import.meta.url), "utf8"));

  it("the world projects the engine's selector, and its actions reach the engine's two doors", () => {
    const world = src("../src/state/world.tsx");
    expect(world, "the world does not project the queued discards").toContain("queued: engine.queuedDiscards(),");
    expect(world).toContain("retryQueued: (id) => acts.retryQueued(id),");
    expect(world).toContain("discardQueued: (key) => acts.discardQueued(key),");
    const live = src("../src/state/live.ts");
    expect(live).toContain("retryQueued: (id) => engine.retryQueued(id),");
    expect(live).toContain("discardQueued: (key) => engine.withdrawQueued(key),");
  });

  it("the queued rows' Try again and Discard sit inside the scroller, and a gone row is not read", () => {
    const ui = src("../src/ui/UnsavedChanges.tsx");
    const open = ui.indexOf("<ScrollView");
    const close = ui.indexOf("</ScrollView>", open);
    const inside = ui.slice(open, close);
    const rows = inside.slice(inside.indexOf("queued.map("));
    expect(inside.indexOf("queued.map("), "the queued rows are not inside the scroller").toBeGreaterThan(-1);
    expect(rows).toContain("Copy.unsavedQueuedWhy");
    expect(rows).toContain("retryQueued(m.id)");
    expect(rows).toContain("world.actions.discardQueued(m.key)");
    expect(ui, "Try again reads a gone row's answer as a result").toMatch(/outcome !== null && outcome\.status === "rolled_back"/);
    expect(ui, "the strip hides itself while a discard is waiting").toMatch(/const listed = rows\.length \+ queued\.length;/);
  });
});

describe("the queued rows' words", () => {
  /** The browser's ICU plural, rendered for `n` — the web strip's own words. */
  const icu = (plural: string, n: number) => {
    const arm = new RegExp(`${n === 1 ? "one" : "other"} \\{([^}]*)\\}`).exec(plural)![1]!;
    return arm.replace("#", String(n));
  };

  it("the count is the browser's sentence word for word, in both languages", async () => {
    const en = (await import("../../webapp/messages/en.json")).default.sync as Record<string, string>;
    const de = (await import("../../webapp/messages/de.json")).default.sync as Record<string, string>;
    for (const n of [1, 3]) {
      expect(EN.unsavedPendingCount(n)).toBe(icu(en.unsavedPendingCount!, n));
      expect(DE.unsavedPendingCount(n)).toBe(icu(de.unsavedPendingCount!, n));
    }
  });

  it("the why names the phone, not the browser, in both languages", () => {
    expect(EN.unsavedQueuedWhy).toBe("This phone could not reach your account. It keeps trying.");
    expect(DE.unsavedQueuedWhy).toBe("Dieses Handy konnte deinen Account nicht erreichen. Es versucht es weiter.");
  });
});
