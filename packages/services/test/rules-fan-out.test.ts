import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { changeLog, mailboxes, mailboxProfileMirror, organizerRequests, rules as rulesTbl } from "@trafficflow/db";
import { PUBLISHED_RULE_ID } from "@trafficflow/core/rule-order";
import { RulesService, type RuleMutation, type RuleRequestResult } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A RULE EDIT FANS OUT — one press, a local write AND a request per held mailbox (mail 0094)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Rules belong to the ACCOUNT and TRAVEL in the organizer's profile document, and an account may
 * hold several mailboxes with different roles. Mail 0083 answered that with one account-wide
 * question and a refusal, which was wrong in both directions:
 *
 *  · on a MIXED account it PERMITTED the write and nothing travelled — so the install actually
 *    organizing the other mailbox never heard about the rule, while the person was told it was
 *    saved. That is the false state, and it is what these cases exist to hold shut.
 *  · on an all-reader account it REFUSED where a request could have gone.
 *
 * The three states are asserted separately, ONBOARDING INCLUDED: an account with no live mailbox
 * writes locally, because account configuration is inert until something organizes and refusing
 * there makes the consent flow unfinishable.
 */

const svc = new RulesService();
type World = Awaited<ReturnType<typeof makeCtx>>;

/** Add a second mailbox in a named role. Returns its id. */
async function addMailbox(
  w: World,
  role: "organizer" | "reader",
  over: { capabilities?: string | null; state?: string | null; name?: string | null; status?: string } = {},
): Promise<string> {
  const [mb] = await w.db.insert(mailboxes).values({
    accountId: w.accountId, provider: "imap",
    address: `fan-${Math.random().toString(36).slice(2, 10)}@lichtgrat.example`,
    organizerRole: role,
    ...(role === "reader"
      ? {
        organizerState: over.state === undefined ? "held" : over.state,
        organizedByCapabilities: over.capabilities === undefined ? "requests,rules" : over.capabilities,
        organizedByKind: "local",
        organizedByName: over.name === undefined ? "mila-thinkpad" : over.name,
      }
      : {}),
    ...(over.status === undefined ? {} : { status: over.status }),
  }).returning();
  return mb!.id;
}

/** Make the world's OWN (default-organizer) mailbox a reader. */
async function demoteOwn(
  w: World, over: { capabilities?: string | null; name?: string | null } = {},
): Promise<void> {
  await w.db.update(mailboxes).set({
    organizerRole: "reader",
    organizerState: "held",
    organizedByCapabilities: over.capabilities === undefined ? "requests,rules" : over.capabilities,
    organizedByKind: "cloud",
    organizedByName: over.name === undefined ? "ohmail Cloud" : over.name,
  }).where(eq(mailboxes.id, w.mailboxId));
}

const BODY = { kind: "sender", match: "news@corp.example", destination: "ohmail/News" };

async function requestRows(w: World) {
  return w.db.select().from(organizerRequests)
    .where(eq(organizerRequests.accountId, w.accountId));
}
async function ruleRows(w: World) {
  return w.db.select().from(rulesTbl).where(eq(rulesTbl.accountId, w.accountId));
}

