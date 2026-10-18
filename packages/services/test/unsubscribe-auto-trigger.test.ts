import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  accountSettings, messageBodies, unsubscribeRecords, folderState, mailboxes,
} from "@trafficflow/db";
import {
  makeUnsubscribeService, unsubscribeListKey, ServiceError,
  type HostResolver, type OneClickPost,
} from "../src/index.js";
import { makeCtx, personScreenedOut, seedMessage } from "./helpers.js";

/**
 * THE AUTOMATIC TRIGGER, THE RECORD TABLE AND THE IDEMPOTENCY KEY (mail 0032).
 *
 * **NO REAL SENDER IS EVER CONTACTED BY THIS FILE.** Every test injects a recording
 * {@link OneClickPost} that opens no socket, or `FORBIDDEN_POST`, which fails the test at the
 * call site if it is reached. The production port is exercised against a loopback listener in
 * `unsubscribe-service.test.ts` and nowhere else.
 *
 * This file is the half `unsubscribe-service.test.ts` does not cover: the service used to be a
 * button, and a button that is pressed once needs no record. Firing it automatically on a
 * screen-out makes it repeatable — by a retry, a re-screen, a second worker — and every claim
 * here is about the thing that stops a repeat becoming a second request to a stranger.
 *
 * The CONCURRENCY half of that claim is deliberately NOT here. PGlite is single-connection and
 * serializes everything, so a missing unique index behaves exactly like a present one and two
 * "concurrent" claims are just two sequential ones. It lives in
 * `unsubscribe-idempotency.pg.test.ts`, against a real pool.
 */

function spyPost(status = 200): OneClickPost & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async post(url: string) { calls.push(url); return { status }; } };
}

const FORBIDDEN_POST: OneClickPost = {
  async post(url: string) {
    throw new Error(`the unsubscribe port was called, and it must not have been: ${url}`);
  },
};

const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
const NOBODY: ReadonlySet<string> = new Set<string>();
/**
 * The position a Gmail-held mailbox trusts (`providerAuthservIds`), and that provider confirming a
 * letter's sender. The automatic arm asks a list only for a confirmed sender, so `seed` writes the
 * confirmation unless a case states its own; the identity gate's cases below vary it.
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);
const CONFIRMED = { "authentication-results": ["mx.google.com; dmarc=pass"] };

const ONE_CLICK = {
  "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
};
/** The same LIST, a different message: a fresh per-message token and a different From. */
const ONE_CLICK_OTHER_TOKEN = {
  "list-unsubscribe": ["<https://sender.example/u?t=zzz-a-completely-different-token>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
};
/**
 * The HOSTILE shape, not the merely-old one: a sender who publishes `mailto:` AND advertises RFC
 * 8058 one-click. Without the post header the parser refuses on the missing header and the
 * `mailto:` rule is never reached, so the guard would be asserting the wrong thing.
 */
const MAILTO_ONLY = {
  "list-unsubscribe": ["<mailto:leave@sender.example>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
};
/** An https route, but the sender never advertised RFC 8058. */
const NO_POST_HEADER = { "list-unsubscribe": ["<https://sender.example/u?t=abc>"] };

const svcWith = (post: OneClickPost) =>
  makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });

type Db = Awaited<ReturnType<typeof makeCtx>>["db"];

async function seed(
  db: Db, accountId: string, mailboxId: string,
  headers: Record<string, string[]>,
  opts: { from?: string; desired?: string } = {},
): Promise<string> {
  const from = opts.from ?? "news@sender.example";
  const folder = opts.desired ?? "ohmail/Screened";
  const messageId = await seedMessage(db, accountId, mailboxId, { from, folder });
  await db.insert(messageBodies).values({ messageId, text: "", headers: { ...CONFIRMED, ...headers } });
  // A person screened the sender out — the only licence the automatic arm acts on (UD-R4-03).
  if (folder === "ohmail/Screened" || folder === "ohmail/Quarantine") {
    await personScreenedOut(db, accountId, from, { destination: folder });
  }
  return messageId;
}

const recordsOf = async (db: Db, accountId: string) =>
  db.select().from(unsubscribeRecords).where(eq(unsubscribeRecords.accountId, accountId));

