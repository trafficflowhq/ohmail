import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** The planted file the classifier is shown: a path that names no real source, joined from two parts so
 *  the published tree's citation gate does not read it as a link to the private tree. */
const PLANTED = "packages/" + "services/src/__planted.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE ERASURE FENCE CENSUS — every write door the fence must stand in, named and classified
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `accounts` SURVIVES Art. 17 erasure (the pseudonymous billing subject), so a table whose rows
 * hang off the account and nothing else has no structural refusal for a writer that arrives late:
 * a request whose session was valid when it started can commit after the sweep and recreate
 * erased state. The fence closes that window — but a fence is only as complete as the set of
 * doors it stands in, and that set was four hand-written calls with nothing proving it whole.
 *
 * This census is the proof. It derives its domain from the sweep itself, enumerates every write
 * against those tables in every server-side source, classifies each, and refuses one it cannot
 * account for — by file, line and table. A new service method that opens its own transaction
 * against an account-owned table is red here the moment it is written.
 *
 * THE FOUR CLASSES, and the argument for each:
 *
 *  (a) FENCED — the write sits inside {@link withAccountTx}, or the fence is called before it in
 *      the same scope. The fence reads `accounts.erased_at FOR SHARE` as the FIRST statement of
 *      the transaction, and `deleteAccount` stamps that row as the FIRST statement of its own.
 *      Both orders close: fence first, the stamp waits and the sweep takes the writer's rows;
 *      stamp first, the fence waits, sees the stamp and refuses 410.
 *
 *  (b1) FENCED BY CONSTRUCTION, by foreign key — an INSERT into a table with a NOT NULL foreign
 *      key to a row the sweep DELETES. After the sweep commits there is no parent, so the insert
 *      cannot land; before it commits, the child row is inside the sweep's own reach. The
 *      ordering is proven, not assumed: the FK is read out of the schema and the parent out of
 *      the sweep's own delete list.
 *
 *  (b2) HITS NOTHING — an UPDATE or DELETE. The sweep removed every row the account owns, so a
 *      late one matches zero rows. An update cannot create.
 *
 *  (c) UNFENCED — an INSERT into a table with no such parent. Each one is either moved through
 *      {@link withAccountTx} or named in {@link ALLOWLIST} with the reason it legitimately runs
 *      without a session. There is no third option: the assertion below prints the door.
 *
 * MUTATIONS WATCHED RED, THEN RESTORED:
 *  · the fence removed from `withAccountTx` → ONLY "the door fences before it hands the
 *    transaction over" goes red, and that is the point of having it: every converted writer still
 *    reads as class (a) here, because this census asks WHERE a write sits and the door's own
 *    source is what says the door fences. Without that one case the other six would pass over a
 *    wrapper that fenced nothing;
 *  · a planted `tx.insert(snippets)` outside the door → the allow-list case red naming the file
 *    and line;
 *  · an allow-list entry deleted → the allow-list case red naming its door; an entry for a door
 *    that does not exist → the stale-entry case red naming it;
 *  · `organizeHere` reverted to its own `asTx(ctx).transaction(…)` → the call-site case red
 *    naming all three consent-settings writes, which is the door this census FOUND: the consent
 *    write was never among the four hand-written fence calls;
 *  · `readAccountErasedAt`'s `{ mode: "share" }` deleted → nothing here moves, and the race pg
 *    test's CONCURRENT arm goes red. A lock is behaviour, not text: this file cannot see it, and
 *    saying so is why both guards exist.
 */

// ── the parse ────────────────────────────────────────────────────────────────────────────────

/**
 * Comments, strings, templates and regex literals blanked to spaces, positions preserved.
 *
 * A SCANNER and not two regexes, which is what this started as and what every census in this
 * repository that predates it still uses. The line `// … `ohmail/*` never appears;` in
 * `mailbox-service.ts` opens a block comment the regex pair then closes 36 lines later at a real
 * `*​/`, blanking the `}).returning()` in between — after which the bracket walk below never found
 * its closing paren and swallowed the rest of the file, reporting every later write as fenced.
 * Blanking string bodies matters for the same walk: an unbalanced paren inside a message is the
 * other way a span runs away.
 */
function withoutComments(src: string): string {
  const out = src.split("");
  const blank = (i: number) => { if (src[i] !== "\n") out[i] = " "; };
  // The previous significant character decides whether a `/` opens a regex or divides.
  let prev = "";
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") blank(i++);
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) blank(i++);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;                                    // the opening quote stays
      while (i < src.length) {
        if (src[i] === "\\") { blank(i); blank(i + 1); i += 2; continue; }
        if (src[i] === quote) { i++; break; } // the closing quote stays
        blank(i++);
      }
      prev = quote;
      continue;
    }
    if (c === "/" && /[(,=:[!&|?{};+\-*%~^<>]/.test(prev)) {
      i++;                                    // a regex literal, by what precedes it
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") { blank(i); blank(i + 1); i += 2; continue; }
        if (src[i] === "/") { i++; break; }
        blank(i++);
      }
      prev = "/";
      continue;
    }
    if (!/\s/.test(c!)) prev = c!;
    i++;
  }
  return out.join("");
}

/**
 * A call's arguments with every arrow-function BODY blanked — what the caller told the seam,
 * separated from what it then did with the transaction.
 */
function withoutCallbacks(text: string): string {
  const out = text.split("");
  for (const [at, m] of hits(text, String.raw`=>\s*\{`)) {
    // Blank the arrow WITH its body: leaving the `=>` behind made this loop find it again.
    const [, to] = span(text, at + m[0].length - 1, "{", "}");
    for (let i = at; i <= to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  }
  return out.join("");
}

/** The span between a bracket and its match, exclusive. */
function span(src: string, open: number, o = "(", c = ")"): [number, number] {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === o) depth++;
    else if (src[j] === c) { depth--; if (depth === 0) return [open + 1, j]; }
  }
  return [open + 1, src.length];
}

function hits(src: string, re: string): Array<[number, RegExpExecArray]> {
  const out: Array<[number, RegExpExecArray]> = [];
  const r = new RegExp(re, "g");
  let m: RegExpExecArray | null;
  while ((m = r.exec(src)) !== null) out.push([m.index, m]);
  return out;
}

const lineOf = (src: string, at: number): number => src.slice(0, at).split("\n").length;

const read = (f: string): string => readFileSync(path.join(ROOT, f), "utf8");

const SWEEP = "packages/services/src/account-deletion-service.ts";
const DOOR = "packages/services/src/context.ts";
/** The seam itself — one helper, in the db package, so the worker can reach it too. */
const SEAM_FILE = "packages/db/src/erasure-fence.ts";

/**
 * The tables the sweep itself writes — the census's domain, taken from the sweep and never from a
 * list somebody remembered. A table added to `deleteAccount` joins this census in the same commit.
 * `accounts` is removed: it is the one row erasure KEEPS, which is the whole reason a fence exists.
 */
function erasedTables(): Set<string> {
  const src = withoutComments(read(SWEEP));
  const out = new Set(
    hits(src, String.raw`\btx\.(?:delete|update)\(\s*([A-Za-z_$][\w$]*)\s*\)`).map(([, m]) => m[1]!),
  );
  out.delete("accounts");
  return out;
}

interface Fk { readonly col: string; readonly notNull: boolean; readonly parent: string }

/** Every drizzle table's declared foreign keys, out of the schema files. */
function foreignKeys(): Map<string, Fk[]> {
  const out = new Map<string, Fk[]>();
  for (const f of ["packages/db/src/schema-mail.ts", "packages/db/src/schema-cloud.ts"]) {
    const src = withoutComments(read(f));
    for (const [at, m] of hits(src, String.raw`export const ([A-Za-z_$][\w$]*)\s*=\s*pgTable\(`)) {
      const [from, to] = span(src, at + m[0].length - 1);
      const body = src.slice(from, to);
      /* A key the table's own CHECK binds for every row but one named kind — `login_tokens`'
         `user_id is not null or purpose = 'desktop_approval'` — fences as NOT NULL does: a row
         with an owner hangs off the swept parent, and the one kind without owns nothing. Read
         from the RAW text (the stripper blanks the template), at a `check(` that is code. */
      const raw = read(f).slice(from, to);
      const bound = new Set(hits(
        raw,
        String.raw`check\(\s*"[^"]*"\s*,\s*sql` + "`" +
          String.raw`\$\{t\.([A-Za-z_$][\w$]*)\}\s+is\s+not\s+null\s+or\s+\$\{t\.[A-Za-z_$][\w$]*\}\s*=\s*'[^']*'` +
          "`" + String.raw`\s*\)`,
      ).filter(([i]) => body.startsWith("check(", i)).map(([, r]) => r[1]!));
      out.set(m[1]!, hits(
        body,
        String.raw`([A-Za-z_$][\w$]*)\s*:\s*[^,\n]*?(\.notNull\(\))?\s*\.references\(\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)\.`,
      ).map(([, r]) => ({ col: r[1]!, notNull: Boolean(r[2]) || bound.has(r[1]!), parent: r[3]! })));
    }
  }
  return out;
}

