/**
 * THE DOOR TO THE DEVELOPMENT TRIGGER. `__DEV__` is a bare identifier here on purpose: Metro's
 * inline plugin replaces it with the bundle's `dev` flag and, in a release bundle, folds the dead
 * branch away BEFORE dependencies are collected — the same mechanism React Native uses for its
 * own dev tools — so the trigger module is not in a release bundle at all. A member read
 * (`globalThis.__DEV__`) would defeat that and ship it. Under vitest `__DEV__` is undefined and
 * the door answers `null`; `render-error-boundary.test.ts` holds the shape by parsing this file.
 */
import type { ComponentType } from "react";

let Trigger: ComponentType | null = null;
if (typeof __DEV__ !== "undefined" && __DEV__) {
  Trigger = (require("./render-error-trigger") as { DevRenderErrorTrigger: ComponentType }).DevRenderErrorTrigger;
}

/** The trigger in a development bundle, `null` in a release one. */
export const DevRenderErrorTrigger: ComponentType | null = Trigger;
