/**
 * COMMENT BLOCKS, AND HOW LONG EACH ONE IS — one definition, for the two readers of that question.
 *
 * `test/comment-length-census.test.ts` asks it over every swept root at the TIP. The landing kit
 * asks the same question over the files a RANGE touched, which is cheap enough for a lane to run
 * on itself — and it has to be the SAME question, or a lane's green means nothing at the tip.
 */
import { createHash } from "node:crypto";

/* Consecutive `//` lines are ONE block: a ten-line essay written as ten single-line comments is
 * the same essay. A JSDoc block at end of file is collected from the EOF token directly, because
 * it becomes a JSDoc child there and the ordinary walk never reaches its trivia. */

/** @typedef {{ start: number, end: number, lines: number, digest: string }} Block */

/**
 * A BLOCK'S IDENTITY IS ITS CONTENT, NOT ITS LINE. Leading indentation and trailing space are
 * normalised away, so a block that moved into a different nesting is still the same block.
 */
export function blockDigest(lines) {
  const body = lines.map((l) => String(l).replace(/^[\t ]+/, "").replace(/\s+$/, "")).join("\n");
  return createHash("md5").update(body).digest("hex");
}

/**
 * Every comment block in `text`, with its 1-based line span.
 * @param text the source · @param fileName decides the script kind (.tsx / .mjs / .ts)
 * @param ts the typescript module — passed in, so this file imports nothing a kit script cannot
 * @returns {Block[]}
 */
export function commentBlocks(text, fileName, ts) {
  const scriptKind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : fileName.endsWith(".mjs") || fileName.endsWith(".js")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
  const seen = new Set();
  const ranges = [];
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JSDoc) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      for (const r of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
        if (seen.has(r.pos)) continue;
        seen.add(r.pos);
        ranges.push(r);
      }
      return;
    }
    for (const c of children) visit(c);
  };
  visit(sf);
  for (const r of ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()) ?? []) {
    if (!seen.has(r.pos)) {
      seen.add(r.pos);
      ranges.push(r);
    }
  }
  ranges.sort((a, b) => a.pos - b.pos);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const merged = [];
  for (const r of ranges) {
    const single = r.kind === ts.SyntaxKind.SingleLineCommentTrivia;
    const l1 = lineOf(r.pos);
    const l2 = lineOf(r.end - 1);
    const last = merged[merged.length - 1];
    if (single && last && last.single && l1 === last.l2 + 1) last.l2 = l2;
    else merged.push({ single, l1, l2 });
  }
  const all = text.split("\n");
  return merged.map((b) => ({
    start: b.l1 + 1, end: b.l2 + 1, lines: b.l2 - b.l1 + 1,
    digest: blockDigest(all.slice(b.l1, b.l2 + 1)),
  }));
}

/** The ceiling, stated once: comments are 5–10 lines, more only where the code needs explaining. */
export const MAX_COMMENT_LINES = 10;

/**
 * THE ROOTS THE RULING COVERS, stated once for both readers of it. The tip census asks over the
 * SWEPT source roots; the range gate asks over the files a range WROTE. Blind to this list the two
 * scopes drift, which is how the range half read seven blocks the tip census cannot see.
 */
export const SWEPT_ROOTS = [
  "apps/admin/app", "apps/admin/lib", "apps/" + "admin/middleware.ts", "apps/api-vercel/src",
  "apps/webapp/app", "packages/api/src", "packages/client-engine/src", "packages/core/src",
  "packages/db-mail/src", "packages/db/src", "packages/services/src", "packages/ui/src",
  "apps/mobile/app", "apps/mobile/src", "apps/desktop/src", "apps/paired-page/src", "apps/sidecar/src", "apps/worker/src",
  "packages/organizer/src",
];

/** The `.mjs` script roots, walked non-recursively; the public-message store is not comment prose. */
export const SCRIPT_ROOTS = ["scripts", "scripts/lib"];
export const SCRIPT_EXCLUDE = ["scripts/public-history.mjs"];

/**
 * The test roots the ruling covers too — 5–10 lines applies to tests. The TIP census does not scan
 * them yet: thousands of blocks over the ceiling in most of the files at that change, so adding them
 * there refuses every landing until a sweep lands. The RANGE gate does cover them, which is the
 * only half that can grow without a campaign: it asks only about lines a range just wrote.
 */
