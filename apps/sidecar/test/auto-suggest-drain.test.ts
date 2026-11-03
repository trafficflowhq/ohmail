import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_SHAPES, anthropicKey } from "../../../test/support/fixture-credentials.js";
import { freshDataDir } from "./_datadir.js";
import { and, eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  accountSettings, folderState, messageInstances, messages, routingDecisions,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS,
} from "@trafficflow/db";
import { AUTO_SUGGEST_BATCH } from "@trafficflow/worker/screener-auto-suggest";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  AUTOMATIC SUGGESTIONS ON THE STANDALONE DOOR — the pass at the tail of the drain
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT WAS MISSING ──────────────────────────────────────────────────────────────────────
 *
 * "Suggest for new senders automatically" existed on the hosted door only, because the pass that
 * does it ran in the always-on worker and a standalone install has no always-on anything. It was
 * not a missing model — this door has one, of the installer's own — it was a missing MOMENT. The
 * moment is the tail of a drain: the only time this process can have new held senders, and the
 * only time it is awake.
 *
 * ── WHY PGLITE, DESPITE THE HOUSE RULE ────────────────────────────────────────────────────
 *
 * `resurface-drain.test.ts` states it and the same inversion applies: **PGlite IS production on
 * the desktop.** `db.ts` opens it on disk under the user's home, this opens the same store through
 * the same `createSidecar`, and running these claims against :5433 would measure a database no
 * desktop install has. The claims PGlite cannot host are the CONCURRENT and the MONEY ones, and
 * neither is this door's: there is one writer here and no ledger at all. The money half of the
 * same pass is proved against real Postgres in `apps/worker/test/screener-auto-suggest.pg.test.ts`,
 * over THIS EXACT FUNCTION — which is the reason this door calls the worker's pass rather than a
 * copy of it.
 *
 * ── THE SIX CLAIMS, AND THE MUTATION THAT TURNS EACH ONE RED ──────────────────────────────
 *
 * Every one of these was run, watched fail, and restored.
 *
 *  1. THE PASS RUNS AT ALL. Delete `await suggestNew(screening.ohboxBar);` from `drain()` in
 *     `apps/sidecar/src/engine.ts` → "the drain bought nothing" with zero suggestion rows.
 *  2. THE OPT-IN. Change `if (!watermark) return EMPTY()` in the worker pass to `if (false)` →
 *     the install that never turned it on has its senders sent to a model.
 *  3. THE WATERMARK. Drop the `created_at > auto_suggest_at` predicate from `selectCandidates` →
 *     the sender that was already in the queue when the switch was flipped is bought for.
 *  4. THE CAP. Raise `AUTO_SUGGEST_BATCH`, or loop pages → one drain buys the whole queue.
 *  5. THE MODEL FAULT STOPS IT. Delete the `break` in the pass's `catch` → a dead model is asked
 *     once per candidate instead of once, on every drain, on somebody's own API key.
 *  6. FLAGGED MAIL IS NOT A CANDIDATE. Drop `eq(reps.noAi, false)` or
 *     `isNull(reps.sensitivityCategory)` from `selectCandidates` → a one-time passcode leaves this
 *     machine at the tail of a drain, with nobody having pressed anything.
 *
 * And the seventh, which is about the DECLARATION rather than about this door: remove
 * `unmetered: true` from the sidecar's call and the pass returns EMPTY, because an absent gate
 * alone is never permission. That one is asserted from the other side in the worker's pg test.
 *
 * And mail the drain finds gone from the server is no candidate: drop `isNull(messages.deletedAt)`
 * from `selectCandidates` → the letter the drain's reaper just tombstoned is sent to the model.
 */

/** An empty `ohmail/_meta` that accepts this install's claim — `readMailboxLease` requires one. */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/**
 * A mailbox where nothing changes: no arrival, no expunge.
 *
 * The senders under test are seeded straight into the local store, because what is being proved is
 * what the PASS does with a queue and not how a queue comes to exist — the ingest half has its own
 * suites. A quiet mailbox also settles the drain in one cycle, so "within one drain" is a claim
 * about the pass rather than about how long a backlog took.
 */
