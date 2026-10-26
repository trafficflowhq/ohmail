/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ABSENT-MODULE STUB SURVIVES THE BUNDLER'S INTEROP — asserted by WIRING one, not by reading
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `node-absent.js` promises that reaching a module a phone does not have fails at the CALL, naming
 * the module and the member. It kept that promise for `import path from "node:path"` and broke it
 * for `import { join } from "node:path"` — the form nearly every consumer writes.
 *
 * The cause is the bundler and not the stub's logic. esbuild wires an ES import of a CommonJS
 * module by walking the module's OWN PROPERTY NAMES and defining one accessor per name on a fresh
 * namespace object. A Proxy over an empty target has no own property names, so the namespace came
 * out empty, `join` was `undefined`, and the call failed as `(0, import_node_path.join) is not a
 * function` — naming neither the module nor the member.
 *
 * ── WHY THIS DRIVES THE REAL BUNDLER ──────────────────────────────────────────────────────
 *
 * The defect lives in the seam between the Proxy's traps and the wrapper esbuild GENERATES, so
 * nothing that constructs the stub by hand can see it: called directly, `absent("path").join` has
 * always refused correctly. The only way to watch it is to bundle an import and load the result,
 * which is what `bundleProbe` is for — the artifact's own plugin, alias table, platform and
 * format, with the entry point swapped.
 */
import { createRequire } from "node:module";
import { readFileSync, rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { BUNDLE, bundleProbe } from "../scripts/bundle-engine.mjs";

const require_ = createRequire(import.meta.url);
const TABLE = require_("../src/engine/shims/node-absent-members.js") as Record<
  string,
  { from: string[]; members: string[]; omitted: number }
>;

/**
 * THE TOKENS THE APP'S OWN PRIVACY SCAN FORBIDS IN SHIPPED SOURCE, named HERE because this file is
 * a test and is therefore not shipped — the same line that scan draws for itself.
 *
 * `node:http` exports one of them. The table counts it instead of writing it; this is the half that
 * says WHICH, so the omission is a checked fact rather than a number somebody typed.
 */
const FORBIDDEN_IN_SHIPPED_SOURCE = [/^WebSocket$/, /^XMLHttpRequest$/, /^EventSource$/];
const absent = require_("../src/engine/shims/node-absent.js") as (
  moduleName: string,
  members?: string[],
) => Record<string, unknown>;

const built: string[] = [];
afterAll(() => {
  for (const dir of built) rmSync(dir, { recursive: true, force: true });
});

/** Bundle one entry module under the artifact's own substitutions and load what comes out. */
async function wired(source: string): Promise<Record<string, () => unknown>> {
  const probe = await bundleProbe(source);
  built.push(probe.dir);
  return require_(probe.bundlePath) as Record<string, () => unknown>;
}

const thrown = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "__nothing was thrown__";
};

describe("an absent module reached through a NAMED import still refuses by name", () => {
  it("names the module and the member — the form that used to answer `undefined`", async () => {
    const mod = await wired(
      'import { join } from "node:path";\nexport const f = (): string => join("a", "b");\n',
    );
    // Anchored at the start: `(0, import_node_path.join) is not a function` also contains the
    // word `join`, and a loose match would have passed over the defect this file exists for.
    expect(thrown(mod.f!)).toMatch(/^path\.join\(\) is not available/);
  }, 60_000);

  it("and the DEFAULT import form, which already worked, still does", async () => {
    // The positive control. Without it a change that broke the default-import path while fixing
    // the named one would pass this file — and that path is how libraries read `path.join` at
    // module scope, which is the read the stub's whole "throw on call, not on read" rule is about.
    const mod = await wired(
      'import path from "node:path";\nexport const g = (): string => path.join("a", "b");\n',
    );
    expect(thrown(mod.g!)).toMatch(/^path\.join\(\) is not available/);
  }, 60_000);

  it("wires a module the phone HAS as itself — the probe is not refusing everything", async () => {
    // Third control, and the one that says the two above measure the stub rather than the probe:
    // a bundle in which every import refused would satisfy them both. `events` is aliased to a
    // real polyfill, so its named import has to WORK.
    const mod = await wired(
      'import { EventEmitter } from "events";\n'
        + 'export const h = (): string => typeof new EventEmitter().on;\n',
    );
    expect(mod.h!()).toBe("function");
  }, 60_000);

  it("formats and reads back the organizer profile through the phone's own `util`", async () => {
    // The phone's `util` is the npm polyfill: a member it lacks failed the profile append on
    // every phone organizer as a TypeError.
    const probe = await bundleProbe(
      'import { makeProfileDoc, formatProfileMessage, parseProfileMessage } from "../../packages/core/src/adapters/organizer-profile";\n'
        + "export const p = () => {\n"
        + '  const doc = makeProfileDoc({ screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["Träume"], signature: null },\n'
        + '    { updatedAt: new Date(Date.UTC(2026, 9, 25)), producer: { kind: "mobile", version: "test" } });\n'
        + '  const r = parseProfileMessage(formatProfileMessage(doc, { installId: "install-probe" })) as { status?: string; encoded?: boolean };\n'
        + "  return { status: r?.status, encoded: r?.encoded };\n"
        + "};\n",
    );
    built.push(probe.dir);
    const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
    const original = Module._load;
    Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
      return original.call(this, request === "react-native-quick-crypto" ? "node:crypto" : request, parent, isMain);
    };
    let mod: Record<string, () => unknown>;
    try { mod = require_(probe.bundlePath) as Record<string, () => unknown>; } finally { Module._load = original; }
    expect(mod.p!()).toEqual({ status: "ok", encoded: true });
  }, 60_000);
});

