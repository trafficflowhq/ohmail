import { describe, it, expect } from "vitest";
import { pipelineFor } from "../src/app.js";
import {
  withCsrf, withErrorEnvelope, withIdempotency, withPressAge, withRequestGuard, withRequestId,
  withSession, withSpendGate, withStepUp, type Middleware,
} from "../src/middleware.js";
import type { Route } from "../src/router.js";

/**
 * WHERE A ROUTE'S OWN MIDDLEWARE RUNS.
 *
 * `app.ts` splices `options.middleware` in directly after `withRequestGuard`, which is the
 * position the staff step-up held while it was a member of all three pipelines — the composition
 * moved, the order did not. This is what says so: the anchor exists in every chain, the splice
 * puts the carried middleware exactly there, and a route carrying nothing is untouched.
 */

const noop: Middleware = (next) => next;
const handler = async (): Promise<Response> => new Response("ok");

const route = (options: Route["options"]): Route =>
  ({ method: "POST", pattern: "/x", cost: "unauthenticated", relay: false, options, handler });

const FULL = [
  withRequestId, withErrorEnvelope, withRequestGuard, withSession, withStepUp, withSpendGate,
  withCsrf, withPressAge, withIdempotency,
];
const RAW = [withRequestId, withRequestGuard, withSession, withStepUp, withSpendGate];
const ANON = [withRequestId, withRequestGuard];

describe("the pipeline a route runs through", () => {
  it("selects full / raw / anonymous, and leaves an ordinary route untouched", () => {
    expect([...pipelineFor(route({ public: true }))]).toEqual(FULL);
    expect([...pipelineFor(route({ public: true, raw: true }))]).toEqual(RAW);
    expect([...pipelineFor(route({ public: true, anonymous: true }))]).toEqual(ANON);
  });

  /**
   * The splice anchor is in all three chains. Without it the insertion index falls to 0 and a
   * carried control would run before `withRequestId` — still enforcing, but no longer where this
   * file says it does, and nothing else would notice.
   */
  it("keeps withRequestGuard in every chain, which is what the splice anchors on", () => {
    for (const chain of [FULL, RAW, ANON]) expect(chain).toContain(withRequestGuard);
  });

  it("splices a carried middleware directly after withRequestGuard, in each chain", () => {
    expect([...pipelineFor(route({ public: true, middleware: [noop] }))])
      .toEqual([withRequestId, withErrorEnvelope, withRequestGuard, noop, ...FULL.slice(3)]);
    expect([...pipelineFor(route({ public: true, raw: true, middleware: [noop] }))])
      .toEqual([withRequestId, withRequestGuard, noop, ...RAW.slice(2)]);
    expect([...pipelineFor(route({ public: true, anonymous: true, middleware: [noop] }))])
      .toEqual([withRequestId, withRequestGuard, noop]);
  });

  it("puts a carried middleware before any session is resolved", () => {
    const chain = [...pipelineFor(route({ public: true, middleware: [noop] }))];
    expect(chain.indexOf(noop)).toBeLessThan(chain.indexOf(withSession));
  });

  it("keeps an empty carry from changing anything", () => {
    expect([...pipelineFor(route({ public: true, middleware: [] }))]).toEqual(FULL);
  });

  /**
   * THE CONTROL THAT IT RUNS AT ALL. The assertions above compare arrays; this drives a request
   * through `dispatch` and watches the carried middleware refuse before the handler — a chain
   * assembled in the right order and never invoked would pass every one of them.
   */
  it("runs the carried middleware, ahead of the handler", async () => {
    const { createApp } = await import("../src/app.js");
    const refuse: Middleware = () => async () => new Response("refused", { status: 418 });
    let handlerRan = false;
    const app = createApp([route({
      public: true, anonymous: true, middleware: [refuse],
    })].map((r) => ({ ...r, handler: async () => { handlerRan = true; return new Response("ok"); } }) as Route));
    const res = await app.handle(
      new Request("https://api.test/x", { method: "POST" }),
      { requestId: "", now: () => new Date() } as never,
    );
    expect(res.status).toBe(418);
    expect(handlerRan).toBe(false);
  });
});
