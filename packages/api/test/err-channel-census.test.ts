import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE `err` CHANNEL CARRIES THE THROWN VALUE, IN `packages/api/src` AND `apps/worker/src`.
 *
 * `err` is the logger's own slot, not an allowlisted field: `createLogger` deletes it and emits
 * `errorClass` + `errorCode` from the value, plus a thrown STRING's own redacted text as
 * `errorText`. So `err: String(e)` is not a smaller line — it is a DIFFERENT one. Measured on the
 * real logger at that change: `err: String(new Error("connect ECONNREFUSED 10.0.0.1:5432 …"))`
 * emits `errorClass:"String", errorCode:null, errorText:"Error: connect ECONNREFUSED …"`, and the
 * value emits `errorClass:"Error", errorCode:"ECONNREFUSED"`. The driver's message reaches the
 * line through the channel built for a genuinely thrown string; the class and code are gone.
 *
 * SCOPE, and why these two roots. `apps/sidecar/test/log-census.test.ts` asks the same question of
 * `apps/sidecar/src` and says in its header that widening is owed work. This widens it by
 * measurement rather than by ambition: `packages/api/src` held all seven surviving sites and
 * `apps/worker/src` holds 63 already-clean ones, so one root is the fix and the other is the lock.
 * `apps/api-vercel/src` is scanned too, at a floor of 2 — which is its whole count. It was
 * reported as ZERO from a line-based grep and is 2 once the extractor reads a call spanning
 * lines; both are already the thrown value, so it is the cheapest lock in the set.
 *
 * RECURSIVE, and that is load-bearing: three of the seven live under `routes/`, and the sidecar
 * census's flat `readdirSync` would have missed them. The control below plants a stringified
 * throw under `routes/` specifically.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/** The roots, with the floor each must clear on its own. A root that stops being scanned reads 0. */
const ROOTS: readonly { dir: string; atLeast: number }[] = [
  // Counts at that change: 37, 135, 2. Each floor is below its count and above zero, so a root
  // that silently stopped being walked reads 0 and refuses instead of passing empty.
  { dir: join(REPO, "packages", "api", "src"), atLeast: 30 },
  { dir: join(REPO, "apps", "worker", "src"), atLeast: 100 },
  // The API program's wiring, which took the function host's two sites with it.
  { dir: join(REPO, "apps", "server", "src"), atLeast: 2 },
];

