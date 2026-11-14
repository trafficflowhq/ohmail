import { describe, it, expect } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * WHERE THE AWAY RESPONDER'S PASS RUNS — a source census, because the failure it guards against is
 * INVISIBLE at run time.
 *
 * ── THE FAILURE THIS EXISTS FOR, WHICH ALREADY HAPPENED ONCE ────────────────────────────────
 *
 * The responder used to be `apps/worker/src/away-responder.ts`, called from that app's cycle tail.
 * It was correct code, it had four test files, and it had almost certainly NEVER DELIVERED A SINGLE
 * REPLY — because the sync host's platform blocks outbound SMTP submission at the port level
 * (`apps/worker/src/smtp-size.ts`: twelve hosts, every dial a timeout, IMAP to the same host
 * 300 ms). Every dial threw, and every throw KEPT the at-most-once claim, so each correspondent was
 * silenced for the rest of the episode by a send that never left the building.
 *
 * Nothing failed. No test went red, no alarm fired, and the counters said the pass ran. That is the
 * "built, tested, unreachable" shape, and the only cheap defence against its recurrence is to pin
 * WHICH PROCESSES CONTAIN THE CALL — which is a fact about source text, not about behaviour.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────────────────────
 *
 *  1. Exactly three call sites, one per host, each of which can dial SMTP.
 *  2. NOTHING under `apps/worker/src` mentions the pass — not the module, not the entry point. The
 *     worker keeps its cron ENTRY (it is the clock that pokes the API route), and that is a URL
 *     string, not a call.
 *  3. The deleted module and its entry point are gone from the tree entirely, so a stale import
 *     cannot resurrect a copy that cannot send.
 */

const REPO = existsSync("packages/services") ? "." : "../..";
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

/**
 * CODE ONLY — comments and string literals removed.
 *
 * Not optional, and the first version of this file proved it: several modules now DISCUSS the pass
 * in prose (`local-away.ts` and `AppShell.tsx` each explain, in a docblock, that
 * `runAwayResponderPass` is what made the standalone door possible; `pass-registry.test.ts`
 * records why `awayResponderPass` was deleted). A census matching raw text counted all of them as
 * call sites and this file went red for five callers where there are three.
 *
 * A census that cannot tell a call from a sentence about a call is the "prose that names a deleted
 * function keeps its row green" hole `pass-registry.test.ts` names from the other direction — there
 * it lets a stale row pass, here it invents callers. Same fix, and its own self-test below.
 */
function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  type Mode = "code" | "line" | "block" | "s" | "d" | "t";
  let mode: Mode = "code";
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && next === "*") { mode = "block"; i += 2; continue; }
      if (c === "'") { mode = "s"; i += 1; continue; }
      if (c === '"') { mode = "d"; i += 1; continue; }
      if (c === "`") { mode = "t"; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === "line") { if (c === "\n") { mode = "code"; out += "\n"; } i += 1; continue; }
    if (mode === "block") {
      if (c === "*" && next === "/") { mode = "code"; i += 2; continue; }
      i += 1; continue;
    }
    // Inside a string: honour escapes, and end at the matching quote.
    if (c === "\\") { i += 2; continue; }
    if ((mode === "s" && c === "'") || (mode === "d" && c === '"') || (mode === "t" && c === "`")) {
      mode = "code";
    }
    i += 1;
  }
  return out;
}

const mentionsInCode = (p: string, name: string): boolean => codeOnly(readFileSync(p, "utf8")).includes(name);

/**
 * Directories this walk never enters. All three are generated output rather than source, so
 * skipping them cannot hide a host from the sweep below — and `node_modules` is the one that
 * matters, for the reason in `sources`.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", ".next"]);

/**
 * Every `.ts` file under a directory, recursively.
 *
 * ── WHY IT SKIPS DIRECTORIES AND USES `lstat` ──────────────────────────────────────────────
 *
 * The first version walked everything with `statSync`, which FOLLOWS symlinks. Under pnpm the
 * workspace farm is symlinks pointing back up the tree —
 * an app's `node_modules/@ohmail/ui/node_modules/react` resolves into `node_modules/.pnpm` —
 * so the walk re-entered directories it had already visited and died about twenty levels down
 * with `ELOOP: too many symbolic links encountered`. That made this file red on every machine
 * where the workspaces had been installed, from the day it was added, and nobody read it: a
 * guard that always fails carries no information, so its failure looks like the weather.
 *
 * TWO independent repairs, on purpose. `lstat` never follows a link, so a symlink is a leaf here
 * whatever it points at and a cycle cannot be entered even through a path nobody thought to name;
 * and {@link SKIP_DIRS} keeps the walk off generated trees, which is where such links live. Either
 * one alone fixes today's ELOOP. Keeping both means the next unexpected symlink — a new package
 * manager layout, someone's local convenience link — cannot hang this test either.
 *
 * The absolute-path branch exists so the guard below can point this at a directory it built,
 * rather than asserting about a cycle it would have to create inside the repository to observe.
 */
