/**
 * FORWARD ON A MESSAGE THIS PHONE DOES NOT HOLD READS ITS BODY FIRST (PHONE-FORWARD-OFF-MIRROR-
 * NOT-FETCHED). A History or Search row opens in the reader without a mirror row behind it; the
 * server refuses a forward whose original it cannot load, so the press reads the body through the
 * reader's own door (`hydrateOffMirror`) before the forward opens, as the web and desktop do.
 * `forwardPress` decides; the read is shared with the reader's open, so it happens once.
 */
import type { EngineMessage } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveMessage, openOffMirror, type LiveWorldActions } from "../src/state/live";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/* @reads: apps/mobile/src/ui/MessageActions.tsx
   Read by a path built at runtime, so no landing pass selects this file when that source
   moves — the shape `reads-list.mjs` exists for. */

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};
const V = { now: new Date("2026-08-19T10:00:00Z"), zone: "UTC" };

/** A server holding `m1` in the mirror and `offId` only on the server, with its body stored. */
async function scene(offId: string) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  fake.setBody(offId, "The original, stored on the server.");
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid: deps.uuid, zone: "UTC",
  });
  // The row a History page handed the reader: on the server, not in this phone's mirror.
  openOffMirror(dto(offId, { subject: "From the archive" }) as unknown as EngineMessage);
  const done = () => { boot.store.close(); fake.server.close(); };
  return { fake, engine: boot.engine, actions, done };
}

const bodyReads = (fake: ReturnType<typeof mailServer>, id: string) =>
  fake.seen.filter((r) => r.method === "GET" && r.url === `/messages/${id}/body`).length;

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

describe("Forward on a row the mirror does not hold", () => {
  it("a held row opens at once: nothing is read for the press", async () => {
    const { fake, engine, actions, done } = await scene("h0");
    expect(engine.read().get("message", "m1")).toBeDefined();
    expect(actions.forwardFetch("m1")).toBeNull();
    expect(bodyReads(fake, "m1")).toBe(0);
    done();
  });

  it("reads the body once through the reader's door, and opens only after it arrived", async () => {
    const { fake, engine, actions, done } = await scene("h1");
    expect(engine.read().get("message", "h1")).toBeUndefined();
    const release = fake.holdNext("GET", "/messages/h1/body");
    let opened = false;
    const press = actions.forwardFetch("h1");
    expect(press).not.toBeNull();
    void press!.then(() => { opened = true; });
    await until(() => bodyReads(fake, "h1") === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toBe(false);
    release();
    await press;
    expect(opened).toBe(true);
    expect(liveMessage(engine, "h1", V)?.bodyState).toBe("full");
    // A second press finds the body read: nothing more is asked.
    await actions.forwardFetch("h1");
    expect(bodyReads(fake, "h1")).toBe(1);
    // Nothing was written into the mirror.
    expect(engine.read().get("message", "h1")).toBeUndefined();
    done();
  });

  it("a press while the reader's own read is in flight joins it rather than asking twice", async () => {
    const { fake, actions, done } = await scene("h2");
    const release = fake.holdNext("GET", "/messages/h2/body");
    actions.hydrateMessage("h2");
    await until(() => bodyReads(fake, "h2") === 1);
    const press = actions.forwardFetch("h2");
    expect(press).not.toBeNull();
    release();
    await press;
    expect(bodyReads(fake, "h2")).toBe(1);
    done();
  });

  it("the forward that follows names the original, after its body was read", async () => {
    const { fake, actions, done } = await scene("h3");
    await actions.forwardFetch("h3");
    const sent = await actions.sendForward("h3", [{ name: null, address: "c@x.test" }], "FYI");
    expect(sent.outcome).toBe("sent");
    const order = fake.seen.map((r) => `${r.method} ${r.url}`);
    expect(order.indexOf("GET /messages/h3/body")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("GET /messages/h3/body")).toBeLessThan(order.indexOf("POST /drafts"));
    const send = fake.seen.find((r) => r.method === "POST" && /^\/drafts\/[^/]+\/send$/.test(r.url));
    const wire = JSON.parse(send!.body) as { forwardOf?: string; forwardZone?: string; forwardLocale?: string };
    expect(wire.forwardOf).toBe("h3");
    // The phone's clock rides with it, so the quoted header dates the original as this phone reads it.
    expect(wire.forwardZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(wire.forwardLocale).toBe("en");
    done();
  });

  it("a refused read still opens the forward, and the next press asks again", async () => {
    const { fake, actions, done } = await scene("h4");
    fake.failNext("GET", "/messages/h4/body");
    await expect(actions.forwardFetch("h4")).resolves.toBeUndefined();
    expect(bodyReads(fake, "h4")).toBe(1);
    await actions.forwardFetch("h4");
    expect(bodyReads(fake, "h4")).toBe(2);
    done();
  });
});

describe("the reader's Forward goes through the read", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/ui/MessageActions.tsx", import.meta.url)), "utf8");

  it("every Forward press in the reader is openForward, and openForward awaits forwardFetch", () => {
    expect(src.match(/onPress(?:: |=\{)openForward\b/g)?.length, "the rail, the bar floor, the compact word and icon, the sheet row").toBe(5);
    const body = src.slice(src.indexOf("const openForward"), src.indexOf("const openForward") + 900);
    expect(body).toMatch(/a\.forwardFetch\(id\)/);
    // The composer opens unconfirmed in ONE place, and the ask sheet is reached only from there.
    expect(src.match(/\{ compose: "forward" \}/g)?.length).toBe(1);
    expect(body).toContain('setOpen(ask ? "forward-ask" : { compose: "forward" })');
  });
});
