import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryImapServer, type MemoryImapOptions, type MemoryImapServer } from "./_metaworld.js";

/**
 * THE PROVIDER-SHAPE REPLAY: a fake that answers the way a RECORDED server answered.
 *
 * The corpus is `provider-shapes/*.shape.json`, written by the kit's `probe-shapes.mjs` (content-free:
 * hashes and type tags) or hand-transcribed from a measured reading with its source line. The replay
 * reads only `semantics`; a null field is unmeasured and the fake keeps its RFC default for it, so a
 * test that depends on one names the gap rather than borrowing another server's behaviour.
 */

export const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "provider-shapes");
export const CORPUS = ["greenmail", "dovecot", "infomaniak", "gmail"] as const;
export type CorpusName = (typeof CORPUS)[number];

export interface TaggedAnswer { status: string; code: string | null; text: string }
export interface ShapeSemantics {
  /** `HEADER <name> ""` over the X-Ohmail-* records (the lease's own headers), else the INBOX reading. */
  headerEmptyValue: "presence" | "nothing" | "refused" | "matches-all" | "partial" | null;
  /** `HEADER Message-ID ""` in INBOX. Gmail refuses it while answering the X-Ohmail-* form. */
  headerEmptyValueStandard: "presence" | "nothing" | "refused" | "matches-all" | null;
  headerValue: "substring" | "not-substring" | "refused" | null;
  subjectEmpty: "all" | "nothing" | "some" | "refused" | null;
  subjectEmptyAnswer: TaggedAnswer | null;
  uidBeyondEnd: "highest" | "nothing" | "refused" | null;
  charsetUtf8: "accepted" | "refused" | null;
  nonexistent: { status: TaggedAnswer; examine: TaggedAnswer; listByName: "empty" | "named" } | null;
  emptyFolderStarFetch: TaggedAnswer | null;
  namespace: { prefix: string; delimiter: string | null; announced: boolean | null } | null;
  specialUse: string[] | null;
  idle: "supported" | "refused" | null;
  capabilities: string[] | null;
}
export interface ProviderShape {
  kind: "ohmail-provider-shape";
  version: 1;
  provider: string;
  presetId: string;
  source: {
    kind: "recorded" | "hand-transcribed"; tool?: string; recordedOn?: string; from?: string[]; owed?: string;
    rescrubbed?: { tool: string; on: string };
  };
  endpoint: { host: string; port: number; tls: "implicit" | "starttls" | "none" } | null;
  measured?: Partial<Record<keyof ShapeSemantics, string>>;
  semantics: ShapeSemantics;
  /** How many server answers the recording holds, and how many carried each transient marker. */
  transient?: { of: number } & Record<string, number>;
}

const SEMANTIC_KEYS: ReadonlyArray<keyof ShapeSemantics> = [
  "headerEmptyValue", "headerEmptyValueStandard", "headerValue", "subjectEmpty", "subjectEmptyAnswer", "uidBeyondEnd", "charsetUtf8",
  "nonexistent", "emptyFolderStarFetch", "namespace", "specialUse", "idle", "capabilities",
];

/** One corpus file, refused when it is not a shape or a semantics field is missing (null is a value). */
export function loadShape(name: CorpusName): ProviderShape {
  const s = JSON.parse(readFileSync(join(CORPUS_DIR, `${name}.shape.json`), "utf8")) as ProviderShape;
  if (s.kind !== "ohmail-provider-shape" || s.version !== 1) throw new Error(`${name}: not a v1 provider shape`);
  for (const k of SEMANTIC_KEYS) if (!(k in s.semantics)) throw new Error(`${name}: semantics.${k} is missing`);
  if (s.source.kind === "hand-transcribed" && (!s.source.from?.length || !s.measured)) {
    throw new Error(`${name}: a hand-transcribed shape names its source line and what it measured`);
  }
  if (s.source.kind === "recorded" && typeof s.transient?.of !== "number") {
    throw new Error(`${name}: a recorded shape counts its transient markers (probe-shapes.mjs --rescrub)`);
  }
  /* A server's momentary state is never its shape: the replay reads no response code inside a text
   * and no transient marker anywhere in the semantics (Gmail's [THROTTLED], 2026-09-27). */
  const sem = JSON.stringify(s.semantics);
  if (/\[[A-Z][A-Z0-9-]*\]/.test(sem) || sem.includes('"transient"')) {
    throw new Error(`${name}: a response code or a transient marker in the semantics the replay reads`);
  }
  return s;
}

/** The server layout the shape measured, or a flat `/` tree when it did not (named by `measured`). */
export function layoutOf(shape: ProviderShape): { prefix: string; delimiter: string; announce: boolean; measured: boolean } {
  const ns = shape.semantics.namespace;
  if (ns === null || ns.delimiter === null) return { prefix: "", delimiter: "/", announce: true, measured: false };
  return { prefix: ns.prefix.startsWith("h:") ? "" : ns.prefix, delimiter: ns.delimiter, announce: ns.announced ?? true, measured: true };
}

