/** The types for `linux-atk-bridge.mjs`, for `test/desktop-linux-recipe.test.ts`. */
export declare const PACKAGED_BRIDGE: string;

type Files = Record<string, string>;
export declare function bridgePackaging(input: { platform: string; bridge: string | undefined }):
  { bundle: { linux: { deb: { files: Files }; rpm: { files: Files } } } } | null;
