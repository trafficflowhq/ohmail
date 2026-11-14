import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_DERIVED_FROM } from "../app/shell/engine";
import { shellFramePaths } from "./source-anchor.js";

/**
 * THE TWO CLAIMS THE PER-PUBLISH SPLIT RESTS ON, CHECKED RATHER THAN TRUSTED.
 *
 * The window keys its whole-mirror derivations on a stamp that ignores {@link NOT_DERIVED_FROM},
 * and the surfaces that draw a body take their own subscription instead. Both are statements
 * about code somebody will edit later, and both fail QUIETLY when they stop being true — a pile
 * derived from a stamp that no longer moves for it shows last minute's mail; a surface that
 * draws a body without subscribing shows the loading snippet for ever. Neither reddens a test
 * that is about anything else, which is why they are censused here.
 */

/** Read a repo file THROUGH A VARIABLE — a literal `new URL` is a Vite asset reference here. */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * Source with its comments removed. A census that greps raw text answers about prose as well as
 * code — and prose is exactly where these types get NAMED, in the notes explaining the rule.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Every `list("x")` / `entries("x")` type literal in a file, comments excluded. */
function typesListedIn(src: string): string[] {
  const out: string[] = [];
  const re = /\.(?:list|entries)\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g;
  for (let m = re.exec(code(src)); m !== null; m = re.exec(code(src))) out.push(m[1]!);
  return out;
}

/**
 * WHERE THE WINDOW'S WHOLE-MIRROR DERIVATIONS LIVE. The two client-engine modules the shell's
 * memos call into, and the shell's own inline reads.
 *
 * `search.ts` USED to be the census's one exclusion: the search index read `message_body`, so the
 * one view built on it had to take the GLOBAL version through its own wrapper. A later fix took the
 * bodies out of that index — the archive is the body search — so the exclusion is gone and
 * `search.ts` is asked the same question as everything else here. The pair of assertions below
 * keeps both halves true: nothing in this list reads a body, and the search view is on the
 * derived stamp like the rest of the window.
 */
const DERIVATION_SOURCES = [
  "../../../packages/client-engine/src/selectors.ts",
  "../../../packages/client-engine/src/consent-cutline.ts",
  "../../../packages/client-engine/src/search.ts",
  "../app/shell/AppShell.tsx",
  /* The shell's whole-mirror memos left `AppShell.tsx` for this frame (ARCH-022). Both are asked:
     the file that computes the derivations, and the file that still reads the mirror inline. */
  "../app/shell/shell-derivations.ts",
];

describe("the derived stamp ignores only what nothing derives from", () => {
  it("no whole-mirror derivation lists a type the stamp is told to ignore", () => {
    expect(NOT_DERIVED_FROM.length, "the deny list emptied — the split derives from nothing")
      .toBeGreaterThan(0);
    for (const rel of DERIVATION_SOURCES) {
      const listed = typesListedIn(read(rel));
      expect(listed.length, `${rel} lists no types at all — the census has lost its subject`)
        .toBeGreaterThan(0);
      for (const ignored of NOT_DERIVED_FROM) {
        expect(listed, `${rel} derives over "${ignored}", which the window's stamp ignores`)
          .not.toContain(ignored);
      }
    }
  });

  /**
   * THE OTHER HALF, AND IT IS THE ONE THAT MOVED. While `search.ts` read bodies, the
   * search view had to take the GLOBAL version or a body arriving during an open search would
   * not reach the results. It no longer reads them, so the global version would now re-run the
   * local pass for writes the index cannot see — an open writes three body records and the eager
   * pass one per message, and each of those was a whole-mirror index rebuild on the keystroke
   * path. The view is on the derived stamp, and this asserts it rather than trusting the comment.
   *
   * `useSearchIndexRevision` is the second dependency and is asserted beside it: the index now
   * lags the mirror deliberately, so a build settling changes the answer with no record having
   * moved, and a view keyed on the mirror alone would hold the pre-build answer until the next
   * drain — which is a stale screen, the same failure this census exists for, one door along.
   */
  it("the search view is on the derived stamp, with the index's own revision beside it", () => {
    const search = typesListedIn(read("../../../packages/client-engine/src/search.ts"));
    expect(search, "search.ts lists types — the census must have a subject").not.toHaveLength(0);
    expect(search, "search.ts reads bodies again — the instant index is back on the whole mail")
      .not.toContain("message_body");
    const shell = code(read("../app/shell/AppShell.tsx"));
    expect(shell, "the search view took the global version back — every body publish is a rebuild")
      .not.toContain("useEngineVersion()");
    expect(shell, "the search view is not on the derived stamp")
      .toContain("useDerivedVersion()");
    expect(shell, "the search view lost the index revision — a settled build will not reach it")
      .toContain("useSearchIndexRevision()");
    expect(shell, "the search mount stopped going through the wrapper that supplies it")
      .toContain("<SearchViewLive");
  });
});

/**
 * THE ONE BODY A DERIVATION READS, AND THE STAMP THAT CARRIES IT. The partition reads the text of
 * a message whose sender a body-term rule names (`messagePlacement`), BY ID, which the list census
 * above cannot see. Such a read is admitted only while the window's stamp takes the engine's
 * `placementStamp` and the engine moves it at every door that writes or drops a body.
 */