/**
 * Every table with a `mailbox_id` column — the rows ONE mailbox owns, which `sweepMailboxData`
 * empties. The account's stamp says nothing about these: a mailbox removal leaves the `mailboxes`
 * row standing as a tombstone, so a key to it refuses nothing and only `mailboxes.erased_at` does.
 */
function mailboxKeyed(): Set<string> {
  const out = new Set<string>();
  for (const f of ["packages/db/src/schema-mail.ts", "packages/db/src/schema-cloud.ts"]) {
    const src = withoutComments(read(f));
    for (const [at, m] of hits(src, String.raw`export const ([A-Za-z_$][\w$]*)\s*=\s*pgTable\(`)) {
      const [from, to] = span(src, at + m[0].length - 1);
      if (/\bmailboxId\s*:\s*uuid\(/.test(src.slice(from, to))) out.add(m[1]!);
    }
  }
  return out;
}

/**
 * A file's local name for each imported table — `import { rules as rulesTbl }` and the write
 * below spelled `tx.insert(rulesTbl)`. Without this the census asks about a symbol the sweep
 * never mentions, finds no match and reports NOTHING: seven files alias a table this way, and
 * `learning-service.ts`'s promoted-rule insert was invisible to every run of this census until
 * the alias was resolved. An alias must never be a way out of a guard.
 */
function aliases(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [at, m] of hits(src, String.raw`import\s*\{`)) {
    const [from, to] = span(src, at + m[0].length - 1, "{", "}");
    for (const [, a] of hits(src.slice(from, to),
      String.raw`([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)`)) out.set(a[2]!, a[1]!);
  }
  return out;
}

type DoorClass =
  | "a-fenced"
  /** Fenced, but on the ACCOUNT alone while the row it writes belongs to one mailbox. */
  | "a-fenced-account-only"
  /**
   * (a) asked through the MAILBOX ARM ALONE — `fenceErasedMailbox`. Admitted only where the
   * account arm is already STRUCTURAL: the row hangs off a NOT NULL key to a parent the ACCOUNT
   * sweep deletes, so after that sweep the insert has no parent and the only erasure left to ask
   * about is the mailbox's, whose row survives as the tombstone. Asking the account again would
   * read a row the caller already holds and, after the mailbox row is taken, cross the fence's
   * own account-then-mailbox order.
   */
  | "a-fenced-mailbox-only"
  /** The same call where NOTHING refuses the account — the mailbox arm used for the wrong door. */
  | "c-mailbox-only-no-account-refusal"
  | "b1-fk"
  /** (b1) whose only refusing parent is `mailboxes` — proven against the ACCOUNT sweep alone. */
  | "b1-fk-mailbox"
  | "b2-hits-nothing"
  | "c-unfenced";

interface Door {
  readonly file: string;
  readonly line: number;
  readonly op: "insert" | "update" | "delete";
  readonly table: string;
  readonly cls: DoorClass;
  /** For (b1): the foreign key that makes the insert unreachable after the sweep. */
  readonly by: string | null;
}

function serverSources(): string[] {
  // `git ls-files` with a `**` pathspec matched a fraction of the tree when the dialect census was
  // written, so the listing is filtered here where the rule is readable.
  const out = execFileSync("git", ["ls-files", "apps", "packages"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((f) => /^(apps|packages)\/[^/]+\/src\/.*\.ts$/.test(f));
}

/**
 * THE OPEN BRACE STACK at each index asked about — every `{` still open there, outermost first.
 *
 * A fence REACHES a write when its stack is a prefix of the write's: every block open at the
 * fence is still open at the write, so no boundary was crossed in between. The body rule above
 * cannot say that, and it is not a nicety — `applyUpsert` in `cloud-mirror.ts` is one `switch`
 * whose arms are SIBLINGS, so the fence in its `folder` arm sat "before the write inside an
 * enclosing body" for four inserts in later arms that it can never run for. Measured: `threads`,
 * `tags`, `rules` and `approvals` read as fenced the moment the first arm was fenced.
 */
function blockStacks(src: string, positions: readonly number[]): Map<number, number[]> {
  const wanted = [...new Set(positions)].sort((a, b) => a - b);
  const out = new Map<number, number[]>();
  const stack: number[] = [];
  let next = 0;
  for (let i = 0; i < src.length && next < wanted.length; i++) {
    while (next < wanted.length && wanted[next] === i) out.set(wanted[next++]!, [...stack]);
    if (src[i] === "{") stack.push(i);
    else if (src[i] === "}") stack.pop();
  }
  while (next < wanted.length) out.set(wanted[next++]!, [...stack]);
  return out;
}

/** Is every block open at `from` still open at `to`? */
function sameBlock(from: readonly number[], to: readonly number[]): boolean {
  return from.length <= to.length && from.every((v, i) => to[i] === v);
}

/**
 * Every function-ish body, so a db-layer writer that takes the caller's `tx` and fences at the
 * top of its own function reads as fenced — which it is. Keyed on POSITION, never on a spelling:
 * the first draft asked whether the write mentioned the fence and reported the fence's own module.
 */
/**
 * WHERE A FUNCTION'S BODY OPENS, past a RETURN TYPE THAT HAS BRACES OF ITS OWN.
 *
 * Both arms used to take the first `{` after the argument list, so
 * `): Promise<{ written: string[] }> {` gave a body span that was the RETURN TYPE — the fence and
 * the write both fell outside it and the door read `c-unfenced`. Measured 2026-09-22 on
 * `insertOrganizerRequestSet`, whose fence is the line above its insert.
 *
 * A `{` belongs to the type while angle brackets are open, or where the previous non-space
 * character still demands one; anything else opens the body. `;` or `=` first means there is no
 * body at all — an overload signature, or a property.
 */
function bodyBrace(src: string, from: number): number {
  let angle = 0;
  let prev = "";
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (/\s/.test(c)) continue;
    if (c === "<") { angle++; prev = c; continue; }
    if (c === ">") { if (angle > 0) angle--; prev = c; continue; }
    if (c === ";" || c === "=") return -1;
    if (c === "{") {
      if (angle === 0 && !":<,|&(".includes(prev)) return i;
      const [, end] = span(src, i, "{", "}");
      i = end - 1;
      prev = "}";
      continue;
    }
    prev = c;
  }
  return -1;
}

function bodies(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [i] of hits(src, String.raw`\.transaction\(`)) out.push(span(src, i + ".transaction".length));
  for (const [at, m] of hits(src, String.raw`(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(`)) {
    const open = src.indexOf("(", at + m[0].length - 1);
    const [, argEnd] = span(src, open);
    const brace = bodyBrace(src, argEnd + 1);
    if (brace !== -1) out.push(span(src, brace, "{", "}"));
  }
  /* METHOD SHORTHAND and arrow properties, which the `function` pattern above cannot see. The
     workflow tools are `async apply(ctx, args) { … }` in an object literal: a fence written
     inside one was invisible here, which reads as an unfenced door rather than as a missed body —
     safe, but wrong by name. The brace must FOLLOW the argument list (optionally past a return
     type): searching forward for any `{` would give an ordinary CALL a body running to the end of
     the file, which is how a bracket walk swallows a whole module. */
  for (const [at, m] of hits(src, String.raw`(?:^|\n)\s*(?:(?:private|protected|public|static|override|async)\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(`)) {
    const open = src.indexOf("(", at + m[0].length - 1);
    const [, argEnd] = span(src, open);
    const brace = bodyBrace(src, argEnd + 1);
    if (brace === -1) continue;
    out.push(span(src, brace, "{", "}"));
  }
  for (const [i, m] of hits(src, String.raw`=>\s*\{`)) out.push(span(src, i + m[0].length - 1, "{", "}"));
  return out;
}

/** The seam and the two edge translations of it. One mechanism; these are its spellings. */
const SEAM = String.raw`(?:fencedAccountWrite|withAccountTx|fenceErasedScope|fenceErasedAccount|fenceErased|readAccountErasedAt)`;

