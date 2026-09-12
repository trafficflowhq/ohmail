import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ═══ THE SERVED HOST CLIENT CARRIES NO ENGINE DOOR ═══════════════════════════════════════════
 *
 * The desktop window talks to the mail engine on its own machine through one shell command,
 * `engine_request` (`src/bridge-fetch.ts`). The bundle the host door serves to a phone has no
 * shell to call it with: its transport is the bearer socket over the origin that served the page.
 * A served page that NAMES a shell channel is a page claiming a channel it does not have, so
 * `scripts/scan-artifact.mjs --expect host-client` refuses one — and `app:build:engine`, the only
 * build CI runs, runs that scan. A packaged release therefore cannot ship while the name is in
 * the bytes.
 *
 * It was in the bytes. `host-client/transports.ts` imported the five `*Via` factories from the
 * window's own `local-*` modules, each of which binds its factory to the bridge in a module
 * constant — so importing any one of them pulled `bridge-fetch.ts` into the graph and its
 * command name into the served chunk, once. The factories now live in `*-wire.ts` modules that
 * import no transport at all.
 *
 * ── MEASURED ON THE ARTIFACT, AND ON THE GRAPH THAT PRODUCED IT ─────────────────────────────
 *
 * Two readings of one build, because each answers a different question. The BYTES are the claim
 * the scan makes, and they are what ships. The MODULE GRAPH says which import dragged the door
 * in, which is the only thing a reader of a future failure can act on — a byte count going from
 * 0 to 1 names nothing.
 *
 * The build is in memory (`write: false`): nothing is emitted, so this cannot disturb `dist-host`
 * or read a stale one somebody else left there.
 *
 * ── AND THE POSITIVE CONTROL IS A DOOR IMPORT, INJECTED IN MEMORY ───────────────────────────
 *
 * A guard for an absence goes green when the thing it watches is deleted, so the third case
 * builds the SAME entry with one extra line transformed into `transports.ts` — a value import of
 * the bridge — and asserts both readings above go red. The injection is a `transform` hook and
 * never touches the tree, because a mutation written to a source file under a running suite is
 * both a false red across the run and a file somebody else may commit.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const DOOR_COMMAND = "engine_request";
const TRANSPORTS = path.join(APP, "src", "host-client", "transports.ts");

/** Every module id the emitted chunks were built from, plus the concatenated emitted code. */
interface Reading {
  modules: string[];
  code: string;
}

/**
 * The two rollup shapes this file reads, spelled here rather than imported.
 *
 * `rollup` is not a declared dependency of this project — vite carries it — so a type import of
 * it compiles in the workspace and fails in the published checkout, which is the one tree these
 * tests exist to be runnable in. Only the members below are touched, and a build whose shape
 * stopped matching them would fail the floors in the first case rather than pass quietly.
 */
interface EmittedChunk {
  type: string;
  modules?: Record<string, unknown>;
  code?: string;
  source?: unknown;
}
interface BuiltPlugin {
  name: string;
  enforce?: "pre" | "post";
  generateBundle?: (options: unknown, bundle: Record<string, EmittedChunk>) => void;
  transform?: (code: string, id: string) => { code: string; map: null } | null;
}

/**
 * One in-memory host-client build.
 *
 * `OHMAIL_HOST_CLIENT` selects the artifact in `vite.config.ts`, and it is set here rather than
 * passed, because that is how `scripts/build-ui.mjs` selects it — a different mechanism would
 * measure a build nothing ships.
 */
async function buildHostClient(extra: BuiltPlugin[] = []): Promise<Reading> {
  const modules = new Set<string>();
  const collect: BuiltPlugin = {
    name: "ohmail-collect-modules",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules ?? {})) modules.add(id);
      }
    },
  };
  process.env.OHMAIL_HOST_CLIENT = "1";
  const { build } = await import("vite");
  const result = (await build({
    root: APP,
    configFile: path.join(APP, "vite.config.ts"),
    logLevel: "silent",
    plugins: [...extra, collect] as never,
    build: { write: false },
  })) as unknown as { output: EmittedChunk[] } | Array<{ output: EmittedChunk[] }>;
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
  const code = outputs
    .map((o) => (o.type === "chunk" ? (o.code ?? "") : String(o.source)))
    .join("\n");
  return { modules: [...modules], code };
}

/** The injection the positive control measures: a VALUE import of the bridge, in memory only. */
const injectDoor: BuiltPlugin = {
  name: "ohmail-inject-door",
  enforce: "pre",
  transform(code, id) {
    if (path.resolve(id.split("?")[0] ?? id) !== TRANSPORTS) return null;
    return {
      code: 'import { bridgeFetch } from "../bridge-fetch.js";\nvoid bridgeFetch;\n' + code,
      map: null,
    };
  },
};

const rel = (id: string): string => path.relative(APP, id);

