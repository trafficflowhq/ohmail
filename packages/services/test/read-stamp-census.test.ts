import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY WRITE THAT FLIPS `unread` ALSO WRITES `lastReadAt` (owner ruling 2026-09-18): the stamp
 * is the invariant and the comparator's own-date fallback is the net, so a read path that flips
 * the flag alone files its row by the net instead of the truth. Parsed for the WRITE: every
 * `.set({ … })` literal naming `unread` must name `lastReadAt`. Scanned by root — RUN BY NAME
 * when core, worker, db or sidecar move; touched-package selection cannot see across roots. The
 * mirror's replication upsert builds its set as a named object, so it is pinned by name below.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const ROOTS = [
  "packages/services/src", "packages/db/src", "packages/core/src",
  "apps/worker/src", "apps/sidecar/src",
];

function sources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, into);
    else if (extname(name) === ".ts") into.push(p);
  }
  return into;
}

/** Every `.set({ … })` literal in `code`, by brace walk from each `.set(` — never a regex over nesting. */
function setLiterals(code: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const at = code.indexOf(".set({", i);
    if (at < 0) return out;
    let depth = 0;
    let j = at + 5; // at the "{"
    for (; j < code.length; j++) {
      if (code[j] === "{") depth += 1;
      else if (code[j] === "}") { depth -= 1; if (depth === 0) break; }
    }
    out.push(code.slice(at + 5, j + 1));
    i = j;
  }
}

