/* @reads: apps/mobile/src/state/world.tsx */
/**
 * A WAITING ROW THE STORE LISTS IS DECIDED WHERE IT IS SHOWN. The mirror is windowed and the
 * queue is not, so the phone's Screener shows senders whose held mail this phone never received
 * (a row minted from the store's own words). A press on one is sent to the store as the ordinary
 * decide on that sender — the wire call the engine sends for representatives it served — whether
 * the sender is on the queue's first page or past it; it is never refused because the phone
 * holds none of the mail. The mirror-backed row decides exactly as before.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FOLDER_OF_VIEW } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveActions, liveScreener, presentedOf, screeningAnswered, waitingAfterDecide, waitingOnScreen,
  type LiveDeps, type ScreenerRow, type WorldView,
} from "../src/state/live";
import { readScreenerWaiting, type ServerWaitingSender } from "../src/net/screener";
import type { ConnectedSession } from "../src/net/pairing";
import { refuse, sayArg } from "../src/refusal";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { arrived } from "./helpers/arrived";

const NOW = new Date("2026-09-26T09:00:00.000Z");
const ANSWERED = screeningAnswered({ dormancyDays: 60, baselineAt: "2026-08-12T01:21:58.372Z", scope: "window" });
const view: WorldView = { now: NOW, zone: "UTC", screening: ANSWERED };
const GATE = FOLDER_OF_VIEW.screener;

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })(),
};

/**
 * One sender the mirror holds and four it never received, cut two to a page: the queue, newest
 * first, is `mirror, old4 | old3, old2 | old1`. The engine's own first page is the first two.
 */
function fixture(fake: ReturnType<typeof mailServer>): void {
  fake.addMessage(dto("m-rep", {
    subject: "In the mirror", folder: GATE, date: "2026-09-25T08:00:00.000Z",
    from: { name: "Mirror Sender", address: "mirror@held.test" },
  }));
  for (const n of [1, 2, 3, 4]) {
    fake.holdOnServer(dto(`old${n}`, {
      subject: `Held since spring ${n}`, folder: GATE, date: `2026-05-0${n}${"T"}08:00:00.000Z`,
      from: { name: `Old Sender ${n}`, address: `old${n}@held.test` },
    }));
  }
  fake.setScreenerPageSize(2);
}

async function phoneOn(origin: string, extra: Partial<LiveDeps> = {}) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  // The cadence's engine half: the store's first page, which the partition reads.
  await boot.engine.refreshScreenerWaiting();
  const session = {
    profile: { origin }, standalone: false, engine: boot.engine,
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  } as unknown as ConnectedSession;
  const toasts: string[] = [];
  const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), ...extra });
  return { ...boot, session, actions, toasts };
}

async function shelf(phone: Awaited<ReturnType<typeof phoneOn>>): Promise<ScreenerRow[]> {
  const server = await readScreenerWaiting(phone.session);
  expect(server, "the queue read answered").not.toBeNull();
  const pres = presentedOf(phone.engine.read(), NOW, false, ANSWERED);
  return liveScreener(pres, view, {}, server).waiting;
}

/**
 * THE WORLD'S SHELF, as `world.tsx` holds it: the cached queue, a decide that landed retires its
 * sender, and a press on a store-backed row holds its sender off until the answer. The wiring
 * case below pins that the world passes exactly this into `liveScreener`.
 */
function worldShelf() {
  let cached: readonly ServerWaitingSender[] | null = null;
  let leaving: ReadonlyArray<{ address: string; scope: "sender" | "domain" }> = [];
  const deps: Partial<LiveDeps> = {
    forgetWaiting: (d) => { cached = waitingAfterDecide(cached, d); },
    leaveWaiting: (d) => {
      const hold = { ...d };
      leaving = [...leaving, hold];
      return () => { leaving = leaving.filter((h) => h !== hold); };
    },
  };
  return {
    deps,
    set: (s: readonly ServerWaitingSender[] | null) => { cached = s; },
    switchAccount: (s: readonly ServerWaitingSender[]) => { cached = s; leaving = []; },
    now: () => waitingOnScreen(cached, leaving),
  };
}

const decided = (fake: ReturnType<typeof mailServer>, id: string) =>
  fake.seen.filter((r) => r.method === "POST" && r.url === `/screener/${id}`).length;

