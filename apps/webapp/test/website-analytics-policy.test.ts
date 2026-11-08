import { afterEach, describe, expect, it, vi } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import {
  ANALYTICS_CSP_SOURCES, GA_ID_VAR, assertMeasurementId, gtagUrl, measurementId, withAnalytics,
} from "../analytics.mjs";
import { MARKETING_PATHS, OWN_ROUTES } from "../routes.mjs";
import { BASELINE_CSP } from "../app/security-headers.js";

/**
 * THE WEBSITE'S VISIT STATISTICS ARE OFF UNLESS A BUILD CARRIES AN ID, AND ONLY THE WEBSITE'S
 * DOCUMENTS EVER GAIN A GOOGLE SOURCE. The header rules are matched here by Next's own path
 * matcher, so "exactly one CSP per path, and which one" is a reading of what the server sends,
 * not of the rule list's spelling. `proxy.e2e.test.ts` stays the real-socket reading.
 */

const ID = "G-9SPZX4FS1X";

type Rule = { source: string; headers: Array<{ key: string; value: string }> };

async function rulesFor(id: string | undefined, zone?: string): Promise<Rule[]> {
  const vars: Record<string, string | undefined> = {
    [GA_ID_VAR]: id, NEXT_PUBLIC_GITHUB_STARS: "1",
    LANDING_ZONE_ORIGIN: zone, LANDING_ZONE_BYPASS: zone === undefined ? undefined : "b",
  };
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    const mod = (await import("../next.config.mjs")).default as () => Promise<{ headers(): Promise<Rule[]> }>;
    return await (await mod()).headers();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every CSP the rules give `path`, as the server's matcher reads them. */
function cspsFor(rules: Rule[], path: string): string[] {
  return rules
    .filter((r) => getPathMatch(r.source, { strict: true, removeUnnamedParams: true })(path) !== false)
    .flatMap((r) => r.headers.filter((h) => h.key === "Content-Security-Policy").map((h) => h.value));
}

/** The product's paths: every route the table declares that is not the website, plus the proxied and static ones. */
const PRODUCT_PATHS = [
  ...OWN_ROUTES.filter((r) => !r.marketing && r.path !== "/demo" && !r.path.includes("[")).map((r) => r.path),
  "/api/session", "/auth/refresh", "/_next/static/chunks/main.js", "/favicon.ico", "/privacy/x", "/de/x",
];
/** The branded 404 is the catch-all: never listed, so it keeps the baseline. */
const UNKNOWN_PATHS = ["/no-such-page", "/a/b/c"];

afterEach(() => { vi.resetModules(); });

describe("the measurement id gate", () => {
  it("only the plain G- shape is an id", () => {
    expect(measurementId(ID)).toBe(ID);
    expect(measurementId(` ${ID} `)).toBe(ID);
    for (const bad of [undefined, null, "", "UA-" + "1234-1", "G-", "G-abc123", 'G-1234"; script-src *', "G-12 34"]) {
      expect(measurementId(bad), String(bad)).toBeNull();
    }
  });

  it("the build refuses a SET variable that is not an id, and treats unset as off", () => {
    expect(assertMeasurementId({})).toBeNull();
    expect(assertMeasurementId({ [GA_ID_VAR]: "  " })).toBeNull();
    expect(assertMeasurementId({ [GA_ID_VAR]: ID })).toBe(ID);
    expect(() => assertMeasurementId({ [GA_ID_VAR]: "UA-" + "1234-1" })).toThrow(/not a measurement id/);
  });

  it("the loader address names the id and Google's tag host", () => {
    expect(gtagUrl(ID)).toBe(`https://www.googletagmanager.com/gtag/js?id=${ID}`);
  });
});

describe("withAnalytics adds the Google sources to three directives and changes nothing else", () => {
  it("script-src, connect-src and img-src gain exactly the listed sources", () => {
    const widened = withAnalytics(BASELINE_CSP).split("; ");
    const base = BASELINE_CSP.split("; ");
    expect(widened).toHaveLength(base.length);
    for (let i = 0; i < base.length; i++) {
      const name = base[i]!.split(" ")[0]!;
      const extra = (ANALYTICS_CSP_SOURCES as Record<string, readonly string[]>)[name];
      expect(widened[i]).toBe(extra ? `${base[i]} ${extra.join(" ")}` : base[i]);
    }
    expect(withAnalytics(BASELINE_CSP)).toContain("script-src 'self' 'unsafe-inline' https://www.googletagmanager.com");
    expect(withAnalytics(BASELINE_CSP)).toContain("connect-src 'self' https://*.google-analytics.com");
    expect(withAnalytics(BASELINE_CSP)).toContain("frame-ancestors 'none'");
  });

  it("refuses a policy missing one of the three rather than extending it silently", () => {
    expect(() => withAnalytics("default-src 'self'; script-src 'self'")).toThrow(/connect-src/);
  });
});

describe("without an id, every route keeps today's policy (the old no-third-party reading)", () => {
  it("the rules are the two every build had: /demo and the blanket baseline", async () => {
    const rules = await rulesFor(undefined);
    expect(rules.map((r) => r.source)).toEqual(["/demo", "/((?!demo).*)"]);
    for (const p of [...MARKETING_PATHS, ...PRODUCT_PATHS, ...UNKNOWN_PATHS]) {
      expect(cspsFor(rules, p), p).toEqual([BASELINE_CSP]);
    }
    expect(JSON.stringify(rules)).not.toMatch(/google/);
  });
});

describe("with an id, the website's documents gain Google and nothing else moves", () => {
  it("each website path carries exactly one policy: the baseline plus the Google sources", async () => {
    const rules = await rulesFor(ID);
    expect([...MARKETING_PATHS].sort()).toEqual(["/", "/de", "/delete-account", "/imprint", "/privacy", "/subprocessors", "/support"]);
    for (const p of MARKETING_PATHS) expect(cspsFor(rules, p), p).toEqual([withAnalytics(BASELINE_CSP)]);
  });

  it("each product path, the 404 and every asset keeps exactly the baseline", async () => {
    const rules = await rulesFor(ID);
    for (const p of [...PRODUCT_PATHS, ...UNKNOWN_PATHS]) expect(cspsFor(rules, p), p).toEqual([BASELINE_CSP]);
  });

  it("the demo keeps its own framable policy, alone", async () => {
    const [unset, set] = [await rulesFor(undefined), await rulesFor(ID)];
    expect(cspsFor(set, "/demo")).toEqual(cspsFor(unset, "/demo"));
    expect(cspsFor(set, "/demo")).toHaveLength(1);
    expect(cspsFor(set, "/demo")[0]).not.toMatch(/google/);
  });

  it("a malformed id fails the config rather than shipping a half-armed site", async () => {
    await expect(rulesFor("UA-" + "1234-1")).rejects.toThrow(/not a measurement id/);
  });
});

describe("with an armed landing zone the website carries its own tag and policy, and this config neither", () => {
  const ZONE = "https://site.ohmail.app";
  const zonePaths = new Set([
    "/", "/de", "/imprint", "/privacy", "/subprocessors", "/support", "/delete-account", "/api/waitlist", "/flathub-verification",
  ]);

  it("no Google source anywhere: the zone's paths carry no policy from here, every other path the baseline", async () => {
    const rules = await rulesFor(undefined, ZONE);
    expect(JSON.stringify(rules)).not.toMatch(/google/);
    for (const p of [...MARKETING_PATHS, ...PRODUCT_PATHS, ...UNKNOWN_PATHS]) {
      expect(cspsFor(rules, p), p).toEqual(zonePaths.has(p) ? [] : [BASELINE_CSP]);
    }
  });

  it("the id beside a zone refuses the build: the measurement id belongs to the landing project", async () => {
    await expect(rulesFor(ID, ZONE)).rejects.toThrow(/belongs to the landing project/);
  });
});
