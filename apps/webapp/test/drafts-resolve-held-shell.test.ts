/**
 * THE SHELL ASKS ABOUT THE HOLD BEFORE IT OPENS A REPLY, AND ANSWERS FOR A HELD SEND THROUGH ONE DOOR. Moved from
 * `drafts-resolve-held.test.tsx` (whose other cases stand over today's Drafts view until its mount). The verbs are
 * `shell-compose.ts`'s, which the mail ground's `WritingMount` mounts; what today's `AppShell` handed the surfaces is
 * read where it is handed now: `writing-of.ts` (the composition as Write reads it), Write's reply and its status.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sliceOfDeclaration } from "./source-anchor";

const SHELL = readFileSync(
  resolve(process.cwd(), "packages/app-logic/src/writing/shell-compose.ts"),
  "utf8",
);
/* What the old shell's frame handed Write, read where the mail ground hands it now. */
const FRAME = ["packages/app-logic/src/writing/writing-of.ts", "packages/app/src/write/Reply.tsx",
  "packages/app/src/write/status/Status.tsx"].map((rel) => readFileSync(resolve(process.cwd(), rel), "utf8")).join("\n");

describe("the shell asks about the hold BEFORE it opens a reply", () => {
  /**
   * ══ THE CENTRAL STRUCTURAL GUARD ═══════════════════════════════════════════════════════
   *
   * Mutation: move `const parked = hold.kind !== "free";` and its `holdOf` read back below the
   * `if (parent …)` block in `AppShell.openDraftWithBody`. Real failure text:
   *   AssertionError: openDraftWithBody's reply arm runs before the hold is known — a held reply
   *   opens in the inline editor with Send live: expected -1 to be greater than -1
   *
   * `openDraftWithBody` and not `openDraft`: opening a draft is two steps now — `openDraft`
   * decides whether the text is in hand and fetches it when it is not, and this is the door it
   * hands a known body to. The hold order is a property of the door, and slicing the wrong
   * declaration reads as the order being gone.
   */
  it("the hold is read above the reply arm, and the arm refuses a parked row", () => {
    const openDraft = sliceOfDeclaration(SHELL, "openDraftWithBody");
    const holdRead = openDraft.indexOf("const parked = hold.kind !== \"free\";");
    const replyArm = openDraft.indexOf("if (parent");

    expect(holdRead, "openDraftWithBody no longer computes a hold at all").toBeGreaterThan(-1);
    expect(replyArm, "openDraftWithBody no longer has a reply arm to guard").toBeGreaterThan(-1);
    expect(
      replyArm,
      "openDraftWithBody's reply arm runs before the hold is known — a held reply opens in the inline "
      + "editor with Send live, which is a second copy of a message that may already have been "
      + "delivered",
    ).toBeGreaterThan(holdRead);

    // And the arm actually CONSULTS it: the order alone would be satisfied by a read nobody uses.
    expect(
      openDraft.slice(replyArm, replyArm + 40),
      "the reply arm does not consult the hold it now runs after",
    ).toMatch(/if \(parent && !parked\)/);
  });

  /** The two answers share one version-bound resolution; the mounted holder checks both outcomes without resending. */
  it("the shell dispatches draft_resolve with the outcome it was handed", () => {
    const answer = sliceOfDeclaration(SHELL, "answerHeldDraft");
    const sendAgain = sliceOfDeclaration(SHELL, "sendAgain");
    const resolve = sliceOfDeclaration(SHELL, "resolveHeldSend");
    expect(resolve).toMatch(/answerHeldDraft\(shown, outcome\)/);
    expect(sendAgain).toMatch(/answerHeldDraft\(d, "not_arrived", true\)/);
    expect(answer.match(/engine\.mutate\(/g)).toHaveLength(1);
    expect(answer).toMatch(/if \(starting !== shown/);
    expect(answer).toMatch(/if \(answering\.has\(draftId\)/);
    expect(answer).toMatch(/answering\.add\(draftId\);[\s\S]*?engine\.mutate\(\{ kind: "draft_resolve", draftId, outcome, ifUpdatedAt: starting\.updatedAt \}/);
    expect(answer + sendAgain + resolve).not.toMatch(/mail_send/);
    expect(
      FRAME,
      "the resolution is wired to something other than the composer's own resolve",
    ).toMatch(/onResolve: w\.resolveHeldSend/);
  });
  /**
   * ── AND THE PRESS INSIDE THE EDITOR, WHICH THE HOISTED READ DOES NOT COVER ────────────────
   *
   * `openDraft` is one door onto a held reply. The other is the message itself: open the
   * conversation and its inline editor is there, with no draft row in its mutation and a scratch
   * buffer that carries none. So the press asked the predicate about `null`, got `free`, and the
   * adapter made a second row and sent under a fresh key — while the first row sat at
   * `unverified` and Drafts said so. The shell knows the row; it hands it to the press.
   *
   * Mutation: drop `heldRow: heldReplyRow(messageId)` from `sendReply`'s `withDone`. Real failure
   * text: AssertionError: sendReply presses without naming the reply's own row, so the hold at
   * that door is asked about nothing
   */
  it("sendReply hands the reply's unconfirmed row to the press", () => {
    const sendReply = sliceOfDeclaration(SHELL, "sendReply");
    expect(
      sendReply,
      "sendReply presses without naming the reply's own row, so the hold at that door is asked "
      + "about nothing and a second copy goes out under a fresh key",
    ).toMatch(/withDone\(\{\s*heldRow: heldReplyRow\(messageId\)[,\s}]/);
    /* By the DECLARED NAME and no hook — `anchor-census.test.ts`'s rule: a census that locates a
       declaration by its memoization hook is one a codemod turns into a silent -1. */
    expect(
      SHELL,
      "the shell no longer derives the reply's unconfirmed row, so nothing can name it",
    ).toContain("const heldReplyRow");
    /* THE ROW IS THE HELD ONE, not simply the first reply draft: an ordinary draft cannot be
       held, and offering the reader "did this arrive?" about it is a question about a send
       nobody attempted. */
    expect(
      sliceOfDeclaration(SHELL, "heldReplyRow"),
      "heldReplyRow stopped narrowing to a row past `draft`",
    ).toMatch(/d\.status !== "draft"/);
  });

  /**
   * The editor's own reading of the hold, and the two verbs that follow from it. Structural for
   * the shell half; the DOM and the refusal are driven in `mail-send-states.test.ts`.
   *
   * Mutation: put `replySendState: mailSend.stateOf` back. Real failure text:
   *   AssertionError: the reply editor reads the durable record alone …
   */
  it("the editor's send state carries the row's witness, and its verbs the shell's resolve", () => {
    expect(
      FRAME,
      "the reply editor reads the durable record alone — a record a sweep, the seven-day age "
      + "limit or another device leaves it without, which is the state the field report was in",
    ).toMatch(/replySendState: compose\.replySendState,/);
    expect(
      sliceOfDeclaration(SHELL, "replySendState"),
      "the reply's send state stopped projecting the hold onto the row",
    ).toMatch(/heldRowUnverified\(/);
    expect(
      FRAME,
      "the reply editor is handed no way to answer for a held send, so the door the reader "
      + "actually opens is a dead end again",
    ).toMatch(/onResolve=\{w\.resolveHeldSend\}/);
    /* AND THE COMPOSER, which holds its row in storage rather than in the drafts list — the
       prop is JSX, so it is asked of the shell frame. */
    expect(
      FRAME,
      "the composer is handed no way to answer for the send it is holding",
    ).toMatch(/const row = readComposeRow\(scope\);[\s\S]*?const hold = holdOf\(engine, \{ lane: COMPOSE_SEND_KEY, draftId: row/);
    expect(FRAME, "the composer's status is handed no way to answer for the send it is holding")
      .toMatch(/const said = \{\s+send: w\.composeSend,\s+held,\s+locked,\s+showShortSending: w\.composeReopenedSending,\s+onResolve: w\.resolveHeldSend,\s+\}/);
  });

  /** The mounted Drafts tests exercise these invariants with two attempts for one row. */
  it("the shell releases through the one door, once, and only on a confirmed answer", () => {
    const body = sliceOfDeclaration(SHELL, "answerHeldDraft");
    const release = sliceOfDeclaration(SHELL, "captureDraftSendRelease");
    const captured = body.indexOf("const release = captureDraftSendRelease(draftId, session)");
    const answered = body.indexOf("await engine.mutate(");
    expect(captured, "the resolution must capture its send records").toBeGreaterThan(-1);
    expect(answered, "a later answer may name a newer send").toBeGreaterThan(captured);
    expect(
      release,
      "the answer must release the captured key and fingerprint only",
    ).toMatch(/for \(const \{ key, fp \} of records\) releaseSendLock\(COMPOSE_SEND_KEY, fp, owed, scope, key\)/);
    expect(
      body.slice(answered),
      "the resolution must leave the durable record on a refusal or superseded answer",
    ).toMatch(/onSettled: \(result\) => \{ if \(result\.status === "confirmed"\) release\(\); \}/);
    expect(body.match(/\brelease\(\)/g), "the captured release must have one caller").toHaveLength(1);
    expect(
      /* CALLS, not mentions — a comment naming the function is not a second door. */
      (release.match(/releaseSendLock\w*\(/g) ?? []).length,
      "a second release path appeared beside the one door",
    ).toBe(1);
    /* A send that may STILL BE RUNNING is refused by name, and "it failed" is not what to say
       about "not yet". */
    expect(
      body,
      "the still-running refusal is reported as a failure, so a person is told the answer did "
      + "not reach the server when it did",
    ).toMatch(/send_still_running/);
  });
});