/**
 * The MAILBOX ARM asked alone — its own pattern rather than another `SEAM` alternative, because
 * it says nothing about the account: a door using it is admitted only where the account arm is
 * structural. SCOPED BY CONSTRUCTION, never by the argument's spelling — the parameter IS a
 * mailbox id, and `SEAM`'s `mailboxId` text test would answer NO for the six doors naming it
 * `mb.id`, `seedRow.id`, `f.mailboxId` or `input.mailboxId`. Three spellings, one question: the
 * services edge puts the 410 on, and the mirror's replay reads and SKIPS (a throw there stops the
 * whole mirror — see the file). What a door DOES with the answer is its own test's; this census
 * asks whether the question was asked at all, before the write.
 */
const MAILBOX_SEAM = String.raw`(?:fenceErasedMailbox|fenceErasedMailboxOnly|readMailboxErasedAt)`;

function doorsIn(file: string): Door[] {
  return classify(file, read(file));
}

/** The classifier over SOURCE TEXT, so the case at the end can drive it with a planted door. */
function classify(file: string, raw: string): Door[] {
  const erased = ERASED;
  const src = withoutComments(raw);
  const bs = bodies(src);
  const alias = aliases(src);
  // Each fence call with its own arguments, callbacks cut out.
  const seamCalls: Array<[number, string]> = hits(src, String.raw`\b${SEAM}\s*\(`)
    .map(([i, m]) => {
      const [from, to] = span(src, i + m[0].length - 1);
      return [i, withoutCallbacks(src.slice(from, to))] as [number, string];
    });
  // Everything lexically inside the seam's callback is fenced: the seam runs the fence before it
  // hands the transaction over, which the case below asserts of the seam's own source.
  const doorSpans = hits(src, String.raw`\b(?:withAccountTx|fencedAccountWrite)\s*\(`)
    .map(([i, m]) => span(src, i + m[0].length - 1));
  // Every MAILBOX-arm call's position. The call carries its own scope, so only WHERE it sits
  // matters — see {@link MAILBOX_SEAM} for why the argument's spelling is not asked about.
  const mailboxSeamCalls = hits(src, String.raw`\b${MAILBOX_SEAM}\s*\(`).map(([i]) => i);
  const writePositions = hits(src, String.raw`\.(?:insert|update|delete)\(`).map(([i]) => i);
  const stacks = blockStacks(src, [...mailboxSeamCalls, ...writePositions]);
  const out: Door[] = [];
  for (const [at, m] of hits(src, String.raw`\.(insert|update|delete)\(\s*([A-Za-z_$][\w$]*)\s*\)`)) {
    const op = m[1] as Door["op"];
    // The LOCAL name resolved to the one the sweep uses — see `aliases` for the census this hid.
    const table = alias.get(m[2]!) ?? m[2]!;
    if (!erased.has(table)) continue;
    const covering = doorSpans.filter(([a, b]) => at > a && at < b);
    /* A fence CALL that precedes this write inside some enclosing body. Keyed on the call and not
       on "the text before the write contains the word": the scope below is read from the call's
       own arguments, and a slice running from the body's start carries every local variable in
       between — `const mailboxId = await this.validMailbox(…)` answered "mailbox-scoped" for a
       door that passed the fence nothing. */
    const bodyFence = seamCalls.filter(([c]) => c < at && bs.some(([a, b]) => a < c && at < b));
    const fenced = covering.length > 0 || bodyFence.length > 0;
    /* The mailbox arm, asked before this write AND in a block the write is still inside — the
       stricter rule of the two, because this arm is the one that says least: see
       {@link blockStacks} for the four doors the body rule read as fenced for nothing. */
    const mailboxOnlyFence = mailboxSeamCalls.some(
      (c) => c < at && sameBlock(stacks.get(c) ?? [], stacks.get(at) ?? []),
    );
    /* The mailbox SCOPE is a property of the fence CALL, not of the writer: a seam asked with an
       account alone cannot refuse a write whose mailbox was erased under it. The door's CALLBACK
       is cut out before the question is asked — every one of these writes names `mailboxId` as a
       COLUMN, so a span that still contained the write answered "scoped" for a door that passed
       the fence nothing. Measured: dropping `{ mailboxId }` from compose left this green. */
    const scopes = [
      ...covering.map(([a, b]) => withoutCallbacks(src.slice(a, b))),
      ...bodyFence.map(([, args]) => args),
    ];
    const mailboxScoped = scopes.some((t) => /\bmailboxId\b/.test(t));
    const fks = (FKS.get(table) ?? []).filter((p) => p.notNull && erased.has(p.parent));
    const fk = fks[0];
    const onlyMailbox = fks.length > 0 && fks.every((p) => p.parent === "mailboxes");
    let cls: DoorClass;
    let by: string | null = null;
    if (fenced) {
      cls = op === "insert" && MAILBOX_KEYED.has(table) && !mailboxScoped
        ? "a-fenced-account-only" : "a-fenced";
    } else if (op !== "insert") cls = "b2-hits-nothing";
    else if (mailboxOnlyFence) {
      /* THE MAILBOX ARM, AND WHAT MAKES IT SOUND. `fk` is the row's NOT NULL key to a parent the
         ACCOUNT sweep deletes: with one, the account erasure is refused by construction and the
         mailbox stamp is the only question left to ask; with none, this door asks about the
         mailbox while nothing at all refuses the account, and that is a fence pointed at the
         wrong erasure. The case below prints it. */
      cls = fk !== undefined ? "a-fenced-mailbox-only" : "c-mailbox-only-no-account-refusal";
      if (fk !== undefined) by = `${table}.${fk.col} -> ${fk.parent}`;
    } else if (fk !== undefined) {
      cls = onlyMailbox ? "b1-fk-mailbox" : "b1-fk";
      by = `${table}.${fk.col} -> ${fk.parent}`;
    } else cls = "c-unfenced";
    out.push({ file, line: lineOf(src, at), op, table, cls, by });
  }
  return out;
}

const ERASED = erasedTables();
const FKS = foreignKeys();
const MAILBOX_KEYED = mailboxKeyed();
const DOORS = serverSources().flatMap(doorsIn);
const key = (d: Door): string => `${d.file} ${d.op} ${d.table}`;

/**
 * ── THE ALLOW-LIST ───────────────────────────────────────────────────────────────────────────
 *
 * Writers that create a row in an account-owned table WITHOUT a fence, each with the reason it
 * legitimately does so. An entry is a written ruling, not a suppression: it is keyed by file,
 * operation and table (never by line, which moves under its own edits) and the case below refuses
 * an entry that no longer names a real door, so a reason cannot outlive the code it was about.
 */