describe("the bundle the host door serves names no shell command", () => {
  let clean: Reading;

  beforeAll(async () => {
    clean = await buildHostClient();
  }, 300_000);

  it("the build this reads is the host client, and it is a real one", () => {
    /* Both floors, because everything below is an ABSENCE: an empty build would pass every one
       of them. The entry's own module and a chunk of real size are what make the absences
       measurements rather than assertions about nothing. */
    expect(clean.modules.some((id) => rel(id) === "src/host-client/main.tsx")).toBe(true);
    expect(clean.modules.length).toBeGreaterThan(200);
    expect(clean.code.length).toBeGreaterThan(500_000);
  });

  it("the EMITTED BYTES do not contain the shell command — the claim `scan:host` makes", () => {
    expect(clean.code).not.toContain(DOOR_COMMAND);
  });

  it("and the engine door is not in the module graph at all, so nothing can name it later", () => {
    /* Only this project's own source files are read: rollup's graph also carries VIRTUAL ids
       (the CommonJS interop helpers arrive as `\0commonjsHelpers.js`), and a reader that hands
       one of those to the filesystem throws — which reads as a defect in this guard rather than
       as an answer about the bundle. */
    const ours = clean.modules
      .map((id) => id.split("?")[0] ?? id)
      .filter((id) => path.isAbsolute(id) && id.startsWith(APP + path.sep) && fs.existsSync(id));
    const draggers = ours
      .filter((id) => rel(id) !== "src/bridge-fetch.ts")
      .filter((id) => /(?:from|import)\s*\(?\s*["'][^"']*bridge-fetch\.js["']/
        .test(fs.readFileSync(id, "utf8")))
      .map(rel);
    expect(clean.modules.map(rel)).not.toContain("src/bridge-fetch.ts");
    expect(draggers, "a module in the served graph imports the engine door").toEqual([]);
  });

  it("POSITIVE CONTROL: one injected door import puts the command back and both cases go red", async () => {
    const dirty = await buildHostClient([injectDoor]);
    expect(dirty.code).toContain(DOOR_COMMAND);
    expect(dirty.modules.map(rel)).toContain("src/bridge-fetch.ts");
  }, 300_000);
});

/**
 * ── THE MECHANISM, AS A SOURCE CENSUS ───────────────────────────────────────────────────────
 *
 * The build above is the evidence; this is the rule, and it is cheap enough to read on every run.
 * `host-client/transports.ts` may import only modules that import no door, so the five factories
 * it needs live in files that spell no transport. A future wire added to that file gets the same
 * treatment or this fails on the new import rather than on a byte count.
 */
describe("the wire modules the host client imports spell no door", () => {
  const WIRES = [
    "src/junk-wire.ts",
    "src/trash-wire.ts",
    "src/profile-import-wire.ts",
    "src/mailbox-facts-wire.ts",
  ];

  it("every wire module exists and names its factory — so the absences below are measured", () => {
    for (const [rel_, factory] of [
      ["src/junk-wire.ts", "export function junkVia("],
      ["src/trash-wire.ts", "export function trashVia("],
      ["src/profile-import-wire.ts", "export function profileImportVia("],
      ["src/mailbox-facts-wire.ts", "export async function readMailboxFactsVia("],
    ] as const) {
      expect(fs.readFileSync(path.join(APP, rel_), "utf8"), rel_).toContain(factory);
    }
  });

  it("no wire module imports the bridge, and none names the shell command", () => {
    for (const rel_ of WIRES) {
      const src = fs.readFileSync(path.join(APP, rel_), "utf8");
      expect(src, `${rel_} imports the engine door`).not.toMatch(/["'][^"']*bridge-fetch(?:\.js)?["']/);
      expect(src, `${rel_} names the shell command`).not.toContain(DOOR_COMMAND);
    }
  });

  it("the host client's transports import only those modules and the shared engine", () => {
    const src = fs.readFileSync(TRANSPORTS, "utf8");
    const specifiers = [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    /* The positive control for this case: the parse found the imports it is judging. */
    expect(specifiers).toContain("../junk-wire.js");
    expect(specifiers).toContain("@ohmail/client-engine");
    /* A relative specifier that lands on a `local-*` module is the defect this closed: every one
       of them binds its factory to the bridge in a module constant. */
    const bound = specifiers.filter((s) => /(^|\/)local-|(^|\/)Desktop[A-Z]/.test(s));
    expect(bound, "the host client's transports reach a bridge-bound module").toEqual([]);
  });

  it("the door-bound modules still bind their factory to the bridge — the window keeps its wire", () => {
    for (const [rel_, binding] of [
      ["src/local-junk.ts", "junkVia(bridgeFetch)"],
      ["src/local-trash.ts", "trashVia(bridgeFetch)"],
      ["src/local-profile-import.ts", "profileImportVia(bridgeFetch)"],
      ["src/local-mailbox-facts.ts", "readMailboxFactsVia(retryingBridgeFetch, opts)"],
      ["src/local-older-body.ts", "olderBodyVia(bridgeFetch)"],
    ] as const) {
      expect(fs.readFileSync(path.join(APP, rel_), "utf8"), rel_).toContain(binding);
    }
  });

  it("and the pane the release publishes at its own content gains no import", () => {
    /* `DesktopMailboxes.tsx` is published at the release's content at older commits, so an import
       added there would name a module those trees do not have and the publish would stop. That is
       why the facts read's bridge binding is its own module rather than a line in the pane. */
    const pane = fs.readFileSync(path.join(APP, "src", "DesktopMailboxes.tsx"), "utf8");
    expect(pane).not.toContain("mailbox-facts-wire");
    expect(pane).not.toContain("local-mailbox-facts");
    /* The positive control: the pane is really being read, and it really is the one that used to
       hold the facts read. */
    expect(pane).toContain("readMailboxReachVia(retryingBridgeFetch)");
  });
});