describe("a row the store lists and this phone holds none of the mail of", () => {
  it("is on the shelf: the whole queue, the mirror's row among the minted ones", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fixture(fake);
      const phone = await phoneOn(origin);
      const rows = await shelf(phone);
      expect(rows.map((r) => r.id)).toEqual(["m-rep", "old4", "old3", "old2", "old1"]);
      expect(phone.engine.read().get("message", "old4"), "the mirror never received it").toBeUndefined();
      phone.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("on the queue's first page: Screen out is sent to the store and lands", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fixture(fake);
      const phone = await phoneOn(origin);
      const row = (await shelf(phone)).find((r) => r.id === "old4")!;
      expect(await phone.actions.decide(row, "screened", false, "sender"), phone.toasts.join(" | ")).toBe(true);
      expect(decided(fake, "old4"), "the decide reached the store").toBe(1);
      expect(fake.message("old4")?.folder).toBe(FOLDER_OF_VIEW.screened);
      phone.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("past the queue's first page: Let in is sent to the store and lands", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fixture(fake);
      const phone = await phoneOn(origin);
      const row = (await shelf(phone)).find((r) => r.id === "old2")!;
      expect(await phone.actions.decide(row, "ohbox", false, "sender"), phone.toasts.join(" | ")).toBe(true);
      expect(decided(fake, "old2"), "the decide reached the store").toBe(1);
      expect(fake.message("old2")?.folder).toBe(FOLDER_OF_VIEW.ohbox);
      phone.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("the mirror-backed row decides as before", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fixture(fake);
      const phone = await phoneOn(origin);
      const row = (await shelf(phone)).find((r) => r.id === "m-rep")!;
      expect(row.gatePhysical).toBe(true);
      expect(await phone.actions.decide(row, "screened", false, "sender")).toBe(true);
      expect(decided(fake, "m-rep")).toBe(1);
      expect(phone.engine.read().get<{ folder: string }>("message", "m-rep")?.folder).toBe(FOLDER_OF_VIEW.screened);
      phone.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("leaves the shelf at the press and the count drops with it; a refused press puts it back", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fixture(fake);
      const shelfOf = worldShelf();
      const phone = await phoneOn(origin, shelfOf.deps);
      shelfOf.set(await readScreenerWaiting(phone.session));
      const rows = () => liveScreener(presentedOf(phone.engine.read(), NOW, false, ANSWERED), view, {}, shelfOf.now())
        .waiting.map((r) => r.id);
      expect(rows()).toHaveLength(5);
      const row = liveScreener(presentedOf(phone.engine.read(), NOW, false, ANSWERED), view, {}, shelfOf.now())
        .waiting.find((r) => r.id === "old2")!;

      const answer = fake.holdNext("POST", "/screener/old2");
      const pressed = phone.actions.decide(row, "screened", false, "sender");
      await arrived("the decide on the wire", () => decided(fake, "old2") === 1);
      expect(rows(), "the row is still on the shelf while its answer is out").not.toContain("old2");
      expect(rows()).toHaveLength(4);
      answer();
      expect(await pressed).toBe(true);
      expect(rows()).toEqual(["m-rep", "old4", "old3", "old1"]);

      const next = liveScreener(presentedOf(phone.engine.read(), NOW, false, ANSWERED), view, {}, shelfOf.now())
        .waiting.find((r) => r.id === "old3")!;
      fake.failNext("POST", "/screener/old3");
      expect(await phone.actions.decide(next, "screened", false, "sender")).toBe(false);
      expect(rows(), "a refused press puts the row back").toEqual(["m-rep", "old4", "old3", "old1"]);
      phone.store.close();
    } finally {
      fake.server.close();
    }
  });

  it.each([false, true])("keeps a delayed decision on its own account, including a relay (%s)", async (relay) => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fixture(fake);
      const shelfOf = worldShelf();
      let activeAccount = "old";
      // The live provider supplies its current-session check. Change the displayed queue while
      // the original engine is still carrying the HTTP response for an already accepted press.
      const relayed: string[] = [];
      const ownership = {
        screenerOutcomeCurrent: () => activeAccount === "old",
        relayedHere: ({ address }: { address: string }) => { relayed.push(address); },
      };
      const old = await phoneOn(origin, { ...shelfOf.deps, ...ownership });
      try {
        const queue = (await readScreenerWaiting(old.session))!;
        shelfOf.set(queue);
        const row = (await shelf(old)).find((r) => r.id === "old2")!;
        if (relay) fake.queueNextForOrganizer("POST", "/screener/old2");
        const answer = fake.holdNext("POST", "/screener/old2");
        const decidedOld = old.actions.decide(row, "ohbox", false, "sender");
        try {
          await arrived("the old account sent its decision", () => decided(fake, "old2") === 1);
          activeAccount = "new";
          const sameSender = queue.find((sender) => sender.address === row.address)!;
          shelfOf.switchAccount([{ ...sameSender, messageId: "new-account-same-sender" }]);
        } finally {
          answer();
        }
        expect(await decidedOld).toBe(!relay);
        expect(decided(fake, "old2")).toBe(1);
        expect(shelfOf.now()?.map((sender) => sender.messageId)).toEqual(["new-account-same-sender"]);
        expect(old.toasts).toEqual([]);
        expect(relayed).toEqual([]);
      } finally {
        old.store.close();
      }
    } finally {
      fake.server.close();
    }
  });

  it("a representative no page served is refused by the engine, and nothing is sent", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fixture(fake);
      const phone = await phoneOn(origin);
      const listed = (await shelf(phone)).find((r) => r.id === "old4")!;
      const ghost: ScreenerRow = { ...listed, id: "never-served", address: "ghost@held.test" };
      expect(await phone.actions.decide(ghost, "screened", false, "sender")).toBe(false);
      expect(fake.seen.some((r) => r.url === "/screener/never-served")).toBe(false);
      expect(phone.toasts.at(-1)).toBe(sayArg(refuse("liveDecideFailed", "ghost@held.test")));
      phone.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("the world holds the shelf by the same rule: the queue less the held presses", () => {
    const world = readFileSync(fileURLToPath(new URL("../src/state/world.tsx", import.meta.url)), "utf8");
    expect(readFileSync(fileURLToPath(new URL("../src/state/world-projection.ts", import.meta.url)), "utf8"))
      .toContain("liveScreener(pres, v, inp.scopes, waitingOnScreen(inp.screenerServer, inp.leavingWaiting))");
    expect(world).toContain("return () => setLeavingWaiting((prev) => prev.filter((h) => h !== hold));");
    // A session swap drops the holds with the queue they were made over.
    expect(world).toMatch(/setScreenerServer\(null\);\s*setLeavingWaiting\(\[\]\);/);
  });
});
