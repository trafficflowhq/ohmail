/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  mutationEffects,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MutationStatus,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { LEGACY_NEWS_FOLDER } from "@trafficflow/core/folder-name";
import {
  autoUnsubscribeDoor,
  DECISION_OF_DEST,
  dispatchScreeningChange,
  movesAtLanding,
  planScreeningChange,
  releaseRules,
  screeningToast,
  senderScreening,
  worstStatus,
  type ScreeningPlan,
} from "../app/shell/sender-screening";

/**
 * CHANGING A SENDER'S SCREENING FROM ANYWHERE — what goes on the WIRE.
 *
 * This was asked for from the Ohbox, and the Ohbox is precisely where the Screener's
 * endpoint does not work: `POST /screener/:id` resolves `:id` only against mail still held
 * in `ohmail/Screener`. So there are two code paths and they must not be confused:
 *
 *   · WAITING sender → the endpoint, carrying the destination, and the server promotes a rule
 *     pointing at that same folder in the same transaction. Nothing else is dispatched;
 *   · anywhere else → `move` plus an explicit `rule_create`, because the endpoint would 404.
 *
 * Confusing them in the obvious direction — sending a decide for a sender who has left the
 * Screener — is a refusal the user sees as "nothing happened". Confusing the yes/no mapping is
 * how an early version nearly filed spam into the Ohbox.
 *
 * ── SCR-READ CHANGED THE FIRST BULLET, AND IT USED TO BE THE DEFECT ──────────────────────
 *
 * It read: *"the endpoint, plus `move` for the three destinations it cannot express"*, against
 * a wire that answered *"with exactly two folders, `INBOX` for yes and `ohmail/Screened` for
 * no"*. Both statements were accurate and the composition they described was a race the user's
 * choice usually lost, because `decide` reads its held rows outside its transaction and then
 * writes `desired_folder` inside it. Production carried four `provenance:'promoted'` rules at
 * `INBOX` for senders admitted with **Reads** and their bulletins in the Ohbox behind them.
 */

let seq = 0;

function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: from },
    to: [],
    cc: [],
    date: `2026-08-0${(seq % 8) + 1}${"T"}09:00:00.000Z`,
    folder,
    snippet: `snippet ${id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

function ruleRow(over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id: `r-${++seq}`,
    kind: "sender",
    match: "lena@atelier.example",
    destination: "ohmail/News",
    priority: 0,
    provenance: "manual",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

async function mirror(messages: EngineMessage[], rules: RuleDTO[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
    ...rules.map((r): SyncChange => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r,
    })),
  ]);
  return store;
}

const kinds = (plan: { mutations: readonly EngineMutation[] }, kind: string): Array<Record<string, unknown>> =>
  plan.mutations.filter((m) => m.kind === kind) as unknown as Array<Record<string, unknown>>;

/** A plan's moves as the demo arm asks them (no forecast): every candidate the plan carries. */
const movesOf = (plan: ScreeningPlan) => movesAtLanding(plan, null);

describe("reading a sender out of any one of their messages", () => {
  it("groups every folder they appear in, case-insensitively, from ONE message id", async () => {
    // The entry point is always a `data-id` off a row, and rows exist in six different
    // views. One lookup has to serve all of them or the affordance cannot be global.
    const store = await mirror([
      msg("a", "Lena@Atelier.example", "ohmail/Screener"),
      msg("b", "lena@atelier.example", "ohmail/Screener"),
      msg("c", "lena@ATELIER.example", "INBOX"),
      msg("d", "someone@else.example", "INBOX"),
    ]);
    const s = senderScreening(store, "c")!;
    expect(s.messages.map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
    expect(s.waiting).toBe(true);
    expect(s.current).toBeNull(); // spread across Screener and Ohbox
  });

  it("a sender wholly in one place reports that place, and is not 'waiting'", async () => {
    const store = await mirror([
      msg("a", "lena@atelier.example", "INBOX"),
      msg("b", "lena@atelier.example", "INBOX"),
    ]);
    const s = senderScreening(store, "a")!;
    expect(s.current).toBe("ohbox");
    expect(s.waiting).toBe(false);
    expect(s.representativeId).toBeNull();
  });
});

describe("a WAITING sender goes through the endpoint that makes a rule", () => {
  it("Ohbox is the endpoint's own yes, with no follow-up move", async () => {
    const store = await mirror([
      msg("a", "lena@atelier.example", "ohmail/Screener"),
      msg("b", "lena@atelier.example", "ohmail/Screener"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "ohbox");
    expect(kinds(plan, "screener_decide")).toEqual([
      expect.objectContaining({ senderId: "a", decision: "yes", scope: "sender" }),
    ]);
    expect(movesOf(plan)).toEqual([]);
    expect(plan.rule).toBe(true);
    expect(plan.moved).toBe(2);
  });

  /**
   * ── SCR-READ: THE DECIDE NAMES THE DESTINATION, SO THERE IS NOTHING TO COMPOSE ───────────
   *
   * This was *"Reads adds a move, because the endpoint has no such destination"* and asserted
   * the `move` fan-out beside the decide. The endpoint has the destination now, and the fan-out
   * is gone — not as a simplification but because it was a race the user's choice kept losing:
   * `decide` reads its held rows outside its transaction and writes `desired_folder` inside it,
   * so a `move` landing in that window was stamped back to `INBOX`. Four `promoted → INBOX`
   * rules and dozens of misfiled bulletins in use came out of exactly this line.
   */
  it("a WAITING sender needs no move at all — the decide carries the destination", async () => {
    const store = await mirror([
      msg("a", "lena@atelier.example", "ohmail/Screener"),
      msg("b", "lena@atelier.example", "ohmail/Screener"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "b")!, "reads");
    expect(kinds(plan, "screener_decide")).toEqual([
      expect.objectContaining({ decision: "yes", dest: "reads" }),
    ]);
    // THE GUARD. Restore `dest: "ohbox"` on the decide and this goes red on `dest`; restore the
    // `WIRE_DECIDE_FOLDER[decision] === wanted` condition on `movedByDecide` and it goes red
    // here, because both held messages would be counted out of place again.
    expect(movesOf(plan)).toEqual([]);
    // The count the toast states still covers both — the decide relocates them.
    expect(plan.moved).toBe(2);
    expect(plan.matched).toBe(2);
  });

  it("SPAM RIDES THE NO BRANCH — a yes would file spam into the Ohbox", async () => {
    // THE GUARD, and it is the bug in a new place. Flip `DECISION_OF_DEST.spam` to "yes"
    // in `sender-screening.ts` and this goes red twice over: the decide asks the server to
    // ADMIT that sender, and the server refuses the pair `{decision:"yes",
    // dest:"ohmail/Quarantine"}` with a 400 rather than guessing which half was meant.
    const store = await mirror([msg("a", "win@jackpot.example", "ohmail/Screener")]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "spam");
    expect(DECISION_OF_DEST.spam).toBe("no");
    expect(kinds(plan, "screener_decide")).toEqual([
      expect.objectContaining({ decision: "no", dest: "spam" }),
    ]);
    // SCR-READ: this used to expect a follow-up `move` to Quarantine, because the wire's `no`
    // could only say `ohmail/Screened`. It says Quarantine now.
    expect(movesOf(plan)).toEqual([]);
  });

  it("Screen out is the endpoint's own no, with no follow-up move", async () => {
    const store = await mirror([msg("a", "win@jackpot.example", "ohmail/Screener")]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "screened");
    expect(kinds(plan, "screener_decide")).toEqual([expect.objectContaining({ decision: "no" })]);
    expect(movesOf(plan)).toEqual([]);
  });

  it("mail the sender has OUTSIDE the Screener is the pass's — one sender, one place", async () => {
    const store = await mirror([
      msg("a", "lena@atelier.example", "ohmail/Screener"),
      msg("b", "lena@atelier.example", "ohmail/News"),
      msg("c", "lena@atelier.example", "INBOX"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "ohbox");
    // The decide relocates the held one; `c` is already home; `b` is the promoted rule's backlog,
    // which the server's pass moves (THE-CLIENTS-FIFTY) — the press composes no move for it.
    expect(movesOf(plan)).toEqual([]);
    expect(kinds(plan, "screener_decide")).toEqual([expect.objectContaining({ applyRetro: true })]);
    expect(plan.moved).toBe(1);
    expect(plan.matched).toBe(2);
  });
});

