import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * WHICH RELEASE IS THIS, AND HOW THE ANSWER GETS ONTO THE SCREEN.
 *
 * About states two facts about the running app — the release and the build sha — and they are
 * derived differently on purpose. The sha comes from the deploy environment, because that is
 * where a commit id genuinely lives and `"dev"` is a TRUE answer when there is none. The release
 * comes from the SOURCE, because a version is a property of the tree being built and there is no
 * honest default for it at all.
 *
 * ── THE FAILURE THIS FILE EXISTS TO PREVENT ─────────────────────────────────────────────────
 *
 * `process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"` in the component compiles, typechecks, passes
 * every other test in this suite, and puts **"dev"** in front of a customer the first time a
 * deployment runs without the variable set. A wrong version number is worse than a missing one,
 * because it is quietly believed — and it is quietly believed in exactly the moment somebody is
 * trying to tell support what they are running. So the number is read from `package.json` at
 * config time and there is no fallback branch to take.
 *
 * Source assertions, deliberately: what is being pinned is where the value comes FROM, and no
 * rendering test can see the difference between a correct inline and a fallback that has not
 * fired yet.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

const rootVersion = (): string =>
  (JSON.parse(read("../../../package.json")) as { version?: string }).version ?? "";

describe("the About pane's release number", () => {
  it("the workspace states one, and it parses as a release", () => {
    expect(rootVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is READ FROM THE FILE at config time, not from the runtime environment", async () => {
    const { appVersion, VERSION_VAR } = await import("../next.config.mjs");
    expect(VERSION_VAR).toBe("NEXT_PUBLIC_APP_VERSION");
    expect(appVersion()).toBe(rootVersion());

    // Not from the environment: a value planted there must not be able to change the answer.
    // That is the whole difference between "inlined from the source" and "read at runtime".
    const before = process.env[VERSION_VAR];
    process.env[VERSION_VAR] = "9.9.9";
    try {
      expect(appVersion()).toBe(rootVersion());
    } finally {
      if (before === undefined) delete process.env[VERSION_VAR];
      else process.env[VERSION_VAR] = before;
    }
  });

  it("the config INLINES it, beside the build sha and by the same mechanism", () => {
    const config = read("../next.config.mjs");
    expect(config).toMatch(/\[VERSION_VAR\]:\s*appVersion\(\)/);
    // Both facts travel Next's `env` block, which is what makes them compile-time constants in
    // the bundle rather than lookups that can miss.
    expect(config).toMatch(/\[BUILD_VAR\]:\s*buildIdentity\(process\.env\)/);
  });

  it("THE PANE HAS NO FALLBACK BRANCH for the version — a `?? \"dev\"` is the named risk", () => {
    const src = read("../app/(product)/mailbox/AboutSection.tsx");
    const line = src.split("\n").find((l) => l.includes("NEXT_PUBLIC_APP_VERSION"));
    expect(line, "AboutSection no longer reads the version at all").toBeTruthy();
    expect(line!).not.toContain("??");
    // The build sha KEEPS its fallback, and that is not an inconsistency: "dev" is the true
    // answer for a build with no commit behind it. Asserted so that a sweep tidying one into
    // agreement with the other has to argue for it.
    const buildLine = src.split("\n").find((l) => l.includes("NEXT_PUBLIC_BUILD"));
    expect(buildLine!).toContain('?? "dev"');
  });

  it("the copy states both, in one sentence, from one key", () => {
    const messages = JSON.parse(read("../messages/en.json")) as {
      about: Record<string, string>;
    };
    expect(messages.about.build).toBe("{version} · build {build}.");
    // One key and not two: the version alone is ambiguous between two deploys of the same
    // release, and a seven-character sha alone means nothing to the person reading it.
    expect(messages.about.version).toBeUndefined();
  });

  it("the version the pane will show is the version the workspace declares", () => {
    // The end-to-end statement, as far as a source test can make it: config reads the root
    // manifest, the pane reads what config inlined, and the copy renders it.
    const src = read("../app/(product)/mailbox/AboutSection.tsx");
    expect(src).toMatch(/const VERSION = process\.env\.NEXT_PUBLIC_APP_VERSION;/);
    expect(src).toMatch(/version: VERSION \?\? null,\s*build: BUILD,/);
    expect(src).toMatch(/<AboutPane model=\{model\} \/>/);
    const pane = read("../../../packages/app/src/settings/about/AboutPane.tsx");
    expect(pane).toMatch(/t\("build", \{ version: model\.version \?\? "", build: model\.build \}\)/);
    expect(HERE).toContain("apps/webapp");
  });
});
