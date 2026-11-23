import { createHmac, randomBytes } from "node:crypto";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const proofHeader = "x-ohmail-client-ip";

describe("forwarding the browser's client address to the API", () => {
  it("authenticates the platform address in the upstream request headers", async () => {
    vi.resetModules();
    const secret = randomBytes(32).toString("hex");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("TF_API_ORIGIN", "http://localhost:3002");
    vi.stubEnv("TF_WEB_CLIENT_IP_SECRET", secret);
    const { middleware } = await import("../middleware");
    const client = "2001:db8::7";
    const seconds = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(seconds * 1000);
    const payload = `${client};${seconds}`;
    const expected = payload + ";" + createHmac("sha256", secret).update(payload).digest("hex");

    const answer = (path: string, platform: boolean, method = "POST") => middleware(new NextRequest("https://web.example.test" + path, {
      method,
      headers: {
        [proofHeader]: "unverified",
        ...(platform ? { "x-vercel-forwarded-for": client } : {}),
      },
    }));
    const headerSent = (response: Response) => response.headers.get("x-middleware-request-" + proofHeader);

    const api = await answer("/api/auth/register", true);
    expect(headerSent(api) === expected).toBe(true);
    expect(api.headers.has(proofHeader)).toBe(false);
    expect(headerSent(await answer("/ApI/auth/register", true)) === expected).toBe(true);
    expect(headerSent(await answer("/%61pi/hello", true, "GET")) === expected).toBe(true);
    expect(headerSent(await answer("/%61pi/waitlist", true, "GET"))).toBeNull();
    expect(headerSent(await answer("/api/auth/register", false))).toBeNull();
    expect(headerSent(await answer("/api/waitlist", true))).toBeNull();

    vi.stubEnv("VERCEL", undefined);
    expect(headerSent(await answer("/api/auth/register", true))).toBeNull();
  });

  it("matches API paths in any case", async () => {
    expect(await matches("/API/auth/register")).toBe(true);
    expect(await matches("/aPi/auth/register")).toBe(true);
  });

  it("scrubs a client copy on an otherwise skipped route", async () => {
    const { middleware } = await import("../middleware");
    const path = "/auth/refresh";
    const headers = { [proofHeader]: "unverified", "content-type": "application/json" };
    expect(await matches(path)).toBe(false);
    expect(await matches(path, headers)).toBe(true);
    const response = await middleware(new NextRequest("https://web.example.test" + path, { method: "POST", headers }));
    const forwarded = response.headers.get("x-middleware-override-headers")?.split(",");
    expect(forwarded).toContain("content-type");
    expect(forwarded).not.toContain(proofHeader);
    expect(response.headers.get("x-middleware-request-" + proofHeader)).toBeNull();
  });
});

async function matches(url: string, headers?: Record<string, string>): Promise<boolean> {
  const { config } = await import("../middleware");
  const matchConfig = config as Parameters<typeof unstable_doesMiddlewareMatch>[0]["config"];
  return unstable_doesMiddlewareMatch({ config: matchConfig, nextConfig: {}, url, headers });
}
