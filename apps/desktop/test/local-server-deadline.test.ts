import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { BRIDGE_DEADLINE_MS, bridgeFetch } from "../src/bridge-fetch.js";
import { LOCAL_SERVER_CALL_DEADLINE_MS } from "../src/local-server-deadline.js";
import { PROBE_PATH } from "../src/local-first-run.js";

/**
 * EVERY CALL THAT MAY WAIT ON A SERVER ON THIS COMPUTER. The engine gives a loopback host up to
 * 150 s to answer a sign-in, plus the submission leg and the seal's launch wait, so every bridge
 * call to a route that probes rides a longer deadline; every other call keeps the one minute, and
 * an absent deadline is never forwarded (`withDeadline` refuses `{ ms: undefined }`).
 */

/* @reads: apps/sidecar/src/engine.ts
   The probing routes are derived from the engine's own handlers, by a path built at runtime. */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const host = globalThis as { __TAURI_INTERNALS__?: { invoke: Invoke } };

function encode(status: number, body = "{}"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

/** A shell whose engine answers after `ms` of (virtual) time. */
function slowShell(ms: number): void {
  host.__TAURI_INTERNALS__ = {
    invoke: () => new Promise((resolve) => setTimeout(() => resolve(encode(200)), ms)),
  };
}

afterEach(() => {
  vi.useRealTimers();
  delete host.__TAURI_INTERNALS__;
});

async function settleAfter(call: Promise<Response>, ms: number): Promise<string> {
  const verdict = call.then((r) => `answered ${r.status}`, (err: Error) => err.name);
  await vi.advanceTimersByTimeAsync(ms);
  return await Promise.race([verdict, Promise.resolve("still pending")]);
}

describe("bridgeFetch — a per-call deadline, forwarded only when present", () => {
  it("the probe, given the constant, survives an engine that answers at 200 s", async () => {
    vi.useFakeTimers();
    slowShell(200_000);
    const verdict = await settleAfter(bridgeFetch(PROBE_PATH, { method: "POST", deadlineMs: LOCAL_SERVER_CALL_DEADLINE_MS }), 200_001);
    expect(verdict).toBe("answered 200");
  });

  it("an ordinary call (/health) still gives up at the one minute", async () => {
    vi.useFakeTimers();
    slowShell(200_000);
    const call = bridgeFetch("/health");
    expect(await settleAfter(call, BRIDGE_DEADLINE_MS - 1)).toBe("still pending");
    expect(await settleAfter(call, 1)).toBe("BridgeDeadlineError");
  });

  it("`{ deadlineMs: undefined }` is never forwarded: the call is sent and keeps the one minute", async () => {
    vi.useFakeTimers();
    slowShell(30_000);
    expect(await settleAfter(bridgeFetch("/health", { deadlineMs: undefined }), 30_001)).toBe("answered 200");
    slowShell(200_000);
    const late = bridgeFetch("/health", { deadlineMs: undefined });
    expect(await settleAfter(late, BRIDGE_DEADLINE_MS)).toBe("BridgeDeadlineError");
  });

  it("the constant covers what it is derived from: 150 s sign-in, 20 s submission, 30 s launch wait", () => {
    expect(LOCAL_SERVER_CALL_DEADLINE_MS).toBeGreaterThan(150_000 + 20_000 + 30_000);
    expect(LOCAL_SERVER_CALL_DEADLINE_MS).toBe(240_000);
  });
});

/* ── the census: every bridge call to a route that probes, derived from both sides ──────────── */

const DESKTOP_SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const ENGINE = fileURLToPath(new URL("../../sidecar/src/engine.ts", import.meta.url));

interface Route { method: string; pattern: string }
interface Call { at: string; method: string | null; path: string | null; deadline: string | null }

function sources(dir: string, into: { file: string; code: string }[] = []): { file: string; code: string }[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, into);
    else if ([".ts", ".tsx"].includes(extname(name)) && !/\.test\.tsx?$/.test(name)) {
      into.push({ file: relative(DESKTOP_SRC, p), code: readFileSync(p, "utf8") });
    }
  }
  return into;
}

