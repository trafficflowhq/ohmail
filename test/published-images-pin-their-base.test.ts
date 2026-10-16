import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FRONTEND_REF, NODE_BASE, NODE_BASE_REF, PUBLISHED_DOCKERFILES, externalBases, unpinnedFroms } from "./support/published-base.js";
import { publicRel } from "./support/public-root.mjs";

/**
 * EVERY BASE A PUBLISHED IMAGE IS BUILT FROM IS NAMED BY ITS DIGEST, AND SO IS THE FRONTEND THAT READS IT.
 *
 * A tag is a pointer the registry can move between two builds of one release; a digest is the
 * bytes that were read. The census (test/support/published-base.ts) holds each published recipe's
 * frontend (`# syntax=`) and bases as written, so one that moves changes it in the same reviewed commit.
 * The same rule takes an image a COPY or RUN reads from, and an ADD of a URL needs its sha256. The image
 * workflow may build no recipe the census lacks.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };

type Matrix = { jobs?: Record<string, { strategy?: { matrix?: { include?: Array<{ dockerfile?: unknown }> } } }> };
const RECIPES_BUILT = ((yaml.load(read(publicRel("github/workflows/ghcr-images.yml"))) as Matrix)
  .jobs?.["build-push"]?.strategy?.matrix?.include ?? [])
  .map((row) => row.dockerfile)
  .filter((d): d is string => typeof d === "string")
  .sort();

describe("every published recipe names its base by digest", () => {
  it("the image workflow builds three recipes, each one the census names", () => {
    expect(RECIPES_BUILT, "the reader found no recipe in ghcr-images.yml's build matrix").toEqual([
      "apps/server/Dockerfile", "apps/webapp/Dockerfile", "apps/worker/Dockerfile.selfhost",
    ]);
    for (const f of RECIPES_BUILT) expect(Object.keys(PUBLISHED_DOCKERFILES), f).toContain(f);
  });

  it.each(Object.keys(PUBLISHED_DOCKERFILES))("%s: every FROM is a digest, and the bases are the census's", (f) => {
    expect(unpinnedFroms(read(f)), "a frontend or a base by tag").toEqual([]);
    expect(externalBases(read(f)), "a frontend or a base moved without the census").toEqual(PUBLISHED_DOCKERFILES[f]);
  });

  it("refuses a planted tag, a missing or short digest, a variable and a later stage; admits a stage, scratch and a digest", () => {
    const sum = `sha256:${"a".repeat(64)}`;
    const pinned = `# syntax=${FRONTEND_REF}\nFROM ${NODE_BASE_REF} AS base\nFROM base AS build\nCOPY --from=base /a /a\n`
      + `COPY --from=0 /a /b\nADD --checksum=${sum} https://example.com/t.tar.gz /t\nFROM scratch\n`;
    expect(unpinnedFroms(pinned), "the positive control: the frontend by digest, stages by name and index, a checksummed URL").toEqual([]);
    expect(unpinnedFroms(`# comment\n# syntax=docker/dockerfile:1\nFROM ${NODE_BASE_REF}\n`), "a syntax line below a comment is no directive").toEqual([]);
    expect(unpinnedFroms(`# escape=\\\n#syntax = ${FRONTEND_REF}\nFROM ${NODE_BASE_REF}\n`), "a frontend by digest after another directive").toEqual([]);
    const planted: Array<[string, string, number]> = [
      ["a frontend by tag", `# syntax=docker/dockerfile:1\nFROM ${NODE_BASE_REF}\n`, 1],
      ["a frontend by tag after another directive, spelled loosely", `# escape=\\\n#Syntax = docker/dockerfile:1.27\nFROM ${NODE_BASE_REF}\n`, 1],
      ["a tag", "FROM node:22-bookworm-slim AS base\n", 1],
      ["no tag at all", "FROM node\n", 1],
      ["a lower-case keyword", "from node:22 as base\n", 1],
      ["a platform flag in front", "FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS base\n", 1],
      ["a continuation", "FROM \\\n  node:22-bookworm-slim AS base\n", 1],
      ["a short digest: the census's own, cut to twelve", `FROM node@${NODE_BASE.digest.slice(0, "sha256:".length + 12)}\n`, 1],
      ["a variable no ARG resolves", "FROM ${BASE_IMAGE}\n", 1],
      ["an ARG that resolves to a tag", "ARG BASE=node:22\nFROM ${BASE}\n", 1],
      ["a stage named before it is declared, and the tag that declares it", "FROM base AS build\nFROM node:22 AS base\n", 2],
      ["an image copied from by tag", `FROM ${NODE_BASE_REF}\nCOPY --from=alpine:3 /bin/busybox /bin/\n`, 1],
      ["an image mounted from by tag", `FROM ${NODE_BASE_REF}\nRUN --mount=type=bind,from=alpine:3,target=/m true\n`, 1],
      ["a URL added with no checksum", `FROM ${NODE_BASE_REF}\nADD https://example.com/t.tar.gz /t\n`, 1],
      ["a URL added with a short checksum", `FROM ${NODE_BASE_REF}\nADD --checksum=sha256:abc123 https://example.com/t.tar.gz /t\n`, 1],
    ];
    for (const [what, text, n] of planted) expect(unpinnedFroms(text), what).toHaveLength(n);
    expect(unpinnedFroms(`ARG BASE=${NODE_BASE_REF}\nFROM \${BASE} AS base\n`), "an ARG that resolves to the digest").toEqual([]);
  });
});