describe("a mixed account writes locally AND sends one request per held mailbox", () => {
  it("N requests + 1 direct write, and the answer says which mailbox got which", async () => {
    const w = await makeCtx();                    // its own mailbox is the default organizer
    const heldA = await addMailbox(w, "reader");
    const heldB = await addMailbox(w, "reader", { name: "mila-air" });

    const result = await svc.create(w.ctx, BODY) as RuleMutation;

    // THE LOCAL WRITE HAPPENED — the row is the rule for the mailbox this install organizes.
    expect(await ruleRows(w)).toHaveLength(1);
    expect(result.rule.match).toBe("news@corp.example");

    // …AND the same edit travelled, once per held mailbox.
    const rows = await requestRows(w);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "rule.create" && r.state === "pending")).toBe(true);
    expect(new Set(rows.map((r) => r.mailboxId))).toEqual(new Set([heldA, heldB]));

    // THE PER-MAILBOX OUTCOME, never one "saved".
    expect(result.travel!.appliedLocally).toEqual([w.mailboxId]);
    expect(new Set(result.travel!.pending.map((p) => p.mailboxId))).toEqual(new Set([heldA, heldB]));
    expect(result.travel!.refused).toEqual([]);
    expect(result.travel!.pending.map((p) => p.holder.name).sort())
      .toEqual(["mila-air", "mila-thinkpad"]);
  });

  it("fans out to the HELD mailboxes only — not to the one it organizes itself", async () => {
    /* MUTATION TARGET: fanning to every mailbox. An install does not send itself a request; it
     * writes. A request against its own organized mailbox would be a record it then drains from
     * its own folder, i.e. the same edit applied twice, and on `rule.create` twice means TWO
     * rules — the account has no unique constraint to catch it. */
    const w = await makeCtx();
    const held = await addMailbox(w, "reader");
    await addMailbox(w, "organizer");

    await svc.create(w.ctx, BODY);
    const rows = await requestRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mailboxId).toBe(held);
  });

  it("one capable holder and one that is not: exactly one request and one organizer_outdated", async () => {
    // Ruling 6's fan-out control, verbatim.
    const w = await makeCtx();
    const capable = await addMailbox(w, "reader", { capabilities: "requests,rules" });
    const stale = await addMailbox(w, "reader", { capabilities: "requests", name: "old-mini" });

    const result = await svc.create(w.ctx, BODY) as RuleMutation;

    const rows = await requestRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mailboxId).toBe(capable);

    expect(result.travel!.refused).toHaveLength(1);
    expect(result.travel!.refused[0]).toMatchObject({
      mailboxId: stale, reason: "organizer_outdated", holder: { name: "old-mini" },
    });
    // The refusal did NOT discard the successes — that is why it rides back instead of throwing.
    expect(result.travel!.pending).toHaveLength(1);
    expect(await ruleRows(w)).toHaveLength(1);
  });

  it("a held mailbox whose holder STOPPED rides back as no_organizer beside the local write", async () => {
    const w = await makeCtx();
    const lapsed = await addMailbox(w, "reader", { state: "stopped", name: "old-mini" });
    const result = await svc.create(w.ctx, BODY) as RuleMutation;
    expect(result.travel!.refused).toEqual([
      expect.objectContaining({ mailboxId: lapsed, reason: "no_organizer" }),
    ]);
    expect(await requestRows(w)).toEqual([]);
  });
});

