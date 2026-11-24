import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// ONE scanner, so a `//` inside a string is never read as a comment — the quoted glob in
// packages/services/src/mailbox-service.ts opened one, and a bracket walk ran off the file.
import * as scan from "../../../scripts/lib/source-scan.mjs";
import { isEnginePart, readAsUnit } from "../../../test/support/engine-unit.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY WRITER OF THE ORGANIZING TRIPLE STAMPS WHEN IT HAPPENED (mail 0088)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The notice a person sees — *"another install organizes this mailbox now"*, *"that install
 * stopped — you can claim it"* — is DERIVED from two instants on the row: it shows iff
 * `organizer_event_at > coalesce(organizer_event_seen_at, -infinity)`. That shape is what makes it
 * appear exactly once per event on every door at once, and what makes two changes between two
 * reads collapse to the later one.
 *
 * It rests entirely on `organizer_event_at` being written by EVERY writer that changes the
 * (role, state, holder) triple. A writer that moves the role and forgets the stamp does not fail:
 * it produces a coherent row in which the mailbox has visibly changed hands and the person is
 * never told. Nothing throws, no query is wrong, and every other test stays green — which is the
 * shape of defect a census exists for and a reading cannot catch.
 *
 * ── THE FAILURE THIS IS SHAPED AGAINST IS THE WRITER NOBODY HAS ADDED YET ──────────────────
 *
 * There are eight such statements today — four on each door — and each is tested where its
 * behaviour is. What none of those
 * tests can say anything about is the SIXTH — a new roster sweep, a new backstop, a new door that
 * demotes a mailbox — and that is exactly how the original hole in this area was reached: mail
 * 0083 moved the stand-down onto `organizer_role` and left `disabled_reason` with no writer at
 * all, and five separate reads silently began answering NULL. Nothing was broken; a row that says
 * "nothing happened" is a coherent row.
 *
 * ── WHY IT MATCHES STATEMENTS AND NOT FILES ────────────────────────────────────────────────
 *
 * A file-level needle would be satisfied by any one statement in the file carrying the stamp, and
 * `apps/worker/src/mailboxes.ts` holds four writers of this triple. Three of them stamping is not
 * the invariant. So the unit is the `.set({…})` or `.values({…})` block, brace-matched, and every
 * block that names `organizerRole` or `organizerState` is asked the question on its own.
 *
 * ── AND WHY THE EXCEPTIONS ARE AN EXACT SET ────────────────────────────────────────────────
 *
 * `flag-intent-census.test.ts`'s rule, restated: a scanner that finds nothing is green, and a
 * broken scanner finds nothing. So the exceptions are enumerated and asserted as an exact set
 * rather than skipped by a predicate — a birth site that stops being one, or a sixth writer that
 * quietly joins the list, is red.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/** The two columns whose movement IS the event. Either one is enough to be a writer. */
const TRIPLE = /\borganizer(Role|State):/;

/** The stamp that has to ride the same statement. */
const STAMP = /\borganizerEventAt\b/;

/**
 * WRITES THAT ARE NOT EVENTS, by file and by the value that identifies them.
 *
 * Each is a BIRTH or a MIRROR, and neither is a change in who organizes an existing mailbox:
 *
 *  · `MailboxService.create` and its OAuth twin write `organizerRole: "reader"` on an INSERT —
 *    a mailbox connected for the first time, which nobody has ever organized. There is no prior
 *    situation for an event to be a change from, and stamping one would put a notice in front of
 *    somebody about a mailbox they connected ten seconds ago.
 *  · `identity.ts#ensureLocalWorld` is the standalone door's version of the same INSERT.
 *
 * The MIRROR (`cloud-mirror.ts`) is deliberately NOT here: it carries both instants, because the
 * hosted row is the authority and a door that mirrored half of the pair would either re-show a
 * dismissed notice or hide a real one. It is therefore an ordinary writer as far as this census is
 * concerned, and it passes.
 *
 * A path plus a discriminator rather than a path alone, so that a file which gains a genuine
 * demotion beside its create does not inherit the exemption.
 */
const BIRTH_SITES: ReadonlyArray<{ file: string; contains: RegExp }> = [
  { file: ["packages", "services", "src", "mailbox-service.ts"].join(sep), contains: /organizeConsentedAt: null,/ },
  { file: ["apps", "sidecar", "src", "identity.ts"].join(sep), contains: /provider: "imap",/ },
];

