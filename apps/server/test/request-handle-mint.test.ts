// @services: none — its Postgres URLs are never dialed
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { bindingOf } from "@trafficflow/db";
import { brandDialect } from "@trafficflow/db/dialect";
import type { ApiDeps } from "@trafficflow/api";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { MANAGED_ENV, PLAIN_ENV, PROCESS_DOOR, env, functionDoor, functionInput, processInput, recordingLogger } from "./_envs.js";

/**
 * THE HOST MINTS EVERY REQUEST'S HANDLE BOUND TO NOTHING. A request leaves the host's deps builder
 * with a handle that names no account and carries no key, over the pool's own handle, which no
 * request holds; the session door binds it. The two ports that write an account's row read the
 * request's handle when they are used, so they write under the account the session door bound.
 */
const open: Program[] = [];
afterEach(async () => { for (const p of open.splice(0)) await p.close(); });

const plain = (): Program => {
  const p = buildProgram(loadSettings(env(PLAIN_ENV), PROCESS_DOOR), processInput(recordingLogger().logger));
  open.push(p);
  return p;
};
const managed = (extra: Record<string, string> = {}): Program => {
  const p = buildProgram(loadSettings(env(MANAGED_ENV, extra), functionDoor()), functionInput(recordingLogger().logger));
  open.push(p);
  return p;
};
const request = (origin: string): Request => new Request(`${origin}/hello`);

describe("the request's handle as the host builds it", () => {
  for (const [name, build, origin] of [
    ["a self-hosted server", plain, "https://mail.example.com"],
    ["the managed service", managed, "https://api.ohmail.app"],
  ] as const) {
    it(`${name}: bound to nothing, without a key, a view over the pool's handle`, () => {
      const p = build();
      const deps = p.buildDeps(request(origin));
      expect(bindingOf(deps.db)).toEqual({ account: null, keyed: false });
      // The pool's own handle carries no binding and is one step under the request's.
      expect(bindingOf(Object.getPrototypeOf(deps.db))).toBeUndefined();
      // A second request gets a container of its own.
      expect(p.buildDeps(request(origin))).not.toBe(deps);
    });

    it(`${name}: the session doors' handle is minted the same way, over its own shorter wait`, () => {
      const deps = build().buildDeps(request(origin));
      const session = deps.sessionDb!();
      expect(bindingOf(session)).toEqual({ account: null, keyed: false });
      expect(session).not.toBe(deps.db);
      expect(bindingOf(Object.getPrototypeOf(session))).toBeUndefined();
    });
  }
});

describe("the ports that write an account's row use the request's handle as it stands when they are used", () => {
  /** A handle that records being reached and does nothing: what the session door would have left on the container. */
  function standIn(): { handle: ApiDeps["db"]; reached: () => number } {
    let touched = 0;
    // Branded first, on the object itself: only a statement's own reach is counted below.
    const handle = new Proxy(brandDialect({}, "pg"), {
      get(target, prop) {
        if (typeof prop === "symbol") return Reflect.get(target, prop);
        touched += 1;
        return () => { throw new Error("the stand-in handle was reached"); };
      },
    });
    return { handle: handle as unknown as ApiDeps["db"], reached: () => touched };
  }

  it("a connect attempt is recorded through the handle the container holds then, not the one it was built with", async () => {
    const deps = managed({ TF_CONNECT_ATTEMPTS: "record", CRON_SECRET: "c".repeat(32) }).buildDeps(request("https://api.ohmail.app"));
    expect(deps.connectAttempts).toBeDefined();
    const later = standIn();
    deps.db = later.handle;
    await deps.connectAttempts!(randomUUID(), { door: "oauth_start" });
    expect(later.reached()).toBeGreaterThan(0);
  });

  it("a refund obligation is written and settled through the handle the container holds then", async () => {
    const deps = managed().buildDeps(request("https://api.ohmail.app"));
    expect(deps.refundObligations).toBeDefined();
    const later = standIn();
    deps.db = later.handle;
    const accountId = randomUUID();
    await expect(deps.refundObligations!.owe({
      accountId, action: "draft_generate", attemptKey: "k", attempt: "a", reason: "drafter_failed",
    } as never)).rejects.toThrow("the stand-in handle was reached");
    const afterOwe = later.reached();
    expect(afterOwe).toBeGreaterThan(0);
    await expect(deps.refundObligations!.settle(accountId, "a")).rejects.toThrow("the stand-in handle was reached");
    expect(later.reached()).toBeGreaterThan(afterOwe);
  });
});
