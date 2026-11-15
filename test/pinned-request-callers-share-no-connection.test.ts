import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { HostResolver } from "@trafficflow/core/net";
import type { Tx } from "@trafficflow/db";
import { makeNodeOneClickPost, makeNodeRemoteFetch } from "@trafficflow/services";
import { namedHostRequest } from "@ohmail/cal-providers";
import { privateNetworkFetch } from "../apps/server/src/settings/private-network-fetch.js";
import { startPushWake, type WakeSource } from "../apps/worker/src/push-wake.js";
import { onOnePort } from "../packages/core/test/far-side.js";

/**
 * EVERY CALLER OF THE PINNED REQUEST CLEARS AN ADDRESS BY ITS OWN RULE, AND NO CONNECTION CARRIES ONE CALLER'S ADDRESS
 * TO ANOTHER. The self-host's settings fetch reaches private addresses only; a calendar on a person's own network
 * reaches private and public ones; the picture proxy, the one-click unsubscribe and the new-mail wake reach public ones
 * only. In each pair below the first caller reaches 127.0.0.1, standing for an address its rule admits and the second
 * caller's refuses; the second then asks the same name and port, pinned to the address its own check passed (this
 * machine's second address), and must be answered there and never at the first's.
 */

type Kind = "private" | "public";
interface Caller {
  readonly admits: readonly Kind[];
  /** One request to `url` with `address` as the caller's own check's answer; `heard` counts what the far sides heard. */
  ask(url: string, address: string, heard: () => number): Promise<unknown>;
}

const only = (address: string): HostResolver => ({ resolve: async () => [address] });
const signal = (): AbortSignal => AbortSignal.timeout(2_000);

/** One wake through the sender's own POST, the guard answering `address`; done once a far side heard it. */
async function wake(url: string, address: string, heard: () => number): Promise<void> {
  const listeners: ((accountId: string, seq: bigint) => void)[] = [];
  const source: WakeSource = { subscribeAll: (on) => { listeners.push(on); return () => undefined; } };
  const rows = [{ id: "row", endpoint: url, p256dh: null, auth: null }];
  const db = { select: () => ({ from: () => ({ where: async () => rows }) }), delete: () => ({ where: async () => [] }) } as unknown as Tx;
  const sender = startPushWake({
    db, source, guard: { check: async () => [address] }, ownsAccount: async () => true,
    vapid: { kind: "absent", why: "none on this machine" }, debounceMs: 1, minIntervalMs: 0,
  });
  const before = heard();
  for (const on of listeners) on("account", 1n);
  for (let i = 0; i < 200 && heard() === before; i++) await new Promise((r) => setTimeout(r, 10));
  sender.stop();
}

const CALLERS: Record<string, Caller> = {
  "the self-host's settings fetch": {
    admits: ["private"],
    ask: async (url, address) => (await privateNetworkFetch(only(address))(url, { method: "POST", headers: {}, body: "{}", signal: signal() })).json(),
  },
  "a calendar on a person's own network": {
    admits: ["private", "public"],
    ask: (url, address) => namedHostRequest({ resolver: only(address), policy: { kind: "own-network" } })
      .request(url, { method: "GET", headers: {}, body: null, auth: null, validators: null, signal: signal() }),
  },
  "the picture proxy": { admits: ["public"], ask: (url, address) => makeNodeRemoteFetch().fetch(url, [address]) },
  "the one-click unsubscribe": { admits: ["public"], ask: (url, address) => makeNodeOneClickPost().post(url, [address]) },
  "the new-mail wake": { admits: ["public"], ask: wake },
};

/** Every ordered pair whose first caller admits an address the second refuses. */
const PAIRS = Object.entries(CALLERS).flatMap(([first, a]) => Object.entries(CALLERS)
  .filter(([second, b]) => second !== first && a.admits.some((kind) => !b.admits.includes(kind)))
  .map(([second, b]) => [first, a, second, b] as const));

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("a caller never reaches the address another caller's rule admitted, on the same name and port", () => {
  for (const [first, a, second, b] of PAIRS) {
    it(`${first}, then ${second}`, async (ctx) => {
      const heard: string[] = [];
      const far = await onOnePort((address) => createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          heard.push(address);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ at: address }));
        });
      }));
      if (far === null) return ctx.skip();
      closers.push(far.close);
      const [admitted, own] = far.addresses;
      const url = `http://localhost:${far.port}/x`;
      await a.ask(url, admitted, () => heard.length);
      await b.ask(url, own, () => heard.length);
      expect(heard, `${second} was answered at the address ${first} was admitted to`).toEqual([admitted, own]);
    });
  }
});
