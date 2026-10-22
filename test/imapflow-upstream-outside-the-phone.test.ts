import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * IMAPFLOW IS UPSTREAM EVERYWHERE BUT THE PHONE BUNDLE — PERF-026. The phone's bundler re-arms
 * imapflow's reader (`apps/mobile/scripts/bundle-engine.mjs`), a gap only the phone's microtask
 * scheduler opens; the worker (Cloud), the desktop engine, core and the API load the published 1.7.8
 * untouched. The pin is the npm tarball's own `lib/imap-flow.js`. The phone half is the bundle census
 * (`apps/mobile/test/no-node-builtins.test.ts`, the marker read from the built bundle).
 */
const ROOT = existsSync(resolve("apps/mobile")) ? resolve(".") : resolve("..", "..");
const UPSTREAM_1_7_8_IMAP_FLOW_SHA256 = "083322da3f60c3b9092e653910a2825f47b0648dafcf6957b185707aa32d3907";
const CONSUMERS = ["packages/core", "apps/worker", "apps/sidecar", "apps/desktop", "apps/api-vercel"];
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("imapflow outside the phone bundle is the published 1.7.8", () => {
  it("resolves, from every package that depends on it, to a reader byte-identical to the tarball's", () => {
    const seen: string[] = [];
    for (const pkg of CONSUMERS) {
      const entry = createRequire(join(ROOT, pkg, "package.json")).resolve("imapflow");
      const dir = join(entry, "..", "..");
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, pkg).toBe("1.7.8");
      expect(sha(join(dir, "lib", "imap-flow.js")), `${pkg} loads a changed imapflow reader`).toBe(UPSTREAM_1_7_8_IMAP_FLOW_SHA256);
      seen.push(pkg);
    }
    expect(seen, "the census read no consumer at all").toHaveLength(CONSUMERS.length);
  });

  /* This repository installs with npm and applies patches/ itself, so patches/ is the one place an
     imapflow patch could come from; the pnpm workspace file this once also read is not here. */
  it("carries no workspace patch for imapflow, so no install can change it", () => {
    expect(readdirSync(join(ROOT, "patches")).filter((f) => f.startsWith("imapflow"))).toEqual([]);
  });

  const meta = join(ROOT, "build", "engine.meta.json");
  it.skipIf(!existsSync(meta))("keeps the phone's re-arm out of the desktop engine's graph (needs a built engine)", () => {
    const inputs = Object.keys((JSON.parse(readFileSync(meta, "utf8")) as { inputs: Record<string, unknown> }).inputs)
      .filter((p) => /imapflow\/lib\/imap-flow\.js$/.test(p));
    expect(inputs.length, "the desktop engine bundles no imapflow reader").toBe(1);
    expect(sha(join(ROOT, inputs[0]!))).toBe(UPSTREAM_1_7_8_IMAP_FLOW_SHA256);
  });
});
