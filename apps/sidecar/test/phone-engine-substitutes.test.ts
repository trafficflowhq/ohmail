/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PHONE'S SUBSTITUTES — that each row is real, that each answers, and that none serves
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `src/phone/aliases.js` decides what the engine's imports resolve to when it is built for a phone,
 * and some of those rows are load-bearing for a SAFETY property rather than for a build: the
 * desktop's host door, its same-network door and its local Postgres are not merely unused in that
 * artifact, they are SUBSTITUTED, so the code for them is not in the file at all.
 *
 * The census over the built bundle (`apps/mobile/test/no-node-builtins.test.ts`) proves what is in
 * the artifact. It cannot prove three things about the table itself, and those are this file's:
 *
 *  1. **Every row names something real.** A key that matches no import substitutes nothing, and a
 *     value that names no file substitutes nothing either — both silently. The bundle census would
 *     stay green in both cases, because the module it was meant to exclude was never imported by
 *     the name the table used.
 *  2. **The substitutes ANSWER rather than throw where the engine calls them at boot.** Three of
 *     them are called on every launch before the composition knows anything about the install. A
 *     thrower there is a phone that cannot start, and the bundle census cannot see it because a
 *     thrower is in the graph exactly like an answer.
 *  3. **The substitutes serve nobody.** Their own import graph must reach no Node builtin and their
 *     code must open no socket. They are the modules that stand in for a door; a door in one of
 *     them would be the whole point defeated.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import aliases from "../src/phone/aliases.js";
import { HOST_SEND_MAX_TOTAL_BYTES as DESKTOP_SEND_CAP } from "../src/host-listener.js";
import { HOST_SEND_MAX_TOTAL_BYTES as PHONE_SEND_CAP, resolveHostConfig } from "../src/phone/host-listener.js";
import { resolveLanBind, serveLanFallback } from "../src/phone/host-lan.js";
import { ensureLanIdentity } from "../src/phone/host-lan-tls.js";
import { localLanRoutes } from "../src/phone/lan-routes.js";
import { hostPairRoutes } from "../src/phone/host-pair-routes.js";
import { createHostStatic } from "../src/phone/host-static.js";
import { desktopHostRoutes } from "../src/phone/desktop-host.js";
import { closeAfterFailedStart, openLocalDb } from "../src/phone/db.js";
import {
  PHONE_AI_REFUSAL, PHONE_DEFAULT_AI_SETTINGS, createLocalAi as createPhoneAi,
} from "../src/phone/ai-provider.js";
/* THE REAL DEFAULTS, imported HERE and nowhere in the artifact. They live beside the three vendor
   transports, so importing them for their strings would put `fetch`-carrying modules for Anthropic,
   OpenAI and a local model server back into a build whose claim is that they are not in it. A test
   may import them; the shipped closure may not. */
import { DEFAULT_ANTHROPIC_MODELS } from "../src/ai-anthropic.js";
import { DEFAULT_OPENAI_MODELS } from "../src/ai-openai.js";
import { DEFAULT_OLLAMA } from "../src/ai-ollama.js";
import { ServiceError } from "@trafficflow/services/mail";

const SIDECAR_SRC = join(aliases.REPO, "apps", "sidecar", "src");

