import { defineConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * THE COMPARISON RUN: each subject in `test/compare/subjects/`, drawn in a real browser and held against
 * its picture and its data file (`test/compare/README.md`).
 *
 * A run of its own, with its own suffix (`*.compare.ts`), so the suite and its shards never pick it up:
 * it reads the reference archive in `build/reference/`, which `node test/compare/fetch.mjs` puts there
 * before this starts. A shard that does not match its manifest fails this run. A shard that is not there
 * is one line and a skip, or a failure with `COMPARE_REQUIRE_REFERENCE=1`; the product's own pictures are
 * compared either way. Module resolution is the suite's, so a subject imports the product as a test does.
 */
export default defineConfig({
  resolve: base.resolve,
  esbuild: base.esbuild,
  test: {
    include: ["test/compare/**/*.compare.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    // The run itself reaches no host but loopback; the archive is fetched before it, by its own step.
    setupFiles: ["./test/setup/no-external-network.ts"],
  },
});