describe("an all-reader account writes nothing locally", () => {
  it("create answers pending with no rule row at all", async () => {
    const w = await makeCtx();
    await demoteOwn(w);

    const result = await svc.create(w.ctx, BODY) as RuleRequestResult;
    expect(result.pending).toBe(true);
    expect(result.rule).toBeUndefined();       // there is no row until an organizer applies it
    expect(await ruleRows(w)).toEqual([]);
    expect(await requestRows(w)).toHaveLength(1);
    expect(result.travel.appliedLocally).toEqual([]);
  });

  it("every rule kind against a `requests`-only holder is 409 organizer_outdated, and queues nothing", async () => {
    const w = await makeCtx();
    await demoteOwn(w, { capabilities: "requests" });

    await expect(svc.create(w.ctx, BODY)).rejects.toMatchObject({
      code: "organized_elsewhere", httpStatus: 409,
      details: { reason: "organizer_outdated", by: { name: "ohmail Cloud" } },
    });
    expect(await requestRows(w)).toEqual([]);
    expect(await ruleRows(w)).toEqual([]);
  });

  it("a holder that STOPPED renewing is 409 no_organizer however its capabilities read", async () => {
    // Its lease lapsed: nothing organizes the mailbox, and "update ohmail on it" names a machine
    // that stopped. `organizer_outdated` is for a LIVE holder whose build cannot take the change.
    const w = await makeCtx();
    await demoteOwn(w);
    await w.db.update(mailboxes).set({ organizerState: "stopped" }).where(eq(mailboxes.id, w.mailboxId));
    await expect(svc.create(w.ctx, BODY)).rejects.toMatchObject({
      code: "organized_elsewhere", httpStatus: 409, details: { reason: "no_organizer" },
    });
    expect(await requestRows(w)).toEqual([]);
  });

  it("a stopped holder beside a live outdated one: the refusal names the live one, in either order", async () => {
    // The planner reads the live mailboxes unordered, so both scan orders are driven.
    for (const stoppedFirst of [true, false]) {
      const w = await makeCtx();
      await w.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, w.mailboxId));
      const live = { capabilities: "requests", name: "old-mini" };
      const lapsed = { state: "stopped", name: "gone-air" };
      await addMailbox(w, "reader", stoppedFirst ? lapsed : live);
      await addMailbox(w, "reader", stoppedFirst ? live : lapsed);
      await expect(svc.create(w.ctx, BODY), `stopped first: ${stoppedFirst}`).rejects.toMatchObject({
        details: { reason: "organizer_outdated", by: { name: "old-mini" } },
      });
    }
  });

  it("update leaves the local row EXACTLY as it was and hands it back unchanged", async () => {
    /* The person is looking at that row. Showing them the value they typed, on an install that
     * changed nothing, is the false state the ruling is about; the row converges when the
     * organizer applies the request and republishes its document. */
    const w = await makeCtx();
    const created = await svc.create(w.ctx, BODY) as RuleMutation;   // written while organizer
    await demoteOwn(w);

    const result = await svc.update(w.ctx, created.rule.id, { destination: "ohmail/Receipts" }) as RuleRequestResult;
    expect(result.pending).toBe(true);
    expect(result.rule!.destination).toBe("ohmail/News");           // unchanged
    const [row] = await ruleRows(w);
    expect(row!.destination).toBe("ohmail/News");

    const [req] = (await requestRows(w)).filter((r) => r.kind === "rule.update");
    expect(req!.payload).toMatchObject({
      key: { kind: "sender", match: "news@corp.example", subjectContains: null, bodyContains: null },
      set: { destination: "receipts" },
    });
  });

  it("delete leaves the local row and asks — 202-shaped, seq null", async () => {
    const w = await makeCtx();
    const created = await svc.create(w.ctx, BODY) as RuleMutation;
    await demoteOwn(w);

    // The queued half is a REQUEST RESULT, not a removal with a null seq: the shape says which
    // of the two states this is, so nothing downstream has to re-derive it (and get it wrong).
    const out = await svc.remove(w.ctx, created.rule.id) as RuleRequestResult;
    expect(out.pending).toBe(true);
    expect(out.travel.pending).toHaveLength(1);
    // The row STAYS: deleting it would remove the only visible copy of a rule still running on
    // the machine that runs it, and the organizer's next document would put it straight back.
    expect(await ruleRows(w)).toHaveLength(1);
    const [req] = (await requestRows(w)).filter((r) => r.kind === "rule.delete");
    expect(req!.payload).toEqual({
      key: { kind: "sender", match: "news@corp.example", subjectContains: null, bodyContains: null },
    });
  });
});

