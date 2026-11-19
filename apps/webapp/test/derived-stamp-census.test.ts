import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_DERIVED_FROM } from "@ohmail/app-logic/engine";

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
 * memos call into, and the shell's own inline reads: re-pointed from today's `AppShell.tsx` and
 * `shell-derivations.ts`, which the switch deletes, to the new composition's reads of the mirror
 * keyed on the derived stamp (the Ohbox's live mirror, the composer's lists; RULING-NEW-SHELL-FIRST D (3)).
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
  /* The new shell's own reads of the mirror on the derived stamp: the Ohbox's live mirror (its tags) and the one
     composer's lists (the mailboxes). */
  "../../../packages/app-logic/src/ohbox/live-mirror.ts",
  "../../../packages/app-logic/src/writing/composer-lists.ts",
  /* And two reads cut out of the shell for the mail ground: the settings stamp the consent row re-asks on, and
     the count of mirrored letters the mail state's mount samples. Both are keyed on the derived stamp. */
  "../../../packages/app-logic/src/consent/consent-row.ts",
  "../../../packages/app/src/mail/ground/MailStateMount.tsx",
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
    /* The list's own pass keys on the stamps of the engine it is handed (`local-pass.ts`), the shell's formula. */
    const pass = code(read("../../../packages/app-logic/src/search/local-pass.ts"));
    expect(pass, "the search view took the global version back — every body publish is a rebuild")
      .not.toMatch(/useEngineVersion\(\)|\.read\(\)\.version\(\)/);
    expect(pass, "the search view is not on the derived stamp")
      .toContain("stampExcept(NOT_DERIVED_FROM)");
    expect(pass, "the search view lost the index revision — a settled build will not reach it")
      .toContain("searchIndexRevision()");
    expect(pass, "the local pass stopped keying on the stamps that supply it")
      .toMatch(/useMemo\([\s\S]*engine\.search\(trimmed\)[\s\S]*\[engine, trimmed, key\]\)/);
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
   * The new tree's surfaces, WALKED rather than listed: the reader's views and its behaviour. A file there that
   * calls `bodyOf` takes the body's arrival through the one door (`@ohmail/app-logic/reading`'s body-arrival),
   * never a store of its own, so the old reader and the new one re-draw a landed body by the same rule.
   */
  it("pairs every bodyOf call of the new tree with the body's arrival", () => {
    const roots = ["../../../packages/app/src", "../../../packages/app-logic/src/reader"]
      .map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
    const callers: string[] = [];
    const unsubscribed: string[] = [];
    for (const file of roots.flatMap(walk)) {
      const src = code(readFileSync(file, "utf8"));
      // A CALL, not a mention, as the case above reads it.
      if (!/(?:^|[^\w.])bodyOf\s*\(|\.bodyOf\s*\(/m.test(src)) continue;
      const where = relative(process.cwd(), file).split("\\").join("/");
      callers.push(where);
      if (!/useBodyArrival\s*\(|useBodyStamp\s*\(/.test(src)) unsubscribed.push(where);
    }
    expect(callers.length, "no file of the new tree was found calling bodyOf — the census matched nothing")
      .toBeGreaterThanOrEqual(1);
    expect(unsubscribed, "a surface of the new tree draws a body without the body's arrival").toEqual([]);
  });
});

/**
 * THE ONE FORM A NAMED RECORD MAY TAKE: a shell hook's record passed through
 * `useRecordWhileSame` (held while no member moved) and handed WHOLE to its ONE context in the same component, every
 * other use a member read. A record named without the hold, or held and handed whole twice, is a finding.
 */
function recordFindings(where: string, src: string, hooks: readonly string[]): { calls: string[]; named: string[] } {
  const named: string[] = [];
  const calls: string[] = [];
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
    /* The held form: its whole uses are counted to the end of the component that binds it. */
    const held = new RegExp(`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*useRecordWhileSame\\(\\s*${hook}\\(`, "g");
    for (let m = held.exec(src); m !== null; m = held.exec(src)) {
      const name = m[1]!;
      calls.push(`${where}: ${hook}`);
      const rest = src.slice(m.index + m[0].length);
      const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s|\n(?:export\s+)?const\s/);
      const component = next === -1 ? rest : rest.slice(0, next);
      const whole = [...component.matchAll(new RegExp(`(?<![\\w$.])${name}\\b(?!\\s*(?:\\?\\.|\\.|\\[))`, "g"))];
      if (whole.length !== 1) {
        named.push(`${where}: const ${name} = useRecordWhileSame(${hook}(…)) is handed whole ${whole.length} times, not to one context`);
      }
    }
  }
  return { calls, named };
}

