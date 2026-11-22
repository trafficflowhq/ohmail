import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncsWhileHidden } from "../app/shell/engine-config";

/**
 * THE DESKTOP SYNC-VISIBILITY FLAG — off by default, on only under a desktop build.
 *
 * `startSyncScheduler` drops to the slow hidden cadence (one drain a minute, no wake stream)
 * when `document.visibilityState` is `hidden` — it was ZERO syncs before the realtime-wake
 * slice; the flag's job is unchanged by that reversal. A desktop WINDOW the OS composites out
 * of view reads `hidden` too, which would silently slow a mail client that is supposed to stay
 * current in the background — so the desktop build passes the scheduler's `visibility: null`
 * seam to opt out of the visibility model. That must happen ONLY in a desktop build.
 *
 * This is the positive gate the brief calls for: if the flag ever leaked into the web build, the
 * default case below would go red. The desktop half — that `apps/desktop/vite.config.ts` sets the
 * flag — is asserted in `apps/desktop/test/desktop-shell.test.ts`.
 */
describe("syncsWhileHidden — the desktop sync-visibility flag", () => {
  it("is OFF in the default (web) environment — the leak guard", () => {
    // The default reads the build environment. In a web build (and in this test process)
    // NEXT_PUBLIC_DESKTOP is unset, so the browser tab's hidden cadence stands.
    // A source change that turned this on unconditionally — the leak — fails here.
    expect(syncsWhileHidden()).toBe(false);
    expect(syncsWhileHidden({})).toBe(false);
    expect(syncsWhileHidden({ NEXT_PUBLIC_DESKTOP: undefined })).toBe(false);
    // Only the exact string "1" opts in — a stray "0"/"false"/"true" does not.
    expect(syncsWhileHidden({ NEXT_PUBLIC_DESKTOP: "0" })).toBe(false);
    expect(syncsWhileHidden({ NEXT_PUBLIC_DESKTOP: "false" })).toBe(false);
    expect(syncsWhileHidden({ NEXT_PUBLIC_DESKTOP: "true" })).toBe(false);
  });

  it("is ON only when the desktop build flag is set", () => {
    expect(syncsWhileHidden({ NEXT_PUBLIC_DESKTOP: "1" })).toBe(true);
  });

  it("is the ONLY thing that lets engine.tsx pass visibility: null to the scheduler", () => {
    const raw = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app/shell/engine.tsx"),
      "utf8",
    );
    // Strip comments first — the file's prose names `visibility: null` while explaining the gate,
    // and only the CODE decides what runs. Same approach the shared-shell guards use.
    const engineTsx = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const gated = engineTsx.match(
      /syncsWhileHidden\(\)\s*\?\s*\{\s*visibility:\s*null,\s*online:\s*null\s*\}\s*:\s*\{\s*\}/g,
    ) ?? [];
    expect(gated).toHaveLength(1);
    for (const option of ["visibility", "online"]) {
      const nulls = engineTsx.match(new RegExp(`\\b${option}:\\s*null\\b`, "g")) ?? [];
      expect(nulls).toHaveLength(gated.length);
    }
  });
});