function quietMailbox(): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      return { ...EMPTY_BATCH };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> {
      return locator;
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> {
      return [];
    },
    async watch(): Promise<() => Promise<void>> {
      return async () => {};
    },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this mailbox cannot send");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
}

const SCREENER = "ohmail/Screener";
const KEY = anthropicKey("auto-suggest-drain");

it("the fixture key has the vendor key's shape", () => {
  expect(KEY).toMatch(FIXTURE_SHAPES.anthropic);
});

/** Every completion the engine's model would have made, and the bodies it sent. */
interface Model {
  completions: string[];
  /** Flip to make every completion fail, as a revoked key or a stopped model server would. */
  broken: { value: boolean };
  fetchImpl: typeof fetch;
}

/**
 * The model, injected AT THE TRANSPORT — `ai-local.e2e.test.ts`'s rule, for its reasons.
 *
 * What is counted is the number of requests that would have LEFT THIS MACHINE, which is the only
 * measure of "how much of somebody's key did this spend" that does not depend on which function
 * the code happened to call.
 */
function model(): Model {
  const completions: string[] = [];
  const broken = { value: false };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const json = (b: unknown): Response =>
      new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (/\/v1\/models\?/.test(url)) return json({ data: [{ id: "claude-haiku-4-5-20251001" }] });
    if (/\/v1\/models\//.test(url)) return json({ id: "ok" });
    if (/\/v1\/messages$/.test(url)) {
      completions.push(typeof init?.body === "string" ? init.body : "");
      if (broken.value) return new Response("upstream is unwell", { status: 500 });
      return json({
        content: [{
          type: "text",
          text: JSON.stringify({
            destination: "ohmail/News", confidence: 0.92, rationale: "a newsletter", spam: false,
          }),
        }],
      });
    }
    return new Response("unexpected", { status: 599 });
  }) as unknown as typeof fetch;
  return { completions, broken, fetchImpl };
}

const aKek = (): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

