import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { bracketSpan, lineOf, withoutComments, withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";

/**
 * EVERY DIAL OF A STORED MAIL SERVER, ON THE API HOST AND ON THE WORKER, TAKES ITS ADDRESS FROM THE
 * DIAL DOOR: the API's `dialFieldsFor`, the organizer's `checkedDial`. A site is every call that
 * opens a socket, whatever its argument: an adapter or submission constructor, or a `net`/`tls`
 * opener under any name the file imports it by. It is guarded only where a door's product, inline
 * or bound in the same file, reaches the socket. Parsed on blanked source, so a comment is not a
 * site. The walk skips the person's own engines and `packages/core/src` (the primitives); the last
 * describe asks whether those engines reach the managed decision.
 *
 * @reads: packages/api/src packages/services/src apps/server/src apps/api-vercel/src apps/worker/src apps/sidecar/src apps/mobile/src packages/client-engine/src packages/core/src
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const API_HOST = ["packages/api/src", "packages/services/src", "apps/server/src", "apps/api-vercel/src"];
const WORKER = ["apps/worker/src"];

const DOOR_BINDING = /\b([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:dialFieldsFor|checkedDial)\s*\(/g;
const DIAL_CALL = /\b(new\s+ImapAdapter|newAdapter|makeAdapter|new\s+ImapFlow|verifySmtpLogin|createTransport|new\s+SMTPConnection)\s*\(/g;
/** Node's socket openers, by module. */
const OPENERS: Record<string, readonly string[]> = { net: ["connect", "createConnection"], tls: ["connect"] };
const NAME = String.raw`[A-Za-z_$][\w$]*`;
const esc = (s: string): string => s.replace(/\$/g, "\\$");
/**
 * A FORWARD is no dial: an arrow bound to a factory name the census counts, handing its own first
 * parameter straight to the constructor. Every call of that name is a site, so the config is
 * counted where its caller writes it. Any other argument, binding or body is a site.
 */
const FORWARD = new RegExp(String.raw`\b(?:makeAdapter|newAdapter)\s*(?::[^;{}=]*(?:=>[^;{}=]*)*)?=\s*` +
  String.raw`(?:[\w$.?]+\s*(?:\?\?|\|\|)\s*)?\(?\s*\(\s*(${NAME})\s*(?::[^,()]*)?(?:,[^()]*)?\)\s*(?::\s*[\w$.]+\s*)?=>\s*$`);

/** Sockets these roots open that are not a stored credential's dial, each with its reason. */
const NOT_A_STORED_DIAL: Record<string, string> = {
  "packages/api/src/imap-probe.ts":
    "the add-time and re-entry probes dial a TYPED credential, cleared by `checked(probeHostGuardFor(deps))` under the same port rule and pinned through `pinFrom`",
  "packages/services/src/mail/smtp-mailer.ts":
    "the operator's own transactional relay, configured from the environment: no mailbox credential",
};

type Site = { file: string; line: number; kind: "adapter" | "submission" | "socket"; guarded: boolean };

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (/\.(?:ts|mts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The top-level comma-separated parts of an argument list or an object body, on blanked text. */
function parts(span: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < span.length; i++) {
    const c = span[i]!;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) { out.push(span.slice(from, i)); from = i + 1; }
  }
  out.push(span.slice(from));
  return out.map((p) => p.trim()).filter((p) => p !== "");
}

/** Parentheses that wrap the whole expression, removed. */
function unwrap(e: string): string {
  let x = e.trim();
  while (x.startsWith("(")) {
    const s = bracketSpan(x, 0);
    if (!s.closed || s.end !== x.length - 1) break;
    x = x.slice(1, -1).trim();
  }
  return x;
}

/** The door's product itself: an awaited door call with nothing after it, or a name bound from one. */
function isDoorProduct(e: string, bound: ReadonlySet<string>): boolean {
  const call = /^await\s+(?:dialFieldsFor|checkedDial)\s*\(/.exec(e);
  if (call === null) return bound.has(e);
  const s = bracketSpan(e, call[0].length - 1);
  return s.closed && e.slice(s.end + 1).trim() === "";
}

const objectBody = (p: string): string | null => {
  if (!p.startsWith("{")) return null;
  const s = bracketSpan(p, 0, "{", "}");
  return s.closed && s.end === p.length - 1 ? p.slice(1, -1) : null;
};
const keyOf = (p: string): string => /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(p)?.[1] ?? "";
const SETS_PIN = /(?<![.\w$])(?:pin|allowInsecure)\s*(?::|,|\}|$)/m;

/** The product reaches the socket when the LAST top-level door spread is not set again after it. */
function reaches(body: string, bound: ReadonlySet<string>): boolean {
  const ps = parts(body);
  const last = ps.map((p) => p.startsWith("...") && isDoorProduct(unwrap(p.slice(3)), bound)).lastIndexOf(true);
  return last >= 0 && !ps.slice(last + 1)
    .some((p) => (p.startsWith("...") ? SETS_PIN.test(p) : ["pin", "allowInsecure"].includes(keyOf(p))));
}

/** An adapter or submission config, and an `smtp` leg written inside it, each reach the socket. */
function configReaches(args: string, bound: ReadonlySet<string>): boolean {
  const body = objectBody(parts(args)[0] ?? "");
  if (body === null || !reaches(body, bound)) return false;
  const smtp = parts(body).find((p) => keyOf(p) === "smtp");
  if (smtp === undefined) return true;
  const leg = objectBody(smtp.slice(smtp.indexOf(":") + 1).trim());
  return leg !== null && reaches(leg, bound);
}

/** `<door product>.pin…`: the address the door cleared. */
function readsThePin(e: string, bound: ReadonlySet<string>): boolean {
  let depth = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e[i]!;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth === 0 && /^\??\.\s*pin\b/.test(e.slice(i))) return isDoorProduct(unwrap(e.slice(0, i)), bound);
  }
  return false;
}

