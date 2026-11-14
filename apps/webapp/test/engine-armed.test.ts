import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HttpAdapter } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { createEngine, EngineUnarmedError } from "../app/shell/engine-config.js";
import { transportOf } from "@ohmail/app-logic/session/sync-scheduler";
import { assertApiArmed, API_ORIGIN_VAR } from "../next.config.mjs";
import { isDemoBuild } from "../app/demo-mode.js";

/**
 * AN UNARMED PRODUCTION BUILD MUST FAIL, NOT DEGRADE.
 *
 * The defect this file exists for: `NEXT_PUBLIC_API_BASE` absent from a production build
 * meant `createEngine(false, …)` returned a `FixturesAdapter`. A signed-in, paying customer
 * would then be shown Mila's fictional mailbox — in the LIVE chrome, with no demo ribbon,
 * because `AppShell` reads the engine's own mode and that mode is `false` — and every click
 * they made would be accepted against fixtures. Nothing errored. Nothing logged. The deploy
 * summary said "Ready".
 *
 * That is the worst failure shape in this product: it looks like it works. So the rule is
 * now stated in two places and asserted in both here:
 *
 *  1. **Build time** — `assertApiArmed` in `next.config.mjs`. A `VERCEL_ENV=production`
 *     build with no `TF_API_ORIGIN` throws, and the deployment never exists.
 *  2. **Construction time** — `EngineUnarmedError` in `app/shell/engine-config.ts`. The
 *     fixtures adapter is reachable ONLY through `demo === true`.
 *
 * The distinction both guards encode is the one the old code collapsed: `?demo=1` is a
 * REQUEST for the fixture world and fixtures are the right answer; a missing environment
 * variable is a MISCONFIGURATION and fixtures are a lie. A missing variable must never be
 * able to select the demo.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

describe("createEngine — fixtures are opted into, never fallen back to", () => {
  it("THE REGRESSION: `demo: false` with no API base THROWS instead of serving fixtures", () => {
    // This is the exact call `EngineProvider` makes for a signed-in account once
    // `GET /auth/session` has named the account. On an unarmed build it used to answer with a
    // fictional mailbox; it must now refuse.
    expect(() => createEngine(false, {})).toThrow(EngineUnarmedError);
    expect(() => createEngine(false, {}, "acct-1")).toThrow(EngineUnarmedError);
    expect(() => createEngine(false, { NEXT_PUBLIC_API_BASE: "" })).toThrow(EngineUnarmedError);
  });

  it("the refusal names the variable and the deliberate way to get the demo", () => {
    // A guard whose message does not say what to set is a guard that gets worked around.
    let message = "";
    try {
      createEngine(false, {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("NEXT_PUBLIC_API_BASE");
    expect(message).toContain("TF_API_ORIGIN");
    expect(message).toContain("?demo=1");
  });

  it("no combination of env and owner reaches a FixturesAdapter with `demo: false`", () => {
    // The property, stated exhaustively rather than by example: the ONLY route to the
    // fixture world is the demo flag.
    for (const env of [{}, { NEXT_PUBLIC_API_BASE: "" }, { NEXT_PUBLIC_API_BASE: undefined }]) {
      for (const owner of [null, "acct-1"]) {
        expect(() => createEngine(false, env, owner)).toThrow(EngineUnarmedError);
      }
    }
  });

  it("an ARMED build still builds the live engine, so the guard is not just refusing everything", () => {
    const engine = createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" });
    // Unwrapped through `transportOf`: the live engine's adapter is now behind the abort
    // gate (`sync-scheduler.ts`), and the claim under test is unchanged — what this engine
    // TALKS TO is the HTTP transport, never the fixture world.
    expect(transportOf((engine as unknown as { adapter: unknown }).adapter)).toBeInstanceOf(HttpAdapter);
  });

  it("`demo: true` is unaffected — it never consults the base and never throws", () => {
    // The demo must keep working on a bundle with no server at all; that is the whole point
    // of the marketing demo, and the guard must not have taken it away.
    for (const env of [{}, { NEXT_PUBLIC_API_BASE: "" }, { NEXT_PUBLIC_API_BASE: "/api" }]) {
      const engine = createEngine(true, env);
      expect((engine as unknown as { adapter: unknown }).adapter).toBeInstanceOf(FixturesAdapter);
    }
  });
});

describe("assertApiArmed — a production build with no API origin does not build", () => {
  it("THE REGRESSION: production + no origin throws", () => {
    expect(() => assertApiArmed(null, { VERCEL_ENV: "production" })).toThrow(/TF_API_ORIGIN is required/);
  });

  it("the message names the permitted origins and the deliberate demo escape", () => {
    let message = "";
    try {
      assertApiArmed(null, { VERCEL_ENV: "production" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("https://api.ohmail.app");
    expect(message).toContain("NEXT_PUBLIC_DEMO=1");
  });

  it("an ARMED production build passes", () => {
    expect(() => assertApiArmed("https://api.ohmail.app", { VERCEL_ENV: "production" })).not.toThrow();
  });

  it("preview and development may be unarmed — they cannot serve a mailbox anyway", () => {
    expect(() => assertApiArmed(null, { VERCEL_ENV: "preview" })).not.toThrow();
    expect(() => assertApiArmed(null, { VERCEL_ENV: "development" })).not.toThrow();
    expect(() => assertApiArmed(null, {})).not.toThrow();
  });

  it("an EXPLICIT demo build is allowed in production — that is an answer, not an omission", () => {
    expect(() => assertApiArmed(null, { VERCEL_ENV: "production", NEXT_PUBLIC_DEMO: "1" })).not.toThrow();
    expect(() => assertApiArmed(null, { VERCEL_ENV: "production", NEXT_PUBLIC_DEMO: "true" })).not.toThrow();
  });

  it("a NON-truthy NEXT_PUBLIC_DEMO does not excuse an unarmed production build", () => {
    // `NEXT_PUBLIC_DEMO=0` is somebody saying "not the demo". It must not be read as an
    // opt-in, or the escape hatch swallows the guard it is an exception to.
    for (const v of ["0", "false", "", "no", "yes", "on"]) {
      expect(() => assertApiArmed(null, { VERCEL_ENV: "production", NEXT_PUBLIC_DEMO: v }))
        .toThrow(/TF_API_ORIGIN is required/);
    }
  });

  it("the duplicated NEXT_PUBLIC_DEMO test agrees with isDemoBuild, value for value", () => {
    // `next.config.mjs` cannot import TypeScript, so the truthiness rule is written twice —
    // the same constraint that puts the CSP in two files. Drift would mean a build the
    // config considers a demo and the app considers live, or the reverse. Every value the
    // guard excuses must be one `isDemoBuild` calls a demo, and every value it refuses must
    // be one `isDemoBuild` does not.
    for (const v of ["1", "true", "TRUE", " 1 ", "0", "false", "", "yes", "on", "nonsense"]) {
      const configSaysDemo = (() => {
        try {
          assertApiArmed(null, { VERCEL_ENV: "production", NEXT_PUBLIC_DEMO: v });
          return true;
        } catch {
          return false;
        }
      })();
      expect(configSaysDemo, `NEXT_PUBLIC_DEMO=${JSON.stringify(v)}`).toBe(isDemoBuild({ NEXT_PUBLIC_DEMO: v }));
    }
  });

  it("the guard actually runs in the config, on the real environment", () => {
    // A guard nobody calls is a comment. It must be invoked at module scope, before the
    // exported config object is built, and with `process.env` rather than a literal.
    const src = read("../next.config.mjs");
    expect(src).toMatch(/^assertApiArmed\(origin, process\.env\);$/m);
    // And it must run BEFORE the config is assembled, not after.
    expect(src.indexOf("assertApiArmed(origin, process.env);"))
      .toBeLessThan(src.indexOf("const nextConfig = {"));
  });

  it("the variable name the guard reports is the one the config reads", () => {
    expect(API_ORIGIN_VAR).toBe("TF_API_ORIGIN");
  });
});
