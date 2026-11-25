/**
 * THE RELEASE THIS BUILD IS, for the header that names the app to every server (`x-ohmail-client`). The one
 * place it is read: `expo-constants` serves the `expo.version` that `expo prebuild` embeds from `app.json`, the
 * same number About shows and the stores' version names are generated from (`build-info.ts`, `build-info.test.ts`).
 *
 * LAZILY, and cached including the absence, for `unified-push.ts`'s reason: `expo-constants` is Flow-typed
 * JavaScript that reads `__DEV__`, so a static import makes the connection layer unloadable by the node-side
 * suite, which loads it under mocks. Metro gives every module a `require`; a plain node or test context may
 * not, and there the answer is `undefined`, which the header says as `dev`.
 */

/** The version out of an `expo-constants` module, or `undefined`. Pure, so the suite holds every shape. */
export function releaseFrom(constants: unknown): string | undefined {
  const version = (constants as { default?: { expoConfig?: { version?: unknown } } } | null | undefined)
    ?.default?.expoConfig?.version;
  return cleanVersion(version);
}

function cleanVersion(version: unknown): string | undefined {
  return typeof version === "string" && version.trim() !== "" ? version.trim() : undefined;
}

interface EmbeddedConfig {
  readonly version?: unknown;
  readonly android?: { readonly versionCode?: unknown };
  readonly ios?: { readonly buildNumber?: unknown };
}

let cached: { config: EmbeddedConfig | undefined } | undefined;

function embeddedConfig(): EmbeddedConfig | undefined {
  if (cached !== undefined) return cached.config;
  cached = { config: undefined };
  if (typeof require === "function") {
    try {
      /* eslint-disable-next-line @typescript-eslint/no-var-requires */
      cached.config = require("expo-constants").default?.expoConfig;
    } catch {
      /* no native config in this context */
    }
  }
  return cached.config;
}

export function appRelease(): string | undefined {
  return cleanVersion(embeddedConfig()?.version);
}

export function appBuildNumber(os: string): string | null {
  const config = embeddedConfig();
  const build = os === "ios" ? config?.ios?.buildNumber : config?.android?.versionCode;
  return (typeof build === "number" || typeof build === "string") && /^[1-9]\d*$/.test(String(build))
    ? String(build)
    : null;
}