/** A raw socket knows no `pin` option: it is guarded only when the host it dials is the door's pin. */
function socketReaches(args: string, bound: ReadonlySet<string>): boolean {
  const ps = parts(args);
  const body = objectBody(ps[0] ?? "");
  const host = body === null ? ps[1] : parts(body).find((p) => keyOf(p) === "host")?.replace(/^host\s*:/, "");
  return host !== undefined && readsThePin(host.trim(), bound);
}

/** A file's names for the openers, read from its imports and requires: module objects, and bare functions. */
function socketNames(code: string): { spaces: Map<string, string>; bare: Set<string> } {
  const spaces = new Map([["net", "net"], ["tls", "tls"]]);
  const bare = new Set<string>();
  const MOD = String.raw`\s*["'](?:node:)?(net|tls)["']`;
  const addBare = (list: string, mod: string, sep: RegExp): void => {
    for (const part of list.split(",").map((p) => p.trim())) {
      const [imported, local] = part.split(sep);
      if (!/^type\s/.test(part) && OPENERS[mod]!.includes(imported!)) bare.add(local ?? imported!);
    }
  };
  for (const m of code.matchAll(new RegExp(String.raw`\bimport\s+(?!type\b)(?:(${NAME})\s*,?\s*)?(?:\*\s*as\s+(${NAME})|\{([^}]*)\})?\s*from${MOD}`, "g"))) {
    for (const ns of [m[1], m[2]]) if (ns) spaces.set(ns, m[4]!);
    if (m[3]) addBare(m[3], m[4]!, /\s+as\s+/);
  }
  for (const m of code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(?:(${NAME})|\{([^}]*)\})\s*=\s*(?:await\s+)?(?:require|import)\s*\(${MOD}\s*\)`, "g"))) {
    if (m[1]) spaces.set(m[1], m[3]!);
    if (m[2]) addBare(m[2], m[3]!, /\s*:\s*/);
  }
  return { spaces, bare };
}

/** Where each opener call starts and where its argument list opens, on blanked source. */
function socketCalls(blanked: string, names: ReturnType<typeof socketNames>): Array<{ at: number; open: number }> {
  const out: Array<{ at: number; open: number }> = [];
  const spaces = [...names.spaces.keys()].map(esc).join("|");
  for (const m of blanked.matchAll(new RegExp(String.raw`(?<![\w$])(${spaces})\s*\.\s*(${NAME})\s*\(`, "g"))) {
    if (OPENERS[names.spaces.get(m[1]!)!]!.includes(m[2]!)) out.push({ at: m.index!, open: m.index! + m[0].length - 1 });
  }
  if (names.bare.size === 0) return out;
  for (const m of blanked.matchAll(new RegExp(String.raw`(?<!\.\s*)(?<![\w$])(${[...names.bare].map(esc).join("|")})\s*\(`, "g"))) {
    out.push({ at: m.index!, open: m.index! + m[0].length - 1 });
  }
  return out;
}

function isForward(blanked: string, at: number, span: string): boolean {
  const m = FORWARD.exec(blanked.slice(Math.max(0, at - 400), at));
  return m !== null && new RegExp(String.raw`^\s*${esc(m[1]!)}\s*(?:,|$)`).test(span);
}

export function dialSites(root: string, roots: readonly string[]): Site[] {
  const out: Site[] = [];
  for (const r of roots) {
    for (const path of filesUnder(join(root, r))) {
      const raw = readFileSync(path, "utf8");
      const blanked = withoutCommentsAndLiterals(raw);
      const bound = new Set([...blanked.matchAll(DOOR_BINDING)].map((m) => m[1]!));
      const file = path.slice(root.length + (root.endsWith("/") ? 0 : 1));
      const argOf = (open: number): string => { const s = bracketSpan(blanked, open); return blanked.slice(s.start, s.end); };
      for (const m of blanked.matchAll(DIAL_CALL)) {
        const span = argOf(m.index! + m[0].length - 1);
        if (isForward(blanked, m.index!, span)) continue;
        const kind = /^(?:verifySmtpLogin|createTransport|new\s+SMTPConnection)/.test(m[1]!) ? "submission" : "adapter";
        out.push({ file, line: lineOf(raw, m.index!), kind, guarded: configReaches(span, bound) });
      }
      for (const c of socketCalls(blanked, socketNames(withoutComments(raw)))) {
        out.push({ file, line: lineOf(raw, c.at), kind: "socket", guarded: socketReaches(argOf(c.open), bound) });
      }
    }
  }
  return out;
}

const named = (s: Site): boolean => Object.hasOwn(NOT_A_STORED_DIAL, s.file);

/** Calls that SEND mail, on blanked source: an adapter's `send(` and nodemailer's `sendMail(`. */
export function sendSites(root: string, roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    for (const path of filesUnder(join(root, r))) {
      const raw = readFileSync(path, "utf8");
      const blanked = withoutCommentsAndLiterals(raw);
      for (const m of blanked.matchAll(/\.\s*send\s*\(|\bsendMail\s*\(/g)) {
        out.push(`${path.slice(root.length + (root.endsWith("/") ? 0 : 1))}:${lineOf(raw, m.index!)}`);
      }
    }
  }
  return out;
}

describe("every stored-credential dial on the API host and the worker goes through the dial door", () => {
  it("measures both hosts, each with sites of both forms", () => {
    for (const [host, roots] of [["API host", API_HOST], ["worker", WORKER]] as const) {
      const sites = dialSites(REPO, roots).filter((s) => !named(s));
      expect(sites.some((s) => s.kind === "adapter"), `${host}: the adapter parse found nothing`).toBe(true);
      expect(sites.some((s) => s.kind === "submission"), `${host}: the submission parse found nothing`).toBe(true);
    }
  });

  it("no site dials a stored server outside the door", () => {
    const outside = dialSites(REPO, [...API_HOST, ...WORKER])
      .filter((s) => !named(s) && !s.guarded).map((s) => `${s.file}:${s.line} ${s.kind}`);
    expect(outside, "these dial a stored mail server with no host guard, pin or port rule").toEqual([]);
  });

  it("every named exception still opens a socket, or it is stale", () => {
    const files = new Set(dialSites(REPO, API_HOST).map((s) => s.file));
    for (const file of Object.keys(NOT_A_STORED_DIAL)) expect(files.has(file), `${file} opens no socket now`).toBe(true);
  });

  /**
   * THE PREMISE THE ATTACH RESTS ON: the organizer never sends, so it builds no submission leg and
   * a sending server's host or port can never stop receiving. A send added to the worker reddens
   * here by name, and the attach's submission leg is a question again.
   */
  it("the organizer sends nothing, which is why its attach builds no submission leg", () => {
    expect(sendSites(REPO, WORKER), "the worker now sends mail: give its attach a guarded submission leg").toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "ohmail-worker-send-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), [
        "// adapter.send(msg) in a comment is not a send",
        "const said = \"adapter.send(msg)\";",
        "await runtime.adapter.send(msg);",
        "await transporter.sendMail(opts);",
      ].join("\n"));
      expect(sendSites(dir, ["src"]), "a planted send must be named, and a commented or quoted one must not")
        .toEqual(["src/a.ts:3", "src/a.ts:4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a dial planted outside the door, in every shape, and admits the guarded ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-every-dial-"));
    try {
      mkdirSync(join(dir, "src", "nested"), { recursive: true });
      writeFileSync(join(dir, "src", "good.ts"), [
        "const a = makeAdapter({ host: h, port: 993, ...(await checkedDial(g, h, \"imap\", leg)), auth: c });",
        "const dial = await dialFieldsFor(deps, leg, \"imap\");",
        "const b = new ImapAdapter({ host: h, port: 993, ...dial, auth: c });",
        "const sd = await dialFieldsFor(deps, s, \"smtp\");",
        "const c2 = newAdapter({ host: h, ...dial, auth: c, smtp: { ...cfg, ...sd } });",
        "const d = verifySmtpLogin({ ...s, ...(await dialFieldsFor(deps, s, \"smtp\")) }, T);",
        "const e2 = new ImapAdapter({ host, ...dial, auth });",
        "const v2 = tls.connect({ host: dial.pin[0], port: 993, servername: s.host });",
        "import { connect as rawDial } from \"node:net\"; rawDial(993, (await checkedDial(g, row.host, 993, \"imap\")).pin[0]);",
        "const w2 = new ImapAdapter({ host: h, port: 993, ...creds, ...dial });",
        "const makeAdapter = deps.adapterFactory ?? ((c) => new ImapAdapter(c));",
        "import { isIP as ipKind } from \"node:net\"; ipKind(h);",
      ].join("\n"));
      writeFileSync(join(dir, "src", "nested", "bad.ts"), [
        "// new ImapAdapter({ host: h, auth: c }) in a comment is not a site",
        "const e = new ImapAdapter({ host: h, port: 993, secure: true, auth: c });",
        "const f = verifySmtpLogin(smtp, T);",
        "const t = createTransport({ host: s.host, port: 587, auth: a });",
        "const u = new ImapAdapter({ host, port, secure, auth });",
        "const v = tls.connect({host: s.host, port: 993});",
        "import { connect as dial } from \"node:net\"; dial(993, row.host);",
        "const w = new ImapAdapter({host: h, port: 993, ...creds});",
        "const open = (c) => new ImapAdapter(c);",
        "import * as sock from \"node:tls\"; sock.connect({ ...row, port: 993 });",
        "const said = \"tls.connect({ host: h }) and dial(993, h)\"; // net.connect(993, h) and dial(993, h)",
        "const makeAdapter = (c) => new ImapAdapter({ ...c, host: row.host });",
        "const { connect: open2 } = await import(\"node:tls\"); open2({ host: row.host, port: 993 });",
        "const netMod = require(\"node:net\"); netMod.connect(993, row.host);",
        "net.createConnection(993, row.host);",
        "const g = new ImapFlow({ host: h, port: 993, auth: a });",
        "const k = new SMTPConnection({ host: s.host, port: 587 });",
      ].join("\n"));
      writeFileSync(join(dir, "src", "half.ts"), [
        "const dial = await dialFieldsFor(deps, leg, \"imap\");",
        "const x = newAdapter({ host: h, ...dial, auth: c, smtp: { ...cfg } });",
      ].join("\n"));
      // The product seen but not reaching the socket, each beside a twin where it does.
      writeFileSync(join(dir, "src", "override.ts"), [
        "const dial = await dialFieldsFor(deps, leg, \"imap\");",
        "const o1 = new ImapAdapter({ host: h, ...dial, pin: undefined, auth: c });",
        "const o2 = new ImapAdapter({ host: h, ...dial, allowInsecure: true, auth: c });",
        "const o3 = new ImapAdapter({ host: h, ...dial, ...(fresh ? { pin: other } : {}), auth: c });",
        "const o4 = new ImapAdapter({ host: h, ...(dial && {}), auth: c });",
        "const o5 = new ImapAdapter({ host: h, auth: c, extra: await checkedDial(g, h, 993, \"imap\") });",
        "const o6 = tls.connect({ host: h, port: 993, ...dial });",
        "const o7 = newAdapter({ host: h, ...dial, auth: c, smtp: { ...dial, pin: undefined } });",
        "const o8 = new ImapAdapter({ host: h, pin: stale, ...dial, auth: c });",
        "const o9 = new ImapAdapter({ host: h, ...dial, ...(slow ? { timeouts: t } : {}), auth: c });",
        "const o10 = tls.connect({ host: cached.pin[0], port: 993 });",
        "const o11 = new ImapAdapter({ host: h, ...(await checkedDial(g, h, 993, \"imap\") && {}), auth: c });",
      ].join("\n"));
      const found = dialSites(dir, ["src"]);
      // Soft, so one run prints both lists: the admitted twins and the refused shapes.
      expect.soft(found.filter((s) => s.guarded).map((s) => `${s.file}:${s.line}`).sort(),
        "the guarded siblings must be seen and admitted, or the refusal below proves nothing")
        .toEqual(["src/good.ts:1", "src/good.ts:3", "src/good.ts:5", "src/good.ts:6", "src/good.ts:7", "src/good.ts:8",
          "src/good.ts:9", "src/good.ts:10", "src/override.ts:9", "src/override.ts:10"].sort());
      expect.soft(found.filter((s) => !s.guarded).map((s) => `${s.file}:${s.line} ${s.kind}`).sort())
        .toEqual(["src/half.ts:2 adapter",
          "src/nested/bad.ts:2 adapter", "src/nested/bad.ts:3 submission", "src/nested/bad.ts:4 submission",
          "src/nested/bad.ts:5 adapter", "src/nested/bad.ts:6 socket", "src/nested/bad.ts:7 socket", "src/nested/bad.ts:8 adapter",
          "src/nested/bad.ts:9 adapter", "src/nested/bad.ts:10 socket", "src/nested/bad.ts:12 adapter", "src/nested/bad.ts:13 socket",
          "src/nested/bad.ts:14 socket", "src/nested/bad.ts:15 socket", "src/nested/bad.ts:16 adapter", "src/nested/bad.ts:17 submission",
          "src/override.ts:2 adapter", "src/override.ts:3 adapter", "src/override.ts:4 adapter", "src/override.ts:5 adapter",
          "src/override.ts:6 adapter", "src/override.ts:7 socket", "src/override.ts:8 adapter", "src/override.ts:11 socket",
          "src/override.ts:12 adapter"].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * NO STRUCTURED LOG LINE NAMES A MAIL SERVER. `host` is an allowed log field with no grammar on its
 * value, so this holds it: in these roots a `host` key reaches a log call, a logger's bindings or the
 * AI usage line only where its file and the parsed shape of its value are both admitted.
 */
/** The organizer's primitives and the desktop engine log through the same logger as the hosts. */
const LOG_ROOTS = [...API_HOST, ...WORKER, "packages/core/src", "apps/sidecar/src"];
const LOG_CALL = /(?:\.\s*(?:debug|info|warn|error|child|log)|(?<![\w$.])(?:log|[A-Za-z_$][\w$]*Log|createLogger|aiUsageLineOf))\s*(?:\?\.\s*)?\(/g;
const HOST_FIELD_ADMITTED: Record<string, (value: string, src: string) => boolean> = {
  // The API's own base URL, which the cron pokes: the operator's server, never a mailbox's.
  "apps/worker/src/api-cron.ts": (v) => /^new\s+URL\(\s*[A-Za-z_$][\w$]*\s*\)\.host$/.test(v),
  // The process role on the worker's AI usage line.
  "apps/worker/src/ai-usage-line.ts": (v) => v === "\"worker\"",
  // The same role handed in by the composition root: shorthand, typed by the closed `AiUsageHost` union.
  "packages/services/src/ai-usage-lines.ts": (v, src) => v === "host" && /\bhost:\s*AiUsageHost\b/.test(src),
  // The self-hosted server's trusted-proxy notes: a name the operator put in TF_TRUSTED_PROXIES, or the
  // socket peer that forwarded. The operator's own network or a visitor, never a mailbox's server.
  "apps/server/src/index.ts": (v, src) => (v === "n.name" || v === "n.peer") && /\bmakeTrustedProxies\(/.test(src),
};

/** A key's value: `host` itself when written in shorthand, else the text to the end of its part. */
function valueAt(keep: string, blank: string, from: number): string {
  if (blank[from] !== ":") return "host";
  let depth = 0;
  for (let i = from + 1; i < blank.length; i++) {
    const c = blank[i]!;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) return keep.slice(from + 1, i).trim(); depth -= 1; }
    else if (c === "," && depth === 0) return keep.slice(from + 1, i).trim();
  }
  return keep.slice(from + 1).trim();
}

export function logHostFields(root: string, roots: readonly string[]): Array<{ file: string; line: number; admitted: boolean }> {
  const out: Array<{ file: string; line: number; admitted: boolean }> = [];
  for (const r of roots) {
    for (const path of filesUnder(join(root, r))) {
      const raw = readFileSync(path, "utf8");
      const keep = withoutComments(raw);
      const blank = withoutCommentsAndLiterals(raw);
      const file = path.slice(root.length + (root.endsWith("/") ? 0 : 1));
      for (const m of blank.matchAll(LOG_CALL)) {
        const s = bracketSpan(blank, m.index! + m[0].length - 1);
        for (const k of blank.slice(s.start, s.end).matchAll(/(?<=[{,]\s*)host\s*(?=[:,}])/g)) {
          const at = s.start + k.index!;
          const value = valueAt(keep, blank, at + k[0].length);
          out.push({ file, line: lineOf(raw, at), admitted: HOST_FIELD_ADMITTED[file]?.(value, keep) === true });
        }
      }
    }
  }
  return out;
}

describe("no structured log line names a mail server", () => {
  it("only the admitted fields pass `host`, and each admission still has its site", () => {
    const found = logHostFields(REPO, LOG_ROOTS);
    expect(found.filter((f) => !f.admitted).map((f) => `${f.file}:${f.line}`), "these log lines pass a `host` nobody admitted")
      .toEqual([]);
    for (const file of Object.keys(HOST_FIELD_ADMITTED)) {
      expect(found.some((f) => f.admitted && f.file === file), `${file} passes no admitted host now: drop the entry`).toBe(true);
    }
  });

  it("reads every root it names, the organizer's primitives and the desktop engine among them", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-log-host-roots-"));
    try {
      for (const r of LOG_ROOTS) mkdirSync(join(dir, r), { recursive: true });
      mkdirSync(join(dir, "packages", "core", "src", "adapters"), { recursive: true });
      mkdirSync(join(dir, "apps", "sidecar", "src"), { recursive: true });
      writeFileSync(join(dir, "packages", "core", "src", "adapters", "lease.ts"), "log.warn(\"lease_release_failed\", { host: cfg.host });");
      writeFileSync(join(dir, "apps", "sidecar", "src", "settings.ts"), "logger.info(\"x\", { mailboxId, host: row.host });");
      expect(logHostFields(dir, LOG_ROOTS).filter((f) => !f.admitted).map((f) => `${f.file}:${f.line}`).sort())
        .toEqual(["apps/sidecar/src/settings.ts:1", "packages/" + "core/src/adapters/lease.ts:1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a stored host planted in a log line, in every shape, and admits by file and value", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-log-host-"));
    try {
      mkdirSync(join(dir, "apps", "worker", "src"), { recursive: true });
      writeFileSync(join(dir, "apps", "worker", "src", "api-cron.ts"), [
        "log.info(\"api_cron_started\", { host: new URL(baseUrl).host, count: 1 });",
        "log.warn(\"api_cron_failed\", { host: cfg.imap.host });",
      ].join("\n"));
      writeFileSync(join(dir, "apps", "worker", "src", "ai-usage-line.ts"), [
        "aiUsageLineOf(r, { accountId, action, host: \"worker\" });",
        "aiUsageLineOf(r, { accountId, action, host: meta.host });",
      ].join("\n"));
      writeFileSync(join(dir, "apps", "worker", "src", "attach.ts"), [
        "// log.info(\"x\", { host: creds.imap.host }) in a comment is not a line",
        "const said = \"log.info('x', { host: h })\";",
        "log.info(\"mailbox_attach_started\", { mailboxId: mb.mailboxId, host: creds.imap.host });",
        "logger.warn(\"x\", { mailboxId, detail: { host: row.host } });",
        "const child = log.child({ host });",
        "cronLog(\"x\", { host: \"worker\" });",
        "log.info(\"x\", { origin: host, port });",
        "const a = makeAdapter({ host: creds.imap.host, ...dial, auth });",
        "log.info(\"api_cron_started\", { host: new URL(baseUrl).host });",
        "this.deps.log?.(\"x\", { host: meta.host });",
      ].join("\n"));
      mkdirSync(join(dir, "apps", "server", "src"), { recursive: true });
      writeFileSync(join(dir, "apps", "server", "src", "index.ts"), [
        "const tp = makeTrustedProxies(cfg.trustedProxies, { onNote: (n) => logger.info(\"trusted_proxy_resolved\", { host: n.name }) });",
        "logger.warn(\"forwarded_header_from_untrusted_peer\", { host: n.peer });",
        "logger.warn(\"x\", { host: cfg.imap.host });",
      ].join("\n"));
      mkdirSync(join(dir, "packages", "services", "src"), { recursive: true });
      writeFileSync(join(dir, "packages", "services", "src", "ai-usage-lines.ts"), [
        "export function usageLines(host: AiUsageHost | undefined): void {",
        "  aiUsageLineOf(r, { accountId, action, host });",
        "  aiUsageLineOf(r, { accountId, action, host: meta.host });",
        "}",
      ].join("\n"));
      const found = logHostFields(dir, ["apps/worker/src", "packages/services/src", "apps/server/src"]);
      expect.soft(found.filter((f) => f.admitted).map((f) => `${f.file}:${f.line}`).sort(), "the admitted fields must be seen")
        .toEqual(["apps/server/src/index.ts:1", "apps/server/src/index.ts:2", "apps/worker/src/ai-usage-line.ts:1",
          "apps/worker/src/api-cron.ts:1", "packages/services/src/ai-usage-lines.ts:2"]);
      expect.soft(found.filter((f) => !f.admitted).map((f) => `${f.file}:${f.line}`).sort())
        .toEqual(["apps/server/src/index.ts:3", "apps/worker/src/ai-usage-line.ts:2", "apps/worker/src/api-cron.ts:2", "apps/worker/src/attach.ts:3",
          "apps/worker/src/attach.ts:4", "apps/worker/src/attach.ts:5", "apps/worker/src/attach.ts:6",
          "apps/worker/src/attach.ts:9", "apps/worker/src/attach.ts:10", "packages/services/src/ai-usage-lines.ts:3"].sort());
      // The type is that admission's premise: the same shorthand typed as a string is refused.
      writeFileSync(join(dir, "packages", "services", "src", "ai-usage-lines.ts"),
        "export function usageLines(host: string): void {\n  aiUsageLineOf(r, { accountId, action, host });\n}");
      expect.soft(logHostFields(dir, ["packages/services/src"]).filter((f) => !f.admitted).map((f) => `${f.file}:${f.line}`))
        .toEqual(["packages/services/src/ai-usage-lines.ts:2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * THE PERSON'S OWN ENGINES NEVER CARRY THE MANAGED DECISION. Both engines load `@trafficflow/core/net`
 * and the API's probe module, so `mail-dial.ts` is in each graph (the shared address bound reaches
 * them through the probe's alias); what may never reach them is the decision itself. Both are built
 * here from this tree, so the reading cannot be a stale file, and the module's presence in each
 * graph is the control that the absence below is tree-shaking, not a build that never saw it.
 */
const DECISION = ["clearMailDial", "MailDialRefusal", "MAIL_DIAL_PORTS", "port does not carry mail"];
const ENGINE_ROOTS = ["apps/sidecar/src", "apps/mobile/src", "packages/client-engine/src"];
type Meta = { inputs: Record<string, unknown>; outputs: Record<string, { inputs?: Record<string, { bytesInOutput: number }> }> };
type Built = { text: string; meta: Meta };

describe("the person's own engines never carry the managed dial decision", () => {
  const built: Record<"desktop" | "phone", Built> = {} as Record<"desktop" | "phone", Built>;
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "ohmail-every-dial-engine-"));
    try {
      const desktop = await import(join(REPO, "scripts", "engine-bundle.mjs")) as {
        buildEngine: (o: { root: string; outRoot: string }) => Promise<{ bundleText: string; metafile: Meta }>;
      };
      const d = await desktop.buildEngine({ root: REPO, outRoot: out });
      built.desktop = { text: d.bundleText, meta: d.metafile };
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    const phone = await import(join(REPO, "apps", "mobile", "scripts", "bundle-engine.mjs")) as {
      buildPhoneEngine: (o: { write: boolean }) => Promise<{ text: string; metafile: Meta }>;
    };
    const p = await phone.buildPhoneEngine({ write: false });
    built.phone = { text: p.text, meta: p.metafile };
  }, 120_000);

  for (const engine of ["desktop", "phone"] as const) {
    it(`the ${engine} engine's graph holds the module and its output holds none of the decision`, () => {
      const { text, meta } = built[engine];
      // As its built copy or its source, whichever the workspace's exports resolve the engine to.
      expect(Object.keys(meta.inputs).some((k) => /net\/mail-dial\.(?:js|ts)$/.test(k)),
        "the module is not in the graph, so the absence below would prove nothing").toBe(true);
      expect(DECISION.filter((needle) => text.includes(needle)),
        `the ${engine} engine now carries the managed dial decision`).toEqual([]);
    });
  }

  it("CONTROL: the decision's needles are the module's own words", () => {
    const own = readFileSync(join(REPO, "packages", "core", "src", "net", "mail-dial.ts"), "utf8");
    expect(DECISION.filter((needle) => !own.includes(needle)), "a needle the module no longer spells").toEqual([]);
  });

  it("no engine source names the decision or imports its module", () => {
    const hits: string[] = [];
    for (const path of ENGINE_ROOTS.flatMap((r) => filesUnder(join(REPO, r)))
      .concat(join(REPO, "packages", "core", "src", "adapters", "imap.ts"))) {
      const raw = readFileSync(path, "utf8");
      const code = withoutCommentsAndLiterals(raw);
      for (const m of code.matchAll(/\b(?:clearMailDial|MailDialRefusal|MAIL_DIAL_PORTS)\b/g)) hits.push(`${path.slice(REPO.length)}:${lineOf(raw, m.index!)}`);
      for (const m of withoutComments(raw).matchAll(/["'][^"'\n]*mail-dial[^"'\n]*["']/g)) hits.push(`${path.slice(REPO.length)}:${lineOf(raw, m.index!)}`);
    }
    expect(hits, "a person's engine now reaches the managed dial decision").toEqual([]);
  });
});
