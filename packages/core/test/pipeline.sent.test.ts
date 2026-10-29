import { describe, it, expect } from "vitest";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import { FakeRepo, FakeRouting, dedupKeyFor } from "./fakes.js";
import type { Change, CreditGate, PlanDeps } from "../src/ports.js";
import type { ClassifierPort, ClassifierResult } from "../src/ai/classify.js";

/**
 * ROUTING FOR MAIL THE USER WROTE — slice.
 *
 * Watching the Sent folder is one line in the adapter. What makes it safe is that almost every
 * instinct of the inbound pipeline is WRONG for outbound mail, and each one is wrong in a way
 * that MOVES mail inside the customer's real mailbox. This file is the guard for each:
 *
 *  1. it is ingested at all, and it is NOT unread;
 *  2. it never reaches the Screener, even though its sender is a stranger to `contacts`;
 *  3. it never reaches the money gate, so re-reading a Sent backlog bills nobody (the "No API cost without revenue behind it" invariant);
 *  4. sensitive outbound mail keeps its never-flags but is NOT dragged into INBOX (and its body,
 *     like every body now, is stored in full);
 *  5. it joins its conversation, in both arrival orders — the entire product point of that change;
 *  6. the Sent twin of a message we already hold writes nothing at all.
 *
 * Every one is written so that removing the `change.ownAuthored` early return in
 * `planChange` turns it red; the failure each one produces is named in its own comment.
 */

const OWNER = "mila@lichtgrat.example";

