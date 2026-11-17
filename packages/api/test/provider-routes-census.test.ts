import { describe, expect, it, vi } from "vitest";
import { createApp, pipelineFor } from "../src/app.js";
import { JSON_BODY_MAX_BYTES, bodyCeilingFor } from "../src/body-ceiling.js";
import { calendarRoutes } from "../src/calendar/index.js";
import type { ApiDeps } from "../src/deps.js";
import { localRoutes } from "../src/local.js";
import { withRequestGuard, withRequestId } from "../src/middleware.js";
import { RELAY_ALLOWLIST, mayRelay } from "../src/relay-allowlist.js";
import type { Route } from "../src/router.js";
import { calendarNoticeRoutes, makeCalendarNoticeDoor } from "../src/routes/calendar-notices.js";
import { desktopHostRoutes } from "../src/routes/desktop-host.js";
import { apiRoutes } from "../src/routes/index.js";
import { mailboxDeviceOAuthRoutes } from "../src/routes/mailbox-oauth-device.js";
import { selfHostRoutes } from "../src/routes/self-host.js";
import { SERVER_ONLY_ROUTES, UNBOUND_CALLS, WIRE_ROUTES } from "../src/wire-routes.js";

/**
 * THE ROUTES A CALENDAR'S PROVIDER CALLS ARE EXACTLY TWO, AND THEY ARE WHAT THEY SAY. A route
 * marked `provider` runs through the request id and nothing else: no media-type or origin guard,
 * no session. That is right for a door which answers every call alike and reads no credential,
 * and wrong for any other route, so the mark is held to the two notice routes in every table a
 * program mounts; each is unauthenticated, anonymous, never relayed and the server's alone; and
 * what its handler reads of a request is shown by running it.
 */

const TABLES: ReadonlyArray<readonly [string, readonly Route[]]> = [
  ["apiRoutes", apiRoutes],
  ["localRoutes", localRoutes],
  ["selfHostRoutes", selfHostRoutes],
  ["desktopHostRoutes", desktopHostRoutes],
  ["mailboxDeviceOAuthRoutes", mailboxDeviceOAuthRoutes],
  ["calendarRoutes", calendarRoutes],
  ["calendarNoticeRoutes", calendarNoticeRoutes],
];
const NOTICE_ROUTES = ["POST /calendar/notices/google", "POST /calendar/notices/microsoft"];
const key = (r: { method: string; pattern: string }): string => `${r.method.toUpperCase()} ${r.pattern}`;

/** Every route that carries the provider's mark, with the table it stands in. */
function marked(tables: ReadonlyArray<readonly [string, readonly Route[]]>): string[] {
  return tables.flatMap(([table, routes]) => routes.filter((r) => r.options?.provider === true).map((r) => `${table}: ${key(r)}`)).sort();
}

describe("the provider's mark", () => {
  it("is carried by the two notice routes and by no other route of any table", () => {
    expect(TABLES.flatMap(([, routes]) => routes).length).toBeGreaterThan(250);
    expect(marked(TABLES)).toEqual(NOTICE_ROUTES.map((n) => `calendarNoticeRoutes: ${n}`));
    expect(calendarNoticeRoutes.map(key)).toEqual(NOTICE_ROUTES);
  });

  it("REFUSES the mark on a third route", () => {
    const hello = apiRoutes.find((r) => key(r) === "GET /hello")!;
    const planted = { ...hello, options: { ...hello.options, provider: true } } as Route;
    expect(marked([...TABLES, ["planted", [planted]]])).toEqual([
      ...NOTICE_ROUTES.map((n) => `calendarNoticeRoutes: ${n}`), "planted: GET /hello",
    ].sort());
  });

  it("selects the request id alone, where every other route keeps the request guard", () => {
    for (const route of calendarNoticeRoutes) expect([...pipelineFor(route)], key(route)).toEqual([withRequestId]);
    for (const [, routes] of TABLES) {
      for (const route of routes) {
        if (route.options?.provider === true) continue;
        expect(pipelineFor(route), key(route)).toContain(withRequestGuard);
      }
    }
  });
});

