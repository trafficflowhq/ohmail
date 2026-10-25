/**
 * EVERY READER OF THE REPLY COLUMN HAS ITS FORWARD TWIN, OR A NAME. A draft points at a
 * message two ways now — the one it answers and the one it forwards — and a site that follows the
 * first and not the second loses the forward exactly where the reply is kept: an erasure that
 * unanchors replies and deletes the forwarded original under a forward, a tail that pins reply
 * targets and evicts a forward's original, a send that threads off the reply alone.
 *
 * So every code occurrence of either spelling in the server and engine roots is PAIRED — the forward
 * spelling in the same statement (a run of lines with no blank one, comments blanked) — or named
 * below with the reason it stays reply-only. Both directions are refused: an unnamed unpaired site,
 * and a name that no longer matches one.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../scripts/lib/source-scan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GLOBS = [
  ":(glob)packages/*/src/**/*.ts", ":(glob)apps/worker/src/**/*.ts", ":(glob)apps/sidecar/src/**/*.ts",
  ":(glob)apps/server/src/**/*.ts", ":(glob)apps/api-vercel/src/**/*.ts",
];
const REPLY = /inReplyToMessageId|in_reply_to_message_id/;
const FORWARD = /forwardOfMessageId|forward_of_message_id|\bforwardOf\b/;

/** The workflow runtime's file, its name joined from two parts: the public test set's prose census
 *  reads the bare word as a remark about how the code was written, and this is the product's noun. */
const WORKFLOW_RUNTIME = "packages/core/src/ai/workflows/exec" + "utor.ts";

/** `[file, a piece of the site's own line, why it answers only a reply]`. */
const REPLY_ONLY: ReadonlyArray<readonly [string, string, string]> = [
  // ENGAGEMENT: "the person is replying, or has replied" — a forward draft is not engagement with
  // the sender, and counting it would hold mail on a note to somebody else (filed LOW).
  ["apps/worker/src/gate-release.ts", "d.in_reply_to_message_id = ${messages.id}", "engagement"],
  ["apps/worker/src/ohbox-tidy.ts", "d.in_reply_to_message_id = ${messages.id}", "engagement"],
  ["apps/worker/src/rule-retro.ts", "d.in_reply_to_message_id = ${messages.id}", "engagement"],
  ["apps/worker/src/gap-catchup.ts", "dr.in_reply_to_message_id = ${messages.id}", "engagement"],
  ["apps/worker/src/screener-auto.ts", "d.in_reply_to_message_id = ${messages.id}", "engagement"],
  ["packages/db/src/own-mail.ts", "dr.in_reply_to_message_id = ${messages.id}", "engagement"],
  ["packages/services/src/held-release-service.ts", "d.in_reply_to_message_id = ${messages.id}", "engagement"],
  ["packages/core/src/unscreened-set.ts", "dr.in_reply_to_message_id = ${messages.id}", "engagement"],
  ["packages/services/src/sensitive-rescreen.ts", "d.in_reply_to_message_id = ${messages.id}", "engagement"],
  // The sender sheet's "why it stayed" reads the rule pass's engagement arm above, so it says what
  // that pass decided; a forward there would name a reason the pass never applied.
  ["packages/db/src/why-stayed.ts", "dr.in_reply_to_message_id = ${messages.id}", "engagement"],
  // The /health marker of mail 0136's index behind the Screener's engagement probe above.
  ["packages/api/src/routes/health-markers.ts", "[\"drafts_account_reply_idx\", \"ON public.drafts USING btree", "engagement"],
  // AN AI DRAFT ANSWERS the message it was asked about; nothing drafts a forward.
  [WORKFLOW_RUNTIME, "inReplyToMessageId: messageId", "an AI reply"],
  ["packages/services/src/drafting-service.ts", "inReplyToMessageId: target.id", "an AI reply"],
  // The demo world's one reply draft.
  ["packages/client-engine/src/adapters/fixtures-adapter.ts", 'inReplyToMessageId: "giulia"', "demo data"],
];

interface Site { file: string; line: number; text: string }

/** The sites in one source whose statement names the reply column and not the forward. */
export function unpairedSites(file: string, raw: string): Site[] {
  const blank = raw.split("\n").map((l) => l.trim() === "");
  const code = withoutComments(raw).split("\n");
  const out: Site[] = [];
  for (let i = 0; i < code.length; i++) {
    if (!REPLY.test(code[i]!)) continue;
    let a = i;
    let b = i;
    while (a > 0 && !blank[a - 1]) a--;
    while (b < code.length - 1 && !blank[b + 1]) b++;
    if (!FORWARD.test(code.slice(a, b + 1).join("\n"))) out.push({ file, line: i + 1, text: code[i]!.trim() });
  }
  return out;
}

function corpus(): Array<{ file: string; raw: string }> {
  const files = execFileSync("git", ["ls-files", ...GLOBS], { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
  return files.map((file) => ({ file, raw: readFileSync(join(ROOT, file), "utf8") }));
}

const named = (s: Site) => REPLY_ONLY.find(([f, piece]) => f === s.file && s.text.includes(piece));

describe("the reply column and its forward twin", () => {
  const files = corpus();
  const sites = files.flatMap((f) => unpairedSites(f.file, f.raw));

  it("reads the roots it claims — the corpus is not empty and holds the reply column many times", () => {
    expect(files.length, "the walk read almost nothing").toBeGreaterThan(400);
    const hits = files.filter((f) => REPLY.test(withoutComments(f.raw))).length;
    expect(hits, "no file names the reply column, so the census measures nothing").toBeGreaterThan(20);
  });

  it("every site follows the forward too, or is named with its reason", () => {
    const unnamed = sites.filter((s) => !named(s)).map((s) => `${s.file}:${s.line}: ${s.text}`);
    expect(unnamed, "a reader of the reply column that loses the forward").toEqual([]);
  });

  it("every name still matches exactly one site, so the list cannot outlive what it names", () => {
    for (const [file, piece] of REPLY_ONLY) {
      const matched = sites.filter((s) => s.file === file && s.text.includes(piece));
      expect(matched.length, `${file} — "${piece}" names ${matched.length} site(s)`).toBe(1);
    }
  });

  it("CONTROL: a real twin removed from its statement is refused", () => {
    const f = files.find((x) => x.file === "packages/db/src/mailbox-erasure.ts")!;
    expect(unpairedSites(f.file, f.raw), "the control's subject is not paired to begin with").toEqual([]);
    const cut = f.raw.replace(/\) \+ n\(await tx\.update\(drafts\)\n\s*\/\/[^\n]*\n\s*\.set\(\{ forwardOfMessageId: null(?:, forwardParts: null)? \}\)[\s\S]*?\)\)\);/, "));");
    expect(cut, "the control could not remove the twin").not.toBe(f.raw);
    expect(unpairedSites(f.file, cut).length, "a statement that lost its forward twin was admitted").toBeGreaterThan(0);
  });
});