const ALLOWLIST: Record<string, string> = {
  // ── Before any session exists ──────────────────────────────────────────────────────────────
  "packages/services/src/auth/auth-service.ts insert users":
    "account creation: there is no account to fence against until this row exists",
  "packages/services/src/auth/auth-service.ts insert webauthnChallenges":
    "a sign-in ceremony, started by an unauthenticated caller and keyed by a challenge, not by " +
    "an account; an erased account has no users left to finish one",
  "packages/services/src/auth/auth-service.ts insert authThrottle":
    "the sign-in throttle, keyed by address or ip. It must keep counting attempts for an address " +
    "that has no account at all — fencing it on the account would turn the throttle off for " +
    "exactly the caller it exists to slow down",
  "packages/services/src/ip-throttle.ts insert authThrottle": "the throttle, keyed by ip",
  "packages/services/src/invites.ts insert invites":
    "an operator issuing an invite CODE, keyed by the email it is issued to. There is no account "
    + "to fence against — the invite is what an account is later created FROM, and the row carries "
    + "a code hash and an address, not account-owned mail",
  "packages/services/src/waitlist-service.ts insert waitlist":
    "a public signup, written by an unauthenticated caller and keyed by email; there is no "
    + "account yet, and fencing on one would close the waitlist to exactly the person it is for",
  "packages/services/src/mail/mail-service.ts insert authThrottle": "the throttle, keyed by ip",
  "packages/db/src/imap-admission.ts insert authThrottle":
    "the IMAP door's admission counter, keyed by host and ip",
  "packages/api/src/routes/admin-staff.ts insert authThrottle":
    "the staff console's own throttle, keyed by a staff identity outside every customer account",
  "packages/services/src/account-lifecycle-pass.ts insert accountLifecycleNotices":
    "the nightly lifecycle pass (cloud 0040), a cron with no session, whose page filter is " +
    "`erased_at IS NULL`. The race — an erasure committing between the page read and the claim " +
    "insert — leaves one row of a uuid, a CHECK-closed word and two billing instants (the same " +
    "retention class as the billing rows the sweep deliberately keeps), and it can mail nobody: " +
    "the recipients are read from `users`, which the sweep has already emptied",
  "packages/services/src/pairing.ts insert pairingTokens":
    "`pairing_tokens.created_by_user_id` references `users`, which the sweep deletes, so a mint " +
    "for a real creator is refused by that key; a creator-less token is the self-host first-boot " +
    "invite, which belongs to the server rather than to any account",

  // ── A private writer whose every call site is inside the door ──────────────────────────────
  // `organizeHere` is the consent write — the very table and the very race `erasure-fence.ts` was
  // written about — and it opens through `withAccountTx`. These two helpers take its `tx`. The
  // case below checks that claim instead of trusting it: every call of either must sit inside a
  // door span, so a third caller that opens its own transaction turns this reason red.
  "packages/services/src/mailbox-service.ts insert accountSettings":
    "written by `stampScreeningBaseline` / `writeScreeningAnswer` on the fenced transaction " +
    "`organizeHere` opens — asserted, not assumed, by the call-site case in this file",

  // ── db-layer primitives: they write inside the CALLER's transaction ────────────────────────
  // Each takes a handle it did not open. The fence belongs to the door that opened it, which is
  // what `withAccountTx` now is; putting a second fence here would read the account row twice.
  "packages/db/src/change-log.ts insert accountSyncState": "the doorbell, written on the caller's tx",
  "packages/db/src/change-log.ts insert changeLog": "the doorbell, written on the caller's tx",
  "packages/db/src/storage.ts insert accountStorage": "the stored-byte counter, on the caller's tx",
  "packages/db/src/learning-signal.ts insert graduations": "on the caller's tx; the request drain fences",
  "packages/db/src/learning-signal.ts insert learningSignals": "on the caller's tx; the request drain fences",
  "packages/db/src/request-apply.ts insert awayResponders":
    "on the caller's tx — the organizer's request drain fences before it",
  "packages/db/src/request-apply.ts insert accountSettings":
    "on the caller's tx — the organizer's request drain fences before it",
  "packages/db/src/request-apply.ts insert rules":
    "on the caller's tx — the organizer's request drain fences before it, and `RulesService.create` "
    + "calls `reconcileRuleCreate` inside `withAccountTx`, asserted by the rule-create case below",
  "packages/db/src/rule-key.ts insert rules":
    "on the caller's tx — `writeRuleUnderKey`'s callers fence first: the Screener decision (its own "
    + "`readAccountErasedAt`), \"Not junk, always allow\" (`fenceErased`) and the HEY import (`withAccountTx`)",
  "packages/db/src/oauth-ceremony.ts insert mailboxOauthCeremonies":
    "on the caller's tx — `packages/api/src/routes/mailbox-oauth.ts` opens it through "
    + "`withAccountTx`, asserted by the call-site case below. Same correction as its device twin "
    + "for the same reason: \"short-lived, and the sweep deletes it\" described the row and not "
    + "the race, and a row the sweep deletes is exactly the row a late insert PUTS BACK",
  "packages/db/src/oauth-ceremony.ts insert mailboxOauthDeviceCeremonies":
    "on the caller's tx — `packages/api/src/routes/mailbox-oauth-device.ts` opens it through "
    + "`withAccountTx` and the call-site case below asserts that, rather than trusting it. The "
    + "reason it replaces said only \"short-lived, and the sweep deletes it\": short-lived is not "
    + "short enough when the clock is a person approving a code in a browser, and a row the sweep "
    + "deletes is the row a late insert PUTS BACK — sealed ceremony state, live, on an account "
    + "that has been erased",
  "packages/db/src/ai-settings.ts insert auditLog": "the operational trail, on the caller's tx",
  "packages/db/src/mailbox-resync.ts insert auditLog": "the operational trail, on the caller's tx",
  "packages/db/src/organizer-profile-import.ts insert auditLog": "the operational trail, on the caller's tx",
  "packages/core/src/adapters/drizzle-repo.ts insert auditLog": "the operational trail, on the caller's tx",
  "packages/core/src/unscreened-set.ts insert auditLog":
    "the undo row of an undecided-sender move: on `screenUnscreened`'s fenced transaction for the " +
    "Screener's offer, and in `agreeSweepSlice` — a slice of the organizer's sweep after a promotion — a background " +
    "pass, no session; ids, an address the row already held, and counts",
  "packages/core/src/adapters/drizzle-repo.ts insert accountStorage": "the byte counter, on the caller's tx",
  "packages/core/src/adapters/drizzle-repo.ts insert threads": "the ingest repository, on the caller's tx",
  "packages/core/src/adapters/drizzle-repo.ts insert contacts": "the ingest repository, on the caller's tx",
  "packages/core/src/adapters/drizzle-repo.ts insert listAddresses": "the ingest repository, on the caller's tx",
  "packages/core/src/adapters/drizzle-repo.ts insert approvals": "the ingest repository, on the caller's tx",
  // The profile import's one merge (moved from the services door so the organizer can run it): on
  // the CALLER'S tx, and both callers fence — the confirm route through `withAccountTx`, the
  // organizer's job through `fencedAccountWrite` with the mailbox scope. Pinned by the call-site
  // case below, which reads both callers.
  // The search document carries the message's words, and it cannot outlive its message: mail
  // 0125's composite key `(message_id, account_id) -> messages(id, account_id)` takes the message
  // row's key lock, so a write racing the sweep either lands before the delete (which then takes
  // the document) or is refused by the database after it — never an orphan put back.
  "packages/core/src/message-search.ts insert messageSearch":
    "the ingest statement and the store-only backfill, on the caller's tx; the composite key to "
    + "the message refuses a late write",

  // ── Background passes: no session, and their subject is gone after the sweep ───────────────
  // A pass reads a mailbox row before it writes; the sweep deletes `mailboxes`, so the next pass
  // finds nothing to write about. What a pass already past its read can leave is an operational
  // row carrying an account id and an action name — no address, no body, no correspondent.
  // `apps/worker/src/gate-release.ts insert accountSettings` was here, and the reason it carried
  // was wrong in the half that mattered: "the pass reads `mailboxes` first, so a run that starts
  // after the sweep never reaches this write" is true of a run that STARTS after it and says
  // nothing about the run already past that read — which is the one that stamps. The pass pages
  // through an account over minutes; an erasure landing inside that window met an UPSERT into a
  // table the sweep empties. It is fenced now, and pinned below.
  "apps/worker/src/gap-catchup.ts insert auditLog": "a background pass, no session",
  "apps/worker/src/ohbox-tidy.ts insert auditLog": "a background pass, no session",
  "apps/worker/src/redacted-restore.ts insert auditLog": "a background pass, no session",
  "apps/worker/src/rule-retro.ts insert auditLog": "a background pass, no session",
  "apps/worker/src/screener-auto.ts insert auditLog": "a background pass, no session",
  "apps/worker/src/sensitive-backfill.ts insert auditLog": "a background pass, no session",
  "apps/worker/src/workflow-cron.ts insert workflowRuns":
    "the workflow cron, which enqueues only for a workflow row the sweep deletes",
  "packages/services/src/auth/session-reaper.ts insert authEvents":
    "the session reaper, a cron with no session: one `session_reaped` row per session its guarded update "
    + "just revoked, inserted while the chunk holds those sessions' locks in id order, the order an erasure's "
    + "step 7 takes before it deletes `auth_events`; the key to `users` refuses a later row. A fence read "
    + "here makes the erasure the deadlock victim (k91-session-writers-take-id-order.pg.test.ts, reaper first)",
  // The away pass's two writes were here as "the away pass, no session". Having no session is not
  // having no subject: both rows carry the CORRESPONDENT'S ADDRESS, both tables are ones the sweep
  // empties, and the pass SENDS after writing them — so the reason admitted the one door through
  // which an erased account could put a stranger's address back and mail them. Fenced now, and
  // pinned below.
  "packages/services/src/attachment-flag-backfill.ts insert auditLog": "a backfill CLI, no session",
  "packages/services/src/inline-cid-backfill.ts insert auditLog": "a backfill CLI, no session; ids and counts only",
  "packages/services/src/sensitive-rescreen.ts insert auditLog": "a rescreen CLI, no session",

  // ── The LOCAL install's own store (apps/sidecar) ───────────────────────────────────────────
  // A different database: one account, on disk, reached over stdio with no TCP listener. The six
  // mirror-replay entries and the consent write have LEFT this list — the replay's account-owned
  // arms read the account's tombstone through `applyAccountUpsert` and skip on a stamp, and the
  // consent write takes `fenceErasedAccount` like every server door. What remains is the
  // first-boot identity, which creates the account this store is about.
  "apps/sidecar/src/organize-here.ts insert auditLog":
    "the agree record, in `requestOrganizerTakeover`'s transaction after `writeConsentScreening` has " +
    "run `fenceErasedAccount` on it; a mailbox id and nothing else",
  "apps/sidecar/src/identity.ts insert users": "the local install's first-boot identity",
  "apps/sidecar/src/identity.ts insert mailboxes": "the local install's first-boot identity",
};

