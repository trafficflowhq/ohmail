import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments, bracketSpan } from "../../../scripts/lib/source-scan.mjs";

/* @reads: packages/db/src/schema-mail.ts packages/db/src/schema-cloud.ts packages/core/src/adapters/drizzle-repo.ts packages/core/src/stored-values.ts packages/core/src/threading.ts packages/core/src/message-search.ts packages/services/src/unsubscribe-service.ts packages/core/src/adapters/imap-bounds.ts */

/**
 * EVERY BTREE INDEX ON A TEXT COLUMN IS NAMED, AND THE ONES A SENDER WRITES ARE BOUNDED AT INGEST.
 * A btree refuses a key of a few kilobytes (`54000`) on the INSERT, and an ingest INSERT that fails holds
 * the folder's cursor, so the message returns every cycle. The columns come from the schema (both
 * journals) and the hand-written migrations; each is classed here by name, and a sender-written
 * one names the line in code that bounds it where it is stored, read with comments stripped. A
 * value the account's own SERVER names (a folder path) is bounded where it enters, in UTF-8 bytes:
 * a character bound admits three bytes per character, which is past the btree.
 */
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const TEXTISH = new Set(["text", "varchar", "char", "citext", "jsonb"]);
const TABLE_RE = /export const \w+ = pgTable\(\s*"([a-z_0-9]+)"\s*,\s*\{/g;

/** sql table → sql column → drizzle column type, from a schema source. */
function tableColumns(src: string): Map<string, Map<string, string>> {
  const code = withoutComments(src);
  const out = new Map<string, Map<string, string>>();
  for (const m of code.matchAll(TABLE_RE)) {
    const cols = bracketSpan(code, code.indexOf("{", m.index! + m[0].length - 1), "{", "}");
    const map = new Map<string, string>();
    for (const c of code.slice(cols.start, cols.end).matchAll(/(\w+)\s*:\s*(\w+)\(\s*"([a-z_0-9]+)"/g)) map.set(c[3]!, c[2]!);
    out.set(m[1]!, map);
  }
  return out;
}

/** `table.column` for every text column a btree in the schema source keys on. */
export function schemaIndexedText(src: string): Set<string> {
  const code = withoutComments(src);
  const out = new Set<string>();
  for (const m of code.matchAll(TABLE_RE)) {
    const table = m[1]!;
    const call = bracketSpan(code, code.indexOf("(", m.index! + m[0].indexOf("pgTable")));
    const cols = bracketSpan(code, code.indexOf("{", m.index! + m[0].length - 1), "{", "}");
    const colText = code.slice(cols.start, cols.end);
    const props = new Map<string, { sql: string; type: string }>();
    for (const c of colText.matchAll(/(\w+)\s*:\s*(\w+)\(\s*"([a-z_0-9]+)"/g)) props.set(c[1]!, { sql: c[3]!, type: c[2]! });
    for (const c of colText.matchAll(/(\w+)\s*:\s*(\w+)\(\s*"([a-z_0-9]+)"[^\n]*?\.(primaryKey|unique)\(/g)) {
      if (TEXTISH.has(c[2]!)) out.add(`${table}.${c[3]}`);
    }
    const cfg = code.slice(cols.end, call.end);
    for (const k of cfg.matchAll(/\b(index|uniqueIndex|unique|primaryKey)\(/g)) {
      const head = bracketSpan(cfg, k.index! + k[1]!.length);
      let body: string;
      if (k[1] === "primaryKey") body = cfg.slice(head.start, head.end);
      else {
        const using = /^\s*\.using\(\s*"(\w+)"/.exec(cfg.slice(head.end, head.end + 400));
        if (using && using[1] !== "btree") continue;
        const onAt = cfg.indexOf(".on(", head.end);
        if (onAt < 0 || onAt > head.end + 400) continue;
        const on = bracketSpan(cfg, onAt + 3);
        body = cfg.slice(on.start, on.end);
      }
      for (const r of body.matchAll(/\bt\.(\w+)\b/g)) {
        const p = props.get(r[1]!);
        if (p && TEXTISH.has(p.type)) out.add(`${table}.${p.sql}`);
      }
    }
  }
  return out;
}

/** `table.column` for every text column a btree created in the migrations keys on, after every DROP. */
export function migrationIndexedText(sqlFiles: string[], columns: Map<string, Map<string, string>>): Set<string> {
  const live = new Map<string, { table: string; expr: string }>();
  for (const raw of sqlFiles) {
    const s = raw.replace(/--[^\n]*/g, "");
    for (const m of s.matchAll(/\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"?(?:public"?\."?)?([a-z_0-9]+)"?/gi)) live.delete(m[1]!);
    for (const m of s.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_0-9]+)"?\s+ON\s+(?:ONLY\s+)?"?(?:public"?\."?)?([a-z_0-9]+)"?\s*(?:USING\s+"?(\w+)"?\s*)?\(/gi)) {
      const [, name, table, method] = m;
      if (method && method.toLowerCase() !== "btree") { live.delete(name!); continue; }
      const open = m.index! + m[0].length - 1;
      let depth = 0, end = open;
      for (; end < s.length; end++) { if (s[end] === "(") depth++; else if (s[end] === ")" && --depth === 0) break; }
      live.set(name!, { table: table!, expr: s.slice(open + 1, end) });
    }
  }
  const out = new Set<string>();
  for (const { table, expr } of live.values()) {
    const cols = columns.get(table);
    if (!cols) continue;
    for (const id of expr.matchAll(/"?([a-z_][a-z0-9_]*)"?/g)) if (TEXTISH.has(cols.get(id[1]!) ?? "")) out.add(`${table}.${id[1]}`);
  }
  return out;
}

/** Where a sender-written value is bounded: the file, and the line of code that bounds it. */
const BOUND = {
  address: { file: "packages/core/src/adapters/drizzle-repo.ts", code: /fromAddress: storedAddress\(input\.fromAddress\)/ },
  contactAddress: { file: "packages/core/src/adapters/drizzle-repo.ts", code: /a\.includes\("@"\) && a\.length <= MAX_STORED_ADDRESS_CHARS/ },
  listAddress: { file: "packages/core/src/adapters/drizzle-repo.ts", code: /ADDRESS_SHAPE\.test\(a\) && a\.length <= MAX_STORED_ADDRESS_CHARS/ },
  messageId: { file: "packages/core/src/adapters/drizzle-repo.ts", code: /messageIdHeader: storedMessageId\(input\.canonical\.messageIdHeader\)/ },
  threadAnchor: { file: "packages/core/src/threading.ts", code: /if \(isStorableMessageId\(id\) && !seen\.has\(id\)\)/ },
  listId: { file: "packages/services/src/unsubscribe-service.ts", code: /Buffer\.byteLength\(identity, "utf8"\) <= MAX_LIST_ID_BYTES/ },
} as const;
type Bound = keyof typeof BOUND;

/** Where a server-named value is bounded: the function every LIST passes through. */
const SERVER_BOUND = {
  folderPath: { file: "packages/core/src/adapters/imap-bounds.ts", fn: "boundListResponse" },
} as const;
type ServerBound = keyof typeof SERVER_BOUND;

/**
 * Does the function bound in BYTES? It must compare a UTF-8 measure against a `_MAX_BYTES`
 * ceiling; a `.length` against any ceiling is characters (UTF-16 units) and refused as the only one.
 */
export function boundsInBytes(src: string, fn: string): boolean {
  const code = withoutComments(src);
  const at = code.indexOf(`export function ${fn}`);
  if (at < 0) return false;
  const params = bracketSpan(code, code.indexOf("(", at));
  const span = bracketSpan(code, code.indexOf("{", params.end), "{", "}");
  const body = code.slice(span.start, span.end);
  return /\b(?:utf8ByteLength|Buffer\.byteLength)\([^;]*\)\s*>\s*[A-Z_]+_MAX_BYTES\b/.test(body);
}

/** Every indexed text column, by name. `inbound` is a sender-written value; the rest say why not. */
const CLASSES: Record<string, { inbound: Bound } | { server: ServerBound } | { not: string }> = {
  "messages.from_address": { inbound: "address" },
  "contacts.address": { inbound: "contactAddress" },     // learned from From and recipients
  "list_addresses.address": { inbound: "listAddress" },   // a List-Post mailto (mail 0150), its primary key
  "away_replies.sender": { inbound: "address" },          // the stored from_address
  "away_responder_sent.sender": { inbound: "address" },
  "away_sender_state.sender": { inbound: "address" },
  "graduations.pattern_key": { inbound: "address" },      // `sender:<from.address>→<folder>`
  "messages.message_id_header": { inbound: "messageId" },
  "threads.root_message_id_header": { inbound: "threadAnchor" },
  "unsubscribe_records.list_key": { inbound: "listId" },  // List-ID, else the bounded From
  "messages.dedup_key": { not: "a fixed-length fingerprint hash" },
  "mailbox_folders.folder": { server: "folderPath" },      // LIST
  "message_failures.folder": { server: "folderPath" },    // the folder a UID was read in
  "message_instances.folder": { server: "folderPath" },
  "junk_rescues.folder": { server: "folderPath" },        // mailboxes.junk_folder, from LIST
  "folder_state.desired_folder": { server: "folderPath" }, // a listed folder, or a pile ohmail names
  "rules.match": { not: "typed by the account's own person" },
  "tags.name": { not: "typed by the account's own person" },
  "mailboxes.address": { not: "the mailbox the person connects" },
  "users.email": { not: "an account's sign-in address" },
  "invites.email": { not: "an address an operator invites" },
  "staff_users.email": { not: "an operator's sign-in address" },
  "waitlist.email": { not: "an address typed into the waitlist form" },
  "drafts.workflow_dedup_key": { not: "a workflow step's own key" },
  "kb_entries.workflow_dedup_key": { not: "a workflow step's own key" },
  "learning_signals.triggering_action_id": { not: "an id the product mints" },
  "idempotency_keys.key": { not: "an API caller's request key" },
  "outbound_sends.idempotency_key": { not: "an API caller's request key" },
  "auth_throttle.key": { not: "a throttle key the product derives" },
  "credit_refund_obligations.attempt": { not: "an id the product mints" },
  "attachment_staging.object_path": { not: "an object path the product mints" },
  "outbound_send_fingerprints.fingerprint": { not: "a fixed-length hash" },
  "erased_bearers.token_hash": { not: "a fixed-length hash" },
  "invites.code_hash": { not: "a fixed-length hash" },
  "login_tokens.token_hash": { not: "a fixed-length hash" },
  "oauth_auth_codes.code_hash": { not: "a fixed-length hash" },
  "pairing_tokens.token_hash": { not: "a fixed-length hash" },
  "refresh_tokens.token_hash": { not: "a fixed-length hash" },
  "sessions.access_token_hash": { not: "a fixed-length hash" },
  "staff_sessions.token_hash": { not: "a fixed-length hash" },
  "mailbox_oauth_ceremonies.state": { not: "a state the product mints" },
  "mailbox_oauth_device_ceremonies.state": { not: "a state the product mints" },
  "webauthn_credentials.credential_id": { not: "an authenticator's credential id" },
  "push_subscriptions.transport": { not: "a device's push registration" },
  "push_subscriptions.endpoint": { not: "a device's push registration" },
  "push_subscriptions.device_token": { not: "a device's push registration" },
  "approvals.status": { not: "a closed set of states" },
  "workflow_proposals.status": { not: "a closed set of states" },
  "workflow_runs.status": { not: "a closed set of states" },
  "message_states.state": { not: "a closed set of states" },
  "organizer_requests.state": { not: "a closed set of states" },
  "message_bodies.withheld_reason": { not: "a closed set of reasons" },
  "account_lifecycle_notices.kind": { not: "a closed set of kinds" },
  "mailbox_credentials.transport": { not: "a closed set of transports" },
  "webauthn_challenges.type": { not: "a closed set of types" },
  "staff_role_grants.role": { not: "a closed set of roles" },
  "graduations.action": { not: "a closed set of actions" },
  "unsubscribe_drain_state.pass": { not: "a pass name the product writes" },
  "alert_pass_runs.driver": { not: "a driver name the product writes" },
  "alert_driver_gaps.driver": { not: "a driver name the product writes" },
  "alert_state.alert_key": { not: "an alert key the product writes" },
  "api_faults.route": { not: "a route pattern the product writes" },
  "platform_signals.provider": { not: "a provider name the product writes" },
  "platform_signals.project": { not: "a project name the product writes" },
  "oauth_provider_config.provider": { not: "a provider name the product writes" },
};

const SCHEMAS = ["packages/db/src/schema-mail.ts", "packages/db/src/schema-cloud.ts"];
const JOURNALS = ["packages/db-mail/drizzle", "packages/db/drizzle-cloud"];
function census(schemaSrcs: string[], sqlFiles: string[]): Set<string> {
  const cols = new Map<string, Map<string, string>>();
  for (const s of schemaSrcs) for (const [t, c] of tableColumns(s)) cols.set(t, c);
  return new Set([...schemaSrcs.flatMap((s) => [...schemaIndexedText(s)]), ...migrationIndexedText(sqlFiles, cols)]);
}
const boundHolds = (b: Bound, src = read(BOUND[b].file)) => BOUND[b].code.test(withoutComments(src));
const realSql = () => JOURNALS.flatMap((d) => (JSON.parse(read(`${d}/meta/_journal.json`)) as { entries: { tag: string }[] }).entries.map((e) => read(`${d}/${e.tag}.sql`)));

describe("every btree on a text column is named, and a sender-written one is bounded at ingest", () => {
  const found = census(SCHEMAS.map(read), realSql());

  it("reads the real schema: the census sees the columns it exists for", () => {
    expect(found.size).toBeGreaterThanOrEqual(60);
    for (const k of ["messages.from_address", "messages.message_id_header", "push_subscriptions.endpoint"]) expect(found.has(k), k).toBe(true);
  });

  it("names every indexed text column, and names no column that is not indexed", () => {
    expect([...found].filter((k) => !(k in CLASSES)).sort(), "an indexed text column nobody classed").toEqual([]);
    expect(Object.keys(CLASSES).filter((k) => !found.has(k)).sort(), "a class for a column no btree keys on").toEqual([]);
  });

  it("finds each sender-written value's bound in code", () => {
    for (const b of Object.keys(BOUND) as Bound[]) expect(boundHolds(b), `${b} in ${BOUND[b].file}`).toBe(true);
  });

  it("bounds each server-named value in UTF-8 bytes where it enters", () => {
    const used = new Set(Object.values(CLASSES).flatMap((c) => ("server" in c ? [c.server] : [])));
    expect([...used].sort()).toEqual(Object.keys(SERVER_BOUND).sort());
    for (const b of used) expect(boundsInBytes(read(SERVER_BOUND[b].file), SERVER_BOUND[b].fn), `${b}: ${SERVER_BOUND[b].fn}`).toBe(true);
  });

  it("CONTROL: a character-only bound on a server-named value is refused", () => {
    const { file, fn } = SERVER_BOUND.folderPath;
    const src = read(file);
    const byteLine = "if (utf8ByteLength(entry.path) > IMAP_FOLDER_PATH_MAX_BYTES) { dropped++; continue; }";
    expect(src.includes(byteLine), "the control's subject moved").toBe(true);
    expect(boundsInBytes(src.replace(byteLine, ""), fn), "the 0.25.8 shape: characters only").toBe(false);
    expect(boundsInBytes(src.replace(byteLine, byteLine.replace("utf8ByteLength(entry.path)", "entry.path.length")), fn),
      "characters against a bytes-named ceiling").toBe(false);
    expect(boundsInBytes(src.replace(byteLine, `/* ${byteLine} */`), fn), "a bound left in a comment").toBe(false);
  });

  it("CONTROL: a planted unbounded text column is found and named as unclassed", () => {
    const planted = `export const evil = pgTable("evil_inbound", {\n  id: uuid("id"),\n  line: text("header_line"),\n}, (t) => ({\n  ix: index("evil_ix").on(t.line),\n  gin: index("evil_gin").using("gin", t.line),\n}));`;
    const got = census([...SCHEMAS.map(read), planted], realSql());
    expect([...got].filter((k) => !(k in CLASSES))).toEqual(["evil_inbound.header_line"]);
  });

  it("CONTROL: a planted migration index on a text column is found", () => {
    const got = census([...SCHEMAS.map(read)], [...realSql(), "CREATE INDEX IF NOT EXISTS evil_m ON public.messages USING btree (lower(subject));"]);
    expect(got.has("messages.subject")).toBe(true);
  });

  it("CONTROL: a gin index is not a btree, and a dropped index is not live", () => {
    const got = census([...SCHEMAS.map(read)], [...realSql(), "CREATE INDEX x_g ON messages USING gin (subject);", "CREATE INDEX x_d ON messages (subject);", "DROP INDEX x_d;"]);
    expect(got.has("messages.subject")).toBe(false);
  });

  it("CONTROL: a bound removed from its file is refused", () => {
    expect(boundHolds("address", read(BOUND.address.file).replace("fromAddress: storedAddress(input.fromAddress)", "fromAddress: input.fromAddress"))).toBe(false);
    expect(boundHolds("listId", read(BOUND.listId.file).replace('Buffer.byteLength(identity, "utf8") <= MAX_LIST_ID_BYTES', "true"))).toBe(false);
  });
});
