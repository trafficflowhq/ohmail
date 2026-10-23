import { describe, it, expect } from "vitest";
import { planChange, commitChange, applyReconcileAction , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import { FakeRepo, FakeAdapter, dedupKeyFor } from "./fakes.js";
import type { Change, PipelineDeps } from "../src/ports.js";
import type { Rule } from "../src/rules.js";

/**
 * The key for the DEFAULT sample. DERIVED and not spelled out: a literal is a second
 * implementation of the key, and every literal in this file was silently asserting the OLD format
 * the moment `dedup_key` changed. Note it is sample-SPECIFIC now — the fingerprint reads `from`,
 * the subject and the body, so a case that changes any of them must derive its own.
 */
const DEDUP = await dedupKeyFor(eml());
const DEDUP_NEWS = await dedupKeyFor(eml({ from: "news@example.com" }));

function eml(opts: { from?: string; subject?: string; body?: string; messageId?: string } = {}): Buffer {
  const {
    from = "anna@example.com",
    subject = "Hello",
    body = "Just saying hi.",
    messageId = "<m-1@example.com>",
  } = opts;
  return Buffer.from([
    `Message-ID: ${messageId}`,
    `From: ${from}`,
    "To: mila@lichtgrat.example",
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n"));
}

function createChange(folder: string, raw: Buffer, ref = "1:10"): Change {
  return { type: "create", locator: { folder, ref }, raw };
}

function makeDeps(): PipelineDeps & { repo: FakeRepo; adapter: FakeAdapter } {
  return { repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "acct-1", mailboxId: "mb-1" };
}

/**
 * Drives the restructured two-phase pipeline (resolution): PLAN (reads, no tx) →
 * COMMIT (persist, no network) → and, when a move is owed, the OUTSIDE-tx reconcile
 * runner realizes the physical adapter move — exactly the worker's ordering. This
 * lets the Phase-0 assertions (dedup, user-wins, idempotent-replay, sensitive→INBOX,
 * screener) stand unchanged while proving no network sits inside the commit.
 */
async function processChange(change: Change, deps: PipelineDeps & { repo: FakeRepo }) {
  const plan = await planChange(change, {
    repo: deps.repo, accountId: deps.accountId, mailboxId: deps.mailboxId,
    classifier: deps.classifier, routing: deps.routing,
  });
  const res = await commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
    repo: deps.repo, accountId: deps.accountId, mailboxId: deps.mailboxId, routing: deps.routing,
  });
  if (res.action.type === "move") {
    const stored = deps.repo.rows.get(res.messageId)!.stored;
    const state = (await deps.repo.getFolderState(res.messageId))!;
    await applyReconcileAction(deps, { messageId: res.messageId, locator: stored.nativeLocator, state }, res.action);
  }
  return res;
}

const feedRule = (match: string): Rule => ({
  id: "r1", kind: "sender", match, destination: "ohmail/News",
  effect: "allow", priority: 10, provenance: "manual", enabled: true,
});

describe("processChange (two-phase: plan → commit → reconcile)", () => {
  it("ingests a new message from a known sender with no matching rule and leaves it in place", async () => {
    const d = makeDeps();
    d.repo.senders.add("anna@example.com");
    const res = await processChange(createChange("INBOX", eml()), d);
    expect(res.outcome).toBe("new");
    expect(res.action).toEqual({ type: "none" });
    expect(d.adapter.moves).toEqual([]);
    const stored = await d.repo.findByDedupKey("mb-1", DEDUP);
    expect(stored).not.toBeNull();
    expect(await d.repo.getFolderState(stored!.id))
      .toEqual({ desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
    // change_log: a message create was emitted (no move, since it stayed put).
    expect(d.repo.changes.filter((c) => c.entityType === "message" && c.op === "create")).toHaveLength(1);
    expect(d.repo.changes.some((c) => c.op === "move")).toBe(false);
    // body persisted
    expect(d.repo.bodies.get(stored!.id)?.text).toContain("Just saying hi.");
  });

  it("applies a routing rule by moving the message to the target folder", async () => {
    const d = makeDeps();
    d.repo.senders.add("news@example.com");
    d.repo.rules = [feedRule("news@example.com")];
    const res = await processChange(createChange("INBOX", eml({ from: "news@example.com" })), d);
    expect(res.outcome).toBe("new");
    expect(res.action).toEqual({ type: "move", to: "ohmail/News" });
    expect(d.adapter.moves).toEqual([{ from: { folder: "INBOX", ref: "1:10" }, to: "ohmail/News" }]);
    const stored = await d.repo.findByDedupKey("mb-1", DEDUP_NEWS);
    expect(stored!.nativeLocator.folder).toBe("ohmail/News");
    expect(await d.repo.getFolderState(stored!.id))
      .toEqual({ desiredFolder: "ohmail/News", observedFolder: "ohmail/News", lastSetBy: "us" });
    // optimistic client-visible move change emitted at commit
    expect(d.repo.changes.some((c) => c.op === "move" && c.meta?.to === "ohmail/News")).toBe(true);
  });

  it("routes an unknown first-contact sender to the Screener", async () => {
    const d = makeDeps();
    const res = await processChange(createChange("INBOX", eml({ from: "stranger@nowhere-com.example" })), d);
    expect(res.action).toEqual({ type: "move", to: "ohmail/Screener" });
    expect(d.adapter.moves[0].to).toBe("ohmail/Screener");
  });

  it("files a sensitive OTP where the person's own rule says, and still sets the never-flags (a manual News rule)", async () => {
    const d = makeDeps();
    // The person filed this sender to News by hand: their rule wins over the sensitivity lift.
    d.repo.rules = [{
      id: "r1", kind: "domain", match: "bank.example", destination: "ohmail/News",
      effect: "allow", priority: 10, provenance: "manual", enabled: true,
    }];
    const raw = eml({ from: "no-reply@bank.example", subject: "Your verification code", body: "Your one-time code is 483920." });
    const res = await processChange(createChange("INBOX", raw), d);
    expect(res.action).toEqual({ type: "move", to: "ohmail/News" });
    expect(d.adapter.moves.map((m: { to: string }) => m.to)).toEqual(["ohmail/News"]);
    const stored = await d.repo.findByDedupKey("mb-1", await dedupKeyFor(raw));
    expect(d.repo.rows.get(stored!.id)!.input.flags)
      .toEqual({ no_ai: true, no_forward: true, no_kb: true, priority: true });
    // ITEM 1 GUARD: body redaction at rest is REMOVED — the stored body is the FULL original, code
    // and all, because the reader is entitled to read their own OTP. The never-flags above are what
    // keep it out of automatic AI; the model gate strips the code from any user-pressed AI payload.
    // (Mutation: restore `storeRedactedBody ? redactedTextBody` in `pipeline.ts` ⇒ this goes red.)
    expect(d.repo.bodies.get(stored!.id)!.text).toContain("483920");
    expect(d.repo.bodies.get(stored!.id)!.text).not.toContain("[REDACTED]");
  });

  for (const provenance of ["promoted", "seeded-from-sent"] as const) {
    it(`keeps a sensitive OTP in the priority Imbox over a rule ohmail inferred (${provenance})`, async () => {
      const d = makeDeps();
      // Only a rule the person authored outranks the lift: an inferred one never pulls a code out.
      d.repo.rules = [{
        id: "r1", kind: "domain", match: "bank.example", destination: "ohmail/News",
        effect: "allow", priority: 10, provenance, enabled: true,
      }];
      const raw = eml({ from: "no-reply@bank.example", subject: "Your verification code", body: "Your one-time code is 483920." });
      const res = await processChange(createChange("INBOX", raw), d);
      expect(res.action).toEqual({ type: "none" });     // desired = INBOX, arrived in INBOX
      expect(d.adapter.moves).toEqual([]);
      const stored = await d.repo.findByDedupKey("mb-1", await dedupKeyFor(raw));
      expect(d.repo.rows.get(stored!.id)!.input.flags)
        .toEqual({ no_ai: true, no_forward: true, no_kb: true, priority: true });
    });
  }

  /**
   * The consent boundary, against the signal the SENDER controls.
   *
   * `classifySensitivity` reads the subject and body. Before this pair,
   * `sensitivity.sensitive ? "INBOX"` outranked `evaluateRules`, so an OTP-shaped body was a
   * remote, unauthenticated bypass of the Screener — the same shape as an earlier review finding,
   * which moved `headerHeuristic` below the gate for exactly this reason.
   *
   * Both tests are polarity-checked: restore the ternary in `pipeline.ts#planChange` and each
   * one fails with `{ type: "none" }` (desired = INBOX = arrival) instead of the move.
   */
  it("sends a STRANGER's OTP to the Screener — a sender-written body cannot buy consent", async () => {
    const d = makeDeps();
    // No rule, and the sender is not in `d.repo.senders` — a pure first contact
    // whose only claim to the Imbox is that it wrote something OTP-shaped.
    const raw = eml({
      from: "stranger@nowhere-com.example",
      subject: "Your verification code",
      body: "Your one-time code is 483920.",
    });
    const res = await processChange(createChange("INBOX", raw), d);

    expect(res.action).toEqual({ type: "move", to: "ohmail/Screener" });
    expect(d.adapter.moves[0].to).toBe("ohmail/Screener");

    // The never-flags are properties of the sensitivity verdict, not of the folder it lands in.
    // The body is stored in FULL (body redaction is removed) whichever folder the message routes to.
    const stored = await d.repo.findByDedupKey("mb-1", await dedupKeyFor(raw));
    expect(d.repo.rows.get(stored!.id)!.input.flags)
      .toEqual({ no_ai: true, no_forward: true, no_kb: true, priority: true });
    expect(d.repo.bodies.get(stored!.id)!.text).toContain("483920");
    expect(d.repo.bodies.get(stored!.id)!.text).not.toContain("[REDACTED]");
  });

  it("does not let an OTP-shaped body free a sender the user QUARANTINED", async () => {
    const d = makeDeps();
    // The user's own explicit "no". `deny` is what must survive contact with a sensitive body.
    d.repo.rules = [{
      id: "r-deny", kind: "domain", match: "spam.example", destination: "ohmail/Quarantine",
      effect: "deny", priority: 10, provenance: "manual", enabled: true,
    }];
    const raw = eml({
      from: "attacker@spam.example",
      subject: "Your login code",
      body: "Your one-time code is 999111.",
    });
    const res = await processChange(createChange("INBOX", raw), d);

    expect(res.action).toEqual({ type: "move", to: "ohmail/Quarantine" });
    expect(d.adapter.moves[0].to).toBe("ohmail/Quarantine");
  });

  it("is idempotent: replaying an already-processed create neither re-inserts nor re-moves", async () => {
    const d = makeDeps();
    d.repo.senders.add("news@example.com");
    d.repo.rules = [feedRule("news@example.com")];
    const raw = eml({ from: "news@example.com" });
    await processChange(createChange("INBOX", raw), d);            // new -> move to Feed
    const stored = await d.repo.findByDedupKey("mb-1", DEDUP_NEWS);
    expect(stored!.nativeLocator.folder).toBe("ohmail/News"); // locator already updated

    const replay = await processChange(createChange("ohmail/News", raw, "1:1001"), d);
    expect(replay.outcome).toBe("duplicate");
    expect(replay.action).toEqual({ type: "none" });
    expect(d.adapter.moves).toHaveLength(1);  // no second move
    expect(d.repo.rows.size).toBe(1);         // no re-insert
  });

  it("recognizes our own move without re-ingesting, and waits for evidence before completing it", async () => {
    const d = makeDeps();
    const raw = eml({ from: "news@example.com" });
    // Simulate a crash AFTER the physical move to Feed but BEFORE updateLocator persisted.
    //
    // FROM HERE THAT IS INDISTINGUISHABLE from a COPY that landed and an EXPUNGE that failed: in
    // both, a copy is at the destination and nothing has reported the source leaving. So this
    // resolves the same way — the message is recognised (not re-ingested, not moved again) and the
    // move is left OWED, because a copy appearing is not the source disappearing. The completion
    // comes from evidence in the next cycle: `batch.deletes` retires the source instance, or
    // `reconcileFolders` retries the move and the adapter answers `MessageGoneError`. The pair of
    // cases below is where those two evidence shapes are pinned.
    const stored = await d.repo.insertMessage({ senderCheck: null,
      accountId: "acct-1", mailboxId: "mb-1",
      canonical: { messageIdHeader: "m-1@example.com", bodyHash: "h" },
      dedupKey: DEDUP_NEWS, subject: "Hello", fromAddress: "news@example.com", date: null,
      nativeLocator: { folder: "INBOX", ref: "1:10" },
      flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
    });
    await d.repo.upsertFolderState(stored.id, { desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" });

    const res = await processChange(createChange("ohmail/News", raw, "1:1001"), d);
    expect(res.outcome).toBe("own_move");
    expect(res.action).toEqual({ type: "move", to: "ohmail/News" });
    expect(d.repo.rows.size).toBe(1);      // did NOT re-ingest

    // THE RETRY IS HANDED THE SOURCE, and that is the assertion worth having. The reconcile
    // runner reads `messages.native_locator`, so leaving the primary on the source is what makes
    // the retry `move(INBOX, Reads)` — a call the adapter can complete by expunging the source it
    // still owes. Had the locator been repointed at the copy this would read
    // `from: ohmail/News`, i.e. a move of the destination to itself.
    expect(d.adapter.moves).toEqual([
      { from: { folder: "INBOX", ref: "1:10" }, to: "ohmail/News" },
    ]);

    // And once that retry returns, the move really is done: locator on the destination, converged.
    const after = await d.repo.findByDedupKey("mb-1", DEDUP_NEWS);
    expect(after!.nativeLocator.folder).toBe("ohmail/News");
    expect(await d.repo.getFolderState(stored.id))
      .toEqual({ desiredFolder: "ohmail/News", observedFolder: "ohmail/News", lastSetBy: "us" });
  });

  /**
   * ── THE PAIR THAT IS THE WHOLE OF THAT CHANGE SLICE 2, COMPOSED THROUGH THE REAL PIPELINE ──────────
   *
   * The next two cases differ in ONE thing and nothing else: whether a disappearance was observed.
   * The bytes are identical, the folder is identical, the stored state is identical. One is the
   * user filing their mail and must be adopted; the other is a stranger delivering a second copy
   * and must change nothing.
   *
   * Before this slice they were the SAME code path and both were adopted, which is the finding.
   */
  it("adopts a user's manual move (user wins) when the source locator DISAPPEARED", async () => {
    const d = makeDeps();
    d.repo.senders.add("anna@example.com");
    const raw = eml({ from: "anna@example.com" });
    await processChange(createChange("INBOX", raw), d);  // new, known sender, no rule -> stays in INBOX
    const stored = await d.repo.findByDedupKey("mb-1", DEDUP);

    // The disappearance, recorded exactly as the worker records it: the server reported the INBOX
    // UID expunged. This is the ONLY thing a stranger cannot cause.
    await d.repo.forgetInstanceAt("mb-1", { folder: "INBOX", ref: "1:10" });

    const res = await processChange(createChange("Archive", raw, "1:1002"), d); // user moved it
    expect(res.outcome).toBe("external_move");
    expect(res.action).toEqual({ type: "adopt_external", newDesired: "Archive" });
    expect(d.adapter.moves).toEqual([]);  // never revert
    expect(await d.repo.getFolderState(stored!.id))
      .toEqual({ desiredFolder: "Archive", observedFolder: "Archive", lastSetBy: "external" });
    const audit = d.repo.audits.at(-1)!;
    expect(audit.action).toBe("adopt_external");
    expect(audit.inverse).toEqual({ messageId: stored!.id, revertTo: "INBOX" });
    // a corrective, client-visible move change was emitted for the adopted move
    expect(d.repo.changes.some((c) => c.op === "move" && c.meta?.to === "Archive")).toBe(true);
  });

  /**
   * THE ADOPTION BOUNDARY. The arrival's observation is the truth AT ITS INSTANT; a press
   * committed after that instant outranks it. The window is real and not contrived: the plan is
   * computed in phase 1, OUTSIDE the commit transaction, so `e.state` is as old as the read that
   * produced it. The case above is this one's control — no press, so the adoption stands whole.
   * Mutation watched (restored by cmp): put the blind `upsertFolderState(to, to, "external")`
   * back in the arm and this case reddens on `desiredFolder` while the case above stays green.
   */
  it("an arrival does NOT overwrite a press committed after the plan was computed", async () => {
    const d = makeDeps();
    d.repo.senders.add("anna@example.com");
    const raw = eml({ from: "anna@example.com" });
    await processChange(createChange("INBOX", raw), d);
    const stored = (await d.repo.findByDedupKey("mb-1", DEDUP))!;
    await d.repo.forgetInstanceAt("mb-1", { folder: "INBOX", ref: "1:10" });

    const plan = await planChange(createChange("Archive", raw, "1:1002"),
      { repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, readerMode: false });
    expect(plan.existing!.action).toEqual({ type: "adopt_external", newDesired: "Archive" });

    // THE PRESS, committed between that read and the commit below.
    await d.repo.upsertFolderState(stored.id,
      { desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" });
    const changesBefore = d.repo.changes.length;

    const res = await commitChange(plan, {
      storageCap: UNMETERED_STORAGE_CAP,
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, routing: d.routing,
    });
    expect(res.outcome).toBe("external_move");

    // THE PRESS KEEPS THE DESIRE; the arrival still records where the server holds the message.
    expect(await d.repo.getFolderState(stored.id)).toEqual({
      desiredFolder: "ohmail/News", observedFolder: "Archive", lastSetBy: "us",
    });
    // The superseded adoption is owed to the log and carries NO inverse: the desire never moved.
    const superseded = d.repo.audits.find((a) => a.action === "adopt_superseded")!;
    expect(superseded, "an adopt_superseded row was written").toBeDefined();
    expect(superseded.inverse).toBe(null);
    expect(d.repo.audits.some((a) => a.action === "adopt_external")).toBe(false);
    // …and everything the arm owes either way still happened: the client-visible move change.
    expect(d.repo.changes.length).toBeGreaterThan(changesBefore);
    expect(d.repo.changes.some((c) => c.op === "move" && c.meta?.to === "Archive")).toBe(true);
  });

  it("adopts a CORRELATED move too — the adapter's own pairing needs no absence probe", async () => {
    const d = makeDeps();
    d.repo.senders.add("anna@example.com");
    const raw = eml({ from: "anna@example.com" });
    await processChange(createChange("INBOX", raw), d);
    const stored = await d.repo.findByDedupKey("mb-1", DEDUP);

    // `correlateMoves` paired the vanished INBOX UID with the re-appeared Archive one, so the
    // adapter emitted `type: "move"`. The INBOX instance is still recorded here — deliberately, to
    // prove this arm does not lean on the absence probe.
    const res = await processChange(
      { type: "move", locator: { folder: "Archive", ref: "1:1002" }, raw }, d,
    );
    expect(res.outcome).toBe("external_move");
    expect(await d.repo.getFolderState(stored!.id))
      .toEqual({ desiredFolder: "Archive", observedFolder: "Archive", lastSetBy: "external" });
  });

  it("a SECOND DELIVERY changes no placement, emits no delta, writes no audit row", async () => {
    // The attack, end to end, through the real `planChange`/`commitChange`. A stranger's message is
    // held in the Screener; they deliver the same bytes again and the second delivery lands
    // wherever they can get it to land (here `ohmail/News`, which the user's own provider-side
    // sieve rules are equally able to deliver into — the reason folder identity is worth nothing).
    //
    // Measured with `permitsAdoption` forced to `true`:
    //     AssertionError: expected 'external_copy' to be … — outcome was 'external_move',
    //     desiredFolder became 'ohmail/News', last_set_by became 'external',
    //     an `adopt_external` audit row was written and a `move` change_log row went out.
    const d = makeDeps();
    const raw = eml({ from: "stranger@nowhere.example" });
    const first = await processChange(createChange("INBOX", raw), d);
    expect(first.action).toEqual({ type: "move", to: "ohmail/Screener" });
    const stored = (await d.repo.findByDedupKey("mb-1", await dedupKeyFor(raw)))!;
    const changesBefore = d.repo.changes.length;
    const auditsBefore = d.repo.audits.length;

    const second = await processChange(createChange("ohmail/News", raw, "1:2002"), d);

    expect(second.outcome).toBe("external_copy");
    expect(second.action).toEqual({ type: "none" });
    // PLACEMENT UNCHANGED, and still OURS.
    expect(await d.repo.getFolderState(stored.id)).toEqual({
      desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us",
    });
    // The conflict is RECORDED — the operator-visible trace that two instances exist.
    expect(d.repo.conflicts.has(stored.id)).toBe(true);
    // NOT ONE new delta and NOT ONE new audit row.
    expect(d.repo.changes.length).toBe(changesBefore);
    expect(d.repo.audits.length).toBe(auditsBefore);
    expect(d.repo.audits.some((a) => a.action === "adopt_external")).toBe(false);
    // No second `messages` row either: identical bytes ARE the same logical message.
    expect(d.repo.rows.size).toBe(1);
    // The primary instance never moved…
    expect((await d.repo.findByDedupKey("mb-1", await dedupKeyFor(raw)))!.nativeLocator.folder)
      .toBe("ohmail/Screener");
    // …and the copy's locator is nonetheless KNOWN, which is what stops it being re-fetched every
    // cycle for ever. Drop `recordInstance` from the `external_copy` branch and this is `false`.
    expect([...d.repo.instances.values()].some(
      (i) => i.folder === "ohmail/News" && i.ref === "1:2002" && !i.isPrimary,
    )).toBe(true);
  });

  it("byte-identical and repeated: three cycles change nothing", async () => {
    // The acceptance criterion is the forgery run TWICE, "different body AND byte-identical", after
    // THREE full cycles. This is the byte-identical variant: the same delivery observed again and
    // again must be idempotent, not cumulative.
    const d = makeDeps();
    const raw = eml({ from: "stranger@nowhere.example" });
    await processChange(createChange("INBOX", raw), d);
    const stored = (await d.repo.findByDedupKey("mb-1", await dedupKeyFor(raw)))!;
    const changesBefore = d.repo.changes.length;

    for (let cycle = 0; cycle < 3; cycle++) {
      const res = await processChange(createChange("ohmail/Receipts", raw, "1:3003"), d);
      expect(res.outcome, `cycle ${cycle}`).toBe("external_copy");
    }
    expect(await d.repo.getFolderState(stored.id)).toEqual({
      desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us",
    });
    expect(d.repo.changes.length).toBe(changesBefore);
    expect(d.repo.rows.size).toBe(1);
    // ONE instance row for the copy after three observations, not three.
    expect([...d.repo.instances.values()].filter((i) => !i.isPrimary)).toHaveLength(1);
  });

  it("a message with NO Message-ID and body `x` is not adoptable by a second delivery either", () => {
    // The acceptance list calls this shape out separately: with no Message-ID the legacy key was
    // `body:<sha256("x")>`, which any other bodyless message shares. The fingerprint separates them
    // by subject and sender, and the evidence rule is what refuses the adoption.
    //
    // Asserted at the identity layer, where it is decidable without a pipeline: two `x`-bodied
    // messages from different senders are DIFFERENT logical messages, so there is no shared row for
    // a second delivery to adopt in the first place.
    return (async () => {
      const d = makeDeps();
      const bare = (from: string) => Buffer.from([
        `From: ${from}`, "To: mila@lichtgrat.example", "Subject: s",
        "Content-Type: text/plain; charset=utf-8", "", "x",
      ].join("\r\n"));
      await processChange(createChange("INBOX", bare("a@x.example")), d);
      const res = await processChange(createChange("INBOX", bare("b@y.example"), "1:11"), d);
      expect(res.outcome).toBe("new");           // NOT `duplicate` — the earlier identity rule would have dropped this
      expect(d.repo.rows.size).toBe(2);
      // And the second delivery of the FIRST one, into another folder, is still only a copy.
      const again = await processChange(createChange("ohmail/News", bare("a@x.example"), "1:12"), d);
      expect(again.outcome).toBe("external_copy");
    })();
  });

  it("throws when a change carries no raw source (content identity is required)", async () => {
    const d = makeDeps();
    await expect(planChange({ type: "flag", locator: { folder: "INBOX", ref: "1:10" }, seen: true }, d))
      .rejects.toThrow(/requires change\.raw/);
  });
});

/**
 * READ-STATE AT INGEST — the "everything is New" resurrection guard.
 *
 * The pipeline used to build `InsertMessageInput` without touching `Change.seen`, so the
 * `messages.unread` column default (`true`) decided every message's read state. `new_for_you` is
 * literally `unread = true`, so the first sync of a real mailbox filed a decade of already-read
 * mail under "New" — an Ohbox full of unread messages on day one, and no way for
 * the user to tell which ones were actually new.
 *
 * TO WATCH IT FAIL: delete `unread: !p.seen` from `commitChange` in `packages/core/src/pipeline.ts`
 * and run this file. The first case below goes red.
 */
describe("ingest maps the server's \\Seen onto messages.unread", () => {
  const inputFor = (d: { repo: FakeRepo }, messageId: string) =>
    d.repo.rows.get(messageId)!.input;

  it("a message the SERVER reports as seen is stored read, not New", async () => {
    const d = makeDeps();
    d.repo.senders.add("anna@example.com");
    const change: Change = { ...createChange("INBOX", eml()), seen: true };
    const res = await processChange(change, d);
    expect(inputFor(d, res.messageId).unread).toBe(false);
  });

  it("a message the server reports as unseen stays unread", async () => {
    const d = makeDeps();
    d.repo.senders.add("anna@example.com");
    const res = await processChange({ ...createChange("INBOX", eml()), seen: false }, d);
    expect(inputFor(d, res.messageId).unread).toBe(true);
  });

  it("an adapter that reports NOTHING degrades to unread — never to 'already read'", async () => {
    // The fallback path cannot derive flags (no prior flags to diff against), so `seen` is
    // absent. Unknown must resolve to unread: the recoverable direction. Guessing "read" would
    // hide new mail, and a hidden message is not recoverable by looking harder.
    const d = makeDeps();
    d.repo.senders.add("anna@example.com");
    const res = await processChange(createChange("INBOX", eml()), d);
    expect(inputFor(d, res.messageId).unread).toBe(true);
  });

  it("the mapping survives a ROUTED message — it is not tied to staying in INBOX", async () => {
    const d = makeDeps();
    d.repo.senders.add("anna@example.com");
    d.repo.rules = [feedRule("anna@example.com")];
    const res = await processChange({ ...createChange("INBOX", eml()), seen: true }, d);
    expect(res.action).toEqual({ type: "move", to: "ohmail/News" });
    expect(inputFor(d, res.messageId).unread).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   RELEVANCE-APPROPRIATE ROUTING UNDER people_only — end-to-end through planChange/commitChange.

   The proof the refinement asks for: with the relevance-focused posture on, a seeded sender's mail
   is routed to the RIGHT pile by what it is — a marketing blast to Reads, a receipt to Receipts —
   while a genuinely relevant service message (a security alert with no bulk marker) and a real
   person both STAY in the Ohbox. This exercises `PlanDeps.ohboxPolicy` → `evaluateRules` →
   `folder_state.desired_folder`; the Ohbox is kept for what is relevant, not emptied of machines.
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("people_only keeps the Ohbox relevant and files the rest to the right pile (end-to-end)", () => {
  const SENDER = "news@vendor.example";
  const seededInbox: Rule = {
    id: "seed-1", kind: "sender", match: SENDER, destination: "INBOX",
    effect: "allow", priority: 0, provenance: "seeded-from-sent", enabled: true,
  };
  const raw = (subject: string, extraHeaders: string[] = []) => Buffer.from([
    "Message-ID: <m@vendor.example>",
    `From: ${SENDER}`,
    "To: mila@lichtgrat.example",
    `Subject: ${subject}`,
    ...extraHeaders,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body text.",
  ].join("\r\n"));

  async function run(
    body: Buffer, ohboxPolicy: "people_only" | "people_and_replied" = "people_only",
    sender = SENDER,
  ) {
    const d = makeDeps();
    d.repo.senders.add(sender);           // a known contact — past the gate
    d.repo.rules = [{ ...seededInbox, match: sender }];  // …with the onboarding seed's INBOX rule
    const plan = await planChange(createChange("INBOX", body), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, ohboxPolicy,
    });
    const res = await commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
    });
    return (await d.repo.getFolderState(res.messageId))!.desiredFolder;
  }

  // A marketing blast: List-Id marks it bulk, no money subject.
  const marketing = raw("This week at the shop", ["List-Id: <news.vendor.example>"]);
  // A receipt: a money subject + a machine sender (List-Unsubscribe footer, as real ESPs send).
  const receipt = raw("Your receipt from Shop", ["List-Unsubscribe: <https://u.vendor.example>"]);
  // A relevant service alert: no bulk marker, no money subject — the ambiguous middle.
  const alert = raw("New sign-in to your account from a new device");

  it("BEFORE (people_and_replied): the seeded rule keeps the marketing blast in the Ohbox", async () => {
    expect(await run(marketing, "people_and_replied")).toBe("INBOX");
  });

  it("a marketing blast is filed to Reads", async () => {
    expect(await run(marketing)).toBe("ohmail/News");
  });

  it("a receipt is filed to Receipts, not buried", async () => {
    expect(await run(receipt)).toBe("ohmail/Receipts");
  });

  it("a genuinely relevant service alert STAYS in the Ohbox — not blanket-demoted", async () => {
    expect(await run(alert)).toBe("INBOX");
  });

  it("a real person writing personally STAYS in the Ohbox", async () => {
    const person = Buffer.from([
      "Message-ID: <p@friends.example>",
      "From: A Friend <friend@friends.example>",
      "To: mila@lichtgrat.example",
      "Subject: lunch on friday?",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Are you free?",
    ].join("\r\n"));
    expect(await run(person, "people_only", "friend@friends.example")).toBe("INBOX");
  });
});
