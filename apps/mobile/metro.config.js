/**
 * Metro, taught two things about this repository.
 *
 * 1. **A workspace install.** Dependencies may live in a `node_modules` at the
 *    package root, at the repo root, or split across both — npm hoists, pnpm
 *    symlinks a virtual store. Metro has to watch the workspace and look in
 *    both places, so this config works under either layout.
 *
 *    Note what is *not* set: `disableHierarchicalLookup`. Every monorepo recipe
 *    written for a hoisting package manager turns it on, and under an isolated
 *    layout (pnpm) that is exactly wrong — a package's own transitive
 *    dependencies live in *its* `node_modules`, not in a hoisted root, so
 *    switching off the upward walk makes them unresolvable. (`expo-router`
 *    importing `@expo/metro-runtime` is the first thing that breaks.)
 *
 * 2. **NodeNext `.js` specifiers.** `@ohmail/client-engine` is consumed
 *    straight from TypeScript source (`main: ./src/index.ts`) and its internal
 *    imports are written `./engine.js` / `./types.js`, because the package is
 *    authored for `moduleResolution: NodeNext`. Metro's resolver takes that
 *    literally and fails on a file that does not exist. TypeScript solves this
 *    with `extensionAlias`, and webpack needs the same hint. The
 *    `resolveRequest` hook below is Metro's version of it: for a relative
 *    `.js` specifier coming from a file inside `packages/` OR from this app's
 *    own source, try `.ts`/`.tsx` first, then fall through to the stock
 *    resolver.
 *
 *    THE APP'S OWN SOURCE WAS NOT COVERED UNTIL IT BROKE THE BUNDLE, and the
 *    scoping is why it took a release ceremony to notice. The hook tested
 *    `originModulePath.includes("/packages/")`, so a NodeNext specifier written
 *    in `apps/mobile` itself fell through to the stock resolver and failed:
 *    `Unable to resolve module ./push.js from apps/mobile/src/net/pairing.ts`.
 *    Three sibling specifiers had been harmless for the same reason they were
 *    invisible — they are `import type`, erased before Metro ever sees them —
 *    so the first VALUE import written in the house style was the first one to
 *    fail, and it failed the Android bundle outright rather than degrading.
 *    The app is authored in the same style as the packages it consumes, so it
 *    gets the same hint. Caught by the pre-tag Hermes export, which exists for
 *    exactly this; nothing shipped broken.
 */
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const fs = require("node:fs");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

const TS_EXTENSIONS = [".ts", ".tsx"];
const stockResolve = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName.startsWith(".") &&
    moduleName.endsWith(".js") &&
    context.originModulePath &&
    (context.originModulePath.includes(`${path.sep}packages${path.sep}`) ||
      context.originModulePath.startsWith(`${projectRoot}${path.sep}`))
  ) {
    const base = path.resolve(path.dirname(context.originModulePath), moduleName.slice(0, -3));
    for (const ext of TS_EXTENSIONS) {
      if (fs.existsSync(base + ext)) {
        return { type: "sourceFile", filePath: base + ext };
      }
    }
  }
  return (stockResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
