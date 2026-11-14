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
  return typeof version === "string" && version.trim() !== "" ? version.trim() : undefined;
}

let cached: { release: string | undefined } | undefined;

export function appRelease(): string | undefined {
  if (cached !== undefined) return cached.release;
  cached = { release: undefined };
  if (typeof require !== "function") return cached.release;
  try {
    /* eslint-disable-next-line @typescript-eslint/no-var-requires */
    cached = { release: releaseFrom(require("expo-constants")) };
  } catch {
    /* no native config in this context: an unnamed release, never a fault */
  }
  return cached.release;
}
