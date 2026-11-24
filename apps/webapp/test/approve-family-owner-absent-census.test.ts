import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as scan from "../../../scripts/lib/source-scan.mjs";
/* @reads: apps/webapp/app/(product)/approve/ApproveRoute.tsx
   apps/webapp/app/(product)/approve/settle-owner.ts
   apps/webapp/app/(product)/link-desktop/LinkDesktopRoute.tsx
   apps/webapp/app/(product)/authorize-desktop/AuthorizeDesktopRoute.tsx
   apps/webapp/app/(product)/mailbox/StepUpPrompt.tsx
   apps/webapp/app/(product)/mailbox/web-step-up.ts
   apps/webapp/app/api-client.ts
   Read by a built path, so no landing pass would select this file when they move. */

/**
 * NO APPROVE-FAMILY SURFACE SAYS `owner_absent`. The pages that settle whose browser this is
 * (every `useSettledOwner` caller) and the step-up prompt they host hand that refusal to the settle
 * step, so neither reload sentence — the client's literal or the catalogue's — is theirs to show.
 * Three arms over the sources: no `messageOf` import or call, under its own name or an alias;
 * every hosted prompt is given the settle step; every catch, and every `.catch` or `.then` rejection
 * handler, that says a gated request's refusal asks `isOwnerAbsent` first. Each arm refuses a
 * planted source and reads a non-zero corpus.
 */

const PRODUCT = join(__dirname, "../app/(product)");
const API_CLIENT = join(__dirname, "../app/api-client.ts");
const PROMPT = join(PRODUCT, "mailbox/StepUpPrompt.tsx");
/** The step-up's door: the prompt's requests and their catches moved here. */
const STEP_UP_DOOR = join(PRODUCT, "mailbox/web-step-up.ts");
const SETTLE = join(PRODUCT, "approve/settle-owner.ts");
const read = (f: string): string => readFileSync(f, "utf8");
const name = (f: string): string => relative(PRODUCT, f);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(e) ? [p] : [];
  });
}

/**
 * The pages that settle whose browser this is, read from the tree rather than listed: every caller of the settle
 * step, and every caller of a page's own ceremony hook that does (`approve/use-approve-door.ts` and its kin).
 */
