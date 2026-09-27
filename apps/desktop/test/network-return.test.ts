import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NETWORK_RETURN_PATH, startNetworkReturnRelay } from "../src/network-return.js";

/**
 * The webview's `online` event reaches the local engine's retry door, so a lost connection is
 * re-dialled when the network comes back. The engine half is driven through its route in the
 * sidecar's reconnect suite; this is the window half: what is posted, on which door, and that the
 * entry arms it.
 */

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function relayOn(local: boolean | (() => Promise<boolean>), post?: (p: string) => Promise<unknown>) {
  const target = new EventTarget();
  const posted: string[] = [];
  const stop = startNetworkReturnRelay({
    target,
    isLocalDoor: typeof local === "function" ? local : async () => local,
    post: post ?? (async (path) => { posted.push(path); }),
  });
  return { target, posted, stop };
}

describe("the network's return, relayed to the local engine", () => {
  it("posts the retry door once per online event on the local door", async () => {
    const { target, posted } = relayOn(true);
    target.dispatchEvent(new Event("online"));
    await settle();
    expect(posted).toEqual([NETWORK_RETURN_PATH]);
    target.dispatchEvent(new Event("online"));
    await settle();
    expect(posted).toHaveLength(2);
  });

  it("posts nothing on another door, where the route does not exist", async () => {
    const { target, posted } = relayOn(false);
    target.dispatchEvent(new Event("online"));
    await settle();
    expect(posted).toEqual([]);
  });

  it("hears only the return, not the loss", async () => {
    const { target, posted } = relayOn(true);
    target.dispatchEvent(new Event("offline"));
    await settle();
    expect(posted).toEqual([]);
  });

  it("drops a refused post and a door it could not ask, and keeps listening", async () => {
    const refusing = relayOn(true, async () => { throw new Error("engine gone"); });
    refusing.target.dispatchEvent(new Event("online"));
    await settle();
    const unreadable = relayOn(async () => { throw new Error("no shell"); });
    unreadable.target.dispatchEvent(new Event("online"));
    await settle();
    expect(unreadable.posted).toEqual([]);
  });

  it("stops when disarmed", async () => {
    const { target, posted, stop } = relayOn(true);
    stop();
    target.dispatchEvent(new Event("online"));
    await settle();
    expect(posted).toEqual([]);
  });

  it("names the engine's own route", () => {
    const engine = readFileSync(resolve(process.cwd(), "apps/sidecar/src/engine.ts"), "utf8");
    expect(engine).toContain(`url.pathname === "${NETWORK_RETURN_PATH}"`);
  });

  it("the window entry arms it, once, on the window", () => {
    // A module-scope call begins its line: a mention inside a comment block is indented or quoted.
    const main = readFileSync(resolve(process.cwd(), "apps/desktop/src/main.tsx"), "utf8");
    expect(main.match(/^startNetworkReturnRelay\(\{$/gm) ?? []).toHaveLength(1);
    expect(main).toMatch(/^startNetworkReturnRelay\(\{\n {2}target: window,\n {2}isLocalDoor: .*\.mode === "local"/m);
  });
});
