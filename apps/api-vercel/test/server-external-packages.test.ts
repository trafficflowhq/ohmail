import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * THE FOUR PACKAGES THIS HOST MUST NOT BUNDLE, under the option name the installed Next reads.
 * Next 15 reads `serverExternalPackages`; on an unknown `experimental` key it warns and builds, so
 * the old spelling bundles postgres, imapflow, nodemailer and mailparser into the function and the
 * first send fails on Vercel only. Nothing before the deploy notices, so the config is read here.
 */
type Config = { serverExternalPackages?: string[]; experimental?: object };
/* By URL: the config is plain `.mjs` with no declaration file, and the test reads what Next reads. */
const load = async (): Promise<Config> =>
  ((await import(/* @vite-ignore */ new URL("../next.config.mjs", import.meta.url).href)) as { default: Config }).default;

describe("next.config.mjs externalises the native and dynamic-require packages", () => {
  it("names exactly the four, under the Next 15 option", async () => {
    const config = await load();
    expect([...(config.serverExternalPackages ?? [])].sort()).toEqual(["imapflow", "mailparser", "nodemailer", "postgres"]);
  });

  it("does not carry the Next 14 spelling, which Next 15 ignores", async () => {
    const config = await load();
    expect(config.experimental ?? {}).not.toHaveProperty("serverComponentsExternalPackages");
  });

  it("every externalised package resolves from this app, as the deployed function requires it", async () => {
    const config = await load();
    // The deploy runs the root `npm ci` (vercel.json), which hoists the packages: an externalised one
    // that does not resolve from the app's own directory throws MODULE_NOT_FOUND on its first use.
    const fromApp = createRequire(new URL("../package.json", import.meta.url));
    expect(config.serverExternalPackages?.length).toBeGreaterThan(0);
    for (const name of config.serverExternalPackages ?? []) {
      expect(() => fromApp.resolve(name), `${name} must resolve from apps/api-vercel`).not.toThrow();
    }
  });
});