const parse = (file: string, code: string): ts.SourceFile => ts.createSourceFile(
  file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
);
const walk = (n: ts.Node, f: (n: ts.Node) => void): void => { f(n); ts.forEachChild(n, (c) => walk(c, f)); };

/** The engine's `local*Match` routes whose handler builds a probe, and probes built anywhere else. */
function probingRoutes(code: string): { routes: Route[]; elsewhere: string[] } {
  const sf = parse("engine.ts", code);
  const declared = new Map<string, Route>();
  const handlers: Array<{ name: string; node: ts.Node }> = [];
  const probes: ts.Node[] = [];
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^local\w*Match$/.test(n.name.text) && n.initializer) {
      const text = n.initializer.getText(sf);
      const method = /req\.method === "(\w+)"/.exec(text)?.[1];
      const literal = /url\.pathname === "([^"]+)"/.exec(text)?.[1];
      const regex = /\/\^(.*)\$\/\.exec\(url\.pathname\)/.exec(text)?.[1];
      const pattern = literal ?? (regex ? regex.replace(/\\\//g, "/").replace(/\([^)]*\)/g, ":id") : undefined);
      if (method && pattern) declared.set(n.name.text, { method, pattern });
    }
    if (ts.isIfStatement(n)) {
      const c = n.expression;
      const id = ts.isIdentifier(c) ? c.text : ts.isBinaryExpression(c) && ts.isIdentifier(c.left) ? c.left.text : null;
      if (id && /^local\w*Match$/.test(id)) handlers.push({ name: id, node: n.thenStatement });
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
      && (n.expression.text === "makeImapProbe" || n.expression.text === "makeSmtpProbe")) probes.push(n);
  });
  const inside = (x: ts.Node, h: ts.Node): boolean => x.getStart(sf) >= h.getStart(sf) && x.end <= h.end;
  const routes: Route[] = [];
  for (const h of handlers) {
    const r = declared.get(h.name);
    if (r && probes.some((p) => inside(p, h.node)) && !routes.some((x) => x.method === r.method && x.pattern === r.pattern)) routes.push(r);
  }
  const elsewhere = probes.filter((p) => !handlers.some((h) => inside(p, h.node))).map((p) => memberOf(p, sf));
  return { routes, elsewhere: [...new Set(elsewhere)].sort() };
}

const isFn = (n: ts.Node | undefined): n is ts.FunctionLikeDeclaration => n !== undefined
  && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n));

/** The name a node is written under: the property, method or function that holds it. */
function memberOf(n: ts.Node, sf: ts.SourceFile): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name) return p.name.getText(sf);
    if (ts.isVariableDeclaration(p) && isFn(p.initializer)) return p.name.getText(sf);
  }
  return "<module>";
}

/**
 * An identifier's path: a `const` in an enclosing function, else a module-level one; null for a
 * parameter, which only a caller knows.
 */
function identPath(id: ts.Identifier, names: Map<string, string | null>): string | null {
  for (let f: ts.Node | undefined = id.parent; f; f = f.parent) {
    if (!isFn(f)) continue;
    if (f.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === id.text)) return null;
    let found: ts.Expression | null = null;
    if (f.body) walk(f.body, (n) => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === id.text && n.initializer) found = n.initializer; });
    if (found) return pathOf(found, names);
  }
  return names.get(id.text) ?? null;
}

/** A path expression as text, `:x` for every part only known at run time; null when not a path. */
function pathOf(e: ts.Expression, names: Map<string, string | null>): string | null {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isIdentifier(e)) return identPath(e, names);
  if (ts.isTemplateExpression(e)) {
    return e.head.text + e.templateSpans.map((s) => (ts.isIdentifier(s.expression)
      ? identPath(s.expression, names) ?? ":x" : ":x") + s.literal.text).join("");
  }
  return null;
}