describe("a sender who has LEFT the Screener gets moves and no promises", () => {
  it("no screener_decide is composed — it would 404 on the wire", async () => {
    // THE OTHER GUARD. Make `planScreeningChange` emit a decide regardless of `waiting`
    // and this goes red — which is the difference between the Ohbox affordance working and
    // it answering 404 while the UI reports success.
    const store = await mirror([
      msg("a", "lena@atelier.example", "INBOX"),
      msg("b", "lena@atelier.example", "INBOX"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    expect(kinds(plan, "screener_decide")).toEqual([]);
    // The rule's backlog is the pass's: the press moves none of it (THE-CLIENTS-FIFTY).
    expect(movesOf(plan)).toEqual([]);
    expect(plan.matched).toBe(2);
    /**
     * CHANGED THIS LINE, AND IT IS THE POINT OF THE SLICE. It used to read
     * `expect(plan.rule).toBe(false)` with the note *"the copy must not promise a rule,
     * because none was made"* — true while `screener_decide` was the only rule-creating verb.
     * A rule IS made now, by `rule_create`, so the assertion is not relaxed but sharpened: the
     * exact row that goes on the wire is named.
     */
    expect(plan.rule).toBe(true);
    expect(plan.ruleState).toBe("created");
    expect(kinds(plan, "rule_create")).toEqual([
      expect.objectContaining({ ruleKind: "sender", match: "lena@atelier.example", destination: "ohmail/News" }),
    ]);
  });

  it("the opt-out reproduces the old plan exactly — moves, and nothing remembered", async () => {
    // (d): the non-rule move stays reachable as the explicit non-default. This is the
    // former default's assertion, kept verbatim on the path that still has that behaviour.
    const store = await mirror([
      msg("a", "lena@atelier.example", "INBOX"),
      msg("b", "lena@atelier.example", "INBOX"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads", "sender", false);
    expect(plan.ruleState).toBe("none");
    expect(plan.rule).toBe(false);
    expect(plan.ruleMutations).toEqual([]);
    // The plan carries no move; its moves are asked through the one door (`movesAtLanding`).
    expect(plan.mutations).toEqual([]);
    expect(movesOf(plan)).toEqual([
      expect.objectContaining({ kind: "move", messageId: "a", folder: "ohmail/News" }),
      expect.objectContaining({ kind: "move", messageId: "b", folder: "ohmail/News" }),
    ]);
  });

  it("choosing where the mail already is still makes the rule — the mail was never ruled", async () => {
    // The mail is in Reads because somebody once moved it, not because anything remembers it.
    // Managing a mailbox is precisely making that durable, so this is NOT a no-op any more —
    // but with the rule turned off it still is, which is the assertion this used to carry.
    const store = await mirror([msg("a", "lena@atelier.example", "ohmail/News")]);
    const s = senderScreening(store, "a")!;

    const plan = planScreeningChange(s, "reads");
    expect(plan.moved).toBe(0);
    expect(movesOf(plan)).toEqual([]);
    expect(kinds(plan, "rule_create")).toHaveLength(1);

    expect(planScreeningChange(s, "reads", "sender", false).mutations).toEqual([]);
  });

  it("a quarantined sender can be let back into the Ohbox", async () => {
    const store = await mirror([msg("a", "lena@atelier.example", "ohmail/Quarantine")]);
    const s = senderScreening(store, "a")!;
    expect(s.current).toBe("spam");
    const plan = planScreeningChange(s, "ohbox");
    // The rule reaches back through the pass, which moves `a` out of Quarantine itself.
    expect(plan.mutations).toEqual([
      expect.objectContaining({ kind: "rule_create", ruleKind: "sender", destination: "INBOX", applyRetro: true }),
    ]);
    expect(plan.matched).toBe(1);
  });
});

/**
 * ── THE RULE IS THE DEFAULT, AND THE LADDER THAT KEEPS IT FROM BEING A RULE FACTORY ─
 *
 * Reported: *"but also allow it to actually create the rule and apply it to ALL messages future
 * and previous, this should be the default behaviour to efficiently manage the mailbox."*
 *
 * `rule_create` is the verb an earlier change named and could not build. These assert the two halves
 * that can silently go wrong: that it REACHES the plan at all (the defect that made the slice
 * necessary was a verb whose effects were empty, which the engine turns into a rollback with
 * nothing sent), and that its subject is the scope's — never the clicked address's.
 */
describe("making the rule from past the gate", () => {
  it("the rule mutation is the identity-shared PREFIX of the dispatch list", async () => {
    // `AppShell` awaits `ruleMutations` and fires the rest. If these were copies rather than
    // the same objects, it would dispatch the rule TWICE — once awaited, once not.
    const store = await mirror([
      msg("a", "lena@atelier.example", "INBOX"),
      msg("b", "lena@atelier.example", "ohmail/Receipts"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    expect(plan.ruleMutations).toHaveLength(1);
    expect(plan.mutations[0]).toBe(plan.ruleMutations[0]);
    expect(plan.mutations.filter((m) => m.kind === "rule_create")).toHaveLength(1);
  });

  /**
   * THE GUARD FOR THE DEFECT FOUND ONE ENTITY ALONG. `decide` computed the mail to
   * move BY ADDRESS regardless of scope, so a domain rule moved one sender's mail and stranded
   * every other sender at that domain. Take `match` from `s.address` instead of the scope, or
   * the moves from `s.messages` instead of `s.scopes[scope].messages`, and this goes red on
   * whichever half was broken.
   */
  it("a domain rule matches the DOMAIN and moves the DOMAIN's mail — not one address's", async () => {
    const store = await mirror([
      msg("a", "one@x.example", "INBOX"),
      msg("b", "two@x.example", "INBOX"),
      msg("c", "three@X.Example", "ohmail/Receipts"),
      msg("d", "someone@other.example", "INBOX"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads", "domain");
    expect(kinds(plan, "rule_create")).toEqual([
      expect.objectContaining({ ruleKind: "domain", match: "x.example", destination: "ohmail/News" }),
    ]);
    // The rule's backlog is the pass's; the DOMAIN's mail is what the sheet counts, and what a
    // bare move (the person's own instruction) moves.
    expect(movesOf(plan)).toEqual([]);
    expect(plan.matched).toBe(3);
    const bare = planScreeningChange(senderScreening(store, "a")!, "reads", "domain", false);
    expect(movesOf(bare).map((m) => m.messageId).sort()).toEqual(["a", "b", "c"]);
    expect(plan.ruleScope).toBe("domain");
  });

  it("a WAITING subject makes no rule_create — the decide already promotes one", async () => {
    // Two rules for one intent, one of them with no consent record behind it.
    const store = await mirror([msg("a", "lena@atelier.example", "ohmail/Screener")]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    expect(kinds(plan, "rule_create")).toEqual([]);
    expect(plan.ruleState).toBe("promoted");
    expect(plan.ruleMutations).toEqual([]);
  });

  /**
   * 0.19 SPLIT THIS CASE IN TWO, and the title used to be "a habit-click writes nothing". Still
   * true of the RULE — no second row is ever written — but the past-mail option is a second
   * question, and answering it yes on a standing rule is the only way to ask that rule for the
   * backlog. The OFF arm is the one that keeps the old promise verbatim.
   */
  it("a rule already filing them there is not duplicated — no second rule is ever written", async () => {
    const store = await mirror(
      [msg("a", "lena@atelier.example", "INBOX")],
      [ruleRow({ destination: "ohmail/News" })],
    );
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    expect(plan.ruleState).toBe("already");
    expect(kinds(plan, "rule_create")).toEqual([]);
    expect(plan.rule, "a rule IS in force afterwards, even though none was written").toBe(true);
    // …and the mail is the re-armed rule's to move, through the pass (THE-CLIENTS-FIFTY).
    expect(movesOf(plan)).toEqual([]);
    expect(kinds(plan, "rule_update")).toEqual([expect.objectContaining({ applyRetro: true })]);
  });

  it("…and with the past-mail option off it writes NOTHING at all, as it always did", async () => {
    const store = await mirror(
      [msg("a", "lena@atelier.example", "INBOX")],
      [ruleRow({ destination: "ohmail/News" })],
    );
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads", "sender", true, false);
    expect(plan.ruleState).toBe("already");
    expect(plan.ruleMutations).toEqual([]);
    // The move went with it in 0.19.1. This line read `toHaveLength(1)` — under a title saying
    // the press writes nothing at all — which is the defect in one file: the switch reached the
    // rule and never the fan-out, so a habit-click with the option OFF still refiled their mail.
    expect(movesOf(plan), "nothing is written and nothing moves").toEqual([]);
  });

  /**
   * EVERY covering rule is retargeted, not just the first. Two `manual` rules with the same
   * match, priority, effect and kind fall through `core/src/rules.ts#compareRules` to an
   * arbitrary ID tie-break, so leaving one pointing at the old place would make "future mail
   * files there too" a coin toss the user cannot see.
   */
  it("a rule pointing elsewhere is RETARGETED, never duplicated — one write over the winner", async () => {
    const store = await mirror(
      [msg("a", "lena@atelier.example", "INBOX")],
      [
        ruleRow({ id: "old-1", destination: "ohmail/Receipts" }),
        ruleRow({ id: "old-2", destination: "ohmail/Quarantine" }),
      ],
    );
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    expect(plan.ruleState).toBe("retargeted");
    expect(kinds(plan, "rule_create")).toEqual([]);
    // The deny twin wins; the server collapses the other into it, so a second PATCH would 404.
    expect(kinds(plan, "rule_update").map((m) => m.ruleId)).toEqual(["old-2"]);
    expect(kinds(plan, "rule_update").every((m) => m.destination === "ohmail/News")).toBe(true);
  });

  it("a disabled rule is not treated as covering — a paused rule sorts nothing", async () => {
    const store = await mirror(
      [msg("a", "lena@atelier.example", "INBOX")],
      [ruleRow({ destination: "ohmail/News", enabled: false })],
    );
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    expect(plan.ruleState).toBe("created");
  });

  /**
   * A DOMAIN RULE IS NOT RETARGETED BY A CLICK ON ONE ADDRESS. Rewriting it would silently
   * re-file everyone else at that domain; the new sender rule outranks it anyway
   * (`core/src/rules.ts` KIND_RANK: sender 0, domain 1).
   */
  it("a covering DOMAIN rule neither suppresses nor absorbs a sender-scope rule", async () => {
    const store = await mirror(
      [msg("a", "lena@atelier.example", "INBOX")],
      [ruleRow({ id: "dom", kind: "domain", match: "atelier.example", destination: "ohmail/Receipts" })],
    );
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    expect(plan.ruleState).toBe("created");
    expect(kinds(plan, "rule_update")).toEqual([]);
    expect(kinds(plan, "rule_create")).toEqual([
      expect.objectContaining({ ruleKind: "sender", match: "lena@atelier.example" }),
    ]);
  });

  it("the match is normalized once, so the optimistic row and the wire body are one string", async () => {
    const store = await mirror([msg("a", "Lena@Atelier.Example", "INBOX")]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    expect(kinds(plan, "rule_create")[0]!.match).toBe("lena@atelier.example");
  });
});

/**
 * ── WHAT THE SHELL IS ALLOWED TO SAY ──────────────────────────────────────────────
 *
 * An earlier change shipped a toast that fired on click and printed "Rule revoked" over a 403 — the fixtures
 * adapter never refuses, so every test was green. This slice makes a claim about FUTURE mail,
 * which is exactly the claim a refusal falsifies, so the sentence is chosen from the outcome.
 */
/**
 * THE RULES PANE'S SIBLINGS: a rule stored before the 0.22 rename says `ohmail/Reads` and files into News. Read
 * by its spelling, it was not "already there": the sheet retargeted it to the place it already filed into, and a
 * release wrote a second rule beside it. The re-arm keeps the stored spelling, so reading never rewrites a rule.
 */
describe("a rule stored before the News rename is the rule already there", () => {
  const LEGACY = LEGACY_NEWS_FOLDER as Folder;

  it("screening into News is 'already', re-armed in the rule's stored spelling (round trip)", async () => {
    const store = await mirror(
      [msg("a", "lena@atelier.example", "INBOX")],
      [ruleRow({ id: "legacy", destination: LEGACY })],
    );
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    expect(plan.ruleState).toBe("already");
    expect(kinds(plan, "rule_create")).toEqual([]);
    expect(plan.ruleMutations).toEqual([
      { kind: "rule_update", ruleId: "legacy", destination: LEGACY, applyRetro: true },
    ]);
    const [effect] = mutationEffects(store, plan.ruleMutations[0]!, { now: () => new Date(), uuid: () => "u" });
    expect((effect!.entity as RuleDTO).destination, "the write rewrote the stored spelling").toBe(LEGACY);
  });

  it("a release writes no second rule when the sender's own pre-0.22 News rule stands", async () => {
    const store = await mirror(
      [msg("a", "lena@atelier.example", "ohmail/Screened")],
      [
        ruleRow({ id: "dom", kind: "domain", match: "atelier.example", destination: "ohmail/Screened" }),
        ruleRow({ id: "legacy", destination: LEGACY }),
      ],
    );
    const planned = releaseRules(store, "lena@atelier.example", "ohmail/Screened", "ohmail/News");
    expect(planned.kind).toBe("address");
    expect(planned.mutations, "a duplicate rule_create").toEqual([]);
  });

  it("a rule holding a sender is found whichever spelling the held folder carries", async () => {
    const store = await mirror(
      [msg("a", "lena@atelier.example", LEGACY)],
      [ruleRow({ id: "own", destination: "ohmail/News" })],
    );
    const planned = releaseRules(store, "lena@atelier.example", LEGACY, "INBOX");
    expect(planned).toEqual({
      kind: "retarget", mutations: [{ kind: "rule_update", ruleId: "own", destination: "INBOX" }],
    });
  });
});

describe("the sentence follows what the server actually said", () => {
  /**
   * A WHOLE PLAN, AND NO CAST — `as never` is how this fixture came to be missing `retro` in the
   * first place (every case read `undefined` and took the declined arm by accident), and the
   * discriminator now reads `mutations` too. Typed, a field added to `ScreeningPlan` is named by
   * `tsc` here rather than thrown at the first case that reaches it. `retro` keeps its shipped
   * default (on); `moves` is what the plan CARRIES, which is the second thing the sentence turns on.
   */
  const plan = (
    ruleState: ScreeningPlan["ruleState"],
    retro = true,
  ): ScreeningPlan => ({
    mutations: [],
    ruleMutations: [],
    ruleState,
    rule: ruleState !== "none",
    ruleScope: "sender",
    wanted: "INBOX",
    outOfPlace: [],
    moved: 0,
    matched: 0,
    retro,
    senders: 1,
    unsubscribes: false,
  });

  it("a refusal says the rule was not made, and never 'future mail files there too'", () => {
    expect(screeningToast(plan("created"), "rolled_back", 0)).toBe("toastRuleFailed");
    expect(screeningToast(plan("retargeted"), "rolled_back", 0)).toBe("toastRuleFailed");
  });

  it("queued is not folded into success — the server has not been told yet", () => {
    // "Back online" only while the browser is offline; a server failure is said as one; an
    // unanswered try while online has not arrived yet (and is the default, never "back online").
    expect(screeningToast(plan("created"), "queued", 0, "queued")).toBe("toastRuleQueued");
    expect(screeningToast(plan("created"), "queued", 0, "failing")).toBe("toastRuleFailing");
    expect(screeningToast(plan("created"), "queued", 0, "unsent")).toBe("toastRuleUnsent");
    expect(screeningToast(plan("created"), "queued", 0)).toBe("toastRuleUnsent");
    expect(screeningToast(plan("promoted"), "queued", 0, "failing")).toBe("toastRuleFailing");
    expect(screeningToast(plan("promoted"), "queued", 0, "queued")).toBe("toastRuleQueued");
  });

  it("each of the five states has its own true sentence", () => {
    expect(screeningToast(plan("created"), "confirmed", 0)).toBe("toastRuled");
    expect(screeningToast(plan("retargeted"), "confirmed", 0)).toBe("toastRetargeted");
    expect(screeningToast(plan("already", true), null, 0)).toBe("toastAlreadyRuledRetro");
    expect(screeningToast(plan("already", false), null, 0)).toBe("toastAlreadyRuled");
    expect(screeningToast(plan("none"), null, 0)).toBe("toastMoved");
    expect(screeningToast(plan("promoted"), null, 0)).toBe("toastRuled");
    // …and with the backlog declined, one sentence for both states that write a rule: nothing
    // moved, so neither of the two above may say where their mail now is.
    expect(screeningToast(plan("created", false), "confirmed", 0)).toBe("toastRuledFuture");
    expect(screeningToast(plan("retargeted", false), "confirmed", 0)).toBe("toastRuledFuture");
  });

  /**
   * ── THE SENTENCE FOLLOWS WHAT THE PLAN DID, NOT WHAT IT ASKED OF THE SERVER ──────────────
   *
   * A Move press writes a rule and moves the mail it names, and it never asks for the backlog —
   * so `retro` is false and the old discriminator sent it to "mail already here stays where it
   * is" about the very message that had just moved. `retro` is NOT widened to buy the sentence:
   * it means the server will walk the backlog, which is still false of this press.
   *
   * Mutation: read `retro` alone again (drop the `moved > 0` arm) and the first case goes red by
   * name, while the two beside it — a press that moved nothing, and a retro press — stay green,
   * which is what says the arm is narrow. The moves ride beside the plan, which carries none.
   */
  it("a press that dispatched moves names them; one that dispatched none does not", () => {
    expect(screeningToast(plan("created", false), "confirmed", 1)).toBe("toastRuledMoved");
    expect(screeningToast(plan("retargeted", false), "confirmed", 1)).toBe("toastRuledMoved");
    // Nothing moved ⇒ the declined sentence stands, counts and all.
    expect(screeningToast(plan("created", false), "confirmed", 0)).toBe("toastRuledFuture");
    // And a backlog press keeps the sentence that names the backlog.
    expect(screeningToast(plan("created", true), "confirmed", 1)).toBe("toastRuled");
    expect(screeningToast(plan("retargeted", true), "confirmed", 1)).toBe("toastRetargeted");
    // The status arms still outrank it: a plan with moves that the server refused says so.
    expect(screeningToast(plan("created", false), "rolled_back", 1)).toBe("toastRuleFailed");
    expect(screeningToast(plan("created", false), "queued", 1)).toBe("toastRuleUnsent");
  });

  it("one refusal among several retargets makes the whole sentence false", () => {
    expect(worstStatus([{ status: "confirmed" }, { status: "rolled_back" }])).toBe("rolled_back");
    expect(worstStatus([{ status: "confirmed" }, { status: "queued" }])).toBe("queued");
    expect(worstStatus([{ status: "confirmed" }])).toBe("confirmed");
    expect(worstStatus([])).toBeNull();
  });
});

/**
 * ── THE WIRING, WHICH IS THE PART THAT KEEPS BEING WRONG ────────────────────────────────
 *
 * A correct module under an untested dispatch is this repository's signature failure:
 * `tag_assign`'s picker over an adapter that threw, the three-outcome vocabulary under a
 * toast that fired on click. `AppShell` calls `dispatchScreeningChange` and nothing else, so
 * driving it here drives what the shell does.
 */
describe("dispatching the plan", () => {
  const mutateAll = (status: MutationStatus, seen: EngineMutation[]) =>
    async (m: EngineMutation) => { seen.push(m); return { status }; };

  it("dispatches every mutation EXACTLY once — the rule is not sent twice", async () => {
    // The rule mutation is both `mutations[0]` and `ruleMutations[0]`. Dispatch the list
    // without excluding the prefix and it goes out twice under two Idempotency-Keys — which,
    // on a route that does not honour the key, is two rules for one click.
    const store = await mirror([
      msg("a", "lena@atelier.example", "INBOX"),
      msg("b", "lena@atelier.example", "ohmail/Receipts"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    const seen: EngineMutation[] = [];
    await dispatchScreeningChange(plan, movesOf(plan), mutateAll("confirmed", seen));

    expect(seen).toHaveLength(plan.mutations.length);
    expect(seen.filter((m) => m.kind === "rule_create")).toHaveLength(1);
    expect(new Set(seen).size).toBe(seen.length);
  });

  /**
   * THE DEFECT THIS SLICE REFUSES TO SHIP AGAIN. THE first cut printed "Rule revoked. Your
   * mail hasn't moved." over a refusal on a live account, because the toast fired on click and the
   * fixtures adapter never refuses. Make `dispatchScreeningChange` return `screeningToast(plan,
   * "confirmed")` — or drop the `await` — and this goes red.
   */
  it("a refusal does not produce a sentence that claims future mail will follow", async () => {
    const store = await mirror([msg("a", "lena@atelier.example", "INBOX")]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    const key = await dispatchScreeningChange(plan, movesOf(plan), async (m) => ({
      status: m.kind === "rule_create" ? "rolled_back" : "confirmed",
    }));
    expect(key).toBe("toastRuleFailed");
  });

  it("a retryable failure says queued, never success — the server has not been told", async () => {
    const store = await mirror([msg("a", "lena@atelier.example", "INBOX")]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    const send = (failed: boolean) => (m: { kind: string }) => Promise.resolve(m.kind === "rule_create"
      ? { status: "queued" as const, ...(failed ? { serverFailed: true as const } : {}) }
      : { status: "confirmed" as const });
    // Online: a server's failure is said as one; an unanswered try has not arrived yet.
    expect(await dispatchScreeningChange(plan, movesOf(plan), send(true))).toBe("toastRuleFailing");
    expect(await dispatchScreeningChange(plan, movesOf(plan), send(false))).toBe("toastRuleUnsent");
    // "Back online" only while the browser is offline.
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    try {
      expect(await dispatchScreeningChange(plan, movesOf(plan), send(false))).toBe("toastRuleQueued");
    } finally {
      Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    }
  });

  it("a MOVE that fails does not falsify the rule's sentence — it rolls its own row back", async () => {
    const store = await mirror([msg("a", "lena@atelier.example", "INBOX")]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    const key = await dispatchScreeningChange(plan, movesOf(plan), async (m) => ({
      status: m.kind === "move" ? "rolled_back" : "confirmed",
    }));
    expect(key).toBe("toastRuled");
  });

  it("with no rule to write it still dispatches the moves and says the move sentence", async () => {
    const store = await mirror([msg("a", "lena@atelier.example", "INBOX")]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads", "sender", false);
    const seen: EngineMutation[] = [];
    expect(await dispatchScreeningChange(plan, movesOf(plan), mutateAll("confirmed", seen))).toBe("toastMoved");
    expect(seen).toHaveLength(1);
  });
});

/**
 * ── RULING ON THE WHOLE DOMAIN ─────────────────────────────────────────────────────
 *
 * `scope` was on the wire and in the mutation vocabulary from the start and no surface had
 * ever set it, so the first thing these assert is that it actually leaves the building.
 */
describe("choosing the whole domain instead of the one address", () => {
  it("reads both scopes off one message, and counts the senders under the domain", async () => {
    const store = await mirror([
      msg("a", "no-reply-aaa@x.example", "ohmail/Screener"),
      msg("b", "no-reply-bbb@x.example", "ohmail/Screener"),
      msg("c", "News@X.example", "INBOX"),
      msg("d", "someone@other.example", "INBOX"),
    ]);
    const s = senderScreening(store, "a")!;
    expect(s.domain).toBe("x.example");
    expect(s.scopes.sender.messages.map((m) => m.id)).toEqual(["a"]);
    // Case-folded on both sides of the `@`, and `other.example` is not swept in.
    expect(s.scopes.domain.messages.map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
    expect(s.scopes.domain.senders).toBe(3);
    expect(s.scopes.sender.senders).toBe(1);
  });

  it("puts scope='domain' on the wire, and moves the domain's mail — not just the address's", async () => {
    // THE GUARD FOR (a). Drop the `scope` argument in `planScreeningChange` and the decide
    // reverts to a sender rule while the sheet says "everyone at x.example"; take the message
    // set from `s.messages` instead of `subject.messages` and `b`/`c` are never moved.
    const store = await mirror([
      msg("a", "one@x.example", "ohmail/News"),
      msg("b", "two@x.example", "ohmail/News"),
      msg("c", "three@x.example", "INBOX"),
      msg("d", "someone@other.example", "ohmail/News"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "receipts", "domain");
    expect(movesOf(plan), "the rule's backlog is the pass's").toEqual([]);
    expect(plan.matched).toBe(3);
    const bare = planScreeningChange(senderScreening(store, "a")!, "receipts", "domain", false);
    expect(movesOf(bare).map((m) => m.messageId).sort()).toEqual(["a", "b", "c"]);
    expect(plan.senders).toBe(3);
    // Nothing is waiting, so no rule is PROMOTED — the sheet writes one directly instead, and the
    // scope it is written at is the one the sheet is showing.
    expect(plan.ruleState).toBe("created");
    expect(plan.ruleScope).toBe("domain");
  });

  it("a waiting domain makes a DOMAIN rule, and says so", async () => {
    const store = await mirror([
      msg("a", "one@x.example", "ohmail/Screener"),
      msg("b", "two@x.example", "ohmail/Screener"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "ohbox", "domain");
    expect(kinds(plan, "screener_decide")).toEqual([
      expect.objectContaining({ decision: "yes", scope: "domain" }),
    ]);
    expect(plan.rule).toBe(true);
    expect(plan.ruleScope).toBe("domain");
  });

  /**
   * ── THE DECIDE OWNS THE HELD MAIL, AND IS NOT RACED BY A `move` ───────────────────────
   *
   * `AppShell` fires mutations in parallel (`void engine.mutate(m)`). A `move` for a held
   * message that landed FIRST would take it out of `ohmail/Screener`, and `decide`'s
   * held-only lookup would then not see it — the message gets filed with no rule and no
   * consent record behind it. So when the endpoint's own folder IS the destination, every
   * held message in scope is credited to the decide and NO move is composed for it.
   *
   * Add `for (const m of subject.messages) …` back as a move loop and this goes red.
   */
  it("composes no move for held mail the decide already owns — it would race the decide", async () => {
    const store = await mirror([
      msg("a", "one@x.example", "ohmail/Screener"),
      msg("b", "two@x.example", "ohmail/Screener"),
      msg("c", "three@x.example", "INBOX"),
    ]);
    // "Screen out" IS the endpoint's `no` folder, so the held pair rides the decide alone.
    const plan = planScreeningChange(senderScreening(store, "a")!, "screened", "domain");
    expect(kinds(plan, "screener_decide")).toHaveLength(1);
    // `c` is the promoted rule's backlog, the pass's to move (THE-CLIENTS-FIFTY).
    expect(movesOf(plan)).toEqual([]);
    // The press files the held pair; the sheet's count names all three.
    expect(plan.moved).toBe(2);
    expect(plan.matched).toBe(3);
  });

  it("an address with no domain offers no second scope at all", async () => {
    // `decide` answers 422 for this, so the sheet must not present the choice. The domain
    // subject IS the sender subject rather than an empty set, which would have rendered as a
    // real option that silently does nothing.
    const store = await mirror([msg("a", "malformed-no-at-sign", "INBOX")]);
    const s = senderScreening(store, "a")!;
    expect(s.domain).toBe("");
    expect(s.scopes.domain).toBe(s.scopes.sender);
  });
});

/**
 * ── SECOND COUPLING: THE SHEET HAS TO SAY THIS BEFORE IT RUNS ──────────────────
 *
 * `decide` calls `unsubscribe.onScreenOut` after its commit on the reject branch and
 * `apps/api-vercel/src/deps.ts` wires that dependency in, so screening a WAITING sender out
 * really does send one-click unsubscribe requests. `ScreeningPlan.unsubscribes` is the single
 * place that condition is decided, and `SenderMenu` refuses to commit without a confirm when
 * it is true.
 */
describe("what the sheet must disclose before the click", () => {
  it("a waiting sender screened out arms auto-unsubscribe", async () => {
    const store = await mirror([msg("a", "spam@bulk.example", "ohmail/Screener")]);
    const s = senderScreening(store, "a")!;
    expect(planScreeningChange(s, "screened").unsubscribes).toBe(true);
    expect(planScreeningChange(s, "spam").unsubscribes).toBe(true);
  });

  it("…and the three ALLOW destinations do not", async () => {
    const store = await mirror([msg("a", "spam@bulk.example", "ohmail/Screener")]);
    const s = senderScreening(store, "a")!;
    for (const dest of ["ohbox", "reads", "receipts"] as const) {
      expect(planScreeningChange(s, dest).unsubscribes).toBe(false);
    }
  });

  /**
   * THE HONEST NEGATIVE, and it is the one a "be safe, always warn" instinct gets wrong.
   * A sender who has LEFT the gate is moved with `move`, which arms nothing — `onScreenOut`
   * is reached only from `decide`, and the drain that would catch a bare `folder_state` row
   * (`unsubscribe-service.ts#sweepScreenedOut`) has no production caller. Warning here would
   * teach the user the warning is noise, and they would then click through the real one.
   *
   * IF THE CRON EVER LANDS, THIS ASSERTION IS THE THING THAT MUST CHANGE FIRST.
   */
  it("a sender already past the gate does NOT — a move arms nothing today", async () => {
    const store = await mirror([msg("a", "spam@bulk.example", "INBOX")]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "screened");
    expect(plan.unsubscribes).toBe(false);
  });

  /**
   * SHARPENS THE NEGATIVE RATHER THAN RETIRING IT, and this is the assertion that keeps
   * it honest. A rule pointing at a reject folder is now created from past the gate — and it
   * STILL arms nothing, because `onScreenOut` has exactly one production caller
   * (`screener-service.ts`, on `decide`'s reject branch), `RulesService.create` calls nothing,
   * and the arrival routing pass calls nothing. Wiring `unsubscribes` to `plan.rule` instead of
   * to the decide path — the obvious "be safe, always warn" edit — makes this go red, and would
   * put a confirm in front of an action that sends no unsubscribe request at all.
   */
  it("…and creating a rule that files them to a reject folder still arms nothing", async () => {
    const store = await mirror([msg("a", "spam@bulk.example", "INBOX")]);
    for (const dest of ["screened", "spam"] as const) {
      const plan = planScreeningChange(senderScreening(store, "a")!, dest);
      expect(plan.ruleState, "the rule is genuinely being made").toBe("created");
      expect(plan.rule).toBe(true);
      expect(plan.unsubscribes).toBe(false);
    }
  });

  it("a domain reject reports how many senders it covers, for the sentence to name", async () => {
    const store = await mirror([
      msg("a", "one@bulk.example", "ohmail/Screener"),
      msg("b", "two@bulk.example", "ohmail/Screener"),
      msg("c", "three@bulk.example", "ohmail/Screener"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "screened", "domain");
    expect(plan.unsubscribes).toBe(true);
    expect(plan.senders).toBe(3);
  });
});

/**
 * ── VIEWER THE SHEET RESOLVED TO A RECIPIENT, NOT THE SENDER ──────────────────────────
 *
 * A contact chip under a message header opens Screener settings for THE CHIP'S address — a To
 * or Cc person who may never have sent this account a single message. `senderScreening` keeps
 * its one entry point (a message id off any row) and takes the address as an OVERRIDE: the seed
 * message anchors the lookup and supplies the chip's display name; the subject of every fact —
 * the key, the domain, the message set, the rules — is the override.
 *
 * The mutation that must stay red: ignore the override and resolve `seed.from.address` — every
 * assertion below about `cy@x.example` then reports the SENDER's facts under the Cc person's
 * name, which is exactly the defect the chip guard in `contact-chips.test.tsx` names.
 */
describe("resolving the sheet to an address override (contact chips)", () => {
  const withRecipients = (id: string, folder: Folder): EngineMessage => ({
    ...msg(id, "sender@corp.example", folder),
    to: [{ name: "Anna Roth", address: "anna@x.example" }],
    cc: [{ name: "Cy Cole", address: "Cy@X.example" }],
  });

  it("every fact is the OVERRIDE's: key, domain, messages, waiting — not the sender's", async () => {
    const store = await mirror([
      withRecipients("seed", "INBOX"),
      msg("theirs", "cy@x.example", "ohmail/News"),
      msg("senders", "sender@corp.example", "INBOX"),
    ]);
    const s = senderScreening(store, "seed", "Cy@X.example")!;
    expect(s.address).toBe("Cy@X.example");
    expect(s.key).toBe("cy@x.example");
    expect(s.domain).toBe("x.example");
    // The message set is mail FROM the override — the seed (from the sender) is not in it.
    expect(s.messages.map((m) => m.id)).toEqual(["theirs"]);
    expect(s.current).toBe("reads");
    expect(s.waiting).toBe(false);
  });

  it("takes the chip's name from the seed's own recipient entry", async () => {
    const store = await mirror([withRecipients("seed", "INBOX")]);
    expect(senderScreening(store, "seed", "cy@x.example")!.name).toBe("Cy Cole");
    expect(senderScreening(store, "seed", "anna@x.example")!.name).toBe("Anna Roth");
    // An address the seed does not carry still resolves — with no name to show.
    expect(senderScreening(store, "seed", "stranger@elsewhere.example")!.name).toBeNull();
  });

  it("a recipient with NO mail in the mirror still yields a subject a rule can be written on", async () => {
    const store = await mirror([withRecipients("seed", "INBOX")]);
    const s = senderScreening(store, "seed", "cy@x.example")!;
    expect(s.messages).toEqual([]);
    const plan = planScreeningChange(s, "reads");
    expect(plan.ruleState).toBe("created");
    expect(kinds(plan, "rule_create")[0]).toMatchObject({ ruleKind: "sender", match: "cy@x.example" });
    expect(movesOf(plan)).toHaveLength(0);
  });

  it("the rules consulted are the OVERRIDE's rules, so already/retarget decisions stay honest", async () => {
    const store = await mirror(
      [withRecipients("seed", "INBOX")],
      [ruleRow({ match: "cy@x.example", destination: "ohmail/News" })],
    );
    const s = senderScreening(store, "seed", "cy@x.example")!;
    expect(s.rules).toHaveLength(1);
    expect(planScreeningChange(s, "reads").ruleState).toBe("already");
  });

  it("no override keeps the shipped behaviour byte for byte — the sender resolves", async () => {
    const store = await mirror([withRecipients("seed", "INBOX")]);
    const s = senderScreening(store, "seed")!;
    expect(s.address).toBe("sender@corp.example");
    expect(s.name).toBeNull();
  });
});

/**
 * ── 0.19: THE PAST-MAIL OPTION, AT THE PLAN LAYER ────────────────────────────────────────
 *
 * `applyRetro` has been the fifth parameter of {@link planScreeningChange} since the retro half
 * shipped, and no caller has ever passed it — so what the wire carried was decided by a default
 * and nothing measured the other answer. These cases drive both, and they are the layer where
 * "OFF is expressible" is either true or a claim.
 *
 * The `already` case is the one that used to be silently nothing: a rule of the same kind
 * already pointing at the destination emitted no rule mutation at all, while the sheet had
 * already promised the mail already here would follow. With the option ON it now re-arms that
 * rule — an explicit `applyRetro: true` on a PATCH that moves no destination, which is the one
 * server rule this feature needs (`rules-service.ts#update`).
 */
describe("applying the rule to past mail is its own answer", () => {
  it("declining it still makes the rule, and says so on the wire", async () => {
    const store = await mirror([msg("a", "lena@atelier.example", "INBOX")]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads", "sender", true, false);
    expect(plan.ruleState).toBe("created");
    expect(kinds(plan, "rule_create")).toEqual([
      expect.objectContaining({ destination: "ohmail/News", applyRetro: false }),
    ]);
    expect(plan.retro, "nothing was asked of the backlog").toBe(false);
  });

  it("the default is ON, and the default is what reaches the wire", async () => {
    const store = await mirror([msg("a", "lena@atelier.example", "INBOX")]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    expect(kinds(plan, "rule_create")).toEqual([
      expect.objectContaining({ applyRetro: true }),
    ]);
    expect(plan.retro).toBe(true);
  });

  it("a rule already filing them there is RE-ARMED when the past-mail option is on", async () => {
    // The hole this closes: `ruleState: "already"` wrote nothing, so "the mail already here
    // follows" was true for a new rule and false for a habit-click — the same sentence, the
    // same press, two different outcomes the sheet could not tell apart.
    const store = await mirror(
      [msg("a", "lena@atelier.example", "INBOX")],
      [ruleRow({ id: "standing", destination: "ohmail/News" })],
    );
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads");
    expect(plan.ruleState).toBe("already");
    expect(kinds(plan, "rule_update")).toEqual([
      expect.objectContaining({ ruleId: "standing", destination: "ohmail/News", applyRetro: true }),
    ]);
    expect(plan.retro, "the backlog IS being asked for").toBe(true);
  });

  it("…and writes NOTHING when the option is off — a habit-click stays free", async () => {
    // `rules-subject-term.test.ts` pins the server half: a PATCH that carries no flag and moves
    // no destination re-walks nothing. The client half is not sending one at all.
    const store = await mirror(
      [msg("a", "lena@atelier.example", "INBOX")],
      [ruleRow({ id: "standing", destination: "ohmail/News" })],
    );
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads", "sender", true, false);
    expect(plan.ruleState).toBe("already");
    expect(plan.ruleMutations).toEqual([]);
    expect(plan.retro).toBe(false);
  });

  it("a retarget carries the declined answer too — the path that could not express it", async () => {
    // RED as a TYPE error before this slice: `rule_update` had no `applyRetro` member, so the
    // server's own default (true) always won and a retarget could not decline.
    const store = await mirror(
      [msg("a", "lena@atelier.example", "INBOX")],
      [ruleRow({ id: "old-1", destination: "ohmail/Receipts" })],
    );
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads", "sender", true, false);
    expect(plan.ruleState).toBe("retargeted");
    expect(kinds(plan, "rule_update")).toEqual([
      expect.objectContaining({ ruleId: "old-1", destination: "ohmail/News", applyRetro: false }),
    ]);
    expect(plan.retro).toBe(false);
  });

  /**
   * THE GATE PATH CARRIES THE ANSWER TOO, and this is the case the sheet could not ask about at
   * all. A waiting sender's rule is promoted by `POST /screener/:id`, which files the HELD mail
   * and stops — so a sender with five messages at the gate and hundreds already filed in
   * Reads had no door to those. The decide now carries the option, the promoted rule
   * is armed with it, and the pass owns the mail the decide does not.
   */
  it("a WAITING subject carries the answer on the decide — the promoted rule is armed with it", async () => {
    const store = await mirror([
      msg("a", "lena@atelier.example", "ohmail/Screener"),
      msg("b", "lena@atelier.example", "ohmail/News"),
    ]);
    const on = planScreeningChange(senderScreening(store, "a")!, "ohbox", "sender", true, true);
    expect(on.ruleState).toBe("promoted");
    expect(on.ruleMutations).toEqual([]);
    expect(kinds(on, "screener_decide")).toEqual([
      expect.objectContaining({ decision: "yes", dest: "ohbox", applyRetro: true }),
    ]);
    expect(on.retro, "the promoted rule's backlog IS being asked for").toBe(true);

    const off = planScreeningChange(senderScreening(store, "a")!, "ohbox", "sender", true, false);
    expect(kinds(off, "screener_decide")).toEqual([
      expect.objectContaining({ decision: "yes", dest: "ohbox", applyRetro: false }),
    ]);
    expect(off.retro).toBe(false);
  });
});

/**
 * ── 0.19.1: THE SWITCH GATES THE DISPATCH, NOT THE LABEL ─────────────────────────────────
 *
 * "Also move the mail already in your mailbox" turned OFF wrote the answer onto the rule and
 * then dispatched up to fifty `move`s anyway — `applyRetro` reached the wire and never reached
 * the fan-out below it, so mail a person had filed by hand or set aside was refiled by the
 * control that said not to. The phone carried the same defect
 * (`apps/mobile/src/state/live.ts#screenSender`, fixed first, four red arms); these are the
 * same questions at this surface's plan layer, which is where both sheets and the shell meet.
 */
describe("the past-mail switch decides whether mail already here moves", () => {
  it("OFF dispatches no move for mail already filed, and still writes the rule", async () => {
    const store = await mirror([
      msg("a", "lena@atelier.example", "INBOX"),
      msg("b", "lena@atelier.example", "ohmail/Receipts"),
      msg("c", "lena@atelier.example", "ohmail/Quarantine"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads", "sender", true, false);
    expect(movesOf(plan), "the switch said not to move anything").toEqual([]);
    expect(plan.ruleState, "…and the rule for future mail is still written").toBe("created");
    expect(kinds(plan, "rule_create")).toEqual([
      expect.objectContaining({ destination: "ohmail/News", applyRetro: false }),
    ]);
    expect(plan.moved, "the count the toast states follows the dispatch").toBe(0);
    expect(plan.matched, "what the rule NAMES is unchanged — it is not a promise to move").toBe(3);
  });

  it("OFF at the gate decides the held mail and moves nothing beside it", async () => {
    // The decide is the act the person pressed: it files what is HELD and promotes the rule.
    // The switch's subject is the mail that had already left the gate — the phone kept the same
    // split, and `movedByDecide` is what keeps the two from being confused here.
    const store = await mirror([
      msg("a", "lena@atelier.example", "ohmail/Screener"),
      msg("b", "lena@atelier.example", "ohmail/Receipts"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "ohbox", "sender", true, false);
    expect(kinds(plan, "screener_decide")).toEqual([
      expect.objectContaining({ decision: "yes", dest: "ohbox", applyRetro: false }),
    ]);
    expect(movesOf(plan), "mail past the gate is the switch's subject").toEqual([]);
    expect(plan.moved, "the decide's own relocation is the act, and it is counted").toBe(1);
  });

  it("ON asks the pass for the mail already here, and moves none of it itself", async () => {
    // THE-CLIENTS-FIFTY: the press used to move up to fifty itself, chosen by a predicate that
    // cannot see a reply or a hand filing, so it moved mail the footer says the pass leaves alone.
    const store = await mirror([
      msg("a", "lena@atelier.example", "INBOX"),
      msg("b", "lena@atelier.example", "ohmail/Receipts"),
      msg("c", "lena@atelier.example", "ohmail/Quarantine"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads", "sender", true, true);
    expect(movesOf(plan), "the press moved backlog the pass alone can judge").toEqual([]);
    expect(kinds(plan, "rule_create")).toEqual([expect.objectContaining({ applyRetro: true })]);
    expect(plan.retro, "the server's pass owns the mail already here").toBe(true);
    expect(plan.moved).toBe(0);
    expect(plan.matched, "the sheet still names all of it").toBe(3);
  });

  it("…however much there is, and the cap binds only a bare move", async () => {
    const store = await mirror(
      Array.from({ length: 60 }, (_, i) => msg(`m${i}`, "lena@atelier.example", "INBOX")),
    );
    const plan = planScreeningChange(senderScreening(store, "m0")!, "reads", "sender", true, true);
    expect(movesOf(plan)).toHaveLength(0);
    expect(plan.matched, "the honest count is all of it, and it is the one the sheet shows").toBe(60);
    const bare = planScreeningChange(senderScreening(store, "m0")!, "reads", "sender", false, true);
    expect(movesOf(bare)).toHaveLength(50);
    // The count of a no-rule press is its moves', asked of the one door; the plan counts the decide.
    expect(bare.moved).toBe(0);
  });

  it("with no rule at all the move IS the instruction, and it stands", async () => {
    // The bulk path (`AppShell`'s "Screen them") and the sheet's rule opt-out: `ruleState` is
    // `none`, no rule reaches back, and the moves are the whole of what was asked for — which is
    // why the sheet withdraws the past-mail switch entirely there (`.sm-retro` is not rendered).
    // Gating this arm as well would make that press a no-op under a switch nobody was shown.
    const store = await mirror([
      msg("a", "lena@atelier.example", "INBOX"),
      msg("b", "lena@atelier.example", "ohmail/Receipts"),
    ]);
    const plan = planScreeningChange(senderScreening(store, "a")!, "reads", "sender", false, false);
    expect(plan.ruleState).toBe("none");
    expect(movesOf(plan)).toHaveLength(2);
    expect(plan.retro).toBe(false);
  });

  it("the sentence after the click follows the same boolean", async () => {
    const store = await mirror([
      msg("a", "lena@atelier.example", "INBOX"),
      msg("b", "lena@atelier.example", "ohmail/Receipts"),
    ]);
    const off = planScreeningChange(senderScreening(store, "a")!, "reads", "sender", true, false);
    expect(screeningToast(off, "confirmed", movesOf(off).length), "a rule for the future, and nothing moved")
      .toBe("toastRuledFuture");
    const on = planScreeningChange(senderScreening(store, "a")!, "reads", "sender", true, true);
    expect(screeningToast(on, "confirmed", movesOf(on).length)).toBe("toastRuled");
    // A refusal still wins: the rule is what was awaited, and a sentence about future mail is
    // exactly the claim a refusal falsifies.
    expect(screeningToast(off, "rolled_back", movesOf(off).length)).toBe("toastRuleFailed");
    expect(screeningToast(off, "queued", movesOf(off).length, "queued")).toBe("toastRuleQueued");
  });
});

/**
 * THE PROMISE AND THE SWITCH ARE ONE RULE (STANDALONE-AUTO-UNSUB).
 *
 * The sheet's pre-click disclosure and the Settings switch that turns the courtesy off used to be
 * two expressions in `AppShell`, and they disagreed on the standalone desktop door: the door hands
 * in a consent transport, so the sentence was stated, while the switch was gated on a hosted-only
 * fact and the engine's screener had no unsubscribe port — a promise nobody could withdraw, over a
 * request that was never made. One rule answers both now.
 *
 * HOW TO WATCH IT FAIL — run, restore, `cmp`: drop `!o.standalone` from `control` and the
 * "nothing to reach" case renders a switch that stores nothing; drop `o.known` and the resting ON
 * state is shown to somebody whose account turned it off.
 */
describe("autoUnsubscribeDoor — what this build says, and what it lets you change", () => {
  const D = { demo: false, known: true, on: true, standalone: false, confirms: true };

  it("a door with a consent row states it AND offers the switch", () => {
    expect(autoUnsubscribeDoor(D)).toEqual({ discloses: true, control: true });
  });

  it("no mailbox whose provider's word ohmail reads: nothing is sent by itself, so nothing is said; the switch stays", () => {
    expect(autoUnsubscribeDoor({ ...D, confirms: false })).toEqual({ discloses: false, control: true });
  });

  it("nothing to reach: no promise, and no control over one", () => {
    expect(autoUnsubscribeDoor({ ...D, standalone: true }))
      .toEqual({ discloses: false, control: false });
  });

  it("the account turned it off: the sheet stops promising, the switch stays", () => {
    expect(autoUnsubscribeDoor({ ...D, on: false })).toEqual({ discloses: false, control: true });
  });

  it("before the row has answered the switch is withheld — it rests ON and would lie", () => {
    expect(autoUnsubscribeDoor({ ...D, known: false }).control).toBe(false);
  });

  it("the demo shows what the product does and changes nothing", () => {
    expect(autoUnsubscribeDoor({ ...D, demo: true })).toEqual({ discloses: true, control: false });
  });

  it("the shell reads BOTH halves from this one rule, so they cannot drift apart again", () => {
    /* From the repo root, which is where this suite runs; the existence check refuses a wrong
       cwd by name rather than letting an unreadable file pass for an empty one. */
    const at = join(process.cwd(), "apps/webapp/app/shell/AppShell.tsx");
    expect(existsSync(at), `the shell is not at ${at} — this census read nothing`).toBe(true);
    const shell = withoutComments(readFileSync(at, "utf8"));
    expect(shell).toContain("autoUnsubscribeDoor({");
    expect(shell, "the door is not told whether any mailbox's provider can confirm a sender").toContain(
      "confirms: autoUnsubscribeConfirms(facts),",
    );
    expect(shell, "the disclosure is a second expression again").toContain(
      "const autoUnsubscribeDiscloses = autoUnsub.discloses;",
    );
    expect(shell, "the switch is gated on something other than the rule").toContain(
      "autoUnsubscribeSection={!autoUnsub.control ? undefined : (",
    );
  });
});