describe("a derivation that reads a body by id rides the placement stamp", () => {
  it("the partition's body read, the window's stamp and the engine's three body doors agree", () => {
    const cutline = code(read("../../../packages/client-engine/src/consent-cutline.ts"));
    expect(cutline, "the census lost its subject: the partition no longer reads a body").toMatch(/\.get<[^>]*>\("message_body"/);
    expect(code(read("../../../packages/app-logic/src/engine/context.ts")), "the window's stamp ignores the bodies that place mail")
      .toMatch(/stampExcept\(NOT_DERIVED_FROM\),\s*engine\.placementStamp\(\)/);
    const engine = code(read("../../../packages/client-engine/src/engine/bodies.ts"));
    const noted = [...engine.matchAll(/this\.notePlacementBodies\(/g)].length;
    expect(noted, "putBody, putBodies and the trim each move the stamp").toBe(3);
  });
});

describe("every surface that draws a body subscribes to one", () => {
  /**
   * The files that call `bodyOf` at draw time. Derived from the source rather than listed, so a
   * fifth surface added later is asked the same question instead of being forgotten.
   */
  const CANDIDATES = [
    "../app/shell/MessagePane.tsx",
    "../app/shell/MessageCard.tsx",
    "../app/views/ReadsView.tsx",
    "../app/views/ReceiptsView.tsx",
    "../app/views/ScreenerView.tsx",
    "../app/views/OhboxView.tsx",
    "../app/views/HistoryView.tsx",
    "../app/shell/StreamCardMemo.tsx",
    "../app/shell/InlineReply.tsx",
    "../app/shell/Conversation.tsx",
  ];

  it("pairs every bodyOf draw with a body-slice hook", () => {
    const draws: string[] = [];
    for (const rel of CANDIDATES) {
      const src = code(read(rel));
      // `useDrawnBody` is the door and its subscription in one call (`body-slice.ts`).
      if (/useDrawnBody\s*\(/.test(src)) draws.push(rel);
      // A CALL, not a mention: `bodyOf: bodyOfMessage` and a prop type are neither.
      if (!/(?:^|[^\w.])bodyOf\s*\(|\.bodyOf\s*\(/m.test(src)) continue;
      if (!draws.includes(rel)) draws.push(rel);
      expect(src, `${rel} draws a body and never subscribes to one — it will show the snippet`)
        .toMatch(/useBodyArrival\s*\(|useBodyStamp\s*\(/);
    }
    // The census must have a subject: four surfaces draw bodies today.
    expect(draws.length, "no file was found drawing a body — the census matched nothing")
      .toBeGreaterThanOrEqual(4);
  });
});

/**
 * NO SHELL FRAME NAMES ANOTHER FRAME'S RECORD.
 *
 * A `useShell…` hook hands back one object built per render. Bound to a name, it can be written
 * into a dependency array — `useMemo(…, [derivations])` — and then every render re-derives: a
 * cost no assertion in this repo can see and the perf harness can. Destructuring at the call site
 * makes the record unnameable, so a dependency can only ever be a FIELD. The hooks are read off
 * the manifest, so the next module the split creates is asked the same question.
 */
describe("no shell frame binds another frame's record to a name", () => {
  it("every manifest hook call is destructured where it is called", () => {
    const frames = shellFramePaths(process.cwd());
    const sources = frames.map((f) => [f, code(readFileSync(f, "utf8"))] as const);
    const hooks = sources.flatMap(([, src]) =>
      [...src.matchAll(/export function (useShell[A-Za-z]*)\(/g)].map((m) => m[1]!));
    expect(hooks.length, "the manifest exports no shell hook — the census has lost its subject")
      .toBeGreaterThan(0);
    const named: string[] = [];
    const calls: string[] = [];
    for (const [file, src] of sources) {
      const where = relative(process.cwd(), file);
      for (const hook of hooks) {
        /* The binding is read BACKWARDS from the call, because the shell destructures across a
           dozen lines and a one-line pattern would match neither shape. Everything between the
           nearest `const ` and the `=` is the binding: `{` opens a destructure, anything else is
           a name. A call that is not a binding at all (an argument, a re-export) is not one of
           these and is skipped rather than guessed at. */
        const re = new RegExp(`=\\s*${hook}\\(`, "g");
        for (let m = re.exec(src); m !== null; m = re.exec(src)) {
          const before = src.slice(0, m.index);
          const at = before.lastIndexOf("const ");
          if (at === -1) continue;
          const binding = before.slice(at + "const ".length).trim();
          calls.push(`${where}: ${hook}`);
          if (!binding.startsWith("{")) named.push(`${where}: const ${binding}= ${hook}(…)`);
        }
      }
    }
    expect(calls.length, "no frame calls a shell hook — the census measured nothing")
      .toBeGreaterThan(0);
    expect(named, `a named record invites a memo keyed on it — destructure instead:\n${named.join("\n")}`)
      .toEqual([]);
  });
});