describe("the recorded export lists are a measurement, not a curated set", () => {
  it("equals what this Node reports, minus exactly the tokens the app may not name", () => {
    // A STALE LIST IS A RED, NOT A GUESS. A Node version that adds or removes an export leaves the
    // stub answering `undefined` for the members nobody recorded — the same silent failure in a
    // smaller place — and this is the only thing that would notice.
    for (const [name, { from, members, omitted }] of Object.entries(TABLE)) {
      const live = [
        ...new Set(from.flatMap((spec) => Object.keys(require_(spec) as object))),
      ].sort();
      const forbidden = live.filter((m) => FORBIDDEN_IN_SHIPPED_SOURCE.some((re) => re.test(m)));
      // Both halves, so the count cannot drift in either direction: what is written is exactly
      // what is allowed, and what is counted is exactly what is not.
      expect(members, `${name} (${from.join(", ")})`).toEqual(live.filter((m) => !forbidden.includes(m)));
      expect(omitted, `${name} omitted count`).toBe(forbidden.length);
    }
  });

  it("and the artifact imports none of the omitted members by name — the cost is zero", () => {
    /* THE COST THE OMISSION CARRIES, held at zero rather than asserted away. A named import of an
       omitted member reads as `undefined` instead of refusing by name, which is the defect this
       whole table exists to fix. Nothing in the graph does that today; if something starts, this
       reddens and the answer is to move the member list out of the app's shipped tree rather than
       to widen anything. */
    const source = readFileSync(BUNDLE, "utf8");
    const omittedNames = Object.values(TABLE)
      .flatMap(({ from }) => from.flatMap((spec) => Object.keys(require_(spec) as object)))
      .filter((m) => FORBIDDEN_IN_SHIPPED_SOURCE.some((re) => re.test(m)));
    // Not vacuous: there IS at least one omitted name, or this case proves nothing.
    expect(omittedNames.length).toBeGreaterThan(0);
    for (const member of new Set(omittedNames)) {
      // esbuild renders a named import of a substituted CommonJS module as `<ns>.<member>`.
      expect(
        new RegExp(`import_node_https?\\.${member}\\b`).test(source),
        `${member} is read off an absent module's namespace`,
      ).toBe(false);
    }
  });

  it("covers every module the stub is constructed for, and each list is non-empty", () => {
    expect(Object.keys(TABLE).sort()).toEqual([
      "child_process", "fs", "http", "https", "os", "path", "perf_hooks",
    ]);
    for (const [name, { members }] of Object.entries(TABLE)) {
      expect(members.length, name).toBeGreaterThan(0);
    }
    // Exactly one member of one module is counted rather than written. A second appearing is a
    // reason to move this table, not to grow the number quietly.
    expect(Object.values(TABLE).reduce((n, m) => n + m.omitted, 0)).toBe(1);
  });

  it("refuses LOUDLY for a module with no recorded list, instead of an empty namespace", () => {
    // The failure mode the default `[]` would have restored, for the one module nobody added to
    // the table — silently, and only on a device.
    expect(() => absent("some_module_nobody_recorded")).toThrow(/no export list is recorded/);
  });

  it("reports the recorded names as its own, so a copy finds them", () => {
    const stub = absent("path");
    expect(Object.getOwnPropertyNames(stub)).toEqual(TABLE.path!.members);
    // And the descriptor a copy reads is enumerable and configurable — without `configurable` the
    // Proxy invariant makes reporting a property the target lacks a TypeError.
    const d = Object.getOwnPropertyDescriptor(stub, "join");
    expect(d?.enumerable).toBe(true);
    expect(d?.configurable).toBe(true);
  });
});