function sources(dir: string): string[] {
  const abs = isAbsolute(dir) ? dir : join(REPO, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(p); continue; }
      if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
    }
  };
  walk(abs);
  return out;
}

/** The three hosts, as the ruling names them. */
const HOSTS: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: "packages/api/src/routes/internal.ts",
    why: "Cloud — GET /internal/away/run, poked every minute by the worker's api-cron",
  },
  {
    file: "apps/sidecar/src/engine.ts",
    why: "the standalone desktop — the drain, with this machine's own SMTP dial",
  },
  {
    file: "apps/server/src/clocks.ts",
    why: "self-host — the always-on send clock's tick",
  },
];

describe("the away responder's pass runs on exactly the three hosts that can dial SMTP", () => {
  for (const host of HOSTS) {
    it(`${host.file} calls it — ${host.why}`, () => {
      const src = read(host.file);
      expect(src).toContain("runAwayResponderPass");
    });
  }

  it("and nowhere else in the tree", () => {
    const callers = [
      ...sources("apps"), ...sources("packages"),
    ].filter((p) => !p.includes("node_modules") && !p.includes("/dist/") && !/\.test\.tsx?$/.test(p))
      .filter((p) => !p.endsWith("away-responder-pass.ts"))      // the definition itself
      .filter((p) => !p.endsWith("packages/services/src/index.ts"))   // the two barrels
      .filter((p) => !p.endsWith("packages/services/src/mail.ts"))
      .filter((p) => mentionsInCode(p, "runAwayResponderPass"))
      .map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));

    const expected = HOSTS.map((h) => h.file).sort();
    expect(callers.map((p) => p.slice(p.indexOf("apps/") >= 0 ? p.indexOf("apps/") : p.indexOf("packages/"))).sort())
      .toEqual(expected);
  });
});

describe("the worker no longer contains a responder it cannot deliver from", () => {
  it("no file under apps/worker/src calls the pass", () => {
    const offenders = sources("apps/worker/src")
      .filter((p) => mentionsInCode(p, "runAwayResponderPass"));
    expect(offenders).toEqual([]);
  });

  it("the deleted module and its entry point are gone from the whole tree", () => {
    expect(existsSync(join(REPO, "apps/worker/src/away-responder.ts"))).toBe(false);
    const survivors = [...sources("apps"), ...sources("packages")]
      .filter((p) => !p.includes("node_modules") && !p.includes("/dist/"))
      .filter((p) => !p.endsWith("away-responder-pass-hosts.test.ts"))   // this file names it to forbid it
      .filter((p) => mentionsInCode(p, "awayResponderPass"));
    expect(survivors).toEqual([]);
  });

  /**
   * The worker keeps ONE mention of the responder, and it is the right kind: a cron TARGET naming
   * the API route to poke. That is a URL and a schedule, not a pass — the distinction this whole
   * file is about. Asserted positively so that deleting the clock is red here too: a route with no
   * driver is the other half of "built, tested, unreachable".
   */
  it("but it DOES still hold the clock that pokes the API route", () => {
    const cron = read("apps/worker/src/api-cron.ts");
    expect(cron).toContain('target: "away_responder"');
    expect(cron).toContain('route: "/internal/away/run"');
  });

  it("and the API actually serves the path that clock names", () => {
    const internal = read("packages/api/src/routes/internal.ts");
    expect(internal).toContain('AWAY_RESPONDER_CRON_PATH = "/internal/away/run"');
    expect(internal).toContain("pattern: AWAY_RESPONDER_CRON_PATH");
  });
});

