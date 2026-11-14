import { describe, it, expect } from "vitest";
import { createApp, jsonResponse, matchRoute, type Route } from "@trafficflow/api";
import { makeDeps, req } from "./helpers.js";

const noop: Route["handler"] = async () => new Response();

const routes: Route[] = [
  { method: "POST", pattern: "/threads/merge", handler: noop },
  { method: "GET", pattern: "/threads/:id", handler: noop },
  { method: "PATCH", pattern: "/threads/:id", handler: noop },
  { method: "GET", pattern: "/messages/:id", handler: noop },
  { method: "POST", pattern: "/messages/:id/move", handler: noop },
  { method: "POST", pattern: "/mailboxes/:id/resync", handler: noop },
];

describe("matchRoute", () => {
  it("prefers a static segment over a param: /threads/merge", () => {
    const m = matchRoute(routes, "POST", "/threads/merge");
    expect(m.matched).toBe(true);
    if (m.matched) expect(m.route.pattern).toBe("/threads/merge");
  });

  it("falls through to the param route for a real id", () => {
    const m = matchRoute(routes, "GET", "/threads/abc-123");
    expect(m.matched).toBe(true);
    if (m.matched) {
      expect(m.route.pattern).toBe("/threads/:id");
      expect(m.params.id).toBe("abc-123");
    }
  });

  it("resolves nested static-after-param routes: /messages/:id/move", () => {
    const move = matchRoute(routes, "POST", "/messages/m1/move");
    expect(move.matched).toBe(true);
    if (move.matched) {
      expect(move.route.pattern).toBe("/messages/:id/move");
      expect(move.params.id).toBe("m1");
    }
    const get = matchRoute(routes, "GET", "/messages/m1");
    expect(get.matched).toBe(true);
    if (get.matched) expect(get.route.pattern).toBe("/messages/:id");
  });

  it("extracts params for /mailboxes/:id/resync", () => {
    const m = matchRoute(routes, "POST", "/mailboxes/mb-9/resync");
    expect(m.matched).toBe(true);
    if (m.matched) expect(m.params.id).toBe("mb-9");
  });

  it("returns 404 (not matched, method-not-allowed=false) for an unknown path", () => {
    const m = matchRoute(routes, "GET", "/nope/here");
    expect(m.matched).toBe(false);
    if (!m.matched) expect(m.methodNotAllowed).toBe(false);
  });

  it("returns 405 (matched path, wrong method) for a known path", () => {
    const m = matchRoute(routes, "DELETE", "/threads/abc-123");
    expect(m.matched).toBe(false);
    if (!m.matched) expect(m.methodNotAllowed).toBe(true);
  });
});

describe("createApp answers what the match said", () => {
  it("an unknown path is 404, a known path asked the wrong way is 405, and neither reaches a handler", async () => {
    let ran = 0;
    const counted: Route["handler"] = async () => { ran += 1; return jsonResponse({ ok: true }); };
    const table: Route[] = [
      { method: "GET", pattern: "/things", cost: "read", relay: false, options: { public: true }, handler: counted },
      { method: "POST", pattern: "/things/merge", cost: "work", relay: false, options: { public: true }, handler: counted },
    ];
    const { deps } = await makeDeps();
    const app = createApp(table);

    const unknown = await app.handle(req("GET", "/nope/here"), deps);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });

    const wrongWay = await app.handle(req("DELETE", "/things"), deps);
    expect(wrongWay.status).toBe(405);
    expect(await wrongWay.json()).toMatchObject({ error: { code: "method_not_allowed" } });
    // A static segment under a param-less path is its own route: GET on a POST-only one is 405 too.
    expect((await app.handle(req("GET", "/things/merge"), deps)).status).toBe(405);
    expect(ran).toBe(0);

    // The control: asked the right way, the handler runs and its answer leaves unchanged.
    const right = await app.handle(req("GET", "/things"), deps);
    expect(right.status).toBe(200);
    expect(await right.json()).toEqual({ ok: true });
    expect(ran).toBe(1);
  });
});