function familyPages(): string[] {
  const code = (f: string): string => scan.withoutCommentsAndLiterals(read(f));
  const settling = walk(PRODUCT).filter((f) => f !== SETTLE && /\buseSettledOwner\s*\(/.test(code(f)));
  const hooks = settling.flatMap((f) => [...code(f).matchAll(/\bexport\s+function\s+(use\w+Door)\s*\(/g)].map((m) => m[1]!));
  const hosting = walk(PRODUCT).filter((f) => !settling.includes(f)
    && hooks.some((hook) => new RegExp(`\\b${hook}\\s*\\(`).test(code(f))));
  return [...settling, ...hosting];
}

/** The `auth` methods that pass `ceremony: true` themselves: owner-free at the gate's first line. */
function ceremonyMethods(src: string): Set<string> {
  const lit = scan.withoutComments(src);
  const open = lit.indexOf("{", lit.indexOf("export const auth = "));
  const body = lit.slice(open + 1, scan.bracketSpan(lit, open, "{", "}").end);
  const members = [...body.matchAll(/^ {2}(\w+):/gm)];
  return new Set(members.flatMap((m, i) => {
    const text = body.slice(m.index!, members[i + 1]?.index ?? body.length);
    return /\bceremony:\s*true\b/.test(text) ? [m[1]!] : [];
  }));
}

/**
 * Arm 1: every use of `messageOf`, which says an owner code as the client's English literal: an
 * import of it under any local name, and a call by that name or its own.
 */
function messageOfUses(src: string): number[] {
  const lit = scan.withoutCommentsAndLiterals(src);
  const names = new Set(["messageOf"]);
  const lines: number[] = [];
  for (const m of lit.matchAll(/\bimport\s*(?:type\s+)?\{([^}]*)\}/g)) {
    const at = m.index! + m[0].indexOf("{") + 1;
    for (const s of m[1]!.matchAll(/\bmessageOf\b(?:\s+as\s+(\w+))?/g)) {
      if (s[1]) names.add(s[1]);
      lines.push(scan.lineOf(lit, at + s.index!));
    }
  }
  for (const n of names) {
    for (const m of lit.matchAll(new RegExp(`\\b${n}\\s*\\(`, "g"))) lines.push(scan.lineOf(lit, m.index!));
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

/**
 * Arm 2: each `StepUpPrompt` a page renders, and each set of the one step-up dialog's answers a page hands its door's
 * page (`factor: { … }`), by line, with whether it is given the settle step (`onOwnerAbsent`).
 */
function hostedPrompts(src: string): Array<{ line: number; settles: boolean }> {
  const lit = scan.withoutCommentsAndLiterals(src);
  const found: Array<{ line: number; settles: boolean }> = [];
  for (const m of lit.matchAll(/\bStepUpPrompt\b/g)) {
    const at = m.index!;
    if (/\bimport\s*\{[^}]*$/.test(lit.slice(0, at))) continue;
    if (lit[at - 1] !== "<") { found.push({ line: scan.lineOf(lit, at), settles: false }); continue; }
    let i = at + m[0].length;
    const attrs: string[] = [];
    while (i < lit.length && !lit.startsWith("/>", i) && lit[i] !== ">") {
      if (lit[i] === "{") { i = scan.bracketSpan(lit, i, "{", "}").end + 1; continue; }
      const attr = /^[A-Za-z]\w*/.exec(lit.slice(i));
      if (attr) { attrs.push(attr[0]); i += attr[0].length; } else i += 1;
    }
    found.push({ line: scan.lineOf(lit, at), settles: attrs.includes("onOwnerAbsent") });
  }
  for (const m of lit.matchAll(/\bfactor\s*:\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const keys = topLevelArgs(lit.slice(open + 1, scan.bracketSpan(lit, open, "{", "}").end)).map((a) => /^\w+/.exec(a)?.[0]);
    found.push({ line: scan.lineOf(lit, m.index!), settles: keys.includes("onOwnerAbsent") });
  }
  return found.sort((a, b) => a.line - b.line);
}

const CLASSIFIERS = new Set(["isOwnerAbsent", "isBusy", "gatedRefusal"]);

/** Where `caught` is first said in `body`, unless `isOwnerAbsent(caught)` came first; -1 when settled. */
function firstUnsettledUse(body: string, caught: string): number {
  let settled = false;
  for (const use of body.matchAll(new RegExp(`\\b${caught}\\b`, "g"))) {
    const callee = /(\w+)\s*\(\s*$/.exec(body.slice(0, use.index!))?.[1];
    const after = body.slice(use.index! + caught.length);
    if (callee === "isOwnerAbsent") { settled = true; continue; }
    if ((callee && CLASSIFIERS.has(callee)) || /^\s*(?:\.|instanceof\b)/.test(after)) continue;
    if (!settled) return use.index!;
  }
  return -1;
}

/** A gated request: an `auth` call that is not a ceremony, or a deferred `await fn()`. */
function asksGated(text: string, ceremony: Set<string>): boolean {
  return [...text.matchAll(/\bauth\.(\w+)\s*\(/g)].some((c) => !ceremony.has(c[1]!))
    || /\bawait\s+\w+\s*\(\s*\)/.test(text);
}

/**
 * Arm 3: every catch whose try asks a gated request (an `auth` call that is not a ceremony, or a
 * deferred `await fn()`) and that hands the caught value to anything but a classifier, a property
 * read or `instanceof`, by line — unless `isOwnerAbsent(<it>)` comes first.
 */
function unsettledCatches(src: string, ceremony: Set<string>): { inspected: number; unsettled: number[] } {
  const lit = scan.withoutCommentsAndLiterals(src);
  const out: number[] = [];
  let inspected = 0;
  for (const m of lit.matchAll(/\bcatch\s*\(\s*(\w+)\s*\)\s*\{/g)) {
    const caught = m[1]!;
    const before = lit.slice(0, m.index!).trimEnd();
    if (!before.endsWith("}")) continue;
    let depth = 0;
    let open = before.length - 1;
    for (; open >= 0; open--) {
      if (before[open] === "}") depth++;
      else if (before[open] === "{" && --depth === 0) break;
    }
    if (!/\btry\s*$/.test(before.slice(0, open))) continue;
    const tried = before.slice(open + 1, before.length - 1);
    if (!asksGated(tried, ceremony)) continue;
    inspected += 1;
    const bodyOpen = m.index! + m[0].length - 1;
    const body = lit.slice(bodyOpen + 1, scan.bracketSpan(lit, bodyOpen, "{", "}").end);
    const use = firstUnsettledUse(body, caught);
    if (use >= 0) out.push(scan.lineOf(lit, bodyOpen + 1 + use));
  }
  return { inspected, unsettled: out };
}

/** A call's argument text split at its top-level commas. */
function topLevelArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out.map((a) => a.trim()).filter((a) => a !== "");
}

/** The expression a `.catch` or `.then` hangs on, back to where its statement or argument starts. */
function receiverOf(before: string): string {
  let depth = 0;
  let i = before.length - 1;
  for (; i >= 0; i--) {
    const c = before[i]!;
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === ";" || c === "," || c === "=")) break;
  }
  return before.slice(i + 1);
}

/**
 * Arm 3's promise form: the rejection handler of a `.catch(h)` or `.then(ok, h)` on a gated
 * request, read as a catch body. A handler passed by name is handed the refusal unread.
 */
function unsettledHandlers(src: string, ceremony: Set<string>): { inspected: number; unsettled: number[] } {
  const lit = scan.withoutCommentsAndLiterals(src);
  const out: number[] = [];
  let inspected = 0;
  for (const m of lit.matchAll(/\.(catch|then)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const args = topLevelArgs(lit.slice(open + 1, scan.bracketSpan(lit, open, "(", ")").end));
    const handler = m[1] === "catch" ? args[0] : args[1];
    const on = receiverOf(lit.slice(0, m.index!));
    if (!handler || !(asksGated(on, ceremony) || /^\s*(?:void\s+|return\s+)?\w+\s*\(\s*\)\s*$/.test(on))) continue;
    inspected += 1;
    const arrow = /^(?:async\s+)?(?:\(\s*(\w*)[^)]*\)|(\w+))\s*=>/.exec(handler);
    const named = /^(?:async\s+)?function\b[^(]*\(\s*(\w*)/.exec(handler);
    if (!arrow && !named) { if (!CLASSIFIERS.has(handler)) out.push(scan.lineOf(lit, m.index!)); continue; }
    const caught = arrow ? arrow[1] || arrow[2] || "" : named![1] || "";
    const body = arrow ? handler.slice(arrow[0].length) : handler.slice(handler.indexOf("{"));
    if (caught && firstUnsettledUse(body, caught) >= 0) out.push(scan.lineOf(lit, m.index!));
  }
  return { inspected, unsettled: out };
}

/** Arm 3 over one source: its try/catch blocks and its promise handlers together. */
function unsettledRefusals(src: string, ceremony: Set<string>): { inspected: number; unsettled: number[] } {
  const a = unsettledCatches(src, ceremony);
  const b = unsettledHandlers(src, ceremony);
  return { inspected: a.inspected + b.inspected, unsettled: [...a.unsettled, ...b.unsettled] };
}

describe("the approve family hands owner_absent to its settle step", () => {
  const ceremony = ceremonyMethods(read(API_CLIENT));
  const pages = familyPages();
  const family = [...pages, SETTLE, PROMPT, STEP_UP_DOOR];

  it("reads the family from the tree, and the gate's ceremony list from the client", () => {
    expect(pages.map(name).sort()).toEqual(expect.arrayContaining([
      "approve/use-approve-door.ts", "link-desktop/use-link-desktop-door.ts", "authorize-desktop/use-authorize-desktop-door.ts",
      "approve/ApproveRoute.tsx", "link-desktop/LinkDesktopRoute.tsx", "authorize-desktop/AuthorizeDesktopRoute.tsx",
    ]));
    expect(ceremony.has("authorizeRequest"), "the reader found no ceremony method").toBe(true);
    expect(ceremony.has("desktopApproval") || ceremony.has("session") || ceremony.has("stepUpTotp")).toBe(false);
  });

  it("arm 1: no family source imports or calls messageOf, so an owner code is only ever said by the one renderer", () => {
    const found = family.flatMap((f) => messageOfUses(read(f)).map((l) => `${name(f)}:${l}`));
    expect(found).toEqual([]);
  });

  it("arm 2: every step-up a family page hosts is given the page's settle step", () => {
    const prompts = pages.flatMap((f) => hostedPrompts(read(f)).map((p) => ({ ...p, file: name(f), at: `${name(f)}:${p.line}` })));
    expect(prompts.map((p) => p.file), "the census read no hosted step-up")
      .toEqual(expect.arrayContaining(["approve/ApproveRoute.tsx", "link-desktop/LinkDesktopRoute.tsx", "authorize-desktop/AuthorizeDesktopRoute.tsx"]));
    expect(prompts.filter((p) => !p.settles).map((p) => p.at)).toEqual([]);
  });

  it("arm 3: every catch and rejection handler that says a gated request's refusal asks isOwnerAbsent first", () => {
    expect(unsettledHandlers(read(join(PRODUCT, "approve/use-approve-door.ts")), ceremony).inspected,
      "the census read no promise handler").toBeGreaterThan(0);
    const read3 = family.map((f) => ({ f, ...unsettledRefusals(read(f), ceremony) }));
    expect(read3.filter((r) => r.inspected > 0).map((r) => name(r.f)), "the census read no gated catch")
      .toEqual(expect.arrayContaining(["approve/use-approve-door.ts", "link-desktop/use-link-desktop-door.ts", "mailbox/web-step-up.ts"]));
    expect(read3.flatMap((r) => r.unsettled.map((l) => `${name(r.f)}:${l}`))).toEqual([]);
  });
});

describe("the census refuses what it exists to refuse (planted sources)", () => {
  const ceremony = new Set(["authorizeRequest"]);

  it("arm 1 finds a call, and not a comment or a string", () => {
    expect(messageOfUses("function f(err) {\n  setError(messageOf(err));\n}")).toEqual([2]);
    expect(messageOfUses('// messageOf(err)\nconst s = "messageOf(err)";')).toEqual([]);
  });

  it("arm 1 finds an import under any name and a call by its alias, and admits another import", () => {
    const aliased = 'import { auth, messageOf as plainText } from "../../api-client";\nfunction f(err) {\n  setError(plainText(err));\n}';
    expect(messageOfUses(aliased)).toEqual([1, 3]);
    expect(messageOfUses('import { messageOf } from "../../api-client";\nconst x = 1;')).toEqual([1]);
    expect(messageOfUses('import { refusalSentence } from "./refusal";\nfunction f(err) {\n  say(refusalSentence(err));\n}')).toEqual([]);
  });

  it("arm 2 refuses a prompt with no settle step, or one it cannot read; admits one given it", () => {
    const head = 'import { StepUpPrompt } from "../mailbox/StepUpPrompt";\n';
    expect(hostedPrompts(`${head}const a = <StepUpPrompt onVerified={() => go(1 > 0)} onCancel={x} />;`))
      .toEqual([{ line: 2, settles: false }]);
    expect(hostedPrompts(`${head}const a = createElement(StepUpPrompt, p);`)).toEqual([{ line: 2, settles: false }]);
    expect(hostedPrompts(`${head}const a = <StepUpPrompt onVerified={() => go()} onOwnerAbsent={settle} />;`))
      .toEqual([{ line: 2, settles: true }]);
  });

  it("arm 2 refuses the dialog's answers with no settle step, and admits them given it", () => {
    expect(hostedPrompts("const door = {\n  factor: { onVerified: go, onCancel: () => set(1), onDiscarded: x },\n};"))
      .toEqual([{ line: 2, settles: false }]);
    expect(hostedPrompts("const door = {\n  factor: {\n    onVerified: () => go({ a: 1 }),\n    onOwnerAbsent: c.settleAgain,\n  },\n};"))
      .toEqual([{ line: 2, settles: true }]);
  });

  it("arm 3 refuses a gated catch that says the refusal first, and admits the settled and the ceremony ones", () => {
    const gated = "try {\n  await auth.desktopApproval(id);\n} catch (err) {\n  setError(refusalSentence(err));\n}";
    expect(unsettledCatches(gated, ceremony)).toEqual({ inspected: 1, unsettled: [4] });
    const deferred = "try {\n  await fn();\n} catch (err) {\n  setError(refusalText(err));\n}";
    expect(unsettledCatches(deferred, ceremony)).toEqual({ inspected: 1, unsettled: [4] });
    const settled = "try {\n  await auth.desktopApproval(id);\n} catch (err) {\n"
      + "  if (err instanceof ApiError && err.status === 401) return;\n"
      + "  if (isOwnerAbsent(err)) { resettle(); return; }\n  setError(refusalSentence(err));\n}";
    expect(unsettledCatches(settled, ceremony)).toEqual({ inspected: 1, unsettled: [] });
    const ceremonyOnly = "try {\n  await auth.authorizeRequest(id);\n} catch (err) {\n  setError(refusalSentence(err));\n}";
    expect(unsettledCatches(ceremonyOnly, ceremony)).toEqual({ inspected: 0, unsettled: [] });
  });

  it("arm 3 reads a promise's rejection handler as a catch, and admits a settled one and a ceremony", () => {
    const caught = "void auth.desktopApproval(id).catch((err) => setError(refusalSentence(err)));";
    expect(unsettledHandlers(caught, ceremony)).toEqual({ inspected: 1, unsettled: [1] });
    const byName = "void auth.desktopApproval(id)\n  .catch(setError);";
    expect(unsettledHandlers(byName, ceremony)).toEqual({ inspected: 1, unsettled: [2] });
    const second = "void auth.desktopApproval(id).then(\n  (r) => show(r),\n  (e) => setError(refusalSentence(e)),\n);";
    expect(unsettledHandlers(second, ceremony)).toEqual({ inspected: 1, unsettled: [1] });
    const settled = "void auth.desktopApproval(id).then(\n  (r) => show(r),\n"
      + "  (e) => { if (isOwnerAbsent(e)) { resettle(); return; } setError(refusalSentence(e)); },\n);";
    expect(unsettledHandlers(settled, ceremony)).toEqual({ inspected: 1, unsettled: [] });
    const silent = "void auth.desktopApproval(id).then((r) => show(r), () => { /* nothing said */ });";
    expect(unsettledHandlers(silent, ceremony)).toEqual({ inspected: 1, unsettled: [] });
    const ceremonyOnly = "void auth.authorizeRequest(id).catch((err) => setError(refusalSentence(err)));";
    expect(unsettledHandlers(ceremonyOnly, ceremony)).toEqual({ inspected: 0, unsettled: [] });
  });
});