/**
 * THE WRITERS OF RECORD, as an exact set of FILES.
 *
 * `apps/worker/src/mailboxes.ts` holds four (the stand-down, the promotion, the holder refresh,
 * the release); `apps/sidecar/src/engine.ts` holds the desktop's four (the peek, the release, the
 * promotion, the stand-down). A file joining this list is a deliberate decision rather than an
 * accident, which is the point — and the statement count below is what stops a fifth write
 * appearing inside one of these two files unnoticed.
 */
const EVENT_SITES = new Set([
  ["apps", "sidecar", "src", "engine.ts"].join(sep),
  ["apps", "worker", "src", "mailboxes.ts"].join(sep),
  /* THE THIRD FILE, and it joined by the decision this comment records rather than by accident.
     `identity.ts#endLegacyOrganizerPauses` rewrites a row a build older than mail 0083 left
     `disabled` with an `organized_elsewhere:*` reason into the reader that state has meant since:
     one write, at boot, keyed on a predicate that is false once it has run. It is NOT the birth
     below it — that one INSERTs a mailbox nobody has organized — so it stamps, and what the person
     sees does change on that launch: a mailbox that was off comes up reading, with a banner naming
     who holds it. */
  ["apps", "sidecar", "src", "identity.ts"].join(sep),
]);

/**
 * THE MIRROR IS NOT A WRITER OF RECORD, and it is asserted separately for exactly that reason.
 *
 * `apps/sidecar/src/cloud-mirror.ts` builds its row through a projection helper rather than an
 * inline `.set({…})`, so the statement walk below does not reach it — and it should not: the
 * mirror makes no decision about who organizes anything. It COPIES a hosted row, and the hosted
 * row's own writer has already stamped the event.
 *
 * What it must not do is copy half the pair. `event_at` without `seen_at` re-shows a notice the
 * person dismissed in the browser; `seen_at` without `event_at` hides one they have never seen.
 * That is a real defect with no symptom on either side of the mirror, so it gets its own row here
 * rather than an exemption and a hope.
 */
const MIRROR = ["apps", "sidecar", "src", "cloud-mirror.ts"].join(sep);

const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", ".next", "coverage"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      if (name.endsWith(".test.ts") || name.endsWith(".test.tsx") || isEnginePart(p)) continue;
      yield p;
    }
  }
}

function rootsOf(): string[] {
  const roots: string[] = [];
  for (const bucket of ["packages", "apps"]) {
    for (const name of readdirSync(join(REPO, bucket))) {
      for (const sub of ["src", "app"]) {
        const p = join(REPO, bucket, name, sub);
        try {
          if (statSync(p).isDirectory()) roots.push(p);
        } catch {
          /* no such subdir — fine */
        }
      }
    }
  }
  return roots;
}

/**
 * Source with COMMENTS REMOVED. The stand-down census's reason verbatim, and it bites in the same
 * direction: this file's own prose names `organizerEventAt` repeatedly, and a block whose only
 * occurrence of the stamp were in a comment would be a writer certified by a sentence.
 */
const withoutComments = (src: string): string => scan.withoutComments(src);

/**
 * Every `.set({…})` / `.values({…})` block, brace-matched from its opening `{`.
 *
 * ── STRING AND TEMPLATE LITERALS ARE SKIPPED, AND THAT IS NOT FASTIDIOUSNESS ────────────────
 *
 * The first version of this walker counted raw braces, and it merged two of `mailbox-service.ts`'s
 * inserts into ONE block: a `sql\`… end\`` fragment between them carries a `}` from a `${…}`
 * interpolation, which unbalanced the match and ran it to the next brace that happened to close.
 * The consequence is worse than an ugly count — the second statement was never asked the question
 * at all, and a census that silently stops looking at a writer is exactly the vacuous green this
 * file's header refuses.
 *
 * So the scanner skips what cannot contain a real brace: `'…'`, `"…"` and backtick templates
 * (whose `${…}` interpolations ARE counted, because those are ordinary code). Still crude — it
 * does not understand regex literals — and still safe in the same direction: a mis-matched block
 * can hide a stamp, which fails loudly, and cannot invent one.
 */
function writeBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /\.(?:set|values)\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    /** Template nesting: each entry is the brace depth at which the current `${…}` began. */
    const templates: number[] = [];
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (c === "\\") { i += 1; continue; }
      if (c === "'" || c === '"') {
        const quote = c;
        i += 1;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === "\\") i += 1;
          i += 1;
        }
        continue;
      }
      if (c === "`") {
        // Walk the template, stopping at each `${` so its interpolation is scanned as code.
        i += 1;
        while (i < src.length) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "`") break;
          if (src[i] === "$" && src[i + 1] === "{") { templates.push(depth); depth += 1; i += 1; break; }
          i += 1;
        }
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (templates.length > 0 && depth === templates[templates.length - 1]) {
          // The interpolation closed; the rest of the template is not code. Resume scanning it.
          templates.pop();
          i += 1;
          while (i < src.length) {
            if (src[i] === "\\") { i += 2; continue; }
            if (src[i] === "`") break;
            if (src[i] === "$" && src[i + 1] === "{") { templates.push(depth); depth += 1; i += 1; break; }
            i += 1;
          }
          continue;
        }
        if (depth === 0) break;
      }
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}

interface Writer { file: string; block: string }

function tripleWriters(): Writer[] {
  const out: Writer[] = [];
  for (const root of rootsOf()) {
    for (const file of walk(root)) {
      const rel = relative(REPO, file);
      const src = withoutComments(readAsUnit(file));
      for (const block of writeBlocks(src)) {
        if (!TRIPLE.test(block)) continue;
        const birth = BIRTH_SITES.find((b) => b.file === rel && b.contains.test(block));
        if (birth) continue;
        out.push({ file: rel, block });
      }
    }
  }
  return out;
}

describe("the organizing event is stamped by every writer of the triple", () => {
  it("the writers of record are exactly the known files", () => {
    const found = new Set(tripleWriters().map((w) => w.file));
    expect([...found].sort()).toEqual([...EVENT_SITES].sort());
  });

  it("every one of them writes organizer_event_at in the SAME statement", () => {
    const writers = tripleWriters();
    for (const w of writers) {
      expect(STAMP.test(w.block),
        `${w.file} moves the organizing role or state and does not stamp organizer_event_at in `
        + "the same statement — the mailbox visibly changes hands and nobody is ever told:\n"
        + w.block.slice(0, 400)).toBe(true);
    }
    /* THE WALK FOUND SOMETHING. A scanner that stopped matching is otherwise green, which is the
       one failure a census cannot afford. The count is a literal on purpose: another one is a
       decision somebody has to make here. Nine since the boot repair above — the desktop's four,
       the worker's four, and the one that ends a pause an older build left. */
    expect(writers.length).toBe(9);
  });

  it("the Cloud mirror copies BOTH instants, or the notice lies on a Cloud-connected desktop", () => {
    const src = withoutComments(readFileSync(join(REPO, MIRROR), "utf8"));
    expect(/organizerEventAt:/.test(src),
      `${MIRROR} mirrors the organizing role and drops the event instant — a Cloud-connected `
      + "desktop shows a mailbox that visibly changed hands with no line saying so").toBe(true);
    expect(/organizerEventSeenAt:/.test(src),
      `${MIRROR} mirrors the event instant and drops the acknowledgement — a notice dismissed in `
      + "the browser comes back on the desktop, for ever").toBe(true);
  });

  /**
   * THE BIRTH SITES ARE STILL BIRTHS. The exemption is by file AND by a value that identifies the
   * statement, so a file that gains a genuine demotion beside its create does not inherit it —
   * but the exemption itself could still go stale by matching nothing, at which point the create
   * would start failing the census for the wrong reason. Asserted directly rather than left to be
   * discovered as a confusing red.
   */
  it("each birth exemption still matches exactly one statement", () => {
    for (const birth of BIRTH_SITES) {
      const src = withoutComments(readFileSync(join(REPO, birth.file), "utf8"));
      const matching = writeBlocks(src)
        .filter((b) => TRIPLE.test(b) && birth.contains.test(b));
      expect(matching.length,
        `${birth.file}: the birth exemption matches ${matching.length} statements, not at least one `
        + "— it has gone stale, and a create is about to be read as an unstamped demotion")
        .toBeGreaterThan(0);
    }
  });
});