/**
 * NO SHELL FRAME NAMES ANOTHER FRAME'S RECORD.
 *
 * A `useShell…` hook hands back one object built per render. Bound to a name, it can be written
 * into a dependency array — `useMemo(…, [derivations])` — and then every render re-derives: a
 * cost no assertion in this repo can see and the perf harness can. Destructuring at the call site
 * makes the record unnameable, so a dependency can only ever be a FIELD. The hooks are read off
 * the manifest, so the next module the split creates is asked the same question.
 *
 * Re-pointed by path (RULING-NEW-SHELL-FIRST D (3)): today's manifest of `shell-*` frames leaves with
 * today's shell. The `useShell…` hooks are read where they live now (`packages/app-logic/src`), and the
 * frames asked are every file of the new shell (`packages/app/src`) that calls one.
 */
describe("no shell frame binds another frame's record to a name", () => {
  it("every manifest hook call is destructured where it is called", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
    const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
    const hooks = walk(here("../../../packages/app-logic/src")).flatMap((f) =>
      [...code(readFileSync(f, "utf8")).matchAll(/export function (useShell[A-Za-z]*)\(/g)].map((m) => m[1]!));
    expect(hooks.length, "the manifest exports no shell hook — the census has lost its subject")
      .toBeGreaterThan(0);
    const sources = walk(here("../../../packages/app/src"))
      .map((f) => [f, code(readFileSync(f, "utf8"))] as const)
      .filter(([, src]) => hooks.some((hook) => src.includes(`${hook}(`)));
    const named: string[] = [];
    const calls: string[] = [];
    for (const [file, src] of sources) {
      const found = recordFindings(relative(process.cwd(), file), src, hooks);
      calls.push(...found.calls);
      named.push(...found.named);
    }
    expect(calls.length, "no frame calls a shell hook — the census measured nothing")
      .toBeGreaterThan(0);
    expect(named, `a named record invites a memo keyed on it — destructure instead:\n${named.join("\n")}`)
      .toEqual([]);
  });

  it("PLANTED: a named record that is not held is found", () => {
    const src = code(`export function Mount() {
  const compose = useShellCompose(input);
  return <ComposerContext.Provider value={compose}>{children}</ComposerContext.Provider>;
}`);
    expect(recordFindings("planted.tsx", src, ["useShellCompose"]).named).toHaveLength(1);
  });

  it("PLANTED: a held record handed whole to a second reader is found; handed to its one context, it is not", () => {
    const twice = code(`export function Mount() {
  const compose = useRecordWhileSame(useShellCompose(input));
  const writing = writingOf(compose, inputs);
  return <ComposerContext.Provider value={compose}>{writing.letter}{compose.replyDone}</ComposerContext.Provider>;
}`);
    expect(recordFindings("planted.tsx", twice, ["useShellCompose"]).named).toHaveLength(1);
    const once = code(`export function Mount() {
  const compose = useRecordWhileSame(useShellCompose(input));
  return <ComposerContext.Provider value={compose}>{compose.replyDone}</ComposerContext.Provider>;
}
function Over() {
  const compose = useComposer();
  return writingOf(compose, inputs);
}`);
    expect(recordFindings("planted.tsx", once, ["useShellCompose"])).toEqual({
      calls: ["planted.tsx: useShellCompose"],
      named: [],
    });
  });
});