/**
 * THE STRIPPER IS NOT THE HOLE IT CLOSES — `pass-registry.test.ts`'s own discipline, applied here.
 *
 * A census whose reader is too eager invents callers (which is what sent the first version of this
 * file red); a census whose reader is too greedy hides them, which is far worse — it would let the
 * pass be called from the worker again and stay green. Both directions are checked.
 */
describe("the comment stripper", () => {
  it("removes line comments, block comments and docblocks", () => {
    expect(codeOnly("// runAwayResponderPass\nconst a = 1;")).not.toContain("runAwayResponderPass");
    expect(codeOnly("/* runAwayResponderPass */ const a = 1;")).not.toContain("runAwayResponderPass");
    expect(codeOnly("/**\n * runAwayResponderPass\n */\nconst a = 1;")).not.toContain("runAwayResponderPass");
  });

  it("removes string literals, so a name inside one is not a call", () => {
    expect(codeOnly('const s = "runAwayResponderPass";')).not.toContain("runAwayResponderPass");
    expect(codeOnly("const s = 'runAwayResponderPass';")).not.toContain("runAwayResponderPass");
    expect(codeOnly("const s = `runAwayResponderPass`;")).not.toContain("runAwayResponderPass");
  });

  it("KEEPS real code — the direction that would hide a caller", () => {
    expect(codeOnly("await runAwayResponderPass(db, deps);")).toContain("runAwayResponderPass");
    expect(codeOnly("import { runAwayResponderPass } from 'x';")).toContain("runAwayResponderPass");
    // Code AFTER a comment on the same line, and after a closed block comment.
    expect(codeOnly("// note\nrunAwayResponderPass();")).toContain("runAwayResponderPass");
    expect(codeOnly("/* note */ runAwayResponderPass();")).toContain("runAwayResponderPass");
  });

  it("is not fooled by an escaped quote inside a string", () => {
    // The `\\\"` must not be read as closing the string and re-entering code.
    expect(codeOnly('const s = "a \\" runAwayResponderPass";')).not.toContain("runAwayResponderPass");
  });

  it("does not treat a division or a regex-looking slash as a comment", () => {
    expect(codeOnly("const r = a / b; runAwayResponderPass();")).toContain("runAwayResponderPass");
  });
});

/**
 * THE HOSTED DOOR INJECTS THE ELIGIBILITY GATE NOW (mail 0124), AND THE TWO UNMETERED DOORS
 * STILL MUST NOT — this census has inverted twice, which is why it is assertions, not a comment.
 * `accountEligible` defaults to ELIGIBLE: correct on the self-host clock and the standalone
 * drain (no entitlements program, nobody parked), and the wall's known window on the hosted
 * path, where a parked account's responder kept sending mail in their name. The API route now
 * composes the gate from the entitlements port ABOVE the claim (`accountEligibleFrom`); the
 * behavioural half is `packages/api/test/pass-eligibility.test.ts`, watched red with the
 * composition removed. These cases pin which doors carry the composition at all.
 */
describe("the hosted door injects the eligibility gate; the unmetered doors do not", () => {
  it("the API route injects the gate (mail 0124 — removing it reopens the wall's window)", () => {
    const src = codeOnly(read("packages/api/src/routes/internal.ts"));
    const call = src.slice(src.indexOf("runAwayResponderPass("));
    const opts = call.slice(0, call.indexOf("});") + 3);
    expect(opts, "the hosted away clock lost its eligibility gate — a parked account's " +
      "responder would send again").toContain("accountEligible");
  });

  for (const [name, file] of [
    ["the self-host clock", "apps/server/src/clocks.ts"],
    ["the standalone drain", "apps/sidecar/src/engine.ts"],
  ] as const) {
    it(`${name} injects nothing — no program, nobody parked, and a gate here would be decoration`, () => {
      const src = codeOnly(read(file));
      const call = src.slice(src.indexOf("runAwayResponderPass("));
      const opts = call.slice(0, call.indexOf("});") + 3);
      expect(opts, `${file} grew an eligibility gate — nothing there can answer it`)
        .not.toContain("accountEligible");
    });
  }

  it("the standalone drain still narrows to its own runtime's mailbox", () => {
    // The other half of "answer only what you organize", and it never depended on metering.
    const src = codeOnly(read("apps/sidecar/src/engine.ts"));
    const call = src.slice(src.indexOf("runAwayResponderPass("));
    expect(call.slice(0, call.indexOf("});") + 3)).toContain("mailboxIds");
  });
});

