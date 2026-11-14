/** @vitest-environment jsdom */
import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  bodyMatchCount,
  bodyTextOf,
  detectBodyToken,
  MAX_BODY_SCAN,
  planSubjectRule,
  subjectRuleContext,
} from "@ohmail/app-logic/press/subject-rule";
import { CORPUS, SENDER, TOKEN, mirror, msg, ruleRow } from "./_ohbox-1-body-rule.js";

/**
 * SPLITTING ONE SENDER BY WHAT THE MESSAGE SAYS: THE PLANNER's HALF, moved out of `body-rule.test.tsx` word for word
 * (that file keeps the sheet, the why-it-went-there panel and the rules surface, which wait for their mounts). These
 * cases run the press's own functions (`@ohmail/app-logic/press/subject-rule`) over a memory mirror: what is
 * detected in the held text, what the client knows of a message's text, and the rule the plan writes. The file's
 * header (the content term, mail 0052, and the floor the client's text is) stands in `body-rule.test.tsx`.
 */

// ───────────────────────────── detection ─────────────────────────────

describe("detecting the repeating token in the text", () => {
  it("finds the bracketed tag that repeats across the sender's other bodies", () => {
    expect(detectBodyToken(
      `${TOKEN} brute-force attempt blocked`,
      [`Scan finished.\n${TOKEN}\nUnsubscribe.`, "Rechnung 2026-08"],
    )).toBe(TOKEN);
  });

  it("answers null when nothing repeats — a tag seen once is this message's wording", () => {
    expect(detectBodyToken(`${TOKEN} one-off`, ["Rechnung", "Terminbestätigung"])).toBeNull();
  });

  it("refuses prose — there is deliberately NO leading-label class for bodies", () => {
    // A body's first colon is a greeting or a sentence, not a label. Only a bracketed run — the
    // sender's own deliberate tag — is offered, so repeating PROSE yields nothing.
    expect(detectBodyToken(
      "Hello: your weekly report is ready",
      ["Hello: your weekly report is ready"],
    )).toBeNull();
  });

  it("compares case-insensitively and keeps the sender's own capitalisation", () => {
    expect(detectBodyToken(
      `${TOKEN} nightly`, ["[ninjafirewall] weekly"],
    )).toBe(TOKEN);
  });

  it("scans only the head of the body — a tag buried past the bound is not offered", () => {
    // The bound is what makes running this over a stranger's multi-kilobyte text safe on every
    // render of an open sheet. A token AFTER it must not be found in the focus OR in the others.
    const deep = `${"x".repeat(MAX_BODY_SCAN)} ${TOKEN}`;
    expect(detectBodyToken(deep, [deep])).toBeNull();
  });

  it("prefers the longer bracketed run — the more specific tag", () => {
    const focus = `[NF] ${TOKEN} alert`;
    expect(detectBodyToken(focus, [`[NF] ${TOKEN} weekly`])).toBe(TOKEN);
  });
});

describe("what the client knows about a message's text", () => {
  it("reads the full body where the mirror holds one, the snippet otherwise", () => {
    expect(bodyTextOf(msg("a", SENDER, "s", "INBOX", { body: "full", snippet: "snip" }))).toBe("full");
    expect(bodyTextOf(msg("b", SENDER, "s", "INBOX", { snippet: "snip" }))).toBe("snip");
  });

  it("counts a match wherever the held text shows it, and nowhere else — the floor", () => {
    const list = [
      msg("hydrated", SENDER, "s", "INBOX", { body: `${TOKEN} deep in the body`, snippet: "top" }),
      msg("snippet-hit", SENDER, "s", "INBOX", { snippet: `${TOKEN} at the top` }),
      // The server WOULD match this one — the token sits past the snippet — but the client
      // cannot see it, and claiming it would be a number the surface cannot stand behind.
      msg("unhydrated", SENDER, "s", "INBOX", { snippet: "the top of a long message" }),
    ];
    expect(bodyMatchCount(list, TOKEN)).toBe(2);
  });
});

// ───────────────────────────── the context and the plan ─────────────────────────────

describe("the sheet's world, with a content token", () => {
  it("detects the body token from the mirror and lists body rules among the existing", async () => {
    const store = await mirror(CORPUS(), [
      ruleRow({ id: "body-rule", destination: "ohmail/News", bodyContains: TOKEN }),
    ]);
    const ctx = subjectRuleContext(store, "alert-1")!;
    expect(ctx.bodyToken).toBe(TOKEN);
    // No subject token — the subjects are all identical, which is this feature's whole case…
    expect(ctx.token).toBeNull();
    // …and a rule narrowed by BODY is "one of these" for the duplicate warning and the footer.
    expect(ctx.existing.map((r) => r.id)).toEqual(["body-rule"]);
  });
});

describe("the plan, field = body", () => {
  const wire = (m: EngineMutation[]) => m as unknown as Array<Record<string, unknown>>;

  it("writes ONE rule carrying bodyContains — not subjectContains — and counts only matching mail", async () => {
    const store = await mirror(CORPUS());
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads", "body");

    expect(wire(plan.ruleMutations)).toEqual([{
      kind: "rule_create",
      ruleKind: "sender",
      match: SENDER,
      destination: "ohmail/News",
      bodyContains: TOKEN,
      applyRetro: true,
    }]);
    expect(plan.field).toBe("body");

    // THE LOAD-BEARING NEGATIVE: the invoice's body has no token, so it is not counted — every
    // other assertion here would pass with the field mix-up this pins against. The press moves
    // none of it itself: a new rule's backlog is the server pass's (THE-CLIENTS-FIFTY).
    expect(plan.mutations.filter((m) => m.kind === "move")).toEqual([]);
    expect(plan.matched).toBe(2);
    expect(plan.outOfPlace).toBe(2);
  });

  it("a SUBJECT rule with the same token is NOT 'already this rule'", async () => {
    // Same token, different field — two different statements about two different slices. Folding
    // them into one "already" would silently refuse the rule the user actually asked for.
    const store = await mirror(CORPUS(), [
      ruleRow({ destination: "ohmail/News", subjectContains: TOKEN }),
    ]);
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads", "body");
    expect(plan.already).toBe(false);
    expect(plan.ruleMutations).toHaveLength(1);
  });

  it("an identical BODY rule is a duplicate, and nothing is written", async () => {
    const store = await mirror(CORPUS(), [
      ruleRow({ destination: "ohmail/News", bodyContains: TOKEN }),
    ]);
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads", "body");
    expect(plan.already).toBe(true);
    expect(plan.ruleMutations).toEqual([]);
  });
});
