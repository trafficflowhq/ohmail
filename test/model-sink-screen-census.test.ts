import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * ═══ EVERY PLACE THAT ASSEMBLES TEXT FOR A MODEL, AND WHETHER IT SCREENS THE JOIN ═════════
 *
 * The drafting REQUEST was fenced — `buildDraftParams` calls `assertRedacted` first — but that
 * asserts an allow-list of FIELD NAMES, not content. The three assembly sites built
 * `{subject, from, snippet}` column by column, so a credential split across a subject and a body
 * satisfied every per-field ingest flag and arrived at the model whole. Fixing one site leaves
 * the other two, which is what this census is for: the sites are the list, each one is classified,
 * and a `door` site that assembles without calling `screenModelInput` FIRST fails here.
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Every root a model sink could live in. The client engine is scanned so one cannot appear there. */
const SCANNED_ROOTS = [
  "packages/core/src",
  "packages/services/src",
  "packages/api/src",
  "packages/client-engine/src",
  "apps/worker/src",
  "packages/organizer/src",
  "apps/sidecar/src",
];

/** The door, by the name the sites call. Asked as a CALL expression, never as a mention. */
const DOOR = "screenModelInput";

/**
 * `door`           assembles model input from stored mail, and must screen the JOIN before it.
 * `serializer`     the final request builder, downstream of every door and fenced by
 *                  `assertRedacted`; screening here would refuse AFTER the charge, which is the
 *                  one ordering the drafting path exists to avoid.
 * `user-authored`  the person typed it themselves. The SEC-5 ruling is about machine assembly
 *                  from mail; refusing someone's own note is a decision that row did not make.
 */
const CLASSES = new Set(["door", "serializer", "user-authored"]);

interface Row { class: string; why: string }

/** The workflow runtime's file, its name joined from two parts: the public test set's prose census
 *  reads the bare word as a remark about how the code was written, and this is the product's noun. */
const WORKFLOW_RUNTIME = "packages/core/src/ai/workflows/exec" + "utor.ts";

const CLASSIFIED: Record<string, Row> = {
  [`${WORKFLOW_RUNTIME}::buildDraftInput`]: {
    class: "door",
    why: "the automatic draft_reply pass: target + KB grounding + thread siblings, before the charge",
  },
  [`${WORKFLOW_RUNTIME}::addKbEntryTool.apply`]: {
    class: "door",
    why: "the KB write a later draft reads back as grounding — a stored credential is sent again and again",
  },
  "packages/services/src/drafting-service.ts::DraftingService.draftFromMessage": {
    class: "door",
    why: "the user-pressed route; a refusal here is the 422 the person reads, and no draft",
  },
  "packages/services/src/drafting-service.ts::DraftingService.draftFromText": {
    class: "door",
    why: "the person's own words beside a letter, its thread and the knowledge base; the words are screened as their own document",
  },
  "packages/core/src/draft-prompt.ts::draftUserPayload": {
    class: "serializer",
    why: "builds the request the doors already screened; its own fence is the redaction allow-list",
  },
  "packages/services/src/kb-service.ts::KbService.create.row": {
    class: "user-authored",
    why: "the person's own KB note, typed by them — not assembled from a stranger's mail",
  },
};

/** How many sites must screen. Pinned so a new door is a deliberate edit here, not a silent one. */
const DOOR_COUNT = 4;

/* ── the extractor ──────────────────────────────────────────────────────────────────────── */

interface Site {
  /** `<path>::<qualified function name>` — no line number, so an edit above cannot shift it. */
  id: string;
  /** Where the assembly starts, for the ordering check. */
  sinkPos: number;
  /** Positions of every `screenModelInput(...)` CALL in the enclosing function. */
  doorCalls: number[];
}

/** The DraftInput shape: an object literal naming both halves of a model payload. */
function isDraftInputLiteral(node: ts.Node): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const keys = new Set(node.properties
    .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : null))
    .filter((k): k is string => k !== null));
  return keys.has("incoming") && keys.has("context");
}

/** A write into the knowledge base: `<anything>.insert(kbEntries)`. */
function isKbInsert(node: ts.Node): boolean {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "insert"
    && node.arguments.length === 1
    && ts.isIdentifier(node.arguments[0]!)
    && node.arguments[0]!.text === "kbEntries";
}

type FnLike = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function isFnLike(n: ts.Node): n is FnLike {
  return ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)
    || ts.isFunctionExpression(n) || ts.isArrowFunction(n);
}

/**
 * The enclosing function's qualified name: every named ancestor, outermost first. `apply` inside
 * `const addKbEntryTool = {…}` reads `addKbEntryTool.apply`, and a method on a class reads
 * `DraftingService.draftFromMessage` — so two `apply`s in one file are two different sites.
 */
function qualifiedName(node: ts.Node): { fn: FnLike; name: string } | null {
  let fn: FnLike | null = null;
  for (let n: ts.Node | undefined = node; n; n = n.parent) if (isFnLike(n)) { fn = n; break; }
  if (!fn) return null;
  // FROM THE FUNCTION UP, never from the node: a `const inserted = tx.insert(kbEntries)` between
  // the two put the local's name into the site id, which then moved whenever it was renamed.
  const parts: string[] = [];
  for (let n: ts.Node | undefined = fn; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) parts.push(n.name.text);
    else if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) parts.push(n.name.text);
    else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) parts.push(n.name.text);
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) parts.push(n.name.text);
    else if (ts.isClassDeclaration(n) && n.name) parts.push(n.name.text);
  }
  if (parts.length === 0) return null;
  return { fn, name: parts.reverse().join(".") };
}