describe("read-stamp census", () => {
  const files = ROOTS.flatMap((r) => sources(join(REPO, r)))
    .map((p) => ({ path: p.slice(REPO.length + 1), code: withoutComments(readFileSync(p, "utf8")) as string }));

  it("no .set literal writes unread without lastReadAt, anywhere in the five roots", () => {
    const offenders: string[] = [];
    let flips = 0;
    for (const f of files) {
      for (const lit of setLiterals(f.code)) {
        // Both spellings: `unread: value` and the SHORTHAND `unread,` the batch writer uses.
        if (!/\bunread\s*[,:}]/.test(lit)) continue;
        flips += 1;
        if (!/\blastReadAt\s*[,:}]/.test(lit)) offenders.push(`${f.path}: ${lit.slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
    // The paths this census exists for, counted so a writer FALLING OUT of the scan (a rename,
    // a refactor into a helper) is a red rather than a silently smaller sweep: the singular
    // read, the batch read, the \Seen adoption, the retro pass.
    // 5 -> 4 (#401): the deny-side decide flips nothing; screened-out and spam mail is filed unread.
    expect(flips).toBeGreaterThanOrEqual(4);
  });

  it("the mirror's replication upsert carries the stamp beside the flag — pinned by name", () => {
    const mirror = files.find((f) => f.path === "apps/sidecar/src/cloud-mirror.ts");
    expect(mirror).toBeDefined();
    // The `display` object IS the `onConflictDoUpdate` set; both keys or the paired install
    // loses every reading instant on the next pull.
    const display = mirror!.code.slice(mirror!.code.indexOf("const display = {"));
    const literal = display.slice(0, display.indexOf("};"));
    expect(/\bunread\s*:/.test(literal)).toBe(true);
    expect(/\blastReadAt\s*:/.test(literal)).toBe(true);
    // The open read rides the same set, or a paired install keeps arrival for it.
    expect(/\bopenReadAt\s*:/.test(literal)).toBe(true);
  });
});

/**
 * THE OPEN READ HAS ONE WRITER AND EVERY UNREAD CLEARS IT (owner 2026-10-07). (a) A `.set` literal
 * that flips `unread` to anything but the literal `false` names `openReadAt` — the batch, the single
 * PATCH, the `\Seen` adoption clear it in the statement that flips the flag (the Screener and retro
 * writers only ever mark read, so they are exempt by that literal). (b) Exactly ONE `.set` literal
 * writes it a non-null value, inside `MessageService.markSeen`.
 */
const mayUnread = (lit: string): boolean => /\bunread\s*[,:}]/.test(lit) && !/\bunread\s*:\s*false\b/.test(lit);
const namesOpenRead = (lit: string): boolean => /\bopenReadAt\s*:/.test(lit);
const stampsOpenRead = (lit: string): boolean => /\bopenReadAt\s*:(?!\s*null\b)/.test(lit);

function setLiteralsAt(code: string): Array<{ at: number; lit: string }> {
  const out: Array<{ at: number; lit: string }> = [];
  let from = 0;
  for (const lit of setLiterals(code)) {
    const at = code.indexOf(lit, from);
    out.push({ at, lit });
    from = at + lit.length;
  }
  return out;
}

describe("open-read census", () => {
  const files = ROOTS.flatMap((r) => sources(join(REPO, r)))
    .map((p) => ({ path: p.slice(REPO.length + 1), code: withoutComments(readFileSync(p, "utf8")) as string }));

  it("the planted controls: an unread without the clear is refused, a read-only writer is exempt", () => {
    expect(mayUnread("{ unread: body.unread, lastReadAt: x }")).toBe(true);
    expect(namesOpenRead("{ unread: body.unread, lastReadAt: x }")).toBe(false);
    expect(mayUnread("{ unread, lastReadAt: readAt }")).toBe(true);
    expect(mayUnread("{ unread: false, lastReadAt: now }")).toBe(false);
    expect(stampsOpenRead("{ openReadAt: at }")).toBe(true);
    expect(stampsOpenRead("{ ...(unread ? { openReadAt: null } : {}) }")).toBe(false);
  });

  it("(a) every .set literal that can mark unread clears the open read", () => {
    const offenders: string[] = [];
    let clears = 0;
    for (const f of files) {
      for (const lit of setLiterals(f.code)) {
        if (!mayUnread(lit)) continue;
        clears += 1;
        if (!namesOpenRead(lit)) offenders.push(`${f.path}: ${lit.slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
    // The batch, the single PATCH, `applyExternalFlag` — a writer falling out of the scan is a red.
    expect(clears).toBeGreaterThanOrEqual(3);
  });

  it("(b) exactly one .set literal stamps it, inside MessageService.markSeen", () => {
    const stamps: Array<{ path: string; at: number }> = [];
    for (const f of files) {
      for (const { at, lit } of setLiteralsAt(f.code)) if (stampsOpenRead(lit)) stamps.push({ path: f.path, at });
    }
    expect(stamps.map((x) => x.path)).toEqual(["packages/services/src/message-service.ts"]);
    const svc = files.find((f) => f.path === "packages/services/src/message-service.ts")!.code;
    const start = svc.indexOf("async markSeen(");
    const end = svc.indexOf("\n  async ", start + 1);
    expect(start).toBeGreaterThan(0);
    expect(stamps[0]!.at, "the stamp is outside markSeen").toBeGreaterThan(start);
    expect(stamps[0]!.at).toBeLessThan(end);
  });
});

/**
 * A PILE OR A PIN ENDS THE OPEN READ (hand-back 1, H1). Every write that moves a row's
 * `message_states` into a state that is not the literal "none" — a park, Reply later, a scheduled
 * return, a pin — clears `openReadAt` inside the same transaction callback, so leaving the pile
 * files the row at arrival. Keyed on the TABLE (`insert(messageStates)` / `update(messageStates)`),
 * never on a `state` key, which other tables carry too. The paired mirror replicates Cloud's rows and
 * takes the clear from the message DTO in the same page, so it is named, not scanned.
 */
const TRIAGE_REPLICAS = new Set(["apps/sidecar/src/cloud-mirror.ts"]);

/** The state value each messageStates write sets, with the enclosing `async (tx) =>` body. */
function triageWrites(code: string): Array<{ value: string; body: string }> {
  const out: Array<{ value: string; body: string }> = [];
  const re = /\b(?:insert|update)\(messageStates\)/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const after = code.slice(m.index);
    const setAt = after.search(/(?:\.set\(\{|\bset:\s*\{)/);
    if (setAt < 0) continue;
    const open = m.index + setAt + after.slice(setAt).indexOf("{");
    let depth = 0;
    let end = open;
    for (; end < code.length; end++) {
      if (code[end] === "{") depth++;
      else if (code[end] === "}") { depth--; if (depth === 0) break; }
    }
    const value = /\bstate\s*:\s*([^,}]+)/.exec(code.slice(open, end + 1))?.[1]?.trim() ?? "";
    const arrow = code.lastIndexOf("async (tx) =>", m.index);
    const next = code.indexOf("async (tx) =>", m.index);
    out.push({ value, body: code.slice(arrow < 0 ? 0 : arrow, next < 0 ? code.length : next) });
  }
  return out;
}
const clearsOpenRead = (body: string): boolean => /\.set\(\{\s*openReadAt:\s*null\s*\}\)/.test(body);

describe("a pile or a pin ends the open read — census", () => {
  const files = ROOTS.flatMap((r) => sources(join(REPO, r)))
    .map((p) => ({ path: p.slice(REPO.length + 1), code: withoutComments(readFileSync(p, "utf8")) as string }));

  it("the planted controls: a park without the clear is refused, a release to none is exempt", () => {
    const parkNoClear = `await db.transaction(async (tx) => { await tx.update(messageStates).set({ state: "muted" }); });`;
    expect(triageWrites(parkNoClear).map((w) => clearsOpenRead(w.body))).toEqual([false]);
    const parkClear = `await db.transaction(async (tx) => { await tx.update(messageStates).set({ state: "muted" }); await tx.update(messages).set({ openReadAt: null }); });`;
    expect(triageWrites(parkClear).map((w) => clearsOpenRead(w.body))).toEqual([true]);
    expect(triageWrites(`async (tx) => { await tx.update(messageStates).set({ state: "none" }); }`)[0]!.value).toBe('"none"');
    expect(triageWrites(`async (tx) => { await tx.insert(messageStates).values({ state: x }).onConflictDoUpdate({ target: t, set: { state: b.state } }); }`)[0]!.value).toBe("b.state");
  });

  it("every write into a pile or a pin clears openReadAt in its own transaction", () => {
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const f of files) {
      if (TRIAGE_REPLICAS.has(f.path)) continue;
      for (const w of triageWrites(f.code)) {
        if (w.value === '"none"') continue;
        seen.push(`${f.path} :: ${w.value}`);
        if (!clearsOpenRead(w.body)) offenders.push(`${f.path} :: state ${w.value}`);
      }
    }
    expect(offenders).toEqual([]);
    // setState (every pile and the pin) and the bubble-up pass — a writer falling out is a red.
    expect(seen.sort()).toEqual([
      'apps/worker/src/bubble-up-pass.ts :: "resurfaced"',
      "packages/services/src/triage-service.ts :: b.state",
    ]);
    // The named replica still writes the table, or its exemption is stale.
    const mirror = files.find((f) => f.path === "apps/sidecar/src/cloud-mirror.ts")!;
    expect(triageWrites(mirror.code).length).toBeGreaterThan(0);
  });
});
