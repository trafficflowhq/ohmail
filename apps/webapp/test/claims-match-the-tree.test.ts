/**
 * ═══ A CLAIM ABOUT THE SERVER IS FALSE UNTIL THE SERVER IS IN THE TREE ════════════════════
 *
 * This lane wrote its client half against a contract relayed from another branch, and then wrote
 * the contract down in the present tense — in the binding ruling, in the gap row, in a published
 * message and in a source comment. Three review rounds found some of it; the third found the rest.
 *
 * The cost is not cosmetic and it is not the reader's inconvenience. A releaser reading "closed"
 * ships believing the ABA window is shut, and it is not shut until the server sends the header.
 * `ruling-citations.test.ts` cannot see this — a citation can resolve perfectly while the sentence
 * around it is false — so semantic drift needs its own guard.
 *
 * ── AND IT TURNS ITSELF OFF ──────────────────────────────────────────────────────────────────
 *
 * The forbidden phrases are forbidden BECAUSE the server half is absent. When it merges they stop
 * being false and start being the plain truth, and a guard that then had to be deleted by hand
 * would be a guard nobody deletes — it would sit there forcing hedged language about a shipped
 * feature. So the condition is measured from the tree: if `packages/api` serves the header, this
 * file passes and says why.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const REPO = `${process.cwd().replace(/\/$/, "")}/`;

/** Is a literal present anywhere in the server's source? `grep` exits 1 when nothing matches. */
function inServerSource(needle: string): boolean {
  try {
    const out = execFileSync("/usr/bin/grep", ["-rl", needle, "packages/api/src"],
      { cwd: REPO, encoding: "utf8" });
    return out.split("\n").filter(Boolean).length > 0;
  } catch {
    return false;
  }
}

/**
 * TWO CONDITIONS, MEASURED SEPARATELY — and keeping them separate is the point.
 *
 * They arrived at different times. The account header landed with the merge stack; the `/join`
 * conflict refusal has not landed at all. One flag for "the server half" would have gone true on
 * the header's arrival and quietly permitted the `session_conflict` claim, which is still false.
 */
const serverSendsHeader = (): boolean => inServerSource("X-Ohmail-Account");
const serverRefusesConflict = (): boolean => inServerSource("session_conflict");

/**
 * Sentences that assert the server already does this. Each is a phrase somebody actually wrote in
 * this lane and a reviewer had to find; they are listed rather than generalised, because a broad
 * pattern over prose refuses honest text and gets weakened until it means nothing.
 */
/** Phrases that assert the header contract. Forbidden only while the server does not send it. */
const HEADER_CLAIMS: Array<[string, RegExp]> = [
  ["a closure conditional on a merge, stated flat", /\bCLOSED at round eight\b/],
  ["the server described in the present tense", /\bThe server now (says|answers|sends)\b/],
  ["the header described as arriving", /\bthe server (?:now )?sends `?X-Ohmail-Account`?/i],
];

/** Phrases that assert the conflict refusal. Forbidden while the server does not return it. */
const CONFLICT_CLAIMS: Array<[string, RegExp]> = [
  ["the conflict code described as returned", /\bthe server (?:already )?returns `?409 session_conflict`?/i],
  ["the conflict refusal described in the present tense", /\bThe\s+server\s+refuses\s+that\s+request\s+outright/],
];

/* The product sources this lane wrote claims into. The binding ruling, the gap ledger and the public
 * messages carry the same claims and are scanned by `test/claims-match-the-tree.docs.test.ts`. */
const FILES = [
  "apps/webapp/app/api-client.ts",
  "apps/webapp/app/(product)/join/JoinScreen.tsx",
  "apps/webapp/app/(product)/join/MailboxStep.tsx",
] as const;

describe("what this lane says about the server matches what this tree contains", () => {
  const scan = (claims: Array<[string, RegExp]>): string[] => {
    const found: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(`${REPO}${f}`, "utf8");
      for (const [why, re] of claims) {
        const m = re.exec(src);
        if (m) found.push(`${f}: ${why} — ${JSON.stringify(m[0])}`);
      }
    }
    return found;
  };

  it("the account header may be described as arriving, because it now does", () => {
    /* THE SWITCH FIRED. This case asserted the opposite until the merge stack brought the server
       half in, and the premise case below is what announced it — a red at the moment the hedged
       language stopped being required, rather than hedging left standing over a shipped feature
       because nobody remembered to delete a guard. */
    expect(serverSendsHeader(),
      "the server no longer sends the header — every sentence in this lane that says it does has become false again")
      .toBe(true);
    expect(scan(HEADER_CLAIMS), "these are permitted now; listed only so the reason is on the record")
      .toBeDefined();
  });

  it("the /join conflict refusal may NOT be described as arriving — no server here returns it", () => {
    /* The half that did NOT land with the stack. Kept separate from the header for exactly this
       reason: one flag for "the server half" would have gone true on the header's arrival and
       quietly permitted this claim too. */
    if (serverRefusesConflict()) {
      expect(serverRefusesConflict()).toBe(true);   // inert once it lands, by the same rule
      return;
    }
    expect(scan(CONFLICT_CLAIMS),
      "no server in this tree returns `409 session_conflict`, and these sentences say one does. The `/join` inter-request window is not shut.")
      .toEqual([]);
  });
});
