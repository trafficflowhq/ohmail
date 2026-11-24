/**
 * WHAT THE ENGINE NEVER HANDS OUT. A send has one owner, a cancelled send stays cancelled and the
 * order of a person's verbs is theirs because the state that decides them has no outside reader or
 * writer: the lock's name, the transport, the lock registry, the notice channel, the owed and
 * withdrawn Cancels, the queue, the overlays, the verbs on the wire and the answers kept for later.
 *
 * Two checks. The type half: each line below expects the compiler's refusal, and the barrel is
 * read for any class that carries one of the names. The suite's runner strips types and the
 * package's build reads `src` alone, so neither would say a word the day a member became public;
 * the last case compiles this file itself, under the options this folder is checked with, and
 * expects it clean. The running half holds the barrel to the engine alone: the classes the engine
 * is built from are not exports.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as barrel from "@ohmail/client-engine";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";

const HERE = fileURLToPath(import.meta.url);

type Hidden =
  | "ownerName" | "adapter" | "locks" | "notices" | "owedWithdraws" | "withdrawnKeys"
  | "queue" | "overlays" | "inFlight" | "lateResults";

/** Every class the barrel exports whose instances would hand one of the names out. */
type Barrel = typeof barrel;
type Leaks = {
  [K in keyof Barrel]: Barrel[K] extends abstract new (...args: never[]) => infer I
    ? (OhmailEngine extends I ? (Extract<keyof I, Hidden> extends never ? never : K) : never)
    : never
}[keyof Barrel];
const noClassCarriesThem: [Leaks] extends [never] ? true : false = true;

const adapter = {
  sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: new Date(0).toISOString() }),
  mutate: async () => ({ changes: [], seq: null }),
  fetchBody: async () => null,
} as unknown as EngineAdapter;

describe("the engine's doors", () => {
  it("none of the state that decides a send is a public member", () => {
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore() });
    // @ts-expect-error the lock's name is the engine's own
    void engine.ownerName;
    // @ts-expect-error the transport is behind the engine
    void engine.adapter;
    // @ts-expect-error ownership is decided at construction
    void engine.locks;
    // @ts-expect-error the notice channel is the engine's own
    void engine.notices;
    // @ts-expect-error an owed Cancel is not editable
    void engine.owedWithdraws;
    // @ts-expect-error a withdrawn key is not editable
    void engine.withdrawnKeys;
    // @ts-expect-error the queue is read through pendingMutations()
    void engine.queue;
    // @ts-expect-error the overlays are read through read()
    void engine.overlays;
    // @ts-expect-error the wire is read through inFlightMutations()
    void engine.inFlight;
    // @ts-expect-error late answers are read through flushPending()
    void engine.lateResults;
    expect(noClassCarriesThem).toBe(true);
    // What a surface reads instead is there.
    expect([engine.pendingMutations(), engine.inFlightMutations(), engine.hasLateResults()]).toEqual([[], [], false]);
  });

  it("the barrel exports the engine and none of the classes it is built from", () => {
    const built: unknown[] = [];
    for (let c: unknown = Object.getPrototypeOf(OhmailEngine); typeof c === "function" && c !== Function.prototype; c = Object.getPrototypeOf(c)) built.push(c);
    const handedOut = Object.entries(barrel).filter(([, v]) => built.includes(v)).map(([name]) => name);
    expect(handedOut).toEqual([]);
  });

  /**
   * What makes the first case bind. A member made public leaves its line expecting a refusal that
   * no longer comes, and a class that carries one of the names no longer fits the constant above:
   * the compiler says both, and only the compiler does.
   */
  it("the compiler refuses every one of them: this file type-checks clean", () => {
    const said = (d: ts.Diagnostic) => ts.flattenDiagnosticMessageText(d.messageText, " ");
    const parsed = ts.getParsedCommandLineOfConfigFile(join(dirname(HERE), "..", "tsconfig.test-dirs.json"), {}, {
      ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(said(d)); },
    })!;
    const program = ts.createProgram({ rootNames: [HERE], options: parsed.options });
    const self = program.getSourceFile(HERE)!;
    // The engine it read is the source the suite runs, not a copy built earlier.
    const read = program.getSourceFiles().map((f) => f.fileName.replace(/\\/g, "/"));
    expect(read.some((f) => f.endsWith("/packages/client-engine/src/engine.ts"))).toBe(true);
    const refused = [...parsed.errors, ...program.getSyntacticDiagnostics(self), ...program.getSemanticDiagnostics(self)].map((d) =>
      `${d.file && d.start !== undefined ? `line ${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "options"}: TS${d.code} ${said(d)}`);
    expect(refused).toEqual([]);
  }, 60_000);
});
