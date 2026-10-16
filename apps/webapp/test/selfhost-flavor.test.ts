import { describe, it, expect, vi, afterEach } from "vitest";

import { rewritesFor } from "../routes.mjs";

/**
 * THE SELF-HOST BUILD ARM — `OHMAIL_FLAVOR=selfhost` — asserted the way `api-rewrite.test.ts`
 * asserts the managed topology, because the two arms are the same decision made by different
 * owners:
 *
 *   managed   — THIS APP owns the origin split: `rewrites()` proxies `/api/*` and
 *               `/auth/refresh` to the allow-listed API origin, `TF_API_ORIGIN` arms it.
 *   selfhost  — the REVERSE PROXY in front of both containers owns the split
 *               (`deploy/selfhost/proxy/Caddyfile`), so this build emits NO rewrite at all while the
 *               client bundle still calls `/api` on its own origin.
 *
 * Two owners of one split is a request routed twice; zero owners is a silently dead client.
 * Every case below pins one edge of "exactly one owner".
 */

interface Rewrite { source: string; destination: string }
interface WebappConfig {
  env?: Record<string, string>;
  rewrites?: () => Promise<Rewrite[]>;
}

/** `api-rewrite.test.ts`'s loader, verbatim: set vars, reset the registry, evaluate as Next does. */
async function loadConfig(
  vars: Record<string, string | undefined>,
): Promise<WebappConfig> {
  const withStars = { NEXT_PUBLIC_GITHUB_STARS: "1", ...vars };
  const previous = Object.fromEntries(Object.keys(withStars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(withStars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    const mod = (await import("../next.config.mjs")).default as
      | WebappConfig
      | (() => Promise<WebappConfig>);
    return typeof mod === "function" ? await mod() : mod;
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => { vi.resetModules(); });

describe("selfHostFlavor — two meaningful states, everything else fails the build", () => {
  it("unset / blank is the managed build", async () => {
    const { selfHostFlavor } = await import("../next.config.mjs");
    expect(selfHostFlavor({})).toBe(false);
    expect(selfHostFlavor({ OHMAIL_FLAVOR: "" })).toBe(false);
    expect(selfHostFlavor({ OHMAIL_FLAVOR: "   " })).toBe(false);
  });

  it("selfhost is the self-host build", async () => {
    const { selfHostFlavor } = await import("../next.config.mjs");
    expect(selfHostFlavor({ OHMAIL_FLAVOR: "selfhost" })).toBe(true);
  });

  it("a misspelled flavor must never select the managed build silently", async () => {
    const { selfHostFlavor } = await import("../next.config.mjs");
    // Each of these is one typo away from a deploy that LOOKS self-host and rewrites nothing
    // while also arming nothing — the silently dead client, reached through spelling.
    for (const bad of ["self-host", "SELFHOST", "local", "managed", "Selfhost"]) {
      expect(() => selfHostFlavor({ OHMAIL_FLAVOR: bad }), bad).toThrow(/OHMAIL_FLAVOR/);
    }
  });
});

describe("OHMAIL_FLAVOR=selfhost — the proxy owns the split", () => {
  it("emits NO rewrite and still arms NEXT_PUBLIC_API_BASE", async () => {
    const cfg = await loadConfig({ OHMAIL_FLAVOR: "selfhost", TF_API_ORIGIN: undefined });
    // The whole contract in two lines: the split is the proxy's, the base is the bundle's.
    expect(await cfg.rewrites?.()).toEqual([]);
    expect(cfg.env?.NEXT_PUBLIC_API_BASE).toBe("/api");
  });

  it("TF_API_ORIGIN set alongside the flavor fails the build — two owners of one split", async () => {
    await expect(loadConfig({ OHMAIL_FLAVOR: "selfhost", TF_API_ORIGIN: "https://api.ohmail.app" }))
      .rejects.toThrow(/reverse proxy owns/);
    // Even a value the managed allow-list would accept: the refusal is about ownership, not
    // about the target's trustworthiness.
    await expect(loadConfig({ OHMAIL_FLAVOR: "selfhost", TF_API_ORIGIN: "http://localhost:3002" }))
      .rejects.toThrow(/reverse proxy owns/);
  });

  it("a misspelled flavor fails the CONFIG EVALUATION, not just the helper", async () => {
    await expect(loadConfig({ OHMAIL_FLAVOR: "self-host", TF_API_ORIGIN: undefined }))
      .rejects.toThrow(/OHMAIL_FLAVOR/);
  });

  it("an externally supplied NEXT_PUBLIC_API_BASE stays a build failure unless it is the derived value", async () => {
    // Next may evaluate the config in a child process that already carries the derived value —
    // the one accepted case, same as the managed arm.
    const cfg = await loadConfig({
      OHMAIL_FLAVOR: "selfhost", TF_API_ORIGIN: undefined, NEXT_PUBLIC_API_BASE: "/api",
    });
    expect(cfg.env?.NEXT_PUBLIC_API_BASE).toBe("/api");
    // An absolute origin would turn every engine request cross-origin, exactly as on managed.
    await expect(loadConfig({
      OHMAIL_FLAVOR: "selfhost", TF_API_ORIGIN: undefined, NEXT_PUBLIC_API_BASE: "https://evil.example",
    })).rejects.toThrow(/NEXT_PUBLIC_API_BASE/);
  });

  it("an externally supplied NEXT_PUBLIC_OHMAIL_FLAVOR fails the build unless it is the derived value", async () => {
    // THE BYPASS THIS CLOSES (a review finding): Next inlines every NEXT_PUBLIC_* variable it finds in
    // the build environment whether or not the `env` block names it — so a MANAGED build whose
    // dashboard grew `NEXT_PUBLIC_OHMAIL_FLAVOR=selfhost` would compile the self-host branch of
    // the session gate, and a second variable (`OHMAIL_INTERNAL_API_ORIGIN`) could then point
    // the gate's bearer-carrying fetch anywhere — the TF_API_ORIGIN incident, re-armed through
    // the flavor. The flavor's public twin is DERIVED, never supplied: a managed build refuses
    // ANY value, and a self-host build accepts exactly the value it derives anyway (Next may
    // evaluate the config in a child process that already carries it — the API_BASE rule).
    await expect(loadConfig({
      OHMAIL_FLAVOR: undefined, TF_API_ORIGIN: "https://api.ohmail.app", NEXT_PUBLIC_OHMAIL_FLAVOR: "selfhost",
    })).rejects.toThrow(/NEXT_PUBLIC_OHMAIL_FLAVOR/);
    await expect(loadConfig({
      OHMAIL_FLAVOR: undefined, TF_API_ORIGIN: undefined, NEXT_PUBLIC_OHMAIL_FLAVOR: "selfhost",
    })).rejects.toThrow(/NEXT_PUBLIC_OHMAIL_FLAVOR/);
    // A WRONG value on a self-host build refuses too — only the derived literal passes.
    await expect(loadConfig({
      OHMAIL_FLAVOR: "selfhost", TF_API_ORIGIN: undefined, NEXT_PUBLIC_OHMAIL_FLAVOR: "managed",
    })).rejects.toThrow(/NEXT_PUBLIC_OHMAIL_FLAVOR/);
    const cfg = await loadConfig({
      OHMAIL_FLAVOR: "selfhost", TF_API_ORIGIN: undefined, NEXT_PUBLIC_OHMAIL_FLAVOR: "selfhost",
    });
    expect(cfg.env?.NEXT_PUBLIC_OHMAIL_FLAVOR).toBe("selfhost");
  });

  it("the flavor's public twin is emitted on the self-host build and ABSENT on managed", async () => {
    const self = await loadConfig({ OHMAIL_FLAVOR: "selfhost", TF_API_ORIGIN: undefined });
    expect(self.env?.NEXT_PUBLIC_OHMAIL_FLAVOR).toBe("selfhost");
    const managed = await loadConfig({ OHMAIL_FLAVOR: undefined, TF_API_ORIGIN: "https://api.ohmail.app" });
    expect(managed.env?.NEXT_PUBLIC_OHMAIL_FLAVOR).toBeUndefined();
  });

  it("VERCEL_ENV=production with the flavor set does NOT trip the armed assertion", async () => {
    // assertApiArmed exists for the managed deploy that forgot its one variable. The flavor IS
    // an armed state (the base is set, the proxy serves it), so production-shaped env must not
    // refuse the build the self-host image runs.
    const cfg = await loadConfig({
      OHMAIL_FLAVOR: "selfhost", TF_API_ORIGIN: undefined, VERCEL_ENV: "production",
    });
    expect(await cfg.rewrites?.()).toEqual([]);
    expect(cfg.env?.NEXT_PUBLIC_API_BASE).toBe("/api");
  });
});

describe("the managed build is byte-identical in behavior with the flavor unset", () => {
  it("armed managed still emits both rewrites and the base", async () => {
    const cfg = await loadConfig({ OHMAIL_FLAVOR: undefined, TF_API_ORIGIN: "https://api.ohmail.app" });
    const rewrites = (await cfg.rewrites?.()) ?? [];
    // The managed arm emits the route table's whole answer; the self-host arm emits none of it.
    // Written against the table so a rewrite added there does not leave this case stale.
    expect(rewrites).toEqual(rewritesFor("https://api.ohmail.app"));
    expect(rewrites.map((r) => r.source)).toContain("/api/:path*");
    expect(rewrites.map((r) => r.source)).toContain("/auth/refresh");
    expect(cfg.env?.NEXT_PUBLIC_API_BASE).toBe("/api");
  });

  it("unarmed managed still derives NOTHING — the flavor must not leak an armed base", async () => {
    const cfg = await loadConfig({ OHMAIL_FLAVOR: undefined, TF_API_ORIGIN: undefined });
    expect(await cfg.rewrites?.()).toEqual([]);
    expect(cfg.env?.NEXT_PUBLIC_API_BASE).toBeUndefined();
  });
});
