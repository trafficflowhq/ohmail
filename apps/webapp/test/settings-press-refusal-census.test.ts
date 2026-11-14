import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as scan from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY MUTATING PRESS ON THE SETTINGS PAGES SAYS SOMETHING WHEN IT IS REFUSED. A census over the
 * Rules, Tags, Mailboxes and Screener-settings sources, and the Screener's own decision: each write
 * door's call must reach a speaking arm — a `.then` that reads the verdict, a `catch` that sets a
 * sentence, or the shell's reporting seam. The Tags writes use the press seam. The Screener
 * settings delegate some writes to a shared control whose refusal handler is also censused.
 * A planted silent press is the control; a door that matches nothing refuses.
 */

const ROOT = join(__dirname, "..");
const SPEAKS = /\b(?:report|pressVerdict|tallyVerdicts|toast|refuse\w*|setRefusal|setError|setFailed|setNotice|setNote|setSaid|set\w*(?:Error|Failed|Notice|Refusal))\s*\(/;
const SEAMS = new Set(["mutateAndReport", "mutateSetAndReport"]);

type Verdict = "then" | "catch" | "seam" | `delegated:${string}` | "silent";

/** The first unmatched opener before `at`, walking out through balanced groups. */
function enclosing(lit: string, at: number): { at: number; ch: string } | null {
  const close: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  const stack: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const c = lit[i]!;
    if (c in close) stack.push(close[c]!);
    else if (c === "(" || c === "{" || c === "[") {
      if (stack.length === 0) return { at: i, ch: c };
      stack.pop();
    }
  }
  return null;
}