describe("the key is FOUR fields, and a change to it is not an edit", () => {
  it("two rules on one sender differing only by a subject term travel under DIFFERENT keys", async () => {
    /* THE CORRECTION THAT MATTERS. There is no unique index on `(account_id, kind, match)`, and
     * that is not an oversight: these are different rules filing to different places. A two-field
     * key collapses them, so the applier finds one and acts on the other — filing mail somewhere
     * nobody chose, with every guard on both sides green. */
    const w = await makeCtx();
    await demoteOwn(w);

    const bare = await svc.create(w.ctx, BODY) as RuleRequestResult;
    const narrowed = await svc.create(w.ctx, {
      ...BODY, destination: "ohmail/Receipts", subjectContains: "Invoice",
    }) as RuleRequestResult;

    const rows = await requestRows(w);
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => (r.payload as { key: unknown }).key);
    expect(keys).toEqual(expect.arrayContaining([
      { kind: "sender", match: "news@corp.example", subjectContains: null, bodyContains: null },
      { kind: "sender", match: "news@corp.example", subjectContains: "Invoice", bodyContains: null },
    ]));
    // Two distinct keys, so the applier can tell them apart.
    expect(JSON.stringify(keys[0])).not.toBe(JSON.stringify(keys[1]));
    void bare; void narrowed;
  });

  it("an update that changes what the rule MATCHES is refused whole, and writes nothing", async () => {
    const w = await makeCtx();
    const created = await svc.create(w.ctx, BODY) as RuleMutation;
    await demoteOwn(w);

    await expect(svc.update(w.ctx, created.rule.id, {
      match: "other@corp.example", destination: "ohmail/Receipts",
    })).rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });

    // NEITHER half landed — the destination change did not sneak through.
    const [row] = await ruleRows(w);
    expect(row).toMatchObject({ match: "news@corp.example", destination: "ohmail/News" });
    expect((await requestRows(w)).filter((r) => r.kind === "rule.update")).toEqual([]);
  });

  it("…but on an account this install organizes, changing the match is an ordinary edit", async () => {
    /* THE POSITIVE CONTROL for the rule above, and it is the one that keeps it honest: the
     * refusal is about a REQUEST, not about the product. A guard that refused every match change
     * everywhere would be green on all the cases above and would have broken the rules surface. */
    const w = await makeCtx();
    const created = await svc.create(w.ctx, BODY) as RuleMutation;

    const result = await svc.update(w.ctx, created.rule.id, { match: "other@corp.example" }) as RuleMutation;
    expect(result.rule.match).toBe("other@corp.example");
    expect(await requestRows(w)).toEqual([]);
  });

  it("a rule may not travel to trash — no door offers delete-on-arrival", async () => {
    const w = await makeCtx();
    await demoteOwn(w);
    // `validDestination` refuses it first, which is the honest layering: the word set this door
    // composes from has no `trash` member, so the payload cannot express it either.
    await expect(svc.create(w.ctx, { ...BODY, destination: "Trash" }))
      .rejects.toMatchObject({ code: "validation_failed" });
    expect(await requestRows(w)).toEqual([]);
  });
});

describe("onboarding: nothing held and nothing organized is ADMITTED", () => {
  it("an account with NO live mailbox writes the rule locally", async () => {
    /* THE STATE A FAIL-CLOSED RULE GETS WRONG, and it is why `organizer-role-census`'s own
     * exemption for the settings writers exists. At consent time nothing is organized yet;
     * refusing here means a person cannot write a rule, name a tag or choose a window until they
     * have connected a mailbox, which makes the flow unfinishable. Account configuration is INERT
     * until something organizes, and inert is not dangerous — what is dangerous is configuration
     * that reaches an organizer which is somebody else's. */
    const w = await makeCtx();
    await w.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, w.mailboxId));

    const result = await svc.create(w.ctx, BODY) as RuleMutation;
    expect(result.rule.match).toBe("news@corp.example");
    expect(await ruleRows(w)).toHaveLength(1);
    expect(await requestRows(w)).toEqual([]);
    expect(result.travel).toBeUndefined();   // nothing travelled, so nothing to report
  });

  it("a TOMBSTONED held mailbox does not make the account refuse", async () => {
    // A removed mailbox keeps whatever `organizer_role` it had, so without the `status` filter an
    // account whose only reader was deleted would still be refused on its behalf.
    const w = await makeCtx();
    await w.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, w.mailboxId));
    await addMailbox(w, "reader", { status: "disabled", capabilities: "requests" });

    const result = await svc.create(w.ctx, BODY) as RuleMutation;
    expect(result.rule.match).toBe("news@corp.example");
    expect(await requestRows(w)).toEqual([]);
  });
});