describe("automatic suggestions at the standalone drain's tail", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(m: Model): Promise<Sidecar> {
    // `realpathSync` because macOS hands out `/var/…` for a `/private/var/…` directory and PGlite
    // records the resolved path in its lock file.
    const dataDir = await freshDataDir("ohmail-autosuggest-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        // A password is what makes `start()` take the connected path at all.
        auth: { user: "owner@trafficflow.test", pass: "drain-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "auto-suggest host",
      // Long enough that the poll timer never fires: every drain here is one the test asked for,
      // so a purchase is never a coincidence of scheduling.
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(),
      // A durable key, because storing an API key is refused without one and this install has to be
      // able to have a model at all.
      keks: { 1: aKek() },
      fetchImpl: m.fetchImpl,
      log: () => {},
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await sidecar.start();
    /* THIS INSTALL ORGANIZES THE MAILBOX, which is what a standalone door IS — and since the
       automatic pass gained its "no organizer, no spend" guard it is also what the pass reads
       before it buys anything. Production sets these columns at consent; the fixture has to be in
       the state production is in, or every case here measures the guard instead of the pass. */
    await grantOrganizeConsent(sidecar);
    return sidecar;
  }

  const auth = (s: Sidecar): Record<string, string> => ({
    authorization: `Bearer ${s.sessionToken}`,
    "content-type": "application/json",
  });

  /** Configure this install's own model, through the route the settings pane uses. */
  async function giveItAModel(s: Sidecar): Promise<void> {
    const res = await s.handle(new Request("http://local/local/ai", {
      method: "PUT",
      headers: auth(s),
      body: JSON.stringify({ provider: "anthropic", anthropic: { apiKey: KEY } }),
    }));
    expect(res.status, "the engine refused a model it should have accepted").toBe(200);
    const status = (await res.json()) as { available: boolean };
    expect(status.available, "the injected endpoint did not verify").toBe(true);
  }

  /** Arm the opt-in through the route the settings row uses. Answers the stored watermark. */
  async function armIt(s: Sidecar, on = true): Promise<string | null> {
    const res = await s.handle(new Request("http://local/local/auto-suggest", {
      method: "PUT", headers: auth(s), body: JSON.stringify({ on }),
    }));
    expect(res.status).toBe(200);
    return ((await res.json()) as { since: string | null }).since;
  }

  /** One UID per letter, as a server numbers them. */
  let nextUid = 100;

  /**
   * One held first-contact sender, waiting in the Screener.
   *
   * `createdAt` is OUR ingest stamp and is set explicitly, because that is the clock the watermark
   * is read against — `messages.date` is the sender's own header and the pass deliberately never
   * reads it.
   *
   * ON THE SERVER by default: held at arrival in INBOX with a watched instance, as the ingest records
   * it, and the drain files it. `onServer: false` is a letter filed into the Screener earlier whose
   * copy is gone: no instance, so the drain's reaper (`tombstoneInstanceless`) tombstones it.
   */
  async function seedHeld(
    s: Sidecar, address: string, createdAt: Date, o: { onServer?: boolean } = {},
  ): Promise<string> {
    const onServer = o.onServer !== false;
    const folder = onServer ? "INBOX" : SCREENER;
    const dedup = `mid:${address}@auto.test`;
    const uid = nextUid++;
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      messageIdHeader: dedup,
      bodyHash: `hash-${address}`,
      dedupKey: dedup,
      subject: `hello from ${address}`,
      fromAddress: address,
      snippet: "a short extract of the mail",
      nativeLocator: { folder, ref: `1:${uid}` },
      createdAt,
    }).returning();
    if (onServer) {
      await s.db.insert(messageInstances).values({
        accountId: s.world.accountId, mailboxId: s.world.mailboxId, messageId: m!.id,
        folder, uidvalidity: 1n, uid, isPrimary: true,
      });
    }
    await s.db.insert(folderState).values({
      messageId: m!.id,
      observedFolder: folder,
      desiredFolder: SCREENER,
      // `us`, because the gate is OUR decision: the pipeline held this first-contact sender, which
      // is the same value `ScreenerService` writes when it places one.
      lastSetBy: "us",
      reconcileStatus: onServer ? "pending" : "reconciled",
    });
    return m!.id;
  }

  const suggestionsOf = async (s: Sidecar) =>
    s.db.select().from(routingDecisions).where(and(
      eq(routingDecisions.accountId, s.world.accountId),
      eq(routingDecisions.inputProvenance, SCREENER_SUGGESTION_PROVENANCE),
    ));

  it("buys for the senders a drain just brought in, under the shared provenance and inert status", async () => {
    const m = model();
    const s = await boot(m);
    await giveItAModel(s);
    const since = await armIt(s);
    expect(since).not.toBeNull();

    // AFTER the switch, which is what makes them candidates.
    const after = new Date(Date.parse(since!) + 60_000);
    const one = await seedHeld(s, "stranger-a@example.test", after);
    const two = await seedHeld(s, "stranger-b@example.test", after);

    const before = m.completions.length;
    await s.syncUntilQuiet();

    const rows = await suggestionsOf(s);
    expect(
      rows.map((r) => r.messageId).sort(),
      "the drain bought nothing — the tail pass did not run, or it ran before the mail arrived",
    ).toEqual([one, two].sort());
    // INERT, which is the property that makes an automatic purchase safe: nothing in the product
    // acts on a `suggestion`, so every sender still waits for a human.
    for (const r of rows) expect(r.status).toBe(SCREENER_SUGGESTION_STATUS);
    // …and it really went to the model, once per sender.
    const sent = m.completions.slice(before);
    expect(sent).toHaveLength(2);
    /* BOTH senders travelled, asserted as a SET rather than by position. The pass orders candidates
       `created_at ASC, id ASC`, and these two share an ingest instant, so which of them goes first
       is decided by a random uuid — an assertion on `completions.at(-1)` passes or fails by luck.
       (Found the honest way: it went red under an unrelated mutation and the reason was the order.) */
    expect(sent.some((b) => b.includes("stranger-a@example.test"))).toBe(true);
    expect(sent.some((b) => b.includes("stranger-b@example.test"))).toBe(true);
    /* WHAT ELSE IS IN THE REQUEST, because a purchase this door makes on somebody's own key should
       carry no more than the button does: the sender, the subject and the stored extract. The body
       is what would have left this machine, so this is a claim about bytes and not about which
       function was called. */
    for (const body of sent) expect(body).toContain("a short extract of the mail");
  }, 120_000);

  it("never sends a letter the drain found gone from the server — the live one beside it still goes", async () => {
    const m = model();
    const s = await boot(m);
    await giveItAModel(s);
    const since = await armIt(s);
    const after = new Date(Date.parse(since!) + 60_000);
    const live = await seedHeld(s, "still-here@example.test", after);
    const gone = await seedHeld(s, "gone-away@example.test", after, { onServer: false });

    const before = m.completions.length;
    await s.syncUntilQuiet();
    const sent = m.completions.slice(before);

    const [row] = await s.db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.id, gone));
    expect(row!.deletedAt, "the drain did not find the letter gone, so this case proves nothing").not.toBeNull();
    expect(sent.join("\n"), "a letter gone from the server was sent to the model")
      .not.toContain("gone-away@example.test");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("still-here@example.test");
    expect(sent[0]).toContain("a short extract of the mail");
    expect((await suggestionsOf(s)).map((r) => r.messageId)).toEqual([live]);
  }, 120_000);

  it("does nothing at all — not one request — while the switch is off", async () => {
    const m = model();
    const s = await boot(m);
    await giveItAModel(s);
    // Deliberately NOT armed.
    await seedHeld(s, "stranger@example.test", new Date());

    const before = m.completions.length;
    await s.syncUntilQuiet();

    expect(await suggestionsOf(s)).toEqual([]);
    expect(
      m.completions.length - before,
      "an install that never turned this on sent mail to a model",
    ).toBe(0);
  }, 120_000);

  it("never reaches back past the watermark — the queue that was already waiting is untouched", async () => {
    const m = model();
    const s = await boot(m);
    await giveItAModel(s);

    // A sender that arrived BEFORE anybody armed anything. This is the whole point of the column
    // being a timestamp: flipping a switch must not spend against a mailbox already synced.
    const old = await seedHeld(s, "already-waiting@example.test", new Date(Date.now() - 86_400_000));
    const since = await armIt(s);
    const fresh = await seedHeld(
      s, "just-arrived@example.test", new Date(Date.parse(since!) + 60_000),
    );

    await s.syncUntilQuiet();

    const bought = (await suggestionsOf(s)).map((r) => r.messageId);
    expect(bought).toEqual([fresh]);
    expect(
      bought,
      "the backlog that predates the opt-in was bought for — the watermark is not being read",
    ).not.toContain(old);
  }, 120_000);

  it("buys at most one page per drain, and the rest wait for the next one", async () => {
    const m = model();
    const s = await boot(m);
    await giveItAModel(s);
    const since = await armIt(s);
    const after = new Date(Date.parse(since!) + 60_000);

    const over = AUTO_SUGGEST_BATCH + 3;
    for (let i = 0; i < over; i++) {
      await seedHeld(s, `crowd-${String(i).padStart(2, "0")}@example.test`, after);
    }

    await s.syncUntilQuiet();
    expect(
      (await suggestionsOf(s)).length,
      "one drain bought more than a page — the cap is not holding",
    ).toBe(AUTO_SUGGEST_BATCH);

    // The NEXT drain resumes at the next unbought sender, with no cursor anywhere: the stored
    // suggestion is the progress marker.
    await s.syncUntilQuiet();
    expect((await suggestionsOf(s)).length).toBe(over);

    // …and a third drain over a fully answered queue buys nothing and asks nothing.
    const settled = m.completions.length;
    await s.syncUntilQuiet();
    expect((await suggestionsOf(s)).length).toBe(over);
    expect(
      m.completions.length - settled,
      "a settled queue was re-asked — the stored suggestion is not excluding its own sender",
    ).toBe(0);
  }, 180_000);

  /**
   * FLAGGED MAIL DOES NOT LEAVE THIS MACHINE, and on this door that sentence is literal.
   *
   * The assertion is on `m.completions` — the request bodies that would have gone over the wire —
   * rather than on stored rows, for the reason the file header gives about every other claim here:
   * what is being measured is what left, not what was recorded afterwards. On a standalone install
   * the destination is the user's own API key or a model server they run, but "your own model" is
   * not the same permission as "this message may be classified": the flag is the detector saying
   * this looks like a credential, and nobody pressed anything at the tail of a drain.
   *
   * The exclusion is ONE implementation on both doors — this test and
   * `apps/worker/test/screener-auto-suggest.pg.test.ts` drive the same `selectCandidates` — so the
   * mutation that turns this red turns those red too, which is the property that makes "both
   * doors" true by construction rather than by two files agreeing today.
   */
  it("never sends a flagged sender to the model — the unflagged one beside it still goes", async () => {
    const m = model();
    const s = await boot(m);
    await giveItAModel(s);
    const since = await armIt(s);
    const after = new Date(Date.parse(since!) + 60_000);

    const ordinary = await seedHeld(s, "shop@example.test", after);
    const flagged = await seedHeld(s, "bank@example.test", after);
    await s.db.update(messages)
      .set({ subject: "Your sign-in code", snippet: "Use 482913 to sign in.", noAi: true, sensitivityCategory: "otp" })
      .where(eq(messages.id, flagged));
    // The INDETERMINATE class as well — `no_ai` with no category, which is the detector saying it
    // could not read the message confidently. Either flag alone must be enough.
    const unreadable = await seedHeld(s, "unknown@example.test", after);
    await s.db.update(messages).set({ noAi: true, sensitivityCategory: null })
      .where(eq(messages.id, unreadable));

    const before = m.completions.length;
    await s.syncUntilQuiet();
    const sent = m.completions.slice(before);

    // The ordinary sender still gets an answer — this door's feature is not switched off.
    expect((await suggestionsOf(s)).map((r) => r.messageId)).toEqual([ordinary]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("shop@example.test");

    // AND NEITHER FLAGGED SENDER TRAVELLED — by address, and by the passcode's own digits.
    const wire = sent.join("\n");
    expect(wire, "a flagged sender was sent to the model").not.toContain("bank@example.test");
    expect(wire, "the indeterminate sender was sent to the model").not.toContain("unknown@example.test");
    expect(wire, "the passcode left this machine").not.toContain("482913");
  }, 120_000);

  it("stops on the model's FIRST fault, and converges once the model comes back", async () => {
    const m = model();
    const s = await boot(m);
    await giveItAModel(s);
    const since = await armIt(s);
    const after = new Date(Date.parse(since!) + 60_000);
    for (let i = 0; i < 5; i++) {
      await seedHeld(s, `outage-${i}@example.test`, after);
    }

    m.broken.value = true;
    const before = m.completions.length;
    await s.syncUntilQuiet();

    expect(await suggestionsOf(s), "a dead model still stored something").toEqual([]);
    // ONE call, not five. This is the whole bound on an unmetered door: there is no ledger to
    // refuse, so the first fault has to be what stops the pass.
    expect(
      m.completions.length - before,
      "the pass kept asking a model that had already failed — on this door that is somebody's own API key being spent against an outage, once per candidate, on every drain",
    ).toBe(1);

    // THE RECOVERY, which is the half a "stops on fault" assertion alone would let rot: the
    // interrupted pass leaves no marker and no cursor, so a later drain simply starts again. The
    // engine withholds a faulted model for a cooldown, so the store is asked directly rather than
    // waiting one out — what is being proved is that nothing about the FIRST pass blocks a second.
    m.broken.value = false;
    await s.db.update(accountSettings)
      .set({ autoSuggestAt: new Date(Date.parse(since!)) })
      .where(eq(accountSettings.accountId, s.world.accountId));
    for (let i = 0; i < 4; i++) await s.syncUntilQuiet();

    expect(
      (await suggestionsOf(s)).length,
      "the queue never converged after the model came back",
    ).toBe(5);
  }, 180_000);
});
