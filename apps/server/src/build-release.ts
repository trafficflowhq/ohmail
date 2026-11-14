import { readFileSync } from "node:fs";
import type { SettingsDoorInput } from "./settings.js";

declare const __OHMAIL_RELEASE__: string | undefined;

/** The checkout's own manifest version, where the server runs unbundled (`src` or `dist`, three levels down). */
const workspaceVersion = (): string => {
  try {
    const v = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
};

/**
 * WHICH RELEASE THIS SERVER IS A BUILD OF, the worker's rule (`apps/worker/src/build-version.ts`, whose
 * source this repeats because the two hosts share no module): the workspace version the host bundler
 * bakes in (`scripts/bundle-host.mjs`), else the checkout's manifest, else `null`. NOT the build label:
 * the published images carry a commit there, which says nothing about the release `GET /hello` states.
 *
 * The PROCESS door's reader: {@link processDoor} hands its answer to the settings.
 * Its own module because the manifest read needs `import.meta`, which a module the function door
 * bundles cannot carry; that door hands in what its own build inlined.
 */
export const buildReleaseOf = (manifest: () => string = workspaceVersion): string | null => {
  const baked = typeof __OHMAIL_RELEASE__ === "string" ? __OHMAIL_RELEASE__.trim() : "";
  if (baked !== "") return baked;
  const read = manifest().trim();
  return read === "" ? null : read;
};

/**
 * What the process door hands the settings: no platform under it, a stream it holds, the release
 * above. `buildVersionFile` reads the label file beside the program (`index.ts`). The door and the
 * boot test load the settings with this one, so the release a test reads is the one a server states.
 */
export const processDoor = (buildVersionFile: () => string): SettingsDoorInput => ({
  door: "process", buildVersionFile, platformBuildId: null, release: buildReleaseOf(), environmentFallback: null,
  sseHolds: true, sseLifetimeMaxMs: null,
});