describe("every substitution row names something real, in both directions", () => {
  it("substitutes a module that EXISTS in the desktop's own source", () => {
    // The KEY side. `"./host-listener.js"` is the specifier `engine.ts` writes; the module it names
    // has to be there, or the row is rewriting an import nobody makes and the bundle census stays
    // green over a module it never excluded.
    const missing: string[] = [];
    for (const specifier of Object.keys(aliases.SIDECAR_SUBSTITUTES)) {
      const real = join(SIDECAR_SRC, basename(specifier).replace(/\.js$/, ".ts"));
      if (!existsSync(real)) missing.push(`${specifier} -> ${real}`);
    }
    expect(missing).toEqual([]);
  });

  it("substitutes WITH a module that exists", () => {
    // The VALUE side, for every group in the table.
    const missing: string[] = [];
    for (const [specifier, target] of Object.entries({
      ...aliases.SIDECAR_SUBSTITUTES,
      ...aliases.API_SUBSTITUTES,
      ...aliases.PACKAGE_ALIASES,
    })) {
      if (!existsSync(target)) missing.push(`${specifier} -> ${target}`);
    }
    // The device schema twin is a row of its own shape.
    if (!existsSync(aliases.SCHEMA_TWIN.to)) missing.push(`schema twin -> ${aliases.SCHEMA_TWIN.to}`);
    expect(missing).toEqual([]);
  });

  it("answers every Node builtin the table claims to, as a file or as an installed package", () => {
    const fromApp = createRequire(join(aliases.MOBILE, "noop.js"));
    const unresolved: string[] = [];
    for (const [specifier, target] of Object.entries(aliases.NODE_MODULES)) {
      if (target.startsWith("/")) {
        if (!existsSync(target)) unresolved.push(`${specifier} -> ${target} (no such file)`);
        continue;
      }
      /* A PACKAGE. `require.resolve` cannot be used to check these: `buffer`, `events`, `util` and
         `string_decoder` are Node BUILTINS as well as npm packages, so it answers the builtin's own
         name and every check passes whether the polyfill is installed or not. The package's own
         manifest is the thing that is unambiguously a file. */
      try {
        fromApp.resolve(`${target.split("/")[0]}/package.json`);
      } catch {
        unresolved.push(`${specifier} -> ${target} (not installed for the phone app)`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("covers both spellings of every builtin — bare and prefixed", () => {
    // A table that answered `fs` and not `node:fs` would leave the engine's own imports (which use
    // the prefix) resolving to a builtin that is not there, while its dependencies' imports worked.
    /* Typed at the boundary: the table is plain JavaScript, so its return reads as `{}` and every
       index into it is an implicit `any`. This package does not typecheck its tests, so nothing
       would have said so — found by running `tsc --noEmit` over this file by hand, which is the
       standing rule for a test in a package with no typecheck script. */
    const bare = aliases.bareSpecifiers() as Record<string, string | undefined>;
    for (const name of Object.keys(aliases.NODE_MODULES)) {
      expect(bare[name], name).toBeDefined();
      expect(bare[`node:${name}`], `node:${name}`).toBeDefined();
    }
  });
});

describe("the workspace rows name real modules, and the desktop keeps them", () => {
  it("each importer exists in its package's source, beside the module it imports, and each twin exists", () => {
    const missing: string[] = [];
    for (const [key, row] of Object.entries(aliases.WORKSPACE_MODULE_SUBSTITUTES)) {
      const [group, pkg, ...rest] = key.split("/");
      const importer = join(aliases.REPO, group!, pkg!, "src", `${rest.join("/")}.ts`);
      if (!existsSync(importer)) missing.push(`importer ${key} -> ${importer}`);
      for (const [specifier, target] of Object.entries(row)) {
        const real = join(importer, "..", specifier.replace(/\.js$/, ".ts"));
        if (!existsSync(real)) missing.push(`${key}: ${specifier} -> ${real}`);
        if (!existsSync(target)) missing.push(`${key}: ${specifier} => ${target}`);
      }
    }
    expect(missing).toEqual([]);
    expect(Object.keys(aliases.WORKSPACE_MODULE_SUBSTITUTES)).toHaveLength(3);
  });

  /* The DESKTOP engine's metafile, which `scripts/build-engine.mjs` writes: the real modules are
     there and no phone twin is. Skipped, by name, in a tree that has not built it. */
  const DESKTOP_META = join(aliases.REPO, "build", "engine.meta.json");
  it.skipIf(!existsSync(DESKTOP_META))("the desktop engine carries the real modules and no phone twin", () => {
    const inputs = Object.keys(
      (JSON.parse(readFileSync(DESKTOP_META, "utf8")) as { inputs: Record<string, unknown> }).inputs,
    );
    for (const real of [/^packages\/api\/(dist|src)\/routes\/health-markers\.(js|ts)$/,
      /^packages\/api\/(dist|src)\/routes\/events\.(js|ts)$/, /^packages\/db\/(dist|src)\/dialect\/pg\.(js|ts)$/]) {
      expect(inputs.filter((p) => real.test(p)), String(real)).toHaveLength(1);
    }
    expect(inputs.filter((p) => p.startsWith("apps/sidecar/src/phone/"))).toEqual([]);
  });
});

describe("the three substitutes the engine calls at boot ANSWER, and answer disarmed", () => {
  /* Called unconditionally by `createSidecar`, before it knows anything about the install. The
     third one was found by reading the call site rather than from a list: `localLanRoutes(...)` is
     SPREAD into the app's route table on every launch. */
  it("resolveHostConfig answers a permanently disarmed state", () => {
    const resolved = resolveHostConfig({});
    expect(resolved.state.armed).toBe(false);
    expect(resolved.state.origin).toBeNull();
    expect(resolved.state.port).toBeNull();
    expect(resolved.authConfig).toBeNull();
    // `reason` means "asked for and refused". Never asked for here, so null.
    expect(resolved.state.reason).toBeNull();
  });

  it("resolveLanBind answers no address", () => {
    const lan = resolveLanBind({});
    expect(lan.address).toBeNull();
    expect(lan.reason).toBeNull();
  });

  it("localLanRoutes answers an EMPTY TABLE and not a throw", () => {
    // The one that would be a phone which cannot start.
    expect(localLanRoutes(() => null)).toEqual([]);
  });

  it("and a knob that IS asked for is refused with a sentence, not silently disarmed", () => {
    // The other half: a caller that asks for a host door must not be told it has one. Unreachable
    // through `startPhoneEngine`, which refuses these first — kept so a future caller that bypasses
    // that check gets a sentence rather than a quietly dead door.
    expect(resolveHostConfig({ hostMode: true }).state.reason).toMatch(/no host door/);
    expect(resolveLanBind({ hostMode: true, lanBind: "192.168.1.10" }).reason).toMatch(/no same-network door/);
  });
});

describe("the substitutes that are unreachable refuse by name", () => {
  it("the LAN fallback, the LAN identity, and the static handler", () => {
    expect(() => serveLanFallback(new Request("http://x/"))).toThrow(/no same-network door/);
    expect(ensureLanIdentity("/nowhere").kind).toBe("refused");
    expect(() => createHostStatic({ assetsDir: null })).toThrow(/no host door/);
  });

  it("the store refuses and names the seam that replaces it", () => {
    // Unreachable twice over — the composition passes a store, and this module is what `./db.js`
    // resolves to in the bundle — so a refusal is the honest answer rather than a stub that
    // returns something.
    return expect(openLocalDb("/nowhere")).rejects.toThrow(/composes its store/);
  });

  it("a failed start's close closes the store the phone handed over, and throws what that close threw", async () => {
    let closed = 0;
    await closeAfterFailedStart({ close: async () => { closed++; } });
    expect(closed).toBe(1);
    const refused = new Error("the phone's store would not close");
    const seen = await closeAfterFailedStart({ close: () => Promise.reject(refused) }).then(() => "swallowed", (e: unknown) => e);
    expect(seen).toBe(refused);
  });

  it("the two route tables are empty", () => {
    expect(hostPairRoutes).toEqual([]);
    expect(desktopHostRoutes).toEqual([]);
  });
});

describe("the duplicated send ceiling cannot drift", () => {
  it("is the same number the desktop uses", () => {
    // `engine.ts` reads this constant into the send surface on every composition, host mode or not,
    // so the phone needs a value for it. It is duplicated BY VALUE rather than imported, because
    // importing it would bring the desktop's listener module into the phone's graph — which is the
    // thing the substitution exists to prevent. A duplicated constant is a drift hazard, so the
    // two are compared here rather than trusted to a comment.
    expect(PHONE_SEND_CAP).toBe(DESKTOP_SEND_CAP);
  });
});

describe("the substitutes reach no Node builtin and open no socket", () => {
  /**
   * ANSWERED FROM THE FILES THEMSELVES, WITH NO BUNDLER AND NO ARTIFACT — and the reason is a cost
   * I inflicted before removing it.
   *
   * The first version bundled the eight substitutes on a neutral platform, which needs the pinned
   * bundler. It therefore REFUSED whenever `OHMAIL_ESBUILD_FROM` was unset, which is every ordinary
   * run of this package's suite — so a lane touching anything in `apps/sidecar` would have met a
   * red it did not cause. A gate that fires on innocent runs is the same failure as one that cannot
   * fire, and dearer, because it discards other people's work.
   *
   * The narrower question does not need a bundler. These eight files are small, hand-written, and
   * import NOTHING but types from the modules they replace plus one route type. So the assertion is
   * the allow-list itself: every import specifier in every one of them is on it. That makes
   * transitivity irrelevant rather than unchecked — if a file imports only allowed specifiers there
   * is no graph beneath it to walk — and it is exact rather than approximate, which is what a
   * shallow read of an arbitrary module could never be.
   *
   * The ARTIFACT-level question ("is any of this in the shipped bundle") stays where it belongs, in
   * `apps/mobile/test/no-node-builtins.test.ts`, over the metafile.
   */
  const files = Object.values(aliases.SIDECAR_SUBSTITUTES)
    .concat(Object.values(aliases.API_SUBSTITUTES))
    .concat(Object.values(aliases.WORKSPACE_MODULE_SUBSTITUTES).flatMap((row) => Object.values(row)));

  /** What a substitute may import. Types only, plus each other. Nothing that runs. */
  const ALLOWED = [
    /^\.\.\/[a-z-]+\.js$/,          // a TYPE from the desktop module this one replaces
    /^\.\/[a-z-]+\.js$/,             // a sibling substitute
    /^@trafficflow\/api\/local$/,   // the `Route` type, and `/events`' shared refusal (an input already)
    /^@trafficflow\/db\/dialect$/,  // the `Dialect` type
    /* THE ONE VALUE IMPORT, and it buys back nothing it does not already cost. The AI twin has to
       throw the request pipeline's own typed error class: that pipeline answers a typed error with
       its code, status and sentence, and ANYTHING ELSE with `500 internal error` and the message
       discarded — so a person tapping Save on a phone would be shown "internal error". The
       specifier is already an input of the artifact through the engine's own services, which is
       what keeps the rule's premise ("no graph beneath it to walk") true; the case below asserts
       that rather than assuming it. */
    /^@trafficflow\/services\/mail$/,
  ];

  it("import nothing that runs — no Node builtin, no package, types only", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      /* Import STATEMENTS only. `require(` is matched separately below; a specifier inside a
         comment cannot match because the pattern is anchored on the statement keyword. */
      for (const m of text.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)) {
        const specifier = m[1]!;
        if (!ALLOWED.some((rule) => rule.test(specifier))) {
          offenders.push(`${basename(file)}: ${specifier}`);
        }
      }
      // No dynamic escape hatch either: `require` and `import()` would both reach a real module.
      expect(text, basename(file)).not.toMatch(/\brequire\s*\(/);
      expect(text, basename(file)).not.toMatch(/\bimport\s*\(/);
    }
    expect(offenders).toEqual([]);
  });

  it("bind no socket — the property the whole directory exists for", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // `createServer(` and `.listen(` are how a door is opened. `serveLanFallback` NAMES the LAN
      // door in a refusal, which is prose about a door rather than one, so the patterns are the
      // CALLS and not the words.
      if (/createServer\s*\(/.test(text)) offenders.push(`${basename(file)}: createServer(`);
      if (/\.listen\s*\(/.test(text)) offenders.push(`${basename(file)}: .listen(`);
    }
    expect(offenders).toEqual([]);
  });

  it("is not vacuous — it read fourteen real files with content in them", () => {
    // A path list that stopped resolving would make both cases above pass over nothing. FOURTEEN
    // since the three workspace twins (the schema markers, the Postgres dialect, `/events`). The
    // count moves with the table on purpose, so a row that disappears is a red and not a silence.
    expect(files).toHaveLength(14);
    for (const file of files) {
      expect(readFileSync(file, "utf8").length, basename(file)).toBeGreaterThan(200);
    }
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE AI PROVIDER SUBSTITUTE — it ANSWERS at boot, refuses only the writes, and says so
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `createSidecar` calls `createLocalAi` unconditionally, before it knows whether anything will ask
 * for a model. The real one opens a store file through `path.join` on its first line, which on a
 * phone reaches a module that is not there — so the engine failed while composing, on a build that
 * does not offer the feature at all. This is the boot-time rule this whole directory is held to,
 * met by the ninth substitute.
 */
describe("the AI provider a phone gets", () => {
  it("composes, and reports the state the product already has a name for", async () => {
    const ai = await createPhoneAi({} as never);
    const status = ai.status();
    expect(status.provider).toBeNull();
    expect(status.available).toBe(false);
    // AN EXISTING MEMBER of the reason vocabulary, never a new one: "no provider chosen" is what
    // this is, and it is the one unavailable state the product treats as normal rather than a fault.
    expect(status.unavailableReason).toBe("not_configured");
    expect(status.contentGoesTo).toBeNull();
    expect(status.probe).toBeNull();
    // No key field is offered, because there is nowhere for a key to go.
    expect(status.canStoreKey).toBe(false);
  });

  it("answers ABSENCE for the three model ports — the engine's own word for 'no model here'", async () => {
    // `undefined` is what makes the route table answer `503 drafter_unconfigured`, which is the
    // sentence a desktop with no provider gets. A port that existed and threw would give one state
    // two names, in two vocabularies, on two doors.
    const ai = await createPhoneAi({} as never);
    expect(ai.drafter()).toBeUndefined();
    expect(ai.classifier()).toBeUndefined();
    expect(ai.classifierForCycle()).toBeUndefined();
  });

  it("refuses the three WRITES as a typed error, which is what carries the sentence to a person", async () => {
    const ai = await createPhoneAi({} as never);
    for (const [name, call] of [
      ["save", () => ai.save({})],
      ["clear", () => ai.clear()],
      ["verify", () => ai.verify()],
    ] as const) {
      const err = await Promise.resolve()
        .then(call)
        .then(() => null, (e: unknown) => e as Error);
      /* THE CLASS, not the shape. The request pipeline matches `instanceof ServiceError` and turns
         anything else into `500 internal error` with the message thrown away — so a duck-typed
         refusal would show somebody in the middle of typing an API key "internal error". */
      expect(err, name).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).httpStatus, name).toBe(503);
      expect((err as ServiceError).code, name).toBe("ai_provider_unavailable");
      expect(err?.message, name).toBe(PHONE_AI_REFUSAL);
    }
  });

  it("says the two things a person needs, and nothing about a module", () => {
    // It cannot be done here, and nothing they typed went anywhere. A message shaped like a
    // transport fault would send somebody to check their network over something that is not built.
    expect(PHONE_AI_REFUSAL).toMatch(/not available on this phone/);
    expect(PHONE_AI_REFUSAL).toMatch(/nothing was stored and nothing was sent/);
    expect(PHONE_AI_REFUSAL).not.toMatch(/node:|Node|module|undefined|ECONN|DNS/);
  });

  it("carries the SAME default model names the real modules export", () => {
    // The cross-file pin the twin's banner promises. The values are duplicated so that importing
    // them cannot drag three vendor transports into the artifact; duplication is a drift hazard, so
    // the two are compared here rather than trusted to a comment.
    expect(PHONE_DEFAULT_AI_SETTINGS.anthropic.classifyModel).toBe(DEFAULT_ANTHROPIC_MODELS.classify);
    expect(PHONE_DEFAULT_AI_SETTINGS.anthropic.draftModel).toBe(DEFAULT_ANTHROPIC_MODELS.draft);
    expect(PHONE_DEFAULT_AI_SETTINGS.openai.classifyModel).toBe(DEFAULT_OPENAI_MODELS.classify);
    expect(PHONE_DEFAULT_AI_SETTINGS.openai.draftModel).toBe(DEFAULT_OPENAI_MODELS.draft);
    expect(PHONE_DEFAULT_AI_SETTINGS.ollama.baseUrl).toBe(DEFAULT_OLLAMA.baseUrl);
    expect(PHONE_DEFAULT_AI_SETTINGS.ollama.classifyModel).toBe(DEFAULT_OLLAMA.classifyModel);
    expect(PHONE_DEFAULT_AI_SETTINGS.ollama.draftModel).toBe(DEFAULT_OLLAMA.draftModel);
    // And no key is claimed for either vendor, on a build with nowhere to put one.
    expect(PHONE_DEFAULT_AI_SETTINGS.anthropic.hasKey).toBe(false);
    expect(PHONE_DEFAULT_AI_SETTINGS.openai.hasKey).toBe(false);
  });

  it("reaches no vendor transport in the ARTIFACT, which is the premise of the allow-list above", () => {
    /* The one value import this directory permits is `@trafficflow/services/mail`, allowed because
       the engine already puts it in the bundle. Read from the metafile rather than argued: the
       three vendor transports and the real provider are NOT inputs, and the twin is. */
    const metaPath = join(aliases.REPO, "build", "phone-engine", "phone-engine.meta.json");
    if (!existsSync(metaPath)) return;   // the bundle census owns building it
    const inputs = Object.keys(
      (JSON.parse(readFileSync(metaPath, "utf8")) as { inputs: Record<string, unknown> }).inputs,
    );
    for (const gone of ["ai-anthropic", "ai-openai", "ai-ollama", "ai-transport"]) {
      expect(inputs.filter((p) => p.includes(gone)), gone).toEqual([]);
    }
    expect(inputs.filter((p) => /apps\/sidecar\/(src|dist)\/ai-provider\.(ts|js)$/.test(p))).toEqual([]);
    expect(inputs.filter((p) => p.includes("phone/ai-provider"))).toHaveLength(1);
  });
});
