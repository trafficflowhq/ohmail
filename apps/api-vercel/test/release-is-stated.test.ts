import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE CLOUD API STATES WHICH RELEASE IT IS, from the source it was built from. `GET /hello` answers
 * what `next.config.mjs` inlines as `OHMAIL_RELEASE`, read from the root manifest at config time as the
 * web app's About pane reads it: there is no fallback to type in, and a manifest with no version is a
 * failed build rather than a deployment that says `0.0.0` to every client.
 */
interface Config {
  default: { env?: Record<string, string> };
  releaseVersion: () => string;
  RELEASE_VAR: string;
}
/** The config, imported by URL as `server-external-packages.test.ts` does: it is a `.mjs` with no declaration file. */
const config = (): Promise<Config> => import(/* @vite-ignore */ new URL("../next.config.mjs", import.meta.url).href) as Promise<Config>;

const manifest = (): { version?: unknown } =>
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown };

describe("the release the Cloud API inlines", () => {
  it("is the root manifest's version, whatever the environment holds", async () => {
    const { releaseVersion, RELEASE_VAR } = await config();
    expect(RELEASE_VAR).toBe("OHMAIL_RELEASE");
    expect(releaseVersion()).toBe(manifest().version);
    expect(releaseVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    const before = process.env[RELEASE_VAR];
    process.env[RELEASE_VAR] = "9.9.9";
    try {
      expect(releaseVersion(), "a value planted in the environment changed the release").toBe(manifest().version);
    } finally {
      if (before === undefined) delete process.env[RELEASE_VAR];
      else process.env[RELEASE_VAR] = before;
    }
  });

  it("is on the config's `env`, where Next turns it into a constant of the server bundle", async () => {
    const { default: nextConfig } = await config();
    expect(nextConfig.env).toEqual({ OHMAIL_RELEASE: manifest().version });
  });
});