/** Every stringifying form an `err:` value can take. Each was reachable here; none is hypothetical. */
const STRINGIFIES: readonly { re: RegExp; why: string }[] = [
  { re: /\bString\s*\(/, why: "String(err) — the class and code are blanked and the message becomes errorText" },
  { re: /\bJSON\s*\.\s*stringify\s*\(/, why: "JSON.stringify(err) — an Error serialises to `{}`" },
  { re: /\.\s*message\b/, why: "err.message — a driver's prose in the channel built to refuse it" },
  { re: /\.\s*stack\b/, why: "err.stack — never logged; the class and code are the record" },
  { re: /\.\s*toString\s*\(/, why: "err.toString() — the same loss as String(err)" },
  { re: /^`/, why: "a template literal — the thrown value has already become text" },
];

/** Every `.ts` under `dir`, at any depth. Not `.d.ts`, which declares and calls nothing. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The index of the matching close bracket for the open bracket at `open`. */
function matchParen(s: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[s[open]!];
  if (close === undefined) return -1;
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i]!;
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") { depth -= 1; if (depth === 0) return c === close ? i : -1; }
  }
  return -1;
}

/** The top-level comma positions in `(from, to)`. */
function topLevelCommas(s: string, from: number, to: number): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const c = s[i]!;
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) out.push(i);
  }
  return out;
}

/**
 * Every `err:` value written at a `log(...)`-shaped call. The MASK decides where a key is, so an
 * `err:` inside a sentence cannot be read as a field; names come back out of the comment-stripped
 * text at the same offsets. Depth 1 only — an `err:` nested in a sub-object is that object's
 * business and the logger never reads it as the thrown value.
 */
export function errValues(source: string, file: string): { file: string; value: string }[] {
  const code = withoutComments(source);
  const mask = withoutCommentsAndLiterals(source);
  const out: { file: string; value: string }[] = [];
  const call = /\blog\s*\??\.?\s*\(|\.(?:debug|info|warn|error)\s*\??\.?\s*\(/g;
  for (let m = call.exec(mask); m !== null; m = call.exec(mask)) {
    const open = mask.indexOf("(", m.index);
    if (open === -1) continue;
    const close = matchParen(mask, open);
    if (close === -1) continue;
    const commas = topLevelCommas(mask, open + 1, close);
    if (commas.length === 0) continue;
    const objStart = mask.indexOf("{", commas[0]!);
    if (objStart === -1 || objStart > close) continue;
    const objEnd = matchParen(mask, objStart);
    if (objEnd === -1) continue;
    const key = /(?:^|[{,\s])err\s*(?=[:,}\n])/g;
    /* THE CLOSING BRACE IS IN THE SLICE, and it is the whole of a defect this census found in the
       extractor it was lifted from: the key's lookahead needs a `:`, `,` or `}` after the name, so
       `{ err }` — `err` LAST, which is what six of this root's sites and all seven of the ones
       this lane closed are written as — ran off the end of the slice and matched nothing. An
       extractor blind to the commonest spelling is a census measuring the other ones. */
    const within = mask.slice(objStart, objEnd + 1);
    for (let k = key.exec(within); k !== null; k = key.exec(within)) {
      const at = objStart + k.index + k[0].length;
      let depth = 0;
      for (let i = objStart + 1; i < at; i += 1) {
        const c = mask[i]!;
        if (c === "{" || c === "(" || c === "[") depth += 1;
        else if (c === "}" || c === ")" || c === "]") depth -= 1;
      }
      if (depth !== 0) continue;
      /* SHORTHAND is the thrown value by construction — there is no expression to read. */
      const colon = /^\s*:/.exec(mask.slice(at, objEnd));
      if (colon === null) { out.push({ file, value: "err" }); continue; }
      const from = at + colon[0].length;
      const ends = topLevelCommas(mask, from, objEnd);
      out.push({ file, value: code.slice(from, ends[0] ?? objEnd).trim() });
    }
  }
  return out;
}

const FIXTURE = String.raw`
  log("a_bare_throw_failed", { err, reason: "the shape every site must have" });
  log("a_renamed_throw_failed", { err: caught, reason: "an identifier is still the value" });
  deps.logger?.warn?.("an_optional_call_failed", { mailboxId, err });
  (deps.logger ?? silentLogger).warn?.("a_guarded_call_failed", { err: String(caught) });
  log("a_messaged_failed", { err: caught.message, reason: "refused" });
  log("a_nested_one", { detail: { err: String(x) }, reason: "not the logger's channel" });
  log("a_sentence", { reason: "the err: prefix inside prose is not a field" });
`;

describe("the extractor bites — this guard is not vacuous", () => {
  it("reads the VALUE at depth 1, through both call spellings, and not out of prose", () => {
    expect(errValues(FIXTURE, "fixture").map((f) => f.value),
      "the extractor lost a site, or invented one out of prose").toEqual([
      "err", "caught", "err", "String(caught)", "caught.message",
    ]);
  });

  it("refuses every stringifying form — the positive control for the refusal itself", () => {
    const refused = errValues(FIXTURE, "fixture")
      .filter((f) => STRINGIFIES.some((s) => s.re.test(f.value)));
    expect(refused.map((f) => f.value), "the refusal admits a pre-stringified throw")
      .toEqual(["String(caught)", "caught.message"]);
  });

  it("the walk reaches a SUBDIRECTORY — the control for `routes/`, where three of the seven live", () => {
    const files = walk(ROOTS[0]!.dir).map((f) => relative(ROOTS[0]!.dir, f));
    expect(files, "the walk went flat again and `routes/` is invisible to it")
      .toContain(join("routes", "admin-oauth.ts"));
    /* A stringified throw PLANTED in a routes/ file is caught — the mutation, run against the
       real file's text rather than a hand-built string, so the plant is in the shape the file has. */
    const planted = readFileSync(join(ROOTS[0]!.dir, "routes", "admin-oauth.ts"), "utf8")
      .replace('log.error("admin_oauth_failed", { err })', 'log.error("admin_oauth_failed", { err: String(err) })');
    const bad = errValues(planted, "routes/admin-oauth.ts")
      .filter((s) => STRINGIFIES.some((r) => r.re.test(s.value)));
    expect(bad.map((s) => s.value), "a planted String(err) under routes/ was not caught")
      .toEqual(["String(err)"]);
  });
});

describe("no log site in these roots hands the `err` channel anything but the thrown value", () => {
  for (const root of ROOTS) {
    const name = relative(REPO, root.dir);
    it(`${name} — every \`err\` value is the thrown value`, () => {
      const files = walk(root.dir);
      expect(files.length, `${name} was not scanned at all`).toBeGreaterThan(5);
      const sites = files.flatMap((f) => errValues(readFileSync(f, "utf8"), relative(REPO, f)));
      /* ANTI-VACUITY per root: a scan that found no `err:` would pass for the wrong reason for
         ever. Per root and not over the union, because a union floor is cleared by whichever
         root is largest while another quietly reads zero. */
      expect(sites.length, `${name} shows too few \`err\` channel sites — it has stopped measuring`)
        .toBeGreaterThanOrEqual(root.atLeast);
      const bad = sites.flatMap((s) => STRINGIFIES
        .filter((rule) => rule.re.test(s.value))
        .map((rule) => `${s.file}: err: ${s.value} — ${rule.why}`));
      expect(bad, "a log site pre-stringified its thrown value").toEqual([]);
    });
  }

  it("the seven sites this closed are READ by the census, by event name", () => {
    /* Named, because a census that stopped finding them would pass in silence. Each is the
       `err` shorthand now; before this lane each was `err: String(err)`. */
    const sites: readonly [string, string][] = [
      ["attachments-adapter.ts", "imap_slot_release_failed"],
      ["imap-probe.ts", "imap_probe_slot_release_failed"],
      ["imap-probe.ts", "smtp_probe_slot_release_failed"],
      [join("routes", "mailbox-oauth.ts"), "oauth_ceremony_prune_failed"],
      [join("routes", "mailbox-oauth-device.ts"), "oauth_device_prune_failed"],
      [join("routes", "admin-oauth.ts"), "admin_oauth_failed"],
      [join("routes", "admin-oauth.ts"), "admin_oauth_reread_failed"],
    ];
    for (const [file, event] of sites) {
      const src = readFileSync(join(ROOTS[0]!.dir, file), "utf8");
      const code = withoutComments(src);
      expect(code, `${file} no longer writes ${event} — the site moved or was renamed`)
        .toContain(`"${event}", { `);
      const at = code.indexOf(`"${event}"`);
      const line = code.slice(at, code.indexOf("\n", at));
      expect(line, `${event} does not hand the channel the bare thrown value`).toContain("err }");
    }
  });
});