describe("a published rule is changed by its key, relayed only", () => {
  const KEY = { kind: "sender", match: "news@corp.example", subjectContains: null, bodyContains: null };
  /** The organizer's copy of one held mailbox, listing the given rules. */
  async function copy(w: World, mailboxId: string, rules: Record<string, unknown>[]): Promise<void> {
    await w.db.insert(mailboxProfileMirror).values({
      mailboxId, accountId: w.accountId, readAt: new Date(), doc: { v: 2, rules },
    });
  }
  const NEWS = { kind: "sender", match: "News@Corp.example", destination: "ohmail/News", priority: 0, enabled: true };
  async function changes(w: World) {
    return w.db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId));
  }
  /** A reader-only account: its own mailbox and a second one, both held, both with a copy. */
  async function readerOnly(w: World): Promise<string> {
    await demoteOwn(w);
    const other = await addMailbox(w, "reader", { name: "mila-air" });
    await copy(w, w.mailboxId, [NEWS]);
    await copy(w, other, [NEWS]);
    return other;
  }

  it("a change by key sends one request per holder in the copy's spelling, answers 202 and writes no row", async () => {
    const w = await makeCtx();
    const other = await readerOnly(w);
    const before = (await changes(w)).length;
    const out = await svc.update(w.ctx, PUBLISHED_RULE_ID, { key: KEY, destination: "INBOX" }) as RuleRequestResult;
    expect(out.pending).toBe(true);
    expect(out.rule).toBeUndefined();
    const rows = await requestRows(w);
    expect(new Set(rows.map((r) => r.mailboxId))).toEqual(new Set([w.mailboxId, other]));
    expect(rows.every((r) => r.kind === "rule.update")).toBe(true);
    expect(rows[0]!.payload).toEqual({ key: { ...KEY, match: "News@Corp.example" }, set: { destination: "inbox" } });
    expect(await ruleRows(w)).toEqual([]);
    expect(await changes(w)).toHaveLength(before);
  });

  it("a removal by key is asked of every holder and removes nothing", async () => {
    const w = await makeCtx();
    await readerOnly(w);
    const out = await svc.remove(w.ctx, PUBLISHED_RULE_ID, { key: KEY }) as RuleRequestResult;
    expect(out.pending).toBe(true);
    const rows = await requestRows(w);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "rule.delete")).toBe(true);
    expect(rows[0]!.payload).toEqual({ key: { ...KEY, match: "News@Corp.example" } });
    expect(await ruleRows(w)).toEqual([]);
  });

  it("a key no copy lists is 404, and nothing travels", async () => {
    const w = await makeCtx();
    await readerOnly(w);
    await expect(svc.update(w.ctx, PUBLISHED_RULE_ID, { key: { ...KEY, subjectContains: "Invoice" }, destination: "INBOX" }))
      .rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
    await expect(svc.remove(w.ctx, PUBLISHED_RULE_ID, { key: { ...KEY, match: "else@corp.example" } }))
      .rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
    expect(await requestRows(w)).toEqual([]);
  });

  it("an organizer or a mixed account is 409 rule_runs_here, never a 404 a delete reads as done", async () => {
    const organizer = await makeCtx();
    await expect(svc.remove(organizer.ctx, PUBLISHED_RULE_ID, { key: KEY }))
      .rejects.toMatchObject({ code: "rule_runs_here", httpStatus: 409 });
    const mixed = await makeCtx();
    const held = await addMailbox(mixed, "reader");
    await copy(mixed, held, [NEWS]);
    await expect(svc.update(mixed.ctx, PUBLISHED_RULE_ID, { key: KEY, destination: "INBOX" }))
      .rejects.toMatchObject({ code: "rule_runs_here", httpStatus: 409 });
    expect(await requestRows(mixed)).toEqual([]);
  });

  it("a key-changing field, a malformed key or a key at a row's id is 400", async () => {
    const w = await makeCtx();
    await readerOnly(w);
    await expect(svc.update(w.ctx, PUBLISHED_RULE_ID, { key: KEY, match: "else@corp.example" }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    await expect(svc.remove(w.ctx, PUBLISHED_RULE_ID, { key: null }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    await expect(svc.remove(w.ctx, PUBLISHED_RULE_ID, { key: { ...KEY, kind: "domain", subjectContains: "x" } }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    await expect(svc.update(w.ctx, crypto.randomUUID(), { key: KEY, destination: "INBOX" }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    expect(await requestRows(w)).toEqual([]);
  });
});