describe("the pass ships in the desktop engine's own bundle", () => {
  /**
   * The standalone door's whole promise rests on this: `@trafficflow/services`' MAIL entry point is
   * what the sidecar imports, and a pass exported only from the cloud-facing barrel would not reach
   * that build. This is the "the module map publishes four subpaths and the responder is not among
   * them" trap the old worker copy actually had, checked from the other side.
   */
  it("is exported from the mail-half barrel, not only the default one", () => {
    expect(read("packages/services/src/mail.ts")).toContain("runAwayResponderPass");
    expect(read("packages/services/src/index.ts")).toContain("runAwayResponderPass");
  });

  it("and the sidecar reaches it through that mail entry point", () => {
    const engine = read("apps/sidecar/src/engine.ts");
    expect(engine).toMatch(/from\s+"@trafficflow\/services\/mail"/);
  });
});

/**
 * THE WALKER THIS FILE DEPENDS ON CANNOT BE HUNG BY A SYMLINK, AND CANNOT WANDER INTO BUILD OUTPUT.
 *
 * Every assertion above is a sweep over `sources("apps")` and `sources("packages")`, so if the walk
 * throws, all of them fail together and none of them is about the away responder. That is precisely
 * what happened: `statSync` followed pnpm's workspace links, the walk re-entered directories it had
 * already seen, and the file was red on any installed checkout from the day it landed — reported by
 * nobody, because a permanently red guard reads as background noise rather than as a finding.
 *
 * This builds the cycle rather than describing it. A repository is the wrong place to observe the
 * bug — the real one lives in `node_modules`, which is untracked, so it is present on a developer's
 * machine, absent in a clean checkout, and impossible to assert about either way.
 */
describe("sources() — the walk terminates, and stays on source", () => {
  const build = (): string => {
    const root = mkdtempSync(join(tmpdir(), "walker-"));
    writeFileSync(join(root, "real.ts"), "export const a = 1;\n");
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "nested", "deep.ts"), "export const b = 2;\n");

    // Generated trees, each holding a .ts the sweep must not pick up.
    for (const d of ["node_modules", "dist", ".next"]) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, "generated.ts"), "export const c = 3;\n");
    }

    // THE CYCLE: a directory symlink pointing at its own ancestor. Following it recurses for ever
    // — this is the shape pnpm's farm produces, reduced to two lines.
    symlinkSync(root, join(root, "nested", "loop"), "dir");
    // And the exact pnpm shape as well: a link that escapes upward out of node_modules.
    symlinkSync(join(root, "nested"), join(root, "node_modules", "escape"), "dir");
    return root;
  };

  it("does not hang or throw on a directory symlink pointing at its own ancestor", () => {
    const root = build();
    try {
      // Before the fix this threw ELOOP rather than returning; the assertion is that it RETURNS.
      const found = sources(root).map((p) => p.slice(root.length + 1)).sort();
      expect(found).toEqual(["nested/deep.ts", "real.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never descends into node_modules, dist or .next", () => {
    const root = build();
    try {
      const found = sources(root);
      for (const d of ["node_modules", "dist", ".next"]) {
        expect(found.some((p) => p.includes(`/${d}/`)), `walked into ${d}`).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is not vacuous: the same tree without the cycle yields the same two files", () => {
    // A walk that returned [] for any reason would pass both cases above. This pins the positive.
    const root = mkdtempSync(join(tmpdir(), "walker-plain-"));
    try {
      writeFileSync(join(root, "real.ts"), "export const a = 1;\n");
      mkdirSync(join(root, "nested"), { recursive: true });
      writeFileSync(join(root, "nested", "deep.ts"), "export const b = 2;\n");
      expect(sources(root).map((p) => p.slice(root.length + 1)).sort())
        .toEqual(["nested/deep.ts", "real.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still reaches the real tree it is used on — apps/ and packages/ are not empty", () => {
    // The skip list must not have swallowed the sweep's actual subject.
    expect(sources("packages").length).toBeGreaterThan(200);
    expect(sources("apps").length).toBeGreaterThan(50);
  });
});