/**
 * ── THE MAILBOX ALLOW-LIST ───────────────────────────────────────────────────────────────────
 *
 * A FENCED door whose table carries `mailbox_id` and which asks the fence about the account
 * alone, with the reason that mailbox's own erasure cannot reach it. Same rule as the allow-list
 * above: a written ruling, keyed by file, operation and table, never a suppression.
 */
const MAILBOX_ALLOWLIST: Record<string, string> = {
  "packages/services/src/send-service.ts insert outboundSendFingerprints":
    "the reserve transaction refuses a `status = 'disabled'` mailbox BEFORE this claim, and a "
    + "mailbox erasure writes exactly that status — so an erased mailbox never reaches the write. "
    + "Asserted by the case below rather than trusted. A fence here was written and REVERTED: it "
    + "takes a `mailboxes` row lock, and this transaction is built not to block on one — "
    + "`send-disabled-mailbox.pg.test.ts` timed out on it, which is the design saying so",
};

/**
 * ── THE (b1) DOORS A `mailboxes` KEY ALONE STANDS BEHIND ─────────────────────────────────────
 *
 * EMPTY, AND THAT IS THE POINT. There were ten — the ingest repository's three, the mirror
 * replay's three, the folder verb's inventory row and the three credential writers — each into a
 * table whose only NOT NULL key to a swept parent is `mailboxes`, the row a mailbox erasure
 * LEAVES. All ten ask the mailbox stamp now and read as `a-fenced-mailbox-only`, pinned by name
 * below. The set stays as the RATCHET so the class cannot grow back quietly.
 */
const MAILBOX_FK_MEASURED: ReadonlySet<string> = new Set<string>([]);

// ── the cases ────────────────────────────────────────────────────────────────────────────────

