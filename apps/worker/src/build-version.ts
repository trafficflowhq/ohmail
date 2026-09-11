import { readFileSync } from "node:fs";

/**
 * WHICH BUILD THIS IS — and the ORDER of the three sources is the whole design. A build label is useless
 * if it can name a build other than the running one, so the sources are consulted most-tightly-bound
 * first: (1) a commit sha the hosting platform supplies (nothing can make it disagree with what runs);
 * (2) a `BUILD_VERSION` file one directory up (an input to the image, uncommitted so no stale label); (3)
 * an environment variable, LAST — it lives beside the artifact and can go out of step in the direction
 * that matters (set the new sha, have the build fail, the old image runs reporting the new one), a wrong
 * answer that looks right. A file in the build context cannot do that. Its own module, not `config.ts`,
 * because `config.ts` imports the bare `@trafficflow/core` barrel (classifier, drafter, model client)
 * while `sync.ts` needs the label and the desktop engine imports `sync.ts` — every other file names `@trafficflow/core/mail`. `config.ts` re-exports both symbols, so every importer is unchanged. */
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
 * The label AND where it came from, because the two are separate facts and only the pair distinguishes a
 * good identity from a confident lie. The fallback chain is unchanged; what was missing is that the last
 * two terms mean opposite things about trust — a `variable` answer is a sha somebody typed beside the
 * artifact, reported with the same confidence as one read out of the image. Measured in production
 * 2026-09-01: the file never reached the image, `TF_BUILD_VERSION` answered, and `/health` named a commit
 * ten days old while every process signal said the deploy had landed — the label was WRONG, invisible,
 * because the only thing ever reported as a fault was the literal `dev`. So the resolution publishes its
 * own provenance and the health report decides what to say. `buildVersionOf` is unchanged for importers.
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