/** Every `bridgeFetch(…)` in the desktop source: its method, its path pattern, its deadline. */
function bridgeCalls(files: { file: string; code: string }[]): Call[] {
  const trees = files.map((f) => ({ file: f.file, sf: parse(f.file, f.code) }));
  /* Module-level path constants across the tree, by name; a name two modules spell differently is
     null, so a call naming it is unread rather than read as either. */
  const names = new Map<string, string | null>();
  const fns = new Map<string, string>();
  for (let pass = 0; pass < 3; pass++) {
    for (const { sf } of trees) {
      for (const st of sf.statements) {
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (!ts.isIdentifier(d.name) || !d.initializer) continue;
            const v = pathOf(d.initializer, names);
            if (v === null || !v.startsWith("/")) continue;
            const had = names.get(d.name.text);
            names.set(d.name.text, had === undefined || had === v ? v : null);
          }
        }
        if (ts.isFunctionDeclaration(st) && st.name && st.body?.statements.length === 1) {
          const only = st.body.statements[0]!;
          const v = ts.isReturnStatement(only) && only.expression ? pathOf(only.expression, names) : null;
          if (v !== null && v.startsWith("/")) fns.set(st.name.text, v);
        }
      }
    }
  }
  const out: Call[] = [];
  for (const { file, sf } of trees) {
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== "bridgeFetch") return;
      const [target, init] = n.arguments;
      let path = target ? pathOf(target, names) : null;
      if (path === null && target && ts.isCallExpression(target) && ts.isIdentifier(target.expression)) {
        path = fns.get(target.expression.text) ?? null;
      }
      let method: string | null = "GET";
      let deadline: string | null = null;
      if (init !== undefined) {
        if (!ts.isObjectLiteralExpression(init)) method = null;
        else {
          for (const p of init.properties) {
            const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
            if (key === "method") method = ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer) ? p.initializer.text : null;
            if (key === "deadlineMs") deadline = ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : "(shorthand)";
          }
        }
      }
      out.push({ at: `${file} ${memberOf(n, sf)}`, method, path: path === null ? null : path.split("?")[0]!, deadline });
    });
  }
  return out;
}

const segments = (p: string): string[] => p.split("/");
const reaches = (r: Route, c: Call): boolean => c.method === r.method && c.path !== null
  && segments(r.pattern).length === segments(c.path).length
  && segments(r.pattern).every((s, i) => s === segments(c.path!)[i] || s.startsWith(":") || segments(c.path!)[i]!.startsWith(":"));

/** The bridge calls whose target a reading cannot know, each with what it reaches instead. */
const UNRESOLVED: Readonly<Record<string, string>> = {
  "cloud-suggest.ts ask": "the Cloud suggest door's helper: its two callers name the Screener page and the suggest buy, neither a probe",
  "main.tsx post": "the network-return relay's poster: it posts the one retry path (`network-return.ts`), which re-dials and probes nothing",
};

/** Probes the engine builds outside a `/local/*` route handler — none a bridge call can reach. */
const ELSEWHERE: Readonly<Record<string, string>> = {
  probeSubmission: "the phone's settings check of an outgoing server, a method of the engine object, not a route",
};

/** The verdicts: a probing call without the constant, a deadline on a call that does not probe. */
function wrong(routes: Route[], calls: Call[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    if (c.path === null || c.method === null) {
      if (!(c.at in UNRESOLVED)) out.push(`${c.at}: a target this census cannot read — name it in UNRESOLVED or make it readable`);
      if (c.deadline !== null) out.push(`${c.at}: an unreadable call passes ${c.deadline}`);
      continue;
    }
    const probing = routes.some((r) => reaches(r, c));
    if (probing && c.deadline !== "LOCAL_SERVER_CALL_DEADLINE_MS") out.push(`${c.at}: ${c.method} ${c.path} probes and passes ${c.deadline ?? "no deadline"}`);
    if (!probing && c.deadline !== null) out.push(`${c.at}: ${c.method} ${c.path} does not probe and passes ${c.deadline}`);
  }
  return out;
}