/** How the door at `at` (its call's `(` at `open`, or `null` for an object door) answers a refusal. */
function classify(src: string, at: number, open: number | null, props: Record<string, string>): Verdict {
  const lit = scan.withoutCommentsAndLiterals(src);
  // An object door (`{ kind: "…" }`) is answered by the call it is the argument of.
  if (open === null) {
    const obj = enclosing(lit, at);
    const call = obj?.ch === "{" ? enclosing(lit, obj.at) : null;
    if (call?.ch === "(") open = call.at;
  }
  // (a) consumed by a `.then`/`.catch` whose body speaks — `Promise.all(xs.map(f)).then(` too.
  if (open !== null) {
    const call = scan.bracketSpan(lit, open);
    const chained = /^[\s)]*\.(then|catch)\(/.exec(lit.slice(call.end + 1));
    if (chained) {
      const p = call.end + 1 + chained[0].length - 1;
      if (SPEAKS.test(lit.slice(p, scan.bracketSpan(lit, p).end))) return "then";
    }
  }
  // (b) inside a `try` whose `catch` speaks; the NEAREST enclosing try decides.
  for (const m of [...lit.slice(0, at).matchAll(/\btry\s*\{/g)].reverse()) {
    const brace = m.index! + m[0].length - 1;
    const block = scan.bracketSpan(lit, brace, "{", "}");
    if (block.end < at) continue;
    const c = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(lit.slice(block.end + 1));
    if (!c) break;
    const cb = block.end + 1 + c[0].length - 1;
    const body = lit.slice(cb, scan.bracketSpan(lit, cb, "{", "}").end);
    if (SPEAKS.test(body)) return "catch";
    break;
  }
  // (c) an argument of the shell's reporting seam, or (d) a handler handed to a prop whose
  // consumer is itself censused. Any other prop (an `onClick` that drops the result) is silent.
  let from = at;
  for (let depth = 0; depth < 6; depth++) {
    const e = enclosing(lit, from);
    if (!e) break;
    const before = lit.slice(0, e.at);
    const callee = /((?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*)\s*$/.exec(before)?.[1];
    if (e.ch === "(" && callee && SEAMS.has(callee.split(".").at(-1)!)) return "seam";
    if (e.ch === "(" && callee && callee in props) return `delegated:${callee}`;
    const prop = /\b(on[A-Z]\w*|set)=\s*$/.exec(before)?.[1];
    if (e.ch === "{" && prop) return prop in props ? `delegated:${prop}` : "silent";
    from = e.at;
  }
  return "silent";
}

interface Pane { file: string; doors: RegExp; props?: Record<string, string> }

/** The write doors, per file. A read (`mailboxApi.list`, the organizer peek) is not a press. */
const SCREENER_SETTINGS = "../../packages/app/src/settings/screener/";
const WRITTEN = `${SCREENER_SETTINGS}written.tsx`;
const PANES: Pane[] = [
  { file: "../../packages/app-logic/src/press/rule-management.ts", doors: /\b(onRevoke|onRetarget)\(/g },
  { file: "../../packages/app/src/settings/browser/TagsSettings.tsx", doors: /kind: "tag_(?:create|recolor)"/g },
  { file: "../../packages/app-logic/src/press/tag-verbs.ts", doors: /kind: "tag_(?:rename|delete)"/g },
  {
    file: "app/(product)/mailbox/MailboxSection.tsx",
    doors: /\bmailboxApi\.(?:release|organize|resync|dismissInboundQuiet|create|update|erase|remove|oauthStart|deviceOAuthStart)\(/g,
  },
  { file: `${SCREENER_SETTINGS}OhboxSheet.tsx`, doors: /\bohbox\.(?:change|saveBar)\(/g },
  {
    file: `${SCREENER_SETTINGS}WindowSheet.tsx`, doors: /\bdial\.set\(/g,
    props: { "write.run": WRITTEN },
  },
  {
    file: `${SCREENER_SETTINGS}SuggestSheet.tsx`, doors: /\b(?:suggest\.set|unsubscribe\.setBlocked)\(/g,
    props: { "write.run": WRITTEN, set: WRITTEN },
  },
  {
    file: WRITTEN, doors: /\b(?:await\s+write|props\.set)\(/g,
    props: { "write.run": WRITTEN },
  },
  // The Screener's decision, at the gate and past it: each refusal names its reason.
  { file: "../../packages/app-logic/src/screener/screener-state.ts", doors: /kind: "screener_decide"|\bdispatchScreeningChange\(/g },
];

/** Every door call in a source, with its verdict. Doors are matched in comment-free code. */
function censusOf(
  src: string, doors: RegExp, props: Record<string, string> = {},
): Array<{ line: number; door: string; verdict: Verdict }> {
  const code = scan.withoutComments(src);
  const out: Array<{ line: number; door: string; verdict: Verdict }> = [];
  for (const m of code.matchAll(new RegExp(doors.source, "g"))) {
    const at = m.index!;
    // A `kind: "…"` door is an object inside the call; the call is what encloses it.
    const open = m[0].endsWith("(") ? at + m[0].length - 1 : null;
    out.push({ line: scan.lineOf(src, at), door: m[0], verdict: classify(src, at, open, props) });
  }
  return out;
}

describe("the census finds its subjects, and every press it finds speaks on a refusal", () => {
  for (const pane of PANES) {
    it(pane.file, () => {
      const rows = censusOf(readFileSync(join(ROOT, pane.file), "utf8"), pane.doors, pane.props);
      expect(rows.length, `no door matched in ${pane.file} — the census reads nothing there`).toBeGreaterThan(0);
      const bad = rows.filter((r) => r.verdict === "silent");
      expect(bad.map((r) => `${pane.file}:${r.line} ${r.door} → ${r.verdict}`)).toEqual([]);
    });
  }

  it("a delegated door's consumer is itself in the census", () => {
    for (const p of PANES) for (const consumer of Object.values(p.props ?? {})) {
      expect(PANES.some((q) => q.file === consumer), consumer).toBe(true);
    }
  });
});

describe("controls: the classifier refuses a silent press and admits a speaking one", () => {
  const verdictOf = (src: string, doors: RegExp) => censusOf(src, doors).map((r) => r.verdict);
  it("a press whose result is dropped is silent", () => {
    expect(verdictOf(`<Button onClick={() => { void onRevoke(rule.id); }}>x</Button>`, /\bonRevoke\(/g)).toEqual(["silent"]);
  });
  it("an empty catch, or one that only ends a spinner, is silent", () => {
    expect(verdictOf(`async () => { try { await mailboxApi.remove(id); } catch { } }`, /\bmailboxApi\.remove\(/g)).toEqual(["silent"]);
    expect(verdictOf(`async () => { try { await setAutoSuggest(true); } catch { setPending(false); } }`, /\bsetAutoSuggest\(/g))
      .toEqual(["silent"]);
  });
  it("a `.then` that reports, a catch that sets a sentence and the seam all speak", () => {
    expect(verdictOf(`void onRevoke(rule.id).then((r) => report(r, a, b, c));`, /\bonRevoke\(/g)).toEqual(["then"]);
    expect(verdictOf(`async () => { try { await mailboxApi.remove(id); } catch (err) { setError(messageOf(err)); } }`, /\bmailboxApi\.remove\(/g))
      .toEqual(["catch"]);
    expect(verdictOf(`void mutateAndReport({ kind: "tag_delete", tagId }, t("x"));`, /kind: "tag_delete"/g)).toEqual(["seam"]);
    expect(verdictOf(`void engine.mutate({ kind: "screener_decide", id }).then((res) => refuse(d, res.error));`, /kind: "screener_decide"/g))
      .toEqual(["then"]);
    expect(censusOf(`write.run(() => dial.set(next));`, /\bdial\.set\(/g, { "write.run": WRITTEN })
      .map((r) => r.verdict)).toEqual(["delegated:write.run"]);
    expect(verdictOf(`void engine.mutate({ kind: "screener_decide", id });`, /kind: "screener_decide"/g)).toEqual(["silent"]);
  });
});