function eml(o: {
  from?: string; to?: string; subject?: string; body?: string;
  messageId: string; inReplyTo?: string; references?: string[]; date?: string;
}): Buffer {
  return Buffer.from([
    `Message-ID: <${o.messageId}>`,
    `From: ${o.from ?? OWNER}`,
    `To: ${o.to ?? "anna@example.com"}`,
    `Subject: ${o.subject ?? "the north elevation"}`,
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`] : []),
    ...(o.references ? [`References: ${o.references.map((r) => `<${r}>`).join(" ")}`] : []),
    ...(o.date ? [`Date: ${o.date}`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body ?? "Sounds good — Thursday works.",
  ].join("\r\n"));
}

function sentChange(raw: Buffer, ref = "1:10"): Change {
  return { type: "create", locator: { folder: "Sent", ref }, raw, seen: false, ownAuthored: true };
}
function inboxChange(raw: Buffer, ref = "1:20"): Change {
  return { type: "create", locator: { folder: "INBOX", ref }, raw, seen: false };
}

/** A gate that FAILS THE TEST if the pipeline ever asks it for money on this path. */
function forbiddenGate(): CreditGate & { asked: string[] } {
  const g = {
    asked: [] as string[],
    async spend(_a: string, _action: never, key: string): Promise<never> {
      g.asked.push(key);
      throw new Error(`credit gate consulted for own-authored mail (key ${key})`);
    },
  };
  return g;
}

/** A classifier that fails the test if it is ever called. */
const forbiddenClassifier: ClassifierPort = {
  async classify(): Promise<ClassifierResult> {
    throw new Error("classifier called for own-authored mail");
  },
};

function deps(repo: FakeRepo, extra: Partial<PlanDeps> = {}): PlanDeps {
  return { repo, accountId: "acct-1", mailboxId: "mb-1", ...extra };
}

async function ingest(change: Change, repo: FakeRepo, extra: Partial<PlanDeps> = {}) {
  const plan = await planChange(change, deps(repo, extra));
  return commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
    repo, accountId: "acct-1", mailboxId: "mb-1", routing: extra.routing,
  });
}

describe("own-authored mail", () => {
  it("is ingested, is NOT unread, and stays in Sent", async () => {
    const repo = new FakeRepo();
    // `senders` is deliberately EMPTY: the account holder is not in their own contacts, which is the
    // condition that sends an unknown sender to the Screener.
    const res = await ingest(sentChange(eml({ messageId: "own-1@t.example" })), repo);

    expect(res.outcome).toBe("new");
    expect(res.action).toEqual({ type: "none" });

    const stored = await repo.findByDedupKey("mb-1", await dedupKeyFor(eml({ messageId: "own-1@t.example" })));
    expect(stored).not.toBeNull();
    // NOT UNREAD. The adapter reported `seen: false` above (some clients APPEND without
    // `\Seen`); the pipeline must still store it read. Change `seen: true` to `change.seen`
    // in the early return and this reads `unread: true`.
    expect(repo.rows.get(stored!.id)!.input.unread).toBe(false);
    // Stays where the user's own client put it — organize-in-place does not file Sent.
    expect(await repo.getFolderState(stored!.id))
      .toEqual({ desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us" });
    expect(repo.changes.some((c) => c.op === "move")).toBe(false);
  });

  it("the SENT TWIN records a non-primary instance, so its locator is never re-fetched", async () => {
    // A later change amends this. `own_copy` used to write NOTHING, and the only reason it did not
    // re-fetch the Sent copy on every cycle was the Sent folder's UID WATERMARK — an accident of one
    // folder. `recordInstance` makes the declined locator KNOWN, so the property holds for any
    // folder, watermark or not; that is what lets `external_copy` decline in INBOX, which has no
    // watermark at all. Delete `recordInstance` from the `own_copy` branch in `commitChange` and the
    // second assertion here is `undefined`.
    const repo = new FakeRepo();
    const raw = eml({ messageId: "own-twin@t.example" });
    // Already held in INBOX…
    const inbox = await ingest(
      { type: "create", locator: { folder: "INBOX", ref: "1:5" }, raw }, repo,
    );
    expect(inbox.outcome).toBe("new");
    const before = await repo.getFolderState(inbox.messageId);
    // …and now observed in Sent, which is where the user's own client put its copy.
    const twin = await ingest(sentChange(raw, "1:99"), repo);
    expect(twin.outcome).toBe("own_copy");
    expect(twin.messageId).toBe(inbox.messageId);

    const recorded = [...repo.instances.values()];
    expect(recorded.filter((i) => i.isPrimary))
      .toEqual([{ messageId: inbox.messageId, folder: "INBOX", ref: "1:5", isPrimary: true }]);
    expect(recorded.find((i) => !i.isPrimary))
      .toEqual({ messageId: inbox.messageId, folder: "Sent", ref: "1:99", isPrimary: false });
    // …and nothing about placement moved, which is the property this must not disturb.
    expect(await repo.getFolderState(inbox.messageId)).toEqual(before);
    expect(repo.conflicts.has(inbox.messageId), "own_copy is not a conflict").toBe(false);
  });

  it("does NOT create a screener entry for its recipient — or for anyone", async () => {
    const repo = new FakeRepo();
    const res = await ingest(sentChange(eml({ to: "stranger@nowhere.example", messageId: "own-2@t.example" })), repo);
    const state = await repo.getFolderState(res.messageId);

    // The failure this guards: delete the `ownAuthored` early return and `evaluateRules`
    // answers `ohmail/Screener` (the FROM — the account owner — is not in `contacts`), the
    // plan's desired folder becomes the Screener, a `move` change is emitted, and the
    // reconciler MOVES the user's own sent mail out of Sent and queues the user for consent
    // in their own consent queue. Measured with the return removed:
    //   AssertionError: expected 'ohmail/Screener' to be 'Sent'
    expect(state!.desiredFolder).toBe("Sent");
    expect(state!.desiredFolder).not.toBe("ohmail/Screener");
    expect(repo.changes.filter((c) => c.op === "move")).toEqual([]);
  });

  it("never reaches the money gate, even with a classifier and routing wired", async () => {
    const repo = new FakeRepo();
    const credits = forbiddenGate();
    // THE OWNER IS IN `contacts`, deliberately, and it is what makes this guard bite.
    //
    // With the early return removed, an owner who is a STRANGER to their own contacts is
    // screened, `decision.destination` is non-null and the AI branch short-circuits before the
    // gate — so the mutation would pass and this test would prove nothing. An owner who IS a
    // known sender falls through to `unclear`, which is the AI branch's own entry condition.
    // And that is the ordinary state of a real account: the kickstart imports Sent
    // recipients into `contacts`, so anyone who has ever CC'd themselves is in there.
    repo.senders.add(OWNER);
    await ingest(sentChange(eml({ messageId: "own-3@t.example" })), repo, {
      classifier: forbiddenClassifier, routing: new FakeRouting(), credits,
    });
    expect(credits.asked).toEqual([]);
  });

  it("keeps sensitive outbound mail in Sent (body in full) — the INBOX short-circuit is inbound-only", async () => {
    const repo = new FakeRepo();
    const raw = eml({
      messageId: "own-4@t.example",
      subject: "your verification code",
      body: "Forwarding the login code you asked for: 493028. It expires in 10 minutes.",
    });
    const plan = await planChange(sentChange(raw), deps(repo));
    expect(plan.new!.sensitivity.sensitive).toBe(true);

    const res = await ingest(sentChange(raw, "1:11"), repo);
    // Body redaction at rest is removed: the stored body is the FULL text, the code included —
    // it is the user's own sent mail. (The AI gate / no_forward flag still hold; the model gate
    // still strips the code from any AI payload.)
    expect(repo.bodies.get(res.messageId)!.text).toContain("493028");
    // …but the ROUTING override does not. `sensitivity.sensitive ? "INBOX"` would lift the
    // user's own sent mail into their inbox; with the early return removed this asserts
    //   AssertionError: expected 'INBOX' to be 'Sent'
    expect((await repo.getFolderState(res.messageId))!.desiredFolder).toBe("Sent");
  });

  // ── THREADING: BOTH ARRIVAL ORDERS ─────────────────────────────────────────────────────────
  //
  // IMAP hands folders over one at a time and UID order is arrival-at-the-server order, so a
  // reply can be ingested before or after the message it answers. the anchor is supposed to
  // make both converge; this is the first change where the two halves come from DIFFERENT
  // FOLDERS on the same pass, so it is verified rather than assumed.

  const inbound = () => eml({
    from: "anna@example.com", to: OWNER, messageId: "them-1@example.com",
    subject: "Quote for the north elevation", body: "Can you confirm Thursday?",
  });
  const reply = () => eml({
    messageId: "mine-1@t.example", to: "anna@example.com",
    subject: "Re: Quote for the north elevation",
    inReplyTo: "them-1@example.com", references: ["them-1@example.com"],
  });

  it("a reply the user sent joins the thread — counterpart FIRST", async () => {
    const repo = new FakeRepo();
    const a = await ingest(inboxChange(inbound()), repo);
    const b = await ingest(sentChange(reply()), repo);
    const ta = repo.rows.get(a.messageId)!.stored.threadId;
    const tb = repo.rows.get(b.messageId)!.stored.threadId;
    expect(ta).not.toBeNull();
    expect(tb).toBe(ta);
    expect(repo.threads.size).toBe(1);
  });

  it("a reply the user sent joins the thread — REPLY first", async () => {
    const repo = new FakeRepo();
    const b = await ingest(sentChange(reply()), repo);
    const a = await ingest(inboxChange(inbound()), repo);
    const ta = repo.rows.get(a.messageId)!.stored.threadId;
    const tb = repo.rows.get(b.messageId)!.stored.threadId;
    expect(tb).not.toBeNull();
    // The reply anchors on `References[0]` = the counterpart's own id; the counterpart then
    // derives the same anchor from its OWN Message-ID and `upsertThread` finds the existing
    // row. One conversation either way round.
    expect(ta).toBe(tb);
    expect(repo.threads.size).toBe(1);
  });

  // ── DEDUP AGAINST MAIL WE ALREADY HOLD ─────────────────────────────────────────────────────

  it("a message ohmail sent, then re-ingested from Sent, is ONE row", async () => {
    const repo = new FakeRepo();
    // `SendService` mints the Message-ID up front and `ImapAdapter.send` APPENDs the same
    // bytes to Sent, so the copy that comes back carries an id we chose. There is no prior
    // `messages` row (the send path writes only `outbound_sends`/`drafts`), so the first
    // ingest is the only ingest — and the SECOND observation (a provider that also files the
    // SMTP submission alongside our APPEND) collapses on the dedup key.
    const minted = "3f2a-b19c@lichtgrat.example";
    const raw = eml({ messageId: minted });
    const first = await ingest(sentChange(raw, "1:30"), repo);
    const second = await ingest(sentChange(raw, "1:31"), repo);

    expect(second.outcome).toBe("duplicate");
    expect(second.messageId).toBe(first.messageId);
    expect(repo.rows.size).toBe(1);
    expect(repo.changes.filter((c) => c.entityType === "message" && c.op === "create")).toHaveLength(1);
  });

  it("the Sent twin of a message already in the Imbox writes NOTHING and never moves it", async () => {
    const repo = new FakeRepo();
    repo.senders.add("anna@example.com");
    // Self-CC: the identical Message-ID lands in INBOX and in Sent.
    const raw = eml({ from: "anna@example.com", to: OWNER, messageId: "cc-self@example.com" });
    const first = await ingest(inboxChange(raw), repo);
    const changesBefore = repo.changes.length;

    const second = await ingest(sentChange(raw, "1:40"), repo);

    // Remove the `own_copy` branch (in `dedup.ts` or in `commitChange`) and this reads
    // `external_move`, `desiredFolder` becomes 'Sent', a `move` delta goes out, and the
    // message disappears from the Imbox. Measured with `dedup.ts`'s branch deleted:
    //   AssertionError: expected 'external_move' to be 'own_copy'
    expect(second.outcome).toBe("own_copy");
    expect(second.messageId).toBe(first.messageId);
    expect(second.action).toEqual({ type: "none" });
    expect(repo.rows.size).toBe(1);
    // Nothing written: no locator repoint, no folder-state change, no delta.
    expect(repo.rows.get(first.messageId)!.stored.nativeLocator).toEqual({ folder: "INBOX", ref: "1:20" });
    expect(await repo.getFolderState(first.messageId))
      .toEqual({ desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
    expect(repo.changes.length).toBe(changesBefore);
  });

  it("an inbound message is unaffected — the whole file's control", async () => {
    const repo = new FakeRepo();
    const res = await ingest(inboxChange(eml({ from: "stranger@nowhere.example", to: OWNER, messageId: "in-1@x" })), repo);
    // Same message shape, no `ownAuthored`: the Screener still does its job.
    expect((await repo.getFolderState(res.messageId))!.desiredFolder).toBe("ohmail/Screener");
    expect(repo.rows.get(res.messageId)!.input.unread).toBe(true);
  });

  // ── THE PROVIDER-REWRITTEN TWIN (Exchange Online) ───────────────────────────────────────────
  //
  // The two dedup tests above collapse twins whose BYTES are identical, and on Exchange the bytes
  // are not: `smtp.office365.com` files its own copy of every SMTP submission into `Sent Items`,
  // and that copy is re-rendered by Exchange transport — new `Received:` chain, re-encoded MIME,
  // rewrapped body — beside the byte-exact copy `ImapAdapter.send` APPENDs. Different bytes ⇒ a
  // different `fp1:` fingerprint ⇒ `resolveExisting`'s two keyed lookups both miss ⇒ the twin used
  // to ingest as `new`, and a message sent through such a mailbox rode the mirror TWICE (except
  // when the provider happened not to rewrite its copy, which is why the byte-identical dedup
  // test above never caught this).
  //
  // The close is a THIRD lookup, by Message-ID alone, gated on `change.ownAuthored`. Message-ID
  // alone is exactly the forgeable key the fingerprint replaced — safe HERE and only here because
  // an `ownAuthored` create was read out of the mailbox's own Sent folder, which strangers cannot
  // write into; the inbound pin below is the other half of that sentence.

  /**
   * The Exchange-rendered copy: same logical message, DIFFERENT DECODED TEXT. The transport
   * re-wraps the body (a hard line break where the submission had a space), which is the smallest
   * real change Exchange makes — and enough: the fingerprint hashes the decoded text, so the two
   * copies stop being one `fp1:` key. The premise is asserted in the test itself, because a
   * fixture whose rewrite quietly decodes back to the original bytes would make this guard
   * decorative (an earlier draft of this file did exactly that, via a windows-1252 `=97` that
   * decoded to the same em-dash).
   */
  function rewrittenBy(provider: "exchange", o: { messageId: string; body?: string }): Buffer {
    void provider;
    return Buffer.from([
      "Received: from AS2PR03MB1.eurprd03.prod.example (2603:10a6::1) by transport",
      ` for <anna@example.com>; Tue, 11 Aug 2026 08:07:58 +0000`,
      `Message-ID: <${o.messageId}>`,
      `From: ${OWNER}`,
      "To: anna@example.com",
      "Subject: the north elevation",
      "Content-Type: text/plain; charset=utf-8",
      "",
      (o.body ?? "Sounds good — Thursday\r\nworks."),
    ].join("\r\n"));
  }

  it("the provider-rewritten Sent twin of an ohmail send is ONE row, not two", async () => {
    const repo = new FakeRepo();
    const minted = "60ce06bc-166c@lichtgrat.example";
    // The fixture's own premise: the rewrite really does change the fingerprint. If these two
    // keys are ever equal again, the twin collapses on the ordinary `fp1:` lookup and this test
    // proves nothing about the Message-ID arm.
    expect(await dedupKeyFor(rewrittenBy("exchange", { messageId: minted })))
      .not.toBe(await dedupKeyFor(eml({ messageId: minted })));
    // Our own APPEND lands first…
    const appended = await ingest(
      { type: "create", locator: { folder: "Sent Items", ref: "1:50" }, raw: eml({ messageId: minted }), seen: true, ownAuthored: true },
      repo,
    );
    expect(appended.outcome).toBe("new");
    // …and the provider's own re-rendered copy of the same submission follows.
    const twin = await ingest(
      { type: "create", locator: { folder: "Sent Items", ref: "1:51" }, raw: rewrittenBy("exchange", { messageId: minted }), seen: true, ownAuthored: true },
      repo,
    );

    // Without the ownAuthored Message-ID lookup this reads `new` — a second `messages` row and a
    // second `message`/`create` delta, which is the doubled sent-row a Microsoft account user sees.
    expect(twin.outcome).toBe("duplicate");
    expect(twin.messageId).toBe(appended.messageId);
    expect(repo.rows.size).toBe(1);
    expect(repo.changes.filter((c) => c.entityType === "message" && c.op === "create")).toHaveLength(1);
  });

  it("the rewritten Sent twin of a message already in the Imbox is its OWN row, and nothing moves", async () => {
    const repo = new FakeRepo();
    repo.senders.add("anna@example.com");
    // The self-CC's inbound copy — already re-rendered by the provider's inbound transport…
    const first = await ingest(inboxChange(rewrittenBy("exchange", { messageId: "cc-rw@t.example" })), repo);
    const before = await repo.getFolderState(first.messageId);
    // …and the byte-exact copy ohmail APPENDed to Sent, observed later. An INBOX row under the same
    // id joins only when its content agrees but for the Date; the re-rendered text does not, so the
    // two copies stay two rows — as every other client shows them.
    const twin = await ingest(sentChange(eml({ messageId: "cc-rw@t.example" }), "1:60"), repo);

    expect(twin.outcome).toBe("new");
    expect(twin.messageId).not.toBe(first.messageId);
    expect(repo.rows.size).toBe(2);
    expect(await repo.getFolderState(first.messageId)).toEqual(before);
  });

  it("a stranger's INBOX row under our Sent copy's Message-ID is never adopted: the copy is its own row", async () => {
    const repo = new FakeRepo();
    // The stranger delivers first, under the id our copy will carry, addressed to an accomplice.
    const theirs = await ingest(inboxChange(eml({
      from: "mallory@evil.example", to: `${OWNER}, accomplice@evil.example`, messageId: "ours-1@t.example",
      body: "their bytes",
    })), repo);
    const ours = await ingest({
      ...sentChange(eml({ messageId: "ours-1@t.example", to: "anna@example.com" }), "1:61"),
      internalDate: new Date("2026-09-22T15:12:00.000Z"),
    }, repo);
    expect(ours.outcome).toBe("new");
    expect(ours.messageId).not.toBe(theirs.messageId);
    // The stranger's row was given no Sent instance, so it is nobody's own writing…
    expect([...repo.instances.values()].filter((i) => i.messageId === theirs.messageId).map((i) => i.folder))
      .toEqual(["INBOX"]);
    // …and the reply arm reads OUR copy's recipients: Anna was written to, the accomplice was not.
    expect(await repo.isCorrespondent("acct-1", "anna@example.com", ["ours-1@t.example"])).toMatchObject({ via: "replied", named: true });
    expect(await repo.isCorrespondent("acct-1", "accomplice@evil.example", ["ours-1@t.example"])).toMatchObject({ named: false });
  });

  it("an INBOUND create naming a stored Message-ID with different bytes stays its own row — the forgery pin", async () => {
    const repo = new FakeRepo();
    const held = await ingest(inboxChange(eml({ from: "anna@example.com", to: OWNER, messageId: "forge-me@x" })), repo);
    // A stranger who names an id the account holds must NOT collapse onto that row: no
    // `ownAuthored`, so the Message-ID lookup may not run. Widen its gate and this reads
    // `external_copy`/`duplicate` instead of `new` — the adoption surface the fingerprint closed.
    const forged = await ingest(
      { type: "create", locator: { folder: "INBOX", ref: "1:70" }, raw: eml({ from: "mallory@evil.example", to: OWNER, messageId: "forge-me@x", body: "entirely different bytes" }) },
      repo,
    );
    expect(forged.outcome).toBe("new");
    expect(forged.messageId).not.toBe(held.messageId);
    expect(repo.rows.size).toBe(2);
  });

  /* ONE LETTER TO YOURSELF, ITS TWO COPIES DATED APART: a send that compiled the delivered copy and
     the Sent copy seconds apart left only the Date line different, and the fingerprint with it. */
  const DELIVERED_AT = "Thu, 29 Oct 2026 18:54:31 +0000";
  const FILED_AT = "Thu, 29 Oct 2026 18:54:38 +0000";
  const toMyself = (date: string, o: { body?: string; to?: string } = {}) =>
    eml({ messageId: "self-reply@lichtgrat.example", to: o.to ?? OWNER, date, ...(o.body ? { body: o.body } : {}) });
  const own = { ownAddresses: new Set([OWNER]) };

  for (const sentFirst of [true, false]) {
    const order = sentFirst ? "Sent copy first" : "INBOX copy first";
    it(`a letter to yourself whose copies are dated apart is ONE row — ${order}`, async () => {
      const repo = new FakeRepo();
      const sent = sentChange(toMyself(FILED_AT), "1:80");
      const inbox = inboxChange(toMyself(DELIVERED_AT), "1:81");
      expect(await dedupKeyFor(sent.raw!), "the premise: two fingerprints").not.toBe(await dedupKeyFor(inbox.raw!));
      const first = await ingest(sentFirst ? sent : inbox, repo, own);
      const second = await ingest(sentFirst ? inbox : sent, repo, own);
      expect(second.outcome).toBe(sentFirst ? "received_copy" : "own_copy");
      expect(second.messageId).toBe(first.messageId);
      expect(repo.rows.size).toBe(1);
    });

    it(`the same Message-ID dated apart with another text or another To stays two rows — ${order}`, async () => {
      for (const other of [{ body: "a different letter" }, { to: "anna@example.com" }]) {
        const repo = new FakeRepo();
        const sent = sentChange(toMyself(FILED_AT), "1:82");
        const inbox = inboxChange(toMyself(DELIVERED_AT, other), "1:83");
        const first = await ingest(sentFirst ? sent : inbox, repo, own);
        const second = await ingest(sentFirst ? inbox : sent, repo, own);
        expect(second.outcome, JSON.stringify(other)).toBe("new");
        expect(second.messageId).not.toBe(first.messageId);
        expect(repo.rows.size).toBe(2);
      }
    });
  }

  it("two INBOX copies of one letter dated apart stay two rows: no Sent copy vouches for either", async () => {
    const repo = new FakeRepo();
    const first = await ingest(inboxChange(toMyself(DELIVERED_AT), "1:84"), repo, own);
    const second = await ingest(inboxChange(toMyself(FILED_AT), "1:85"), repo, own);
    expect(second.outcome).toBe("new");
    expect(second.messageId).not.toBe(first.messageId);
    expect(repo.rows.size).toBe(2);
  });
});