describe("the census — every bridge call to a route that probes rides the local deadline", () => {
  const engine = probingRoutes(readFileSync(ENGINE, "utf8"));
  const files = sources(DESKTOP_SRC);
  const calls = bridgeCalls(files);

  it("the probing routes are read off the engine's own handlers, and the three known ones are among them", () => {
    expect(engine.routes).toEqual(expect.arrayContaining([
      { method: "POST", pattern: "/local/mailboxes/probe" },
      { method: "POST", pattern: "/local/mailboxes" },
      { method: "PATCH", pattern: "/local/mailboxes/:id" },
    ]));
    expect(engine.elsewhere, "a probe built outside a /local route is named, or it is a route this census misses").toEqual(Object.keys(ELSEWHERE).sort());
  });

  it("every probing call passes the constant, and nothing else passes any deadline", () => {
    expect(calls.length, "the reading found almost nothing").toBeGreaterThan(40);
    expect(calls.filter((c) => engine.routes.some((r) => reaches(r, c))).length).toBeGreaterThanOrEqual(4);
    expect(wrong(engine.routes, calls)).toEqual([]);
    const unread = calls.filter((c) => c.path === null || c.method === null).map((c) => c.at).sort();
    expect([...new Set(unread)], "UNRESOLVED names a call that is gone, or misses one").toEqual(Object.keys(UNRESOLVED).sort());
  });

  it("RED: Sign in again's old form — the seal with no deadline — is named", () => {
    const planted = files.map((f) => {
      if (f.file !== "DesktopMailboxes.tsx") return f;
      expect(f.code.split("deadlineMs: LOCAL_SERVER_CALL_DEADLINE_MS,").length - 1, "the seal's deadline line").toBe(1);
      return { ...f, code: f.code.replace("deadlineMs: LOCAL_SERVER_CALL_DEADLINE_MS,", "") };
    });
    expect(wrong(engine.routes, bridgeCalls(planted))).toEqual([
      "DesktopMailboxes.tsx seal: PATCH /local/mailboxes/:x probes and passes no deadline",
    ]);
  });

  it("RED: a route the engine starts probing on is followed, and so is the call to it", () => {
    const planted = probingRoutes([
      'const localZapMatch = req.method === "POST" && url.pathname === "/local/zap";',
      "if (localZapMatch) { makeImapProbe(deps, probeOpts); }",
    ].join("\n"));
    expect(planted.routes).toEqual([{ method: "POST", pattern: "/local/zap" }]);
    const call = bridgeCalls([{ file: "zap.ts", code: 'export const zap = () => bridgeFetch("/local/zap", { method: "POST" });' }]);
    expect(wrong(planted.routes, call)).toEqual(["zap.ts zap: POST /local/zap probes and passes no deadline"]);
  });

  it("reads a deadline in every spelling: the constant, a literal, a shorthand (positive control)", () => {
    const read = bridgeCalls([{ file: "x.ts", code: [
      'const P = "/x"; export async function a() { await bridgeFetch(P, { deadlineMs: LOCAL_SERVER_CALL_DEADLINE_MS }); }',
      'export async function b() { await bridgeFetch("/health", { deadlineMs: 300_000 }); }',
      'export async function c() { await bridgeFetch(`/y/${id}`, { method: "PATCH", deadlineMs }); }',
    ].join("\n") }]);
    expect(read).toEqual([
      { at: "x.ts a", method: "GET", path: "/x", deadline: "LOCAL_SERVER_CALL_DEADLINE_MS" },
      { at: "x.ts b", method: "GET", path: "/health", deadline: "300_000" },
      { at: "x.ts c", method: "PATCH", path: "/y/:x", deadline: "(shorthand)" },
    ]);
  });
});
