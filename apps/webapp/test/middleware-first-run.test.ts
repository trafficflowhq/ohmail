import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEB = "http://localhost:3000";
const API = "http://api:8080";
const hello = (needsSetup: boolean) => Response.json({ product: "ohmail", needsSetup });

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_OHMAIL_FLAVOR", "selfhost");
  vi.stubEnv("OHMAIL_INTERNAL_API_ORIGIN", API);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function frontDoor() {
  const { middleware } = await import("../middleware");
  return (request = new NextRequest(WEB)) => middleware(request);
}

function expectRedirect(response: Response, path: string) {
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(`${WEB}${path}`);
  expect(response.headers.get("cache-control")).toContain("no-store");
}

describe("the first page on a self-hosted server", () => {
  it("opens setup when the server cannot answer before the deadline", async () => {
    let timedOut = false;
    const fetchHello = vi.fn((_url: string, { signal }: RequestInit) => new Promise<Response>((resolve, reject) => {
      const delayed = setTimeout(() => resolve(hello(true)), 1_500);
      signal?.addEventListener("abort", () => {
        timedOut = true;
        clearTimeout(delayed);
        reject(signal.reason);
      }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchHello);

    const open = await frontDoor();
    const response = await open();
    expect(timedOut).toBe(true);
    expect(fetchHello).toHaveBeenCalledWith(`${API}/hello`, expect.objectContaining({ cache: "no-store" }));
    expectRedirect(response, "/setup");
  });

  it.each([
    ["the connection fails", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["the server is unavailable", () => Promise.resolve(new Response(null, { status: 503 }))],
    ["the answer is incomplete", () => Promise.resolve(Response.json({ product: "ohmail" }))],
  ] as const)("opens setup when %s and checks again on the next visit", async (_failure, fail) => {
    const fetchHello = vi.fn<() => Promise<Response>>()
      .mockImplementationOnce(fail)
      .mockResolvedValueOnce(hello(true))
      .mockResolvedValueOnce(hello(false));
    vi.stubGlobal("fetch", fetchHello);

    const open = await frontDoor();
    expectRedirect(await open(), "/setup");
    expectRedirect(await open(), "/setup");
    expectRedirect(await open(), "/login");
    expect(fetchHello).toHaveBeenCalledTimes(3);
  });

  it("preserves the sign-in return after a session ends when setup status is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(hello(true)));
    const open = await frontDoor();
    const request = () => new NextRequest(`${WEB}/?from=mail`, {
      headers: { cookie: "tf_signed_out=revoked" },
    });

    expectRedirect(await open(request()), "/login");
    expectRedirect(await open(request()), "/setup?from=mail");
  });

  it.each([
    ["?demo=1", new Response(null, { status: 503 })],
    ["?demo=0&demo=yes", hello(true)],
  ] as const)("opens the explicit demo without probing setup: %s", async (query, reply) => {
    const fetchHello = vi.fn().mockResolvedValue(reply);
    vi.stubGlobal("fetch", fetchHello);
    const open = await frontDoor();

    const response = await open(new NextRequest(`${WEB}/${query}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${WEB}/mailbox${query}`);
    expect(fetchHello).not.toHaveBeenCalled();
  });

  it("checks setup on an ordinary visit with demo turned off in the URL", async () => {
    const fetchHello = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchHello);
    const open = await frontDoor();

    expectRedirect(await open(new NextRequest(`${WEB}/?demo=0`)), "/setup?demo=0");
    expect(fetchHello).toHaveBeenCalledTimes(1);
  });
});
