import { describe, expect, it } from "vitest";
import {
  DEMO_NOW, FixturesAdapter, HttpAdapter, OhmailEngine, SERVER_ADDRESS_DIRECTIONS_SERVED,
  type ServerAddressOpts,
} from "@ohmail/client-engine";

/**
 * THE ADDRESS VIEW'S DIRECTION REACHES THE WIRE. The archive answers `to` and `any` since mail 0154,
 * so the engine asks the direction on screen and the adapter sends it. A server that predates the
 * recipient index refuses `to`/`any` by name (`search_direction_unsupported`); the engine then asks
 * `from` once and labels the answer `from`, so the view states the shortfall instead of failing.
 */
type Seen = { address: string | null; direction: string | null };

function server(refuse: boolean, seen: Seen[]): typeof globalThis.fetch {
  return ((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const direction = url.searchParams.get("direction");
    seen.push({ address: url.searchParams.get("address"), direction });
    if (refuse && direction !== "from") {
      return Promise.resolve(new Response(JSON.stringify({ error: { code: "search_direction_unsupported", message: "no" } }),
        { status: 400, headers: { "content-type": "application/json" } }));
    }
    return Promise.resolve(new Response(JSON.stringify({ items: [], total: direction === "from" ? 3 : 5, direction }),
      { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof globalThis.fetch;
}

describe("the address direction on the wire", () => {
  it("every direction is served", () => {
    expect([...SERVER_ADDRESS_DIRECTIONS_SERVED].sort()).toEqual(["any", "from", "to"]);
  });

  it("the adapter sends the direction asked, and `from` when none is", async () => {
    const seen: Seen[] = [];
    const a = new HttpAdapter({ baseUrl: "https://api.test", fetch: server(false, seen) });
    expect((await a.searchAddressServer("Info@acme.test", { direction: "to" })).direction).toBe("to");
    await a.searchAddressServer("Info@acme.test", { direction: "any" });
    await a.searchAddressServer("Info@acme.test", {});
    expect(seen).toEqual([
      { address: "Info@acme.test", direction: "to" },
      { address: "Info@acme.test", direction: "any" },
      { address: "Info@acme.test", direction: "from" },
    ]);
  });

  it("the engine asks the direction it is given and reads the answer's own", async () => {
    const seen: Seen[] = [];
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(), now: () => DEMO_NOW,
      serverAddressSearch: async (address: string, opts: ServerAddressOpts) => {
        seen.push({ address, direction: opts.direction ?? null });
        return { items: [], total: 1, direction: opts.direction ?? "from" };
      },
    });
    const [to, any] = await Promise.all([
      engine.searchAddressServer("x@acme.test", { direction: "to" }),
      engine.searchAddressServer("x@acme.test", { direction: "any" }),
    ]);
    expect(to).toMatchObject({ state: "ready", direction: "to" });
    expect(any).toMatchObject({ state: "ready", direction: "any" });
    // Two directions are two questions: single-flight never joins them.
    expect(seen.map((s) => s.direction)).toEqual(["to", "any"]);
    await engine.searchAddressServer("x@acme.test");
    expect(seen.at(-1)!.direction).toBe("from");
  });

  it("an older server refuses `to` by name: the engine asks `from` once and labels it so", async () => {
    const seen: Seen[] = [];
    const engine = new OhmailEngine({
      adapter: new HttpAdapter({ baseUrl: "https://api.test", fetch: server(true, seen) }), now: () => DEMO_NOW,
    });
    const out = await engine.searchAddressServer("x@acme.test", { direction: "to" });
    expect(out).toMatchObject({ state: "ready", total: 3, direction: "from" });
    expect(seen.map((s) => s.direction)).toEqual(["to", "from"]);
  });

  it("CONTROL: any other refusal is a failure, asked once", async () => {
    const seen: Seen[] = [];
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(), now: () => DEMO_NOW,
      serverAddressSearch: async (address: string, opts: ServerAddressOpts) => {
        seen.push({ address, direction: opts.direction ?? null });
        throw Object.assign(new Error("down"), { code: "db_busy" });
      },
    });
    expect((await engine.searchAddressServer("x@acme.test", { direction: "to" })).state).toBe("failed");
    expect(seen.map((s) => s.direction)).toEqual(["to"]);
  });
});