/**
 * `_metaworld`'s server, answering SEARCH as the shape does: an empty-value HEADER term (`true` is what
 * imapflow sends as `""`) is answered per `headerEmptyValue` for X- headers and per
 * `headerEmptyValueStandard` for the rest — nothing, refused (`false`, as imapflow resolves a NO), or
 * presence (the double's own RFC answer).
 */
export function providerMetaWorld(shape: ProviderShape, opts: MemoryImapOptions = {}): MemoryImapServer {
  const server = memoryImapServer(opts);
  const rfc = server.search!.bind(server);
  server.search = async (query, options) => {
    const answered = await rfc(query, options);
    const terms = Object.entries(query.header ?? {}).filter(([, v]) => v === true || v === "");
    if (terms.length === 0 || !Array.isArray(answered)) return answered;
    const custom = terms.every(([n]) => /^x-/i.test(n));
    const mode = custom ? shape.semantics.headerEmptyValue
      : shape.semantics.headerEmptyValueStandard ?? shape.semantics.headerEmptyValue;
    if (mode === "nothing") return [];
    if (mode === "refused") return false;
    if (mode === "matches-all") return rfc({ ...query, header: {} }, options);
    return answered;
  };
  return server;
}

const require = createRequire(import.meta.url);
const statusCommand = require("imapflow/lib/commands/status.js") as
  (conn: unknown, path: string, query: unknown) => Promise<unknown>;
const { parser } = require("imapflow/lib/handler/imap-handler.js") as {
  parser: (b: Buffer) => Promise<{ command: string }>;
};

/** The recorded tagged line for `name`, the probe's `{name}` put back. */
export function recordedLine(answer: TaggedAnswer, name: string): string {
  return `${"A"}1 ${answer.status}${answer.code ? ` [${answer.code}]` : ""} ${answer.text.split("{name}").join(name)}`;
}

/**
 * STATUS of a folder this server does not hold, through imapflow's OWN command module over the
 * recorded wire line — so it rejects (or resolves `false`) exactly as the driver does for it.
 */
export async function replayStatusOfMissing(shape: ProviderShape, path: string, query: unknown): Promise<unknown> {
  const ns = shape.semantics.nonexistent;
  if (ns === null) throw new Error(`${shape.provider}: the missing-folder answer is unmeasured`);
  const line = recordedLine(ns.status, path);
  const conn = {
    states: { AUTHENTICATED: 2, SELECTED: 3 }, state: 2, capabilities: new Map(), enabled: new Set(),
    namespace: { delimiter: layoutOf(shape).delimiter, prefix: "" }, mailbox: false, log: { warn() { /* quiet */ } },
    async exec() {
      const response = await parser(Buffer.from(line));
      if (response.command.toUpperCase() === "OK") return { next() { /* nothing untagged */ } };
      throw Object.assign(new Error("Command failed"), { response, responseStatus: response.command.toUpperCase() });
    },
    async run() { return ns.listByName === "named" ? [{ path }] : []; },
  };
  return statusCommand(conn, path, query);
}

/**
 * A PROVIDER'S SIGN-IN REFUSALS: `provider-shapes/<name>.refusals.json`, the tagged NO per case and
 * the hint `googleAuthHint` must read from it. `synthetic` until a real mailbox recorded one (`owed`
 * names the row). `code` and `text` are kept apart, the bracket never inside the text.
 */
export interface ProviderRefusal {
  case: string; status: "NO"; code: string | null; codeArg?: string; text: string; hint: string;
}
export interface ProviderRefusals {
  kind: "ohmail-provider-refusals"; version: 1; provider: string; presetId: string;
  source: { kind: "synthetic" | "recorded"; from: string[]; owed?: string };
  refusals: ProviderRefusal[];
}

export function loadRefusals(name: string): ProviderRefusals {
  const r = JSON.parse(readFileSync(join(CORPUS_DIR, `${name}.refusals.json`), "utf8")) as ProviderRefusals;
  if (r.kind !== "ohmail-provider-refusals" || r.version !== 1) throw new Error(`${name}: not v1 provider refusals`);
  if (!r.source.from.length || (r.source.kind === "synthetic" && !r.source.owed)) {
    throw new Error(`${name}: refusals name their source, and a synthetic set the row that owes a recording`);
  }
  for (const x of r.refusals) {
    if (/[[\]]/.test(x.text)) throw new Error(`${name}/${x.case}: a bracket inside the text`);
  }
  return r;
}

/** The tagged line a refusal answers with. */
export function refusalLine(tag: string, r: ProviderRefusal): string {
  const code = r.code === null ? "" : ` [${r.code}${r.codeArg ? ` ${r.codeArg}` : ""}]`;
  return `${tag} ${r.status}${code} ${r.text}`;
}
