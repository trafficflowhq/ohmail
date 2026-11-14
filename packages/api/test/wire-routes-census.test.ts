import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/routes/index.js";
import { localRoutes } from "../src/local.js";
import { selfHostRoutes } from "../src/routes/self-host.js";
import { desktopHostRoutes } from "../src/routes/desktop-host.js";
import type { Route } from "../src/router.js";
import { SERVER_ONLY_ROUTES, UNBOUND_CALLS, WIRE_ROUTES } from "../src/wire-routes.js";

/**
 * EVERY MOUNTED ROUTE HAS ONE PLACE: bound to the wire's types on both sides, called by a client
 * with types of its own, or the server's alone with a reason. A new route that is in none of the
 * three lists is red here, so whoever adds one says which it is; a route in two is red too.
 *
 * The bound list is also what the tables themselves say: a route is bound exactly when it is
 * marked (`Route.wire`), and the compiler holds a marked route's method, pattern and handler to
 * the wire's entry (`test/contract/wire-drift.fixture.ts`). So this reads the four tables as they are
 * mounted and compares names; it opens no source file.
 */

const TABLES: ReadonlyArray<readonly [string, readonly Route[]]> = [
  ["apiRoutes", apiRoutes],
  ["localRoutes", localRoutes],
  ["selfHostRoutes", selfHostRoutes],
  ["desktopHostRoutes", desktopHostRoutes],
];
const key = (r: { method: string; pattern: string }) => `${r.method.toUpperCase()} ${r.pattern}`;
const everyRoute = TABLES.flatMap(([, routes]) => routes);
const mounted = new Set(everyRoute.map(key));

interface Lists { wire: readonly string[]; unbound: readonly string[]; serverOnly: readonly string[] }
const LISTS: Lists = { wire: WIRE_ROUTES, unbound: UNBOUND_CALLS, serverOnly: Object.keys(SERVER_ONLY_ROUTES) };

/** Each mounted name that is not in exactly one list, and each listed name nothing mounts. */
function misplaced(names: ReadonlySet<string>, lists: Lists): string[] {
  const all = [...lists.wire, ...lists.unbound, ...lists.serverOnly];
  const count = new Map<string, number>();
  for (const n of all) count.set(n, (count.get(n) ?? 0) + 1);
  const out: string[] = [];
  for (const n of [...names].sort()) {
    const c = count.get(n) ?? 0;
    if (c !== 1) out.push(`${n}: in ${c} lists`);
  }
  for (const n of [...new Set(all)].sort()) if (!names.has(n)) out.push(`${n}: listed, mounted nowhere`);
  return out;
}

/** Where the routes' own `wire` marks and the bound list disagree. A marked route's name is its method and pattern. */
function mismarked(routes: readonly Pick<Route, "method" | "pattern" | "wire">[], wire: readonly string[]): string[] {
  const listed = new Set(wire);
  const marked = new Set(routes.filter((r) => r.wire === true).map(key));
  const out: string[] = [];
  for (const n of [...marked].sort()) if (!listed.has(n)) out.push(`${n}: bound in a table, not listed`);
  for (const n of [...listed].sort()) if (!marked.has(n)) out.push(`${n}: listed, bound in no table`);
  return out;
}

describe("every mounted route is bound, called unbound, or the server's alone", () => {
  it("reads four tables with routes in them", () => {
    expect(mounted.size).toBeGreaterThan(250);
    expect(LISTS.wire.length).toBeGreaterThanOrEqual(54);
  });

  it("holds every mounted route in exactly one list, and lists nothing that is not mounted", () => {
    expect(misplaced(mounted, LISTS)).toEqual([]);
  });

  it("REFUSES a route in no list, a route in two, and a listed route nothing mounts", () => {
    const names = new Set(["GET /a", "GET /b", "GET /c"]);
    expect(misplaced(names, { wire: ["GET /a", "GET /b"], unbound: ["GET /b"], serverOnly: ["GET /gone"] })).toEqual([
      "GET /b: in 2 lists",
      "GET /c: in 0 lists",
      "GET /gone: listed, mounted nowhere",
    ]);
  });

  it("gives every server-only route one of the four reasons", () => {
    expect(Object.entries(SERVER_ONLY_ROUTES).filter(([, why]) =>
      !["operator", "platform", "site", "no-caller-found"].includes(why))).toEqual([]);
  });
});

describe("the bound list is what the tables say", () => {
  it("lists exactly the routes that are marked as bound to the wire", () => {
    expect(mismarked(everyRoute, WIRE_ROUTES)).toEqual([]);
  });

  it("REFUSES a bound route that is not listed and a listed one no table binds", () => {
    const routes = [
      { method: "GET", pattern: "/a", wire: true },
      { method: "GET", pattern: "/c", wire: true },
      { method: "GET", pattern: "/d", wire: undefined },
    ] as unknown as Pick<Route, "method" | "pattern" | "wire">[];
    expect(mismarked(routes, ["GET /a", "GET /d"])).toEqual([
      "GET /c: bound in a table, not listed",
      "GET /d: listed, bound in no table",
    ]);
  });
});