export const TEST_ROOTS = [
  "apps/admin/test", "apps/api-vercel/test", "apps/webapp/test", "packages/api/test",
  "packages/client-engine/test", "packages/core/test", "packages/db-mail/test", "packages/db/test",
  "packages/services/test", "packages/ui/test", "apps/mobile/test", "apps/desktop/test",
  "apps/sidecar/test", "apps/worker/test", "packages/organizer/test", "test",
];

/**
 * Is `rel` a TEST file the ruling covers? Measured 2026-09-15 at that change: the range gate took
 * no roots, so twenty-three test docblocks six lanes wrote turned the BATCH_VERDICT red after the
 * twenty SOURCE blocks had been shortened — and the dispatcher had ruled those docblocks FILED,
 * because cutting six lanes' test reasoning at a landing tip is the "comment sweep shortened three
 * blocks a test reads" hazard. A verdict token that is red by construction for a filed class is a
 * gate saying nothing, so the two classes are named apart here, once, for every reader.
 */
export function isTestPath(rel) {
  const p = String(rel);
  for (const r of TEST_ROOTS) if (p === r || p.startsWith(`${r}/`)) return true;
  return false;
}

/** Is `rel` inside a SOURCE root the ceiling is red on — the swept roots and the script roots? */
export function coversSource(rel) {
  return coversPath(rel) && !isTestPath(rel);
}

/** How near a moved block may land before DISTANCE alone can no longer say it is the same block. */
export const RE_HOME_WITHIN = 24;

/**
 * WHY AN ALLOW-LIST PIN STOPPED MATCHING. A pin that no longer names an over-length block either
 * MOVED or is GONE, and the remedies are opposites. `was` — the block's digest at the base — decides
 * it OUTRIGHT AND AT ANY DISTANCE, because content is what identifies a block: K32 re-homed thirteen
 * pins whose blocks had moved 59 and 99 lines, far past a 24-line window that advised DROP for every
 * one of them. Without `was` the reading falls back to distance and SAYS SO, so a DROP taken on
 * distance alone is never stated as a fact about the block.
 */
export function pinAdvice(over, at, claimed, was) {
  if (over.some((b) => b.start === at)) return { verdict: "ok", by: "line", why: () => "" };
  if (was) {
    const same = over.filter((b) => b.digest === was && !claimed.has(b.start));
    if (same.length === 1) {
      const n = same[0];
      return { verdict: "re-home", by: "content", to: n.start,
        why: (key, rel) => `${key}: the block MOVED ${n.start - at > 0 ? "+" : ""}${n.start - at} lines — `
          + `RE-HOME this entry to ${rel}:${n.start} (${n.lines} lines). Its content is unchanged (md5 ${was.slice(0, 8)}).` };
    }
    if (same.length > 1) {
      return { verdict: "ambiguous", by: "content",
        why: (key, rel) => `${key}: ${same.length} unpinned over-length blocks in ${rel} share this block's content `
          + `(md5 ${was.slice(0, 8)}) at ${same.map((b) => b.start).join(", ")} — a person picks the home.` };
    }
  }
  const near = over
    .filter((b) => Math.abs(b.start - at) <= RE_HOME_WITHIN && !claimed.has(b.start))
    .sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at))[0];
  if (near) {
    return { verdict: "re-home", by: "distance", to: near.start,
      why: (key, rel) => `${key}: the block MOVED — RE-HOME this entry to ${rel}:${near.start} `
        + `(${near.lines} lines). Do not drop it: the block is still there and still allowed.` };
  }
  return { verdict: "drop", by: was ? "content" : "distance",
    why: (key) => was
      ? `${key}: no unpinned over-length block anywhere in the file carries this block's content `
        + `(md5 ${was.slice(0, 8)}) — the block was shortened or removed, so DROP the entry.`
      : `${key}: no over-length block starts there and none within ${RE_HOME_WITHIN} lines is unpinned. `
        + "READ ON DISTANCE ALONE — supply the base digest before taking this as a fact about the block." };
}

/** Is `rel` inside a root the ruling covers? The landing kit's own tree is not: its docblocks ARE its record. */
export function coversPath(rel) {
  const p = String(rel);
  if (SCRIPT_EXCLUDE.includes(p)) return false;
  for (const r of [...SWEPT_ROOTS, ...TEST_ROOTS]) if (p === r || p.startsWith(`${r}/`)) return true;
  for (const r of SCRIPT_ROOTS) if (p.startsWith(`${r}/`) && !p.slice(r.length + 1).includes("/")) return true;
  return false;
}