// ─────────────────────────────────────────────────────────────────────────────────────────
// GUARD 1 — the four "do nothing" cases the report named, driven through the AUTOMATIC path
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("onScreenOut — absent evidence never selects the acting branch", () => {
  it("GUARD 1: a mailto:-only sender produces NO request and NO record row", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, MAILTO_ONLY);

    const sweep = await svcWith(FORBIDDEN_POST).onScreenOut(ctx, [id]);

    expect(sweep).toEqual({ considered: 1, posted: 0, skipped: 1, failed: 0, remaining: 0 });
    // NO ROW, not a `refused` row. A refused row would poison the (mailbox, list) key, so a
    // later message from the same list that DOES publish one-click could never be acted on.
    expect(await recordsOf(db, accountId)).toHaveLength(0);
  });

  it("GUARD 2: no List-Unsubscribe-Post produces NO request and NO record row", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, NO_POST_HEADER);

    const sweep = await svcWith(FORBIDDEN_POST).onScreenOut(ctx, [id]);

    expect(sweep).toEqual({ considered: 1, posted: 0, skipped: 1, failed: 0, remaining: 0 });
    expect(await recordsOf(db, accountId)).toHaveLength(0);
  });

  it("GUARD 3: a message routed to ohmail/News produces NO request — it is a KEEP destination", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, ONE_CLICK, { desired: "ohmail/News" });

    const sweep = await svcWith(FORBIDDEN_POST).onScreenOut(ctx, [id]);

    expect(sweep).toEqual({ considered: 1, posted: 0, skipped: 1, failed: 0, remaining: 0 });
    expect(await recordsOf(db, accountId)).toHaveLength(0);
  });

  it("GUARD 3b: ohmail/Receipts likewise — a receipt is for a purchase already made", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, ONE_CLICK, { desired: "ohmail/Receipts" });

    expect(await svcWith(FORBIDDEN_POST).onScreenOut(ctx, [id]))
      .toEqual({ considered: 1, posted: 0, skipped: 1, failed: 0, remaining: 0 });
    expect(await recordsOf(db, accountId)).toHaveLength(0);
  });

  it("a message still in the Screener produces NO request — the user has not decided", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, ONE_CLICK, { desired: "ohmail/Screener" });

    expect(await svcWith(FORBIDDEN_POST).onScreenOut(ctx, [id]))
      .toEqual({ considered: 1, posted: 0, skipped: 1, failed: 0, remaining: 0 });
    expect(await recordsOf(db, accountId)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// GUARD 4 — the record table is the point: a second trigger sends nothing
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("onScreenOut — at most one request per (mailbox, list)", () => {
  it("GUARD 4: a second identical trigger produces NO second request", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, ONE_CLICK);
    const post = spyPost();
    const svc = svcWith(post);

    await svc.onScreenOut(ctx, [id]);
    const second = await svc.onScreenOut(ctx, [id]);

    expect(post.calls).toHaveLength(1);
    expect(second).toEqual({ considered: 1, posted: 0, skipped: 1, failed: 0, remaining: 0 });
    const rows = await recordsOf(db, accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("sent");
    expect(rows[0]!.httpStatus).toBe(200);
  });

  it("a DIFFERENT message from the SAME list sends nothing — the key is the list, not the message", async () => {
    // The defect this is the guard for: a one-click URL carries a per-message token, so keying
    // the record on the URL (or on the message) would send once per message and the record table
    // would be decoration. Two messages, two different tokens, two different From addresses,
    // one `List-ID` — one request.
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const listed = (h: Record<string, string[]>) => ({ ...h, "list-id": ["Weekly <news.sender.example>"] });
    const first = await seed(db, accountId, mailboxId, listed(ONE_CLICK), { from: "a-1@sender.example" });
    const second = await seed(db, accountId, mailboxId, listed(ONE_CLICK_OTHER_TOKEN), { from: "a-2@sender.example" });
    const post = spyPost();

    const sweep = await svcWith(post).onScreenOut(ctx, [first, second]);

    expect(post.calls).toHaveLength(1);
    expect(sweep).toEqual({ considered: 2, posted: 1, skipped: 1, failed: 0, remaining: 0 });
    expect(await recordsOf(db, accountId)).toHaveLength(1);
  });

  it("the SAME list in a DIFFERENT mailbox is a different subscription, and is sent", async () => {
    // Two mailboxes on one account subscribed to the same newsletter are two subscriptions at
    // the sender, with two different tokens. Collapsing them would leave the second mailbox
    // subscribed while the record claimed otherwise.
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const [second] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: "second@lichtgrat.example" }).returning();
    const listed = { ...ONE_CLICK, "list-id": ["<news.sender.example>"] };
    const a = await seed(db, accountId, mailboxId, listed);
    const b = await seed(db, accountId, second!.id, listed);
    const post = spyPost();

    const sweep = await svcWith(post).onScreenOut(ctx, [a, b]);

    expect(post.calls).toHaveLength(2);
    expect(sweep).toEqual({ considered: 2, posted: 2, skipped: 0, failed: 0, remaining: 0 });
    expect(await recordsOf(db, accountId)).toHaveLength(2);
  });

  it("THE ACCEPTED RESIDUAL, END TO END: a discussion-list shape sends once PER DOMAIN, not once per message and not zero times", async () => {
    // The behavioural half of `unsubscribeListKey`'s "one List-ID, two poster domains" test.
    // Three messages, one mailbox, one List-ID, TWO author domains (one of them posting twice):
    // the bound this residual accepts is "one send per domain seen", proven from both directions
    // in one pass — not unbounded (the domain-doubled message must NOT send again) and not
    // silently dropped to one (the second domain must still get its own send).
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const listed = { ...ONE_CLICK, "list-id": ["<discuss.list.example>"] };
    const aliceFirst = await seed(db, accountId, mailboxId, listed, { from: "alice@a.example" });
    const aliceAgain = await seed(db, accountId, mailboxId,
      { ...listed, "list-unsubscribe": ["<https://sender.example/u?t=alice-2>"] },
      { from: "alice-again@a.example" });
    const bob = await seed(db, accountId, mailboxId,
      { ...listed, "list-unsubscribe": ["<https://sender.example/u?t=bob>"] },
      { from: "bob@b.example" });
    const post = spyPost();

    const sweep = await svcWith(post).onScreenOut(ctx, [aliceFirst, aliceAgain, bob]);

    // TWO sends — one per domain — never three (unbounded) and never one (the vulnerability
    // this key exists to close, reintroduced by collapsing across domains).
    expect(post.calls).toHaveLength(2);
    expect(sweep).toEqual({ considered: 3, posted: 2, skipped: 1, failed: 0, remaining: 0 });
    const rows = await recordsOf(db, accountId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.listKey).sort()).toEqual([
      "list:a.example|discuss.list.example",
      "list:b.example|discuss.list.example",
    ]);
  });

  it("the explicit per-message route honours the record too — the button cannot bypass it", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, ONE_CLICK);
    const post = spyPost();
    const svc = svcWith(post);

    expect((await svc.unsubscribe(ctx, id)).posted).toBe(true);
    const repeat = await svc.unsubscribe(ctx, id);

    expect(repeat.posted).toBe(false);
    expect(repeat.refusal).toBe("already_recorded");
    expect(post.calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The key itself
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("unsubscribeListKey — the idempotency key", () => {
  it("prefers the RFC 2919 List-ID identifier, and ignores the friendly phrase around it", () => {
    // The phrase is the sender's to change at will; keying on it would make a renamed list a
    // new list, and one rename would buy the sender a second request.
    expect(unsubscribeListKey({ "list-id": ["Weekly News <news.sender.example>"] }, "a@x.test"))
      .toBe("list:x.test|news.sender.example");
    expect(unsubscribeListKey({ "list-id": ["Totally Rebranded <news.sender.example>"] }, "b@x.test"))
      .toBe("list:x.test|news.sender.example");
  });

  it("falls back to the lowercased From when the sender publishes no List-ID", () => {
    expect(unsubscribeListKey({}, "News@Sender.Example")).toBe("addr:news@sender.example");
  });

  it("keeps a List-ID of exactly 255 octets and treats a longer one as absent", () => {
    // RFC 2919's ceiling; the longer key met the unique index's btree limit and failed the claim.
    const at = "a".repeat(255);
    expect(unsubscribeListKey({ "list-id": [`<${at}>`] }, "a@x.test")).toBe(`list:x.test|${at}`);
    expect(unsubscribeListKey({ "list-id": [`<${at}b>`] }, "a@x.test")).toBe("addr:a@x.test");
  });

  it("namespaces the two, so a forged List-ID cannot claim another sender's From key", () => {
    expect(unsubscribeListKey({ "list-id": ["<news@sender.example>"] }, "x@y.test"))
      .not.toBe(unsubscribeListKey({}, "news@sender.example"));
  });

  // ── THE IDENTITY BINDING ────────────────────────────────────────────────────────────────
  //
  // `List-ID` is a header the SENDER writes, so keyed on it alone the at-most-once key was a
  // string the sender chose. These assert the property that replaced that: a `list:` claim can
  // only ever name a slot inside the domain the message claims to come from.

  it("a `list:` claim is namespaced by the CLAIMED AUTHOR'S DOMAIN, not by the header alone", () => {
    // The whole attack, as one line: the attacker's own legitimately-owned domain carrying the
    // victim list's `List-ID` must not produce the key the victim list produces.
    const attacker = unsubscribeListKey(
      { "list-id": ["<news.victim.example>"] }, "hello@evil.example");
    const victim = unsubscribeListKey(
      { "list-id": ["<news.victim.example>"] }, "news@news.victim.example");
    expect(attacker).not.toBe(victim);
    expect(attacker).toBe("list:evil.example|news.victim.example");
    expect(victim).toBe("list:news.victim.example|news.victim.example");
  });

  it("still collapses several per-send addresses in ONE domain onto one key", () => {
    // The property the `List-ID` was chosen for, and the reason the namespace is the DOMAIN
    // rather than the full address: a real newsletter arrives from `bounce-<opaque>@sender`, a
    // fresh address every send. Namespacing by address would send once per message.
    const key = (from: string) => unsubscribeListKey({ "list-id": ["<news.sender.example>"] }, from);
    expect(key("bounce-1@sender.example")).toBe(key("bounce-2@sender.example"));
  });

  it("two lists from ONE domain are still two keys — the namespace does not over-collapse", () => {
    const key = (listId: string) =>
      unsubscribeListKey({ "list-id": [`<${listId}>`] }, "news@sender.example");
    expect(key("offers.sender.example")).not.toBe(key("weekly.sender.example"));
  });

  it("the separator is escaped, so the two halves cannot be re-split into another pair", () => {
    // `|` is legal `atext` in a domain and in a sender-authored `List-ID`, so an unescaped join
    // is a second route to somebody else's slot: `d|l` for `d="victim.example|news"`, `l="x"`
    // would otherwise be byte-identical to `d="victim.example"`, `l="news|x"`.
    const key = (from: string, listId: string) =>
      unsubscribeListKey({ "list-id": [`<${listId}>`] }, from);
    expect(key("a@victim.example|news", "x")).not.toBe(key("a@victim.example", "news|x"));
    // …and the escape itself is not forgeable, which is why `%` is escaped before `|`.
    expect(key("a@victim.example%7cnews", "x")).not.toBe(key("a@victim.example", "news|x"));
  });

  it("a From with no domain at all drops the sender-chosen List-ID rather than trusting it", () => {
    // No `@` means no namespace to put a `list:` claim in. Falling back to `addr:` is the
    // conservative direction: the claim is scoped to the exact string the sender presented.
    expect(unsubscribeListKey({ "list-id": ["<news.victim.example>"] }, "not-an-address"))
      .toBe("addr:not-an-address");
  });

  it("THE ACCEPTED RESIDUAL: one List-ID, two poster domains, is two keys — not a security hole", () => {
    // A discussion list that preserves each poster's own From no longer collapses to one claim.
    // This is FOUND, NAMED and ACCEPTED in the function's own docblock rather than fixed, because
    // the only way to collapse it is a rule an attacker could use identically to reach a
    // domain that is not theirs — which is the whole vulnerability this key exists to close.
    const key = (from: string) => unsubscribeListKey({ "list-id": ["<discuss.list.example>"] }, from);
    expect(key("alice@a.example")).not.toBe(key("bob@b.example"));
    // Still collapses WITHIN a domain: the SAME domain posting twice is one key. This is the
    // only bound this key gives — "at most one claim per domain actually seen" — and it is NOT
    // a bound on the total, which the next test measures at its worst case.
    expect(key("alice@a.example")).toBe(key("alice-again@a.example"));
  });

  it("THE WORST CASE, MEASURED RATHER THAN ASSUMED: every poster on a distinct domain gives NO deduplication at all", () => {
    // Found by review (codex round on the residual note): the prior version of this
    // file asserted the mixed-domain case and called the trade-off "bounded" without ever
    // measuring the fully adversarial shape — a discussion list whose every poster happens to
    // use a domain nobody else on the list shares. Here, `unsubscribeListKey` gives up its whole
    // purpose: N messages derive N distinct keys, which is exactly the per-message granularity
    // the function exists to avoid. Stated plainly rather than implied: this key provides ZERO
    // deduplication for this shape, and the residual note no longer claims otherwise.
    const posters = ["alice@a.example", "bob@b.example", "carol@c.example", "dave@d.example"];
    const keys = posters.map((from) => unsubscribeListKey({ "list-id": ["<discuss.list.example>"] }, from));
    expect(new Set(keys).size).toBe(posters.length);
  });

  it("ignores a trailing dot on the List-ID identifier — a root-labelled name is the same list", () => {
    expect(unsubscribeListKey({ "list-id": ["<news.sender.example.>"] }, "a@sender.example"))
      .toBe(unsubscribeListKey({ "list-id": ["<news.sender.example>"] }, "a@sender.example"));
  });

  it("ignores a List-ID inherited from Object.prototype — jsonb through JSON.parse", () => {
    // Residue `message_bodies.headers` inherits from `Object.prototype`, so a bare index
    // answers for `constructor` and friends. `hasOwnProperty` is what stops that.
    expect(unsubscribeListKey({}, "real@sender.example")).toBe("addr:real@sender.example");
    expect(unsubscribeListKey({ "list-id": [] }, "real@sender.example")).toBe("addr:real@sender.example");
    expect(unsubscribeListKey({ "list-id": [""] }, "real@sender.example")).toBe("addr:real@sender.example");
    expect(unsubscribeListKey({ "list-id": [42] as unknown as string[] }, "real@sender.example"))
      .toBe("addr:real@sender.example");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The identity gate on the AUTOMATIC path — the other half of the key's binding
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * `unsubscribeListKey` namespaces a `list:` claim under the CLAIMED author domain, which closes
 * the attack that needs no forgery. The residual it cannot close is a FORGED `From`, and this is
 * that residual's other half: the automatic pass wants an author the mailbox's provider confirmed.
 *
 * Any verdict but `pass` refuses, `unavailable` included: at a provider no authserv-id is known for,
 * `authVerdictFromHeaders` answers `unavailable` for every message, and an automatic request there
 * would be made for whoever wrote the `From`. The refusal sits before the claim, and the person's
 * button is not gated.
 *
 * ── HOW TO SEE EACH ONE FAIL ──────────────────────────────────────────────────────────────
 *
 *  · Delete the `mode === "automatic" && authVerdict !== "pass"` refusal → cases 1 and 4 post.
 *  · Change `run(ctx, id, "automatic")` in `onScreenOut` to `"manual"` → cases 1 and 4 post.
 *  · Change `unsubscribe()` to pass `"automatic"` → cases 3 and 4 stop posting, which is a button
 *    disabled by a rule about a pass nobody watches.
 */
describe("onScreenOut — the automatic pass wants an author its provider vouches for", () => {
  /** One provider we trust to report, as `providerAuthservIds` would resolve for Gmail. */
  const TRUSTED: ReadonlySet<string> = new Set(["mx.google.com"]);
  const svcTrusting = (post: OneClickPost) =>
    makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => TRUSTED });

  /** The trusted provider vouching for the claimed author. DMARC is aligned by definition. */
  const AR_PASS = {
    ...ONE_CLICK,
    "authentication-results": ["mx.google.com; spf=pass; dkim=pass header.d=sender.example; dmarc=pass"],
  };
  /** The trusted provider reporting, and saying nothing about who sent it. */
  const AR_INCONCLUSIVE = {
    ...ONE_CLICK,
    "authentication-results": ["mx.google.com; spf=none; dkim=none; dmarc=none"],
  };

  it("1. REFUSES when the provider reports and does not vouch — and consumes no claim", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, AR_INCONCLUSIVE);

    // `FORBIDDEN_POST` throws at the call site, so a gate that did not run fails loudly.
    const sweep = await svcTrusting(FORBIDDEN_POST).onScreenOut(ctx, [id]);

    expect(sweep).toEqual({ considered: 1, posted: 0, skipped: 1, failed: 0, remaining: 0 });
    // NO ROW. The refusal sits before the claim, so a later message from the same list that DOES
    // authenticate can still be acted on — a `refused` row here would turn an unverified message
    // into a permanent silence, which is the very defect the key binding just closed.
    expect(await recordsOf(db, accountId)).toHaveLength(0);
  });

  it("2. ACTS when the provider vouches for the claimed author", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, AR_PASS);
    const post = spyPost();

    expect(await svcTrusting(post).onScreenOut(ctx, [id]))
      .toEqual({ considered: 1, posted: 1, skipped: 0, failed: 0, remaining: 0 });
    expect(post.calls).toHaveLength(1);
    expect(await recordsOf(db, accountId)).toHaveLength(1);
  });

  it("3. the MANUAL button is NOT gated — a person is looking at the message", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, AR_INCONCLUSIVE);
    const post = spyPost();

    const result = await svcTrusting(post).unsubscribe(ctx, id);

    expect(result.posted).toBe(true);
    expect(result.refusal).toBeNull();
    expect(post.calls).toHaveLength(1);
  });

  it("4. a provider nobody is known for confirms nothing: the pass sends nothing, the button still posts", async () => {
    // Every mailbox outside the provider map: every verdict is `unavailable`, and a header claiming
    // `pass` is one any sender can write — from a position nobody trusts it says nothing. No record
    // is written, so the person's own press on the same letter is a first request.
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, AR_PASS);
    const untrusted = (post: OneClickPost) =>
      makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });

    expect(await untrusted(FORBIDDEN_POST).onScreenOut(ctx, [id]))
      .toEqual({ considered: 1, posted: 0, skipped: 1, failed: 0, remaining: 0 });
    expect(await recordsOf(db, accountId)).toHaveLength(0);

    const post = spyPost();
    expect((await untrusted(post).unsubscribe(ctx, id)).posted).toBe(true);
    expect(post.calls).toHaveLength(1);
  });

  it("names the refusal, so the reason is legible and not folded into `skipped` alone", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, AR_INCONCLUSIVE);

    // Driven through the private automatic path's only public door, then re-checked at the seam:
    // the refusal CODE is what an operator reads, and `unsubscribe_already_recorded` vs
    // `unsubscribe_sender_identity_unverified` are very different stories about one silent list.
    await expect(
      makeUnsubscribeService({
        post: FORBIDDEN_POST, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => TRUSTED,
      }).sweepScreenedOut(ctx, { since: new Date("2026-01-01T00:00:00Z"), limit: 10 }),
    ).resolves.toEqual({ considered: 1, posted: 0, skipped: 1, failed: 0, remaining: 0 });
    expect(await recordsOf(db, accountId)).toHaveLength(0);
    expect(id).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// A failed unsubscribe must not block the screen-out
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("onScreenOut — a courtesy on top, never a gate", () => {
  it("a sender whose server explodes does not throw at the caller", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, ONE_CLICK);
    const exploding: OneClickPost = {
      async post() { throw new Error("ECONNRESET from a stranger's web server"); },
    };

    // The screen-out's caller sees a count, not an exception. This is the response-level half;
    // the durable half is that `onScreenOut` is called after the screen-out tx has committed.
    const sweep = await svcWith(exploding).onScreenOut(ctx, [id]);

    expect(sweep).toEqual({ considered: 1, posted: 0, skipped: 0, failed: 1, remaining: 0 });
    const rows = await recordsOf(db, accountId);
    expect(rows).toHaveLength(1);
    // `failed`, not `refused`: we tried and cannot tell whether it arrived. Either way it is
    // never retried — at-most-once resolves the ambiguity toward not sending again.
    expect(rows[0]!.state).toBe("failed");
  });

  it("one bad message does not stop the rest of the batch", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const bad = await seed(db, accountId, mailboxId, MAILTO_ONLY, { from: "mailto@sender.example" });
    const good = await seed(db, accountId, mailboxId, ONE_CLICK, { from: "ok@other.example" });
    const post = spyPost();

    const sweep = await svcWith(post).onScreenOut(ctx, [bad, good]);

    expect(sweep).toEqual({ considered: 2, posted: 1, skipped: 1, failed: 0, remaining: 0 });
    expect(post.calls).toHaveLength(1);
  });

  it("an SSRF-refused URL consumes the claim and sends nothing", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, ONE_CLICK);
    const insideDns: HostResolver = { async resolve() { return ["169.254.169.254"]; } };
    const post = spyPost();

    const sweep = await makeUnsubscribeService({ post, resolver: insideDns, trustedAuthservIdsFor: async () => GMAIL })
      .onScreenOut(ctx, [id]);

    expect(post.calls).toHaveLength(0);
    expect(sweep.posted).toBe(0);
    const rows = await recordsOf(db, accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("refused");
    expect(rows[0]!.refusal).toBe("ssrf_gate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The drain, and the backlog it refuses to sweep by accident
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("sweepScreenedOut — the drain will not touch the backlog by default", () => {
  it("refuses to run without an explicit cutoff", async () => {
    const { ctx } = await makeCtx();
    const svc = svcWith(FORBIDDEN_POST);

    await expect(svc.sweepScreenedOut(ctx, { since: new Date(NaN), limit: 10 }))
      .rejects.toBeInstanceOf(ServiceError);
    await expect(svc.sweepScreenedOut(ctx, { since: new Date(), limit: 0 }))
      .rejects.toBeInstanceOf(ServiceError);
  });

  it("only considers screen-outs after the cutoff — the pre-existing backlog is untouched", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const old = await seed(db, accountId, mailboxId, ONE_CLICK, { from: "old@sender.example" });
    await db.update(folderState).set({ updatedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(folderState.messageId, old));
    const fresh = await seed(db, accountId, mailboxId, ONE_CLICK, { from: "fresh@sender.example" });
    const post = spyPost();

    const sweep = await svcWith(post).sweepScreenedOut(ctx, {
      since: new Date("2026-01-01T00:00:00Z"), limit: 100,
    });

    expect(post.calls).toHaveLength(1);
    expect(sweep.considered).toBe(1);
    // The old one is still sitting there, unconsidered and unrecorded, exactly as intended.
    const rows = await recordsOf(db, accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messageId).toBe(fresh);
  });

  it("finds a screen-out nobody enqueued — the STATE is the queue", async () => {
    // Nothing called `onScreenOut` for this message; it is simply sitting in a reject
    // destination. That is what makes every reject path covered, including ones added later.
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await seed(db, accountId, mailboxId, ONE_CLICK, { desired: "ohmail/Quarantine" });
    const post = spyPost();

    const sweep = await svcWith(post).sweepScreenedOut(ctx, {
      since: new Date("2026-01-01T00:00:00Z"), limit: 100,
    });

    expect(sweep).toEqual({ considered: 1, posted: 1, skipped: 0, failed: 0, remaining: 0 });
    expect(post.calls).toHaveLength(1);
  });

  it("never considers a KEEP destination, however many are sitting there", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    for (const desired of ["INBOX", "ohmail/News", "ohmail/Receipts", "ohmail/Screener"]) {
      await seed(db, accountId, mailboxId, ONE_CLICK, { desired, from: `${desired}@x.test` });
    }

    const sweep = await svcWith(FORBIDDEN_POST).sweepScreenedOut(ctx, {
      since: new Date("2026-01-01T00:00:00Z"), limit: 100,
    });

    expect(sweep).toEqual({ considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0 });
  });

  it("honours the limit — the blast radius is what the caller typed", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    for (let i = 0; i < 5; i += 1) {
      await seed(db, accountId, mailboxId, ONE_CLICK, { from: `s${i}@sender.example` });
    }
    const post = spyPost();

    const sweep = await svcWith(post).sweepScreenedOut(ctx, {
      since: new Date("2026-01-01T00:00:00Z"), limit: 2,
    });

    expect(sweep.considered).toBe(2);
    expect(post.calls).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The account switch (mail 0054) — read at the seam, not at the surface
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * `account_settings.block_auto_unsubscribe_at` is the one row that decides whether the automatic
 * pass runs at all, and these are the guards for it.
 *
 * They are written against the SERVICE and not against the settings route deliberately. A switch
 * that is only honoured by the interface is a suggestion: a stale tab, a client too old to know
 * about the column and a script calling `POST /screener/:id` directly all reach the same
 * `onScreenOut`, and it is that function that has to refuse. So every assertion below drives the
 * seam and reads the record table, which is the only durable evidence a request was made.
 *
 * ── HOW TO SEE EACH ONE FAIL ──────────────────────────────────────────────────────────────
 *
 *  · Delete `if (await this.blocked(ctx)) return sweep;` from `onScreenOut` → the OFF cases post
 *    and write a record row.
 *  · Make `blocked()` answer `row?.at === null` instead of `!= null` → the DEFAULT cases stop
 *    posting, which is the reversed-sense mistake that would silently retire a shipping feature
 *    for every account that has never opened Settings.
 *  · Move the guard into `unsubscribe()` → the manual-button case stops posting, which is a
 *    control disabled by a switch that does not name it.
 */
describe("onScreenOut — the account switch decides, and the default is ON", () => {
  /** Stamp the opt-out. The column `setBlockAutoUnsubscribe` writes, without the route. */
  const turnOff = async (db: Db, accountId: string) => {
    await db.insert(accountSettings)
      .values({ accountId, blockAutoUnsubscribeAt: new Date("2026-08-10T00:00:00Z") });
  };

  it("DEFAULT: no settings row at all — a screen-out still unsubscribes", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seed(db, accountId, mailboxId, ONE_CLICK);
    const post = spyPost();

    const sweep = await svcWith(post).onScreenOut(ctx, [id]);

    // The behaviour this slice must not change. Most accounts have never written an
    // `account_settings` row — it is created lazily by whichever feature writes first — so if an
    // absent row read as "off", the switch would have retired the feature for nearly everybody.
    expect(sweep).toEqual({ considered: 1, posted: 1, skipped: 0, failed: 0, remaining: 0 });
    expect(post.calls).toHaveLength(1);
    expect(await recordsOf(db, accountId)).toHaveLength(1);
  });

  it("DEFAULT: a settings row that exists but has NULL in the column — still unsubscribes", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    // A row written by some OTHER preference. The column is the switch; the row is not.
    await db.insert(accountSettings).values({ accountId, dormancyDays: 30 });
    const id = await seed(db, accountId, mailboxId, ONE_CLICK);
    const post = spyPost();

    expect(await svcWith(post).onScreenOut(ctx, [id]))
      .toEqual({ considered: 1, posted: 1, skipped: 0, failed: 0, remaining: 0 });
    expect(post.calls).toHaveLength(1);
  });

  it("OFF: the port is never called, and NO record row is written", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await turnOff(db, accountId);
    const id = await seed(db, accountId, mailboxId, ONE_CLICK);

    // `FORBIDDEN_POST` throws at the call site, so this fails loudly rather than by a count.
    const sweep = await svcWith(FORBIDDEN_POST).onScreenOut(ctx, [id]);

    expect(sweep).toEqual({ considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0 });
    // NO ROW is the load-bearing half. A `refused` row would consume the (mailbox, list) claim,
    // so turning the switch back ON would leave this list permanently unreachable — a reversible
    // preference with an irreversible side effect.
    expect(await recordsOf(db, accountId)).toHaveLength(0);
  });

  it("OFF: `considered` is 0, not the length of the batch", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await turnOff(db, accountId);
    const ids = [
      await seed(db, accountId, mailboxId, ONE_CLICK, { from: "a@sender.example" }),
      await seed(db, accountId, mailboxId, ONE_CLICK, { from: "b@sender.example" }),
    ];

    // Not cosmetic. `skipped` is where a healthy pass over real mail puts the senders who publish
    // no one-click route, so folding an opt-out into it would make "this account turned it off"
    // and "these senders offer nothing" the same number in the same field.
    expect(await svcWith(FORBIDDEN_POST).onScreenOut(ctx, ids))
      .toEqual({ considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0 });
  });

  it("OFF: the DRAIN is gated too, because it runs through the same entry point", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await turnOff(db, accountId);
    await seed(db, accountId, mailboxId, ONE_CLICK);

    const sweep = await svcWith(FORBIDDEN_POST).sweepScreenedOut(ctx, {
      since: new Date("2026-01-01T00:00:00Z"), limit: 100,
    });

    // It has no production caller today, which is exactly why this is asserted rather than
    // assumed: the day it gets one, it must not be a route around the switch.
    expect(sweep).toEqual({ considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0 });
    expect(await recordsOf(db, accountId)).toHaveLength(0);
  });

  it("OFF: the MANUAL button is NOT gated — a switch named `auto` disables nothing else", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await turnOff(db, accountId);
    const id = await seed(db, accountId, mailboxId, ONE_CLICK);
    const post = spyPost();

    const result = await svcWith(post).unsubscribe(ctx, id);

    // `POST /messages/:id/unsubscribe` is a person pressing unsubscribe on a message in front of
    // them. Gating it here would make the Settings switch mean something its label does not say,
    // and would leave the button visibly present and silently inert.
    expect(result.posted).toBe(true);
    expect(post.calls).toHaveLength(1);
  });

  it("the switch is read PER ACCOUNT, not once per process", async () => {
    const off = await makeCtx();
    const on = await makeCtx();
    await turnOff(off.db, off.accountId);
    // Two worlds, because `makeTestDb` is per-context. One service instance answers both, which
    // is what a memoised or module-level read would get wrong.
    const quiet = await seed(off.db, off.accountId, off.mailboxId, ONE_CLICK);
    const loud = await seed(on.db, on.accountId, on.mailboxId, ONE_CLICK);
    const post = spyPost();

    // The WHOLE sweep, not `posted`, on the off side: `FORBIDDEN_POST` throws, so a guard that
    // did not run would still report `posted: 0` — with the failure counted in `failed` instead.
    // A test that reads only `posted` here passes under the mutation it exists to catch.
    expect(await svcWith(FORBIDDEN_POST).onScreenOut(off.ctx, [quiet]))
      .toEqual({ considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0 });
    expect((await svcWith(post).onScreenOut(on.ctx, [loud])).posted).toBe(1);
  });
});