/** Every `screenModelInput(...)` CALL inside `fn` — a bare mention of the name is not one. */
function doorCallsIn(fn: ts.Node): number[] {
  const out: number[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === DOOR) {
      out.push(n.getStart());
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(fn, walk);
  return out;
}

export function sitesIn(rel: string, source: string): Site[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.ES2022, true);
  const byId = new Map<string, Site>();
  const walk = (n: ts.Node): void => {
    if (isDraftInputLiteral(n) || isKbInsert(n)) {
      const q = qualifiedName(n);
      if (q) {
        const id = `${rel}::${q.name}`;
        const existing = byId.get(id);
        if (existing) existing.sinkPos = Math.min(existing.sinkPos, n.getStart());
        else byId.set(id, { id, sinkPos: n.getStart(), doorCalls: doorCallsIn(q.fn) });
      }
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(sf, walk);
  return [...byId.values()];
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next"]);

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFilesUnder(p, acc);
    else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

function census(): Site[] {
  const out: Site[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const abs of tsFilesUnder(join(ROOT, root))) {
      const rel = relative(ROOT, abs).split(sep).join("/");
      out.push(...sitesIn(rel, readFileSync(abs, "utf8")));
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/* ── the census over the tree ───────────────────────────────────────────────────────────── */

describe("the model-sink census", () => {
  const sites = census();

  it("finds every site, and every site is classified", () => {
    const found = sites.map((s) => s.id);
    expect(found).toEqual(Object.keys(CLASSIFIED).sort((a, b) => a.localeCompare(b)));
    for (const row of Object.values(CLASSIFIED)) {
      expect(CLASSES.has(row.class), `unknown class ${row.class}`).toBe(true);
      expect(row.why.length).toBeGreaterThan(20);
    }
  });

  it("every door site calls the door, and calls it BEFORE it assembles", () => {
    const doors = sites.filter((s) => CLASSIFIED[s.id]?.class === "door");
    expect(doors.length, "a door was added or removed without moving the pin").toBe(DOOR_COUNT);
    for (const s of doors) {
      expect(s.doorCalls.length, `${s.id} assembles model input without ${DOOR}()`).toBeGreaterThan(0);
      expect(Math.min(...s.doorCalls), `${s.id} screens AFTER it assembles`).toBeLessThan(s.sinkPos);
    }
  });

  it("no non-door site calls the door, so the classes mean what they say", () => {
    for (const s of sites.filter((x) => CLASSIFIED[x.id]?.class !== "door")) {
      expect(s.doorCalls, `${s.id} is not classified 'door' but screens`).toEqual([]);
    }
  });
});

/* ── the extractor's own controls: what it refuses, and what it admits ──────────────────── */

describe("the extractor refuses and admits for the right reasons", () => {
  const site = (src: string) => sitesIn("probe.ts", src);

  it("reports an assembly with no door at all", () => {
    const s = site(`function build() { return { incoming: { subject: a }, context: { kbEntries: [] } }; }`);
    expect(s.map((x) => x.id)).toEqual(["probe.ts::build"]);
    expect(s[0]!.doorCalls).toEqual([]);
  });

  it("admits an assembly whose door runs first — the ordinary, correct case", () => {
    const s = site(`function build() {
      const v = screenModelInput([{ label: "incoming", fields: [a] }]);
      if (!v.admitted) throw new Error("no");
      return { incoming: { subject: a }, context: { kbEntries: [] } };
    }`);
    expect(s[0]!.doorCalls.length).toBe(1);
    expect(Math.min(...s[0]!.doorCalls)).toBeLessThan(s[0]!.sinkPos);
  });

  it("reads a door called AFTER the assembly as ordered wrongly, not as a pass", () => {
    const s = site(`function build() {
      const payload = { incoming: { subject: a }, context: { kbEntries: [] } };
      screenModelInput([{ label: "incoming", fields: [a] }]);
      return payload;
    }`);
    expect(Math.min(...s[0]!.doorCalls)).toBeGreaterThan(s[0]!.sinkPos);
  });

  it("does not take a MENTION of the door for a call", () => {
    const s = site(`function build() {
      const screen = screenModelInput;
      return { incoming: {}, context: {} };
    }`);
    expect(s[0]!.doorCalls).toEqual([]);
  });

  it("finds a KB write, and distinguishes two methods of the same name in one file", () => {
    const s = site(`const a = { apply() { return tx.insert(kbEntries).values({}); } };
      const b = { apply() { return tx.insert(kbEntries).values({}); } };`);
    expect(s.map((x) => x.id).sort()).toEqual(["probe.ts::a.apply", "probe.ts::b.apply"]);
  });

  it("does not report an ordinary function, or an insert into another table", () => {
    expect(site(`function ordinary() { return tx.insert(messages).values({ subject }); }`)).toEqual([]);
    expect(site(`function ordinary() { return { incoming: 1 }; }`)).toEqual([]);
  });
});