describe("the erasure fence census", () => {
  it("looked — the domain, the schema and the doors are all non-empty", () => {
    // The first thing a census must prove is that it looked. A renamed sweep, a glob that stopped
    // matching or a bracket walk that fell off the end reads exactly like a clean sweep otherwise.
    expect(ERASED.size).toBeGreaterThanOrEqual(60);
    expect(ERASED.has("account_settings")).toBe(false);   // symbols, not table names
    expect(ERASED.has("accountSettings")).toBe(true);
    expect(ERASED.has("accounts")).toBe(false);           // the row erasure KEEPS
    expect(FKS.size).toBeGreaterThanOrEqual(50);
    expect(DOORS.length).toBeGreaterThanOrEqual(400);
    expect(DOORS.filter((d) => d.cls === "a-fenced").length).toBeGreaterThanOrEqual(10);
    expect(DOORS.filter((d) => d.cls === "b1-fk").length).toBeGreaterThanOrEqual(40);
  });

  it("the seam fences before it hands the transaction over", () => {
    // Without this, every (a) above is decorative: the census would read `fencedAccountWrite(`
    // and conclude "fenced" for a wrapper that fences nothing. The fence must be the FIRST await
    // inside the seam's transaction callback — first because it is the head of the global lock
    // order, and a lock taken in front of it is the sweep's deadlock partner.
    const src = withoutComments(read(SEAM_FILE));
    const at = src.indexOf("export async function fencedAccountWrite");
    expect(at, "the seam has moved or been renamed").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}", at));
    const tx = body.indexOf(".transaction(");
    expect(tx, "the seam no longer opens a transaction").toBeGreaterThan(-1);
    const inside = body.slice(tx);
    const fence = inside.indexOf("fenceErased(");
    expect(fence, "the seam opens a transaction without fencing it").toBeGreaterThan(-1);
    // …and nothing else awaits ahead of it: the one `await` between the transaction opening and
    // the fence is the fence's own. A lock taken in front of it would cross `deleteAccount`'s
    // order and make this seam the sweep's deadlock partner.
    expect(inside.slice(0, fence).match(/\bawait\b/g) ?? []).toHaveLength(1);
  });

  it("the seam asks the ACCOUNT first and the MAILBOX second", () => {
    /**
     * The lock order, in the one place that decides it. `deleteAccount` stamps `accounts` as its
     * first statement and `sweepMailboxData`'s caller takes the account row before the mailbox
     * row; a fence reading them the other way round is the diagonal those two orders exist to
     * avoid. Read off `fenceErased`'s own body rather than asserted about it.
     */
    const src = withoutComments(read(SEAM_FILE));
    const at = src.indexOf("export async function fenceErased(");
    expect(at, "the fence has moved or been renamed").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}", at));
    const account = body.indexOf("readAccountErasedAt(");
    const mailbox = body.indexOf("readMailboxErasedAt(");
    expect(account, "the fence no longer reads the account").toBeGreaterThan(-1);
    expect(mailbox, "the fence no longer reads the mailbox").toBeGreaterThan(-1);
    expect(account, "the mailbox row is read before the account row").toBeLessThan(mailbox);
  });

  it("the one door that opens a transaction is the seam — the services door delegates", () => {
    // `withAccountTx` was its own `transaction(…) { fence; fn }` and is now the seam plus an
    // error shape. A second implementation is how the two drift: this refuses one appearing.
    const src = withoutComments(read(DOOR));
    const at = src.indexOf("export async function withAccountTx");
    expect(at, "withAccountTx has moved or been renamed").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(body, "the services door opens its own transaction again").not.toContain(".transaction(");
    expect(body, "the services door no longer goes through the seam").toContain("fencedAccountWrite(");
  });

  it("every unfenced writer is on the written allow-list — a new one is red by name", () => {
    const unruled = DOORS
      .filter((d) => d.cls === "c-unfenced" && ALLOWLIST[key(d)] === undefined)
      .map((d) => `${d.file}:${d.line} inserts ${d.table}`);
    expect(
      unruled,
      "a write that can create an account-owned row AFTER the Art. 17 sweep commits. Open it " +
        "through `withAccountTx` (packages/services/src/context.ts), or add it to ALLOWLIST in " +
        "this file with the reason it legitimately runs without a session.",
    ).toEqual([]);
  });

  it("a fenced door writing a MAILBOX's row asks the fence about the mailbox too", () => {
    /**
     * THE GRANULARITY HALF, and the reason "add the call" was never the whole answer. A mailbox
     * removal leaves the `mailboxes` row standing as a tombstone, so the ACCOUNT's stamp says
     * nothing about it: `reader-request.ts` DID fence, account-only, and still admitted an erased
     * mailbox's correspondent and decision into `organizer_requests`. A door whose table carries
     * `mailbox_id` passes the mailbox to the seam, or it is refusing the wrong erasure.
     */
    const accountOnly = DOORS
      .filter((d) => d.cls === "a-fenced-account-only" && MAILBOX_ALLOWLIST[key(d)] === undefined)
      .map((d) => `${d.file}:${d.line} ${d.op}s ${d.table} (mailbox-keyed, fenced on the account alone)`);
    expect(
      accountOnly,
      "a fenced write into a table one MAILBOX owns, asked about the account alone. Pass the " +
        "`mailboxId` to the seam, or add it to MAILBOX_ALLOWLIST with the reason the mailbox's " +
        "own erasure cannot reach it.",
    ).toEqual([]);
  });

  it("the send's fingerprint claim is covered by the disabled-mailbox refusal above it", () => {
    /**
     * The one MAILBOX_ALLOWLIST reason, and it is a claim about OTHER CODE in the same
     * transaction — the shape this file always checks rather than trusts. A mailbox erasure
     * writes `status = 'disabled'`, and the reserve transaction refuses that status before it
     * claims the fingerprint; move the refusal below the claim, or drop it, and the reason is a
     * sentence about a program that no longer exists.
     */
    const file = "packages/services/src/send-service.ts";
    const src = withoutComments(read(file));
    const refusal = src.search(/\bmb\?\.status\s*===\s*"\s*"/);
    expect(refusal, "the disabled-mailbox refusal is gone from the send").toBeGreaterThan(-1);
    const claims = hits(src, String.raw`\.insert\(\s*outboundSendFingerprints\s*\)`);
    expect(claims.length, "the fingerprint claim is gone").toBeGreaterThanOrEqual(1);
    for (const [at] of claims) {
      expect(at, `a fingerprint claim at line ${lineOf(src, at)} runs BEFORE the refusal`)
        .toBeGreaterThan(refusal);
    }
    // …and both sit inside ONE transaction, or the order above buys nothing.
    const doors = hits(src, String.raw`\bwithAccountTx\s*\(`)
      .map(([i, m]) => span(src, i + m[0].length - 1));
    expect(doors.some(([a, b]) => refusal > a && claims.every(([at]) => at < b)),
      "the refusal and the claim are no longer in one transaction").toBe(true);
  });

  it("the doors resting only on a `mailboxes` key are the measured set, and nothing joins it", () => {
    /**
     * (b1) proves an insert unreachable after the ACCOUNT sweep, because the sweep DELETES the
     * parent. It proves nothing about a MAILBOX erasure, which leaves its row: such a door is
     * refused by a key to a row that is still there. The set is EMPTY now — all ten ask the
     * mailbox arm — and it stays as the ratchet against a new one.
     */
    const live = DOORS.filter((d) => d.cls === "b1-fk-mailbox").map((d) => `${d.file} ${d.table}`);
    expect(
      [...new Set(live)].filter((k) => !MAILBOX_FK_MEASURED.has(k)).sort(),
      "a NEW insert whose only refusal is a key to `mailboxes` — a row the mailbox sweep leaves " +
        "standing, so the key refuses nothing. Fence it on the mailbox through the seam, or add " +
        "it to MAILBOX_FK_MEASURED with the reason it cannot outlive its mailbox.",
    ).toEqual([]);
    // …and the list may not outlive its doors, the same rule the allow-list keeps.
    expect([...MAILBOX_FK_MEASURED].filter((k) => !live.includes(k)).sort(),
      "a MAILBOX_FK_MEASURED entry that no longer names a real door").toEqual([]);
  });

  it("every door resting on a `mailboxes` key asks that mailbox's stamp, and each is pinned", () => {
    /**
     * THE TEN, BY NAME. Each writes a table whose only NOT NULL key to a swept parent is
     * `mailboxes`: the ACCOUNT sweep deletes that parent, so the key refuses it by construction,
     * and a MAILBOX erasure leaves the row standing as the tombstone — the stamp is the only
     * thing left that can refuse them. Pinned by key rather than counted, so a revert reads as a
     * missing key here and not as a number somebody could re-baseline.
     */
    const armed = new Set(DOORS.filter((d) => d.cls === "a-fenced-mailbox-only").map(key));
    for (const k of [
      // The connect ceremony's credential writer — the one door into `mailbox_credentials` in
      // the service. A credential re-minted for an erased mailbox is a live way back into it.
      "packages/services/src/mailbox-service.ts insert mailboxCredentials",
      // The local install's two: the launch seal and the submission copy beside it.
      "apps/sidecar/src/engine.ts insert mailboxCredentials",
      // The ingest repository — the mail-sync writers this fence had never covered.
      "packages/core/src/adapters/drizzle-repo.ts insert messages",
      "packages/core/src/adapters/drizzle-repo.ts insert messageFailures",
      "packages/core/src/adapters/drizzle-repo.ts insert mailboxFolders",
      // The folder verb's inventory row.
      "packages/services/src/folder-ops-service.ts insert mailboxFolders",
      // The local mirror replay: folders, mail and unsent words.
      "apps/sidecar/src/cloud-mirror.ts insert mailboxFolders",
      "apps/sidecar/src/cloud-mirror.ts insert messages",
      "apps/sidecar/src/cloud-mirror.ts insert drafts",
    ]) expect(armed, `${k} no longer asks the mailbox stamp`).toContain(k);
    // TEN DOORS, NINE KEYS: `engine.ts` seals twice — the imap row at launch and the smtp copy
    // beside it — and a key naming a file and a table cannot tell them apart, so the pair is
    // counted here rather than left invisible.
    expect(DOORS.filter((d) =>
      d.file === "apps/sidecar/src/engine.ts" && d.cls === "a-fenced-mailbox-only").length,
    "the local install seals two credential rows; one of the pair is no longer fenced").toBe(2);
    // THE INGEST REPOSITORY WRITES `mailbox_folders` TWICE — the cursor upsert and the budget
    // stop's own (mail 0115), which may not advance a cursor and so cannot ride the first. A key
    // naming a file and a table cannot tell them apart, exactly as with the `engine.ts` pair
    // above, so the pair is asserted here rather than left invisible behind one key.
    expect(DOORS.filter((d) =>
      d.file === "packages/core/src/adapters/drizzle-repo.ts" && d.table === "mailboxFolders"
      && d.cls === "a-fenced-mailbox-only").length,
    "the ingest repository writes mailbox_folders twice; one of the pair is no longer fenced").toBe(2);
    // AND THE TWO THAT RODE ALONG, named so the number is not a surprise: each sits in the same
    // block as one of the ten, behind the same call, and each was already (b1) against the
    // ACCOUNT sweep through a key to a parent that is not `mailboxes` — `folder_state` to
    // `messages`, `folder_ops` to the folder row. Thirteen doors, ten of them the subject.
    expect(DOORS.filter((d) => d.cls === "a-fenced-mailbox-only").length).toBe(13);
  });

  it("nothing asks the mailbox alone where the account erasure is not refused by construction", () => {
    /**
     * The mailbox arm says NOTHING about the account. It is sound exactly where the row hangs off
     * a NOT NULL key to a parent the account sweep deletes — with no such key, a door using it is
     * fenced against one erasure and open to the other, which reads as covered and is not.
     */
    const unsound = DOORS
      .filter((d) => d.cls === "c-mailbox-only-no-account-refusal")
      .map((d) => `${d.file}:${d.line} inserts ${d.table} (mailbox arm, no key refusing the account)`);
    expect(
      unsound,
      "a write fenced with `fenceErasedMailbox` into a table nothing keys to a swept parent: the "
        + "account's Art. 17 sweep is not refused here. Open it through `withAccountTx` (or "
        + "`fenceErased` with both ids) instead.",
    ).toEqual([]);
  });

  it("refuses a PLANTED bare insert — the census's own positive control", () => {
    /**
     * Every case above says what the repository looks like today. This one drives the classifier
     * with a door it has never seen: a bare `tx.insert(snippets)` in a fixture, outside any seam
     * and on no allow-list. Without it, a classifier that quietly stopped matching `.insert(`
     * would pass every case in this file by finding nothing at all — which is how a census reads
     * green for a repository it is no longer looking at.
     */
    const planted = `
      import { snippets } from "@trafficflow/db";
      export async function backDoor(tx: Tx, accountId: string) {
        await tx.insert(snippets).values({ accountId, title: "t", body: "b" });
      }
    `;
    expect(classify(PLANTED, planted)
      .map((d) => `${d.table} ${d.cls}`))
      .toEqual(["snippets c-unfenced"]);

    // …and the same insert THROUGH the seam is admitted, so the refusal above is not "everything".
    const fenced = `
      import { snippets, fencedAccountWrite } from "@trafficflow/db";
      export async function frontDoor(db: Tx, accountId: string) {
        await fencedAccountWrite(db, { accountId }, async (tx) => {
          await tx.insert(snippets).values({ accountId, title: "t", body: "b" });
        });
      }
    `;
    expect(classify(PLANTED, fenced)
      .map((d) => `${d.table} ${d.cls}`))
      .toEqual(["snippets a-fenced"]);

    /* A RETURN TYPE WITH BRACES OF ITS OWN — the hole measured 2026-09-22. Both arms of `bodies`
       took the first `{` after the argument list, so the span was the TYPE and the fence above the
       write fell outside it: a correctly fenced door read `c-unfenced`. Driven both ways, because
       a body brace that now lands past every type would make the refusal below unreachable. */
    const typedReturn = `
      import { snippets, fenceErased } from "@trafficflow/db";
      export async function typedDoor(tx: Tx, accountId: string): Promise<{ n: number }> {
        await fenceErased(tx, dialect(tx), { accountId });
        await tx.insert(snippets).values({ accountId, title: "t", body: "b" });
        return { n: 1 };
      }
    `;
    expect(classify(PLANTED, typedReturn)
      .map((d) => `${d.table} ${d.cls}`))
      .toEqual(["snippets a-fenced"]);

    const typedReturnUnfenced = `
      import { snippets } from "@trafficflow/db";
      export async function typedBackDoor(tx: Tx, accountId: string): Promise<{ n: number }> {
        await tx.insert(snippets).values({ accountId, title: "t", body: "b" });
        return { n: 1 };
      }
    `;
    expect(classify(PLANTED, typedReturnUnfenced)
      .map((d) => `${d.table} ${d.cls}`))
      .toEqual(["snippets c-unfenced"]);

    // An ALIASED planted insert, which is the hole this census carried until now.
    const aliased = `
      import { snippets as snip } from "@trafficflow/db";
      export async function aliasDoor(tx: Tx, accountId: string) {
        await tx.insert(snip).values({ accountId, title: "t", body: "b" });
      }
    `;
    expect(classify(PLANTED, aliased)
      .map((d) => `${d.table} ${d.cls}`))
      .toEqual(["snippets c-unfenced"]);

    // A MAILBOX-keyed insert fenced on the account alone — the granularity refusal, driven.
    const accountOnly = `
      import { organizerRequests, fencedAccountWrite } from "@trafficflow/db";
      export async function halfDoor(db: Tx, accountId: string, mailboxId: string) {
        await fencedAccountWrite(db, { accountId }, async (tx) => {
          await tx.insert(organizerRequests).values({ accountId, mailboxId });
        });
      }
    `;
    expect(classify(PLANTED, accountOnly)
      .map((d) => `${d.table} ${d.cls}`))
      .toEqual(["organizerRequests a-fenced-account-only"]);

    /* THE MAILBOX ARM, BOTH OUTCOMES, DRIVEN. `messages` hangs off `mailboxes` with a NOT NULL
       key the account sweep deletes, so the arm is sound there and the door is admitted;
       `snippets` hangs off the account alone — the row erasure KEEPS — so the same call leaves
       the account erasure unrefused and the door is printed. The pair is what makes the
       admission mean something: a rule that admitted both would admit every door in the
       repository for the price of one call. Neither planted call spells `mailboxId`: the scope
       is the function's, not the argument's name. */
    const mailboxArm = `
      import { messages, fenceErasedMailbox } from "@trafficflow/db";
      export async function ingestDoor(tx: Tx, d: Dialect, input: InsertInput) {
        await fenceErasedMailbox(tx, d, input.box);
        await tx.insert(messages).values({ accountId: input.accountId, mailboxId: input.box });
      }
    `;
    expect(classify(PLANTED, mailboxArm)
      .map((d) => `${d.table} ${d.cls}`))
      .toEqual(["messages a-fenced-mailbox-only"]);

    const mailboxArmUnsound = `
      import { snippets, fenceErasedMailbox } from "@trafficflow/db";
      export async function wrongDoor(tx: Tx, d: Dialect, input: InsertInput) {
        await fenceErasedMailbox(tx, d, input.box);
        await tx.insert(snippets).values({ accountId: input.accountId, title: "t", body: "b" });
      }
    `;
    expect(classify(PLANTED, mailboxArmUnsound)
      .map((d) => `${d.table} ${d.cls}`))
      .toEqual(["snippets c-mailbox-only-no-account-refusal"]);

    // …and the arm is POSITIONAL like every other fence here: the same call AFTER the write
    // leaves the door exactly as it was, which is what stops a trailing check reading as one.
    const mailboxArmAfter = `
      import { messages, fenceErasedMailbox } from "@trafficflow/db";
      export async function lateDoor(tx: Tx, d: Dialect, input: InsertInput) {
        await tx.insert(messages).values({ accountId: input.accountId, mailboxId: input.box });
        await fenceErasedMailbox(tx, d, input.box);
      }
    `;
    expect(classify(PLANTED, mailboxArmAfter)
      .map((d) => `${d.table} ${d.cls}`))
      .toEqual(["messages b1-fk-mailbox"]);

    /* AND THE SIBLING ARM — the defect this rule was written for, driven rather than described.
       One `switch`, the fence in the first arm, the write in the second: the fence is textually
       before the write and inside the same function body, and it can never run for it. The
       first arm is admitted, the second is not. */
    const siblingArms = `
      import { messages, mailboxFolders, fenceErasedMailbox } from "@trafficflow/db";
      export async function replay(tx: Tx, d: Dialect, ch: Change) {
        switch (ch.type) {
          case "folder": {
            await fenceErasedMailbox(tx, d, ch.box);
            await tx.insert(mailboxFolders).values({ mailboxId: ch.box });
            return true;
          }
          case "message": {
            await tx.insert(messages).values({ mailboxId: ch.box });
            return true;
          }
        }
      }
    `;
    expect(classify(PLANTED, siblingArms)
      .map((d) => `${d.table} ${d.cls}`))
      .toEqual(["mailboxFolders a-fenced-mailbox-only", "messages b1-fk-mailbox"]);
  });

  it("an aliased table import does not hide a door", () => {
    /**
     * `import { rules as rulesTbl }` and then `tx.insert(rulesTbl)`: the census asked about a
     * symbol the sweep never mentions, matched nothing and reported NOTHING. Seven files alias a
     * table this way and `learning-service.ts`'s promoted-rule insert was invisible in every run
     * of this census until the alias was resolved. Asserted on a file that HAS the property: the
     * promotion now writes through `rule-key.ts`, whose insert is the aliased one.
     */
    const src = withoutComments(read("packages/db/src/rule-key.ts"));
    expect(aliases(src).get("rulesTbl"), "rule-key.ts no longer aliases `rules`").toBe("rules");
    expect(
      DOORS.some((d) => d.file === "packages/db/src/rule-key.ts" && d.table === "rules"),
      "the aliased write is invisible to the census again",
    ).toBe(true);
  });

  it("a helper allow-listed as fenced-by-its-caller is called only from inside the door", () => {
    // The one allow-list reason that is a claim about OTHER code rather than about the writer
    // itself. A reason nobody checks is how a ruling outlives the program it was about: a third
    // caller opening its own transaction would leave the consent write unfenced while this file
    // still said it was covered.
    const file = "packages/services/src/mailbox-service.ts";
    const src = withoutComments(read(file));
    const doors = hits(src, String.raw`\bwithAccountTx\s*\(`)
      .map(([i, m]) => span(src, i + m[0].length - 1));
    expect(doors.length, "the door is gone from this file").toBeGreaterThanOrEqual(1);

    const loose: string[] = [];
    for (const helper of ["stampScreeningBaseline", "writeScreeningAnswer"]) {
      const calls = hits(src, String.raw`this\.${helper}\s*\(`);
      expect(calls.length, `${helper} is no longer called`).toBeGreaterThanOrEqual(1);
      for (const [at] of calls) {
        if (!doors.some(([a, b]) => at > a && at < b)) loose.push(`${file}:${lineOf(src, at)} ${helper}`);
      }
    }
    expect(loose, "a consent-settings writer called outside the fenced door").toEqual([]);
  });

  it("the profile import's one merge runs only inside a fenced door, at its two callers", () => {
    // The merge fences its mailbox with the account itself, and its callers open the door it runs
    // in: this is the check that both do. Two callers, each inside its door; a third, or one
    // outside a door, is red by file and line.
    const callers = ["packages/services/src/profile-import-service.ts", "apps/worker/src/profile.ts"];
    const loose: string[] = [];
    for (const file of callers) {
      const src = withoutComments(read(file));
      const doors = hits(src, String.raw`\b(?:withAccountTx|fencedAccountWrite)\s*\(`)
        .map(([i, m]) => span(src, i + m[0].length - 1));
      const calls = hits(src, String.raw`\bapplyOrganizerProfile\s*\(`);
      expect(calls.length, `${file} no longer calls the merge`).toBeGreaterThanOrEqual(1);
      for (const [at] of calls) {
        if (!doors.some(([a, b]) => at > a && at < b)) loose.push(`${file}:${lineOf(src, at)}`);
      }
    }
    expect(loose, "the import merge called outside a fenced door").toEqual([]);
    const elsewhere = serverSources().filter((f) => !callers.includes(f)
      && !f.endsWith("organizer-profile-store.ts")
      && /\bapplyOrganizerProfile\s*\(/.test(withoutComments(read(f))));
    expect(elsewhere, "a third caller of the import merge").toEqual([]);
    // ONE IMPORTER: the services door keeps no copy of the merge's writes.
    const door = withoutComments(read("packages/services/src/profile-import-service.ts"));
    expect(door.match(/\btx\.(?:insert|update)\s*\(\s*(?:rules|contacts|notifyRules|awayResponders|tags|mailboxes)\b/g) ?? [],
      "the services door writes the merge's tables itself").toEqual([]);
  });

  it("carries no allow-list entry for a door that no longer exists", () => {
    // A reason that outlives its code is worse than none: it reads as a ruling somebody made
    // about the current program. Every entry must still name a real unfenced door.
    const live = new Set(DOORS.filter((d) => d.cls === "c-unfenced").map(key));
    expect([...Object.keys(ALLOWLIST)].filter((k) => !live.has(k))).toEqual([]);
  });

  it("every allow-list reason is written, not a placeholder", () => {
    const thin = Object.entries(ALLOWLIST).filter(([, why]) => why.trim().length < 20);
    expect(thin.map(([k]) => k)).toEqual([]);
  });

  it("the writers moved onto the door read as fenced, table by table", () => {
    // The positive control for the conversion: these are the request-scoped writers this slice
    // moved. If `withAccountTx` were reverted at any of them the case above would pass — the door
    // would simply be gone — so the fenced set is asserted by name rather than by count.
    const fenced = new Set(DOORS.filter((d) => d.cls === "a-fenced").map(key));
    for (const k of [
      "packages/services/src/mailbox-service.ts insert mailboxes",
      "packages/services/src/tags-service.ts insert tags",
      "packages/services/src/snippets-service.ts insert snippets",
      "packages/services/src/notify-rules-service.ts insert notifyRules",
      "packages/services/src/kb-service.ts insert kbEntries",
      "packages/services/src/workflows-service.ts insert workflows",
      "packages/services/src/workflows-service.ts insert workflowRuns",
      "packages/services/src/away-responder-service.ts insert awayResponders",
      "packages/services/src/push-service.ts insert pushSubscriptions",
      "packages/services/src/send-service.ts insert outboundSends",
      // The profile import's writes moved into `applyOrganizerProfile` (core), which fences its
      // mailbox with the account; the two callers that open its transaction are pinned below.
      "packages/api/src/junk-window.ts insert contacts",
      // ── The three writers a reference taken before the fence licensed a write after ──
      // Each was allow-listed above with a written reason, and each reason was true about the
      // wrong moment: it described a pass that STARTS after the sweep, never one already past its
      // read. These three keys are the pin — a revert reads as a missing key here, not as an
      // allow-list entry somebody could re-add without noticing what it admits.
      "packages/services/src/away-responder-pass.ts insert awayReplies",
      "packages/services/src/away-responder-pass.ts insert awaySenderState",
      "apps/worker/src/gate-release.ts insert accountSettings",
      // The profile marker now rings the settings doorbell in the same transaction, so it is
      // fenced with it: a late marker must not append a change row to an erased account's log.
      "apps/worker/src/profile.ts insert auditLog",
    ]) expect(fenced, `${k} is no longer fenced`).toContain(k);
  });

  it("the away pass writes NOTHING account-owned outside the fenced reservation", () => {
    /**
     * THE COUNT, AND WHY IT IS A COUNT. The pin above names the two tables the pass writes today;
     * this case refuses a THIRD write appearing unfenced beside them. The away pass is the one
     * writer here that SENDS — a row it recreates is followed by mail leaving the building — so
     * "every write in this file is fenced" is the property, not "the two we knew about are".
     * Rises only by a fenced site: an unfenced addition lands in `unfenced` and prints its line.
     */
    const file = "packages/services/src/away-responder-pass.ts";
    const mine = DOORS.filter((d) => d.file === file && d.op === "insert");
    expect(mine.length, "the away pass no longer inserts into any erased table").toBeGreaterThanOrEqual(2);
    const unfenced = mine.filter((d) => d.cls !== "a-fenced")
      .map((d) => `${d.file}:${d.line} inserts ${d.table} (${d.cls})`);
    expect(
      unfenced,
      "an away-pass write into a table the Art. 17 sweep empties, outside the fenced reservation. "
        + "This pass sends mail after it writes: an unfenced row here is a correspondent's address "
        + "recreated on an erased account, and then a reply to them.",
    ).toEqual([]);
  });

  it("BOTH connect ceremonies are created only inside the fenced door", () => {
    /**
     * The allow-list reasons for the two `oauth-ceremony.ts` inserts are claims about OTHER code —
     * the same shape as the `mailbox-service.ts` case above, and checked the same way. Each
     * `create*Ceremony` takes a `tx` it did not open, so the fence belongs to whoever opens it;
     * a caller opening a bare transaction would leave the ceremony unfenced while the allow-list
     * still said it was covered.
     *
     * BOTH, in one case, because that is how this defect travelled: the device route was fixed
     * first and the redirect route beside it carried the identical reason and the identical hole.
     * A case naming only one of a pair is how the second one survives a fix aimed at the first.
     */
    for (const [file, helper] of [
      ["packages/api/src/routes/mailbox-oauth-device.ts", "createDeviceCeremony"],
      ["packages/api/src/routes/mailbox-oauth.ts", "createOAuthCeremony"],
    ] as const) {
      const src = withoutComments(read(file));
      const doors = hits(src, String.raw`\bwithAccountTx\s*\(`)
        .map(([i, m]) => span(src, i + m[0].length - 1));
      expect(doors.length, `the door is gone from ${file}`).toBeGreaterThanOrEqual(1);

      const calls = hits(src, String.raw`\b${helper}\s*\(`);
      expect(calls.length, `${helper} is no longer called in ${file}`).toBeGreaterThanOrEqual(1);
      const loose = calls
        .filter(([at]) => !doors.some(([a, b]) => at > a && at < b))
        .map(([at]) => `${file}:${lineOf(src, at)} ${helper}`);
      expect(loose, `a connect ceremony minted outside the fenced door (${helper})`).toEqual([]);
    }
  });

  it("the local rule doors (create, update, remove) write rules only inside the fenced door", () => {
    // The three doors converge a key through the db layer (`reconcileRuleCreate`, `convergeRuleKey`)
    // and write by id; every such call, and the rule-key lock before it, sits inside `withAccountTx`.
    const file = "packages/services/src/rules-service.ts";
    const src = withoutComments(read(file));
    const doors = hits(src, String.raw`\bwithAccountTx\s*\(`).map(([i, m]) => span(src, i + m[0].length - 1));
    expect(doors.length, "create, update and remove each open through withAccountTx").toBeGreaterThanOrEqual(3);
    const calls = hits(src, String.raw`\b(?:reconcileRuleCreate|convergeRuleKey|lockAccountRuleKeys|recordRuleDelta)\s*\(|\.(?:update|delete)\(\s*rules\s*\)`);
    for (const name of ["reconcileRuleCreate", "convergeRuleKey", "lockAccountRuleKeys"]) {
      expect(calls.some(([, m]) => m[0].startsWith(name)), `${name} is no longer called in ${file}`).toBe(true);
    }
    const loose = calls.filter(([at]) => !doors.some(([a, b]) => at > a && at < b))
      .map(([at, m]) => `${file}:${lineOf(src, at)} ${m[0]}`);
    expect(loose, "a rule written outside the fenced door").toEqual([]);
  });

  it("proves the (b1) ordering it rests on, rather than asserting it", () => {
    // "Fenced by construction" is a claim about the schema AND about the sweep. Both halves are
    // read here for a sample of the tables it covers: the FK exists and is NOT NULL, and its
    // parent is a table `deleteAccount` deletes — so an insert after the sweep has no parent.
    for (const [child, parent] of [
      ["messages", "mailboxes"], ["messageStates", "messages"], ["messageBodies", "messages"],
      ["mailboxFolders", "mailboxes"], ["drafts", "mailboxes"],
    ] as const) {
      const fk = (FKS.get(child) ?? []).find((p) => p.notNull && p.parent === parent);
      expect(fk, `${child} no longer has a NOT NULL key to ${parent}`).toBeDefined();
      expect(ERASED.has(parent), `${parent} is no longer deleted by the sweep`).toBe(true);
    }
    // …and the counter-example that keeps the rule honest. `users.account_id` is NOT NULL and
    // references `accounts` — the one row erasure KEEPS — so that key refuses nothing and a
    // `users` insert stays class (c). A rule that counted `accounts` as a parent would have
    // passed the whole census for nothing.
    expect((FKS.get("users") ?? []).some((p) => p.notNull && p.parent === "accounts")).toBe(true);
    expect(DOORS.some((d) => d.table === "users" && d.op === "insert" && d.cls === "c-unfenced"))
      .toBe(true);
  });
});