describe("each notice route's class", () => {
  it("is unauthenticated, anonymous, raw, a literal path, and carries nothing of its own", () => {
    expect(calendarNoticeRoutes.map((r) => ({
      route: key(r), cost: r.cost, relay: r.relay, wire: r.wire ?? null, replay: r.replay ?? null, options: r.options,
    }))).toEqual(NOTICE_ROUTES.map((route, i) => ({
      route, cost: "unauthenticated", relay: false, wire: null, replay: null,
      options: { public: true, anonymous: true, raw: true, provider: true, bodyMaxBytes: [0, 64 * 1024][i] },
    })));
    for (const r of calendarNoticeRoutes) expect(r.pattern.includes(":"), r.pattern).toBe(false);
  });

  it("is in no table but its own: not the managed one, not a self-hosted server's, not a device's door", () => {
    for (const [table, routes] of TABLES) {
      if (table === "calendarNoticeRoutes") continue;
      expect(routes.map(key).filter((k) => k.includes("/calendar/notices")), table).toEqual([]);
    }
  });

  it("is never relayed: the relay's list does not hold it, and a relay asked for it refuses", () => {
    expect(RELAY_ALLOWLIST.map(key).filter((k) => k.includes("/calendar/notices"))).toEqual([]);
    for (const path of ["/calendar/notices/google", "/calendar/notices/microsoft", "/api/calendar/notices/google"]) {
      expect(mayRelay("POST", path), path).toBe(false);
    }
  });

  it("is the server's alone, for the provider's reason, which no other route gives", () => {
    expect(Object.entries(SERVER_ONLY_ROUTES).filter(([, why]) => why === "provider").map(([name]) => name).sort()).toEqual(NOTICE_ROUTES);
    for (const name of NOTICE_ROUTES) {
      expect((WIRE_ROUTES as readonly string[]).includes(name) || (UNBOUND_CALLS as readonly string[]).includes(name), name).toBe(false);
    }
  });

  it("has a body ceiling of its own: none of Google's is read, and of Microsoft's 64 KiB", () => {
    const large = 50 * 1024 * 1024;
    expect(bodyCeilingFor([...calendarNoticeRoutes], "POST", "/calendar/notices/google", large)).toBe(0);
    expect(bodyCeilingFor([...calendarNoticeRoutes], "POST", "/calendar/notices/microsoft", large)).toBe(64 * 1024);
  });

  it("a route's own ceiling only lowers: one named above the JSON ceiling is held to it, and no other route names one", () => {
    const greedy = { ...calendarNoticeRoutes[1]!, options: { ...calendarNoticeRoutes[1]!.options, bodyMaxBytes: 1024 * 1024 * 1024 } } as Route;
    expect(bodyCeilingFor([greedy], "POST", "/calendar/notices/microsoft", 50 * 1024 * 1024)).toBe(JSON_BODY_MAX_BYTES);
    for (const [table, routes] of TABLES) {
      if (table === "calendarNoticeRoutes") continue;
      expect(routes.filter((r) => r.options?.bodyMaxBytes !== undefined).map(key), table).toEqual([]);
    }
  });
});

describe("what a notice route's handler reads of a request", () => {
  const app = createApp(calendarNoticeRoutes);
  const door = (): ApiDeps["services"] => ({
    calendarNotices: makeCalendarNoticeDoor({ microsoftValidation: true, log: { info() {}, warn() {} } as never, now: () => 0 }),
  }) as ApiDeps["services"];
  /** A request that carries a session both ways, and which header names its handling asked for. */
  async function asked(req: Request): Promise<{ names: string[]; res: Response; deps: ApiDeps }> {
    const get = vi.spyOn(req.headers, "get");
    const deps = { db: {}, now: () => new Date(), requestId: "", session: null, services: door() } as unknown as ApiDeps;
    const res = await app.handle(req, deps);
    return { names: [...new Set(get.mock.calls.map(([name]) => String(name).toLowerCase()))].sort(), res, deps };
  }
  const credentials = { cookie: "tf_session=a-session; tf_csrf=a-csrf", authorization: "Bearer a-session" };

  it("Google's: its three headers and no other, never a cookie and never Authorization", async () => {
    const { names, res, deps } = await asked(new Request("https://api.example.test/calendar/notices/google", {
      method: "POST", headers: { ...credentials, "x-goog-channel-id": "not-shaped", "x-goog-resource-uri": "https://www.googleapis.com/x" },
    }));
    expect(names).toEqual(["x-goog-channel-id", "x-goog-channel-token", "x-goog-resource-id"]);
    expect([res.status, deps.session, res.headers.get("x-ohmail-account"), res.headers.get("set-cookie")]).toEqual([202, null, null, null]);
  });

  it("Microsoft's: the body's length and nothing else, never a cookie and never Authorization", async () => {
    const { names, res, deps } = await asked(new Request("https://api.example.test/calendar/notices/microsoft", {
      method: "POST", headers: { ...credentials, "content-type": "application/json" }, body: JSON.stringify({ value: [] }),
    }));
    expect(names).toEqual(["content-length"]);
    expect([res.status, deps.session, res.headers.get("x-ohmail-account"), res.headers.get("set-cookie")]).toEqual([202, null, null, null]);
  });

  it("is refused by the guard it does not carry, where a route carries it: the control", async () => {
    // The same call to a route of the anonymous pipeline is refused for its media type: the guard is what the mark removes.
    const guarded = createApp([{ ...calendarNoticeRoutes[1]!, options: { public: true, anonymous: true, raw: true } } as Route]);
    const res = await guarded.handle(
      new Request("https://api.example.test/calendar/notices/microsoft?validationToken=abc", { method: "POST", headers: { "content-type": "text/plain" }, body: "" }),
      { db: {}, now: () => new Date(), requestId: "", session: null, services: door() } as unknown as ApiDeps,
    );
    expect(res.status).toBe(415);
    const open = await app.handle(
      new Request("https://api.example.test/calendar/notices/microsoft?validationToken=abc", { method: "POST", headers: { "content-type": "text/plain" }, body: "" }),
      { db: {}, now: () => new Date(), requestId: "", session: null, services: door() } as unknown as ApiDeps,
    );
    expect([open.status, await open.text()]).toEqual([200, "abc"]);
  });
});
