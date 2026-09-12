import { readFileSync } from "node:fs";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  WHICH BUILD THIS IS — and the ORDER of the three sources is the whole design
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A build label is only useful if it cannot name a build other than the running one. The three
 * sources are consulted in order of how tightly each is bound to the artifact, most tightly
 * bound first, which is deliberately NOT the order that would put the environment first:
 *
 *  1. A commit sha the hosting platform itself supplies, present only when the platform built
 *     the code from a source it can name. Nothing can make it disagree with what is running, so
 *     it wins whenever it is there.
 *  2. A `BUILD_VERSION` file one directory above this module. It is written into the tree that
 *     gets built, so it is an input to the image rather than state beside it, and it is not
 *     committed — a committed copy would be a stale label on every later build.
 *  3. An environment variable, last.
 *
 * ── WHY (3) IS LAST AND NOT FIRST, WHICH IS THE POINT OF THIS BLOCK ───────────────────────
 *
 * An environment variable lives beside the artifact rather than in it, and the two can go out of
 * step in the direction that matters: set the variable to the new sha, have the build fail, and
 * the old image keeps running while reporting the new one. A health endpoint then answers with a
 * label nothing was ever built from, which is worse than answering "unknown" — it is a wrong
 * answer that looks like a right one, and every check downstream believes it. Some platforms make
 * this sharper by restarting the process when a variable changes, so the running image picks up
 * the new label without being rebuilt.
 *
 * A file in the build context cannot do that. Changing it changes the image, and an image either
 * contains it or does not. The variable is kept as a last resort because it costs nothing and
 * covers a container built by some path that writes no file — but it can only ever be consulted
 * when the artifact itself is silent.
 *
 * ══ WHY THIS IS ITS OWN MODULE AND NOT PART OF `config.ts` ════════════════════════════════
 *
 * Three strings and a file read do not need the import graph of a composition root behind them.
 *
 * `config.ts` imports the bare `@trafficflow/core` barrel, which reaches the classifier, the
 * drafter and their model client. `sync.ts` needs the build label — the durable failure ledger's
 * retry is woken by a change of build and by nothing else, so a build it cannot name is a retry
 * that never fires — and the desktop engine imports `sync.ts`. Every other file in this package
 * names `@trafficflow/core/mail` rather than the barrel, deliberately, so that the engine that
 * ships in the app carries no model vocabulary at all. Reaching the label through `config.ts`
 * would have undone that from three modules away.
 *
 * `config.ts` re-exports both symbols, so every existing importer is unchanged.
 */
const buildVersionFile = (): string => {
  try {
    // From `dist/build-version.js` this is `<app>/BUILD_VERSION`; from `src/build-version.ts`
    // under tsx it is the same path, so a local run and the image read one location.
    return readFileSync(new URL("../BUILD_VERSION", import.meta.url), "utf8").trim();
  } catch {
    return "";
  }
};

/**
 * Every term is trimmed HERE and not only in the reader above. A `BUILD_VERSION` holding nothing
 * but whitespace is still truthy, so an untrimmed read reported `"  "` as the running build: a
 * label that is present, is not `dev`, and matches nothing. The same trap exists one layer up,
 * where a tool that stores an empty environment variable will happily list it as set. A blank
 * label has to fall through to the next source rather than be reported as an identity.
 */
export type BuildIdentitySource = "platform" | "file" | "variable" | "none";

/**
 * The label AND where it came from, because the two are separate facts and only the pair can
 * distinguish a good identity from a confident lie.
 *
 * ── WHY THE SOURCE HAD TO BECOME AN OUTPUT ────────────────────────────────────────────────
 *
 * The fallback chain is correct and stays exactly as it was. What was missing is that the LAST
 * two terms mean opposite things about trust and the caller could not tell them apart: a
 * `variable` answer is a sha somebody typed beside the artifact, and it is reported with the
 * same confidence as one read out of the image. Measured in production 2026-09-01 — the file
 * never reached the image, `TF_BUILD_VERSION` answered instead, and `/health` named a commit
 * from ten days earlier while every process signal said the deploy had landed. The label was
 * not missing; it was WRONG, which no consumer could see, because the only thing that had ever
 * been reported as a fault was the literal string `dev`.
 *
 * So the resolution publishes its own provenance and the health report decides what to say
 * about it. `buildVersionOf` is unchanged for every existing importer.
 */
export const buildIdentityOf = (
  env: NodeJS.ProcessEnv,
  file: () => string = buildVersionFile,
): { version: string; source: BuildIdentitySource } => {
  const platform = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (platform) return { version: platform, source: "platform" };
  const fromFile = file().trim();
  if (fromFile) return { version: fromFile, source: "file" };
  const variable = env.TF_BUILD_VERSION?.trim();
  if (variable) return { version: variable, source: "variable" };
  return { version: "dev", source: "none" };
};

export const buildVersionOf = (env: NodeJS.ProcessEnv, file: () => string = buildVersionFile): string =>
  buildIdentityOf(env, file).version;
