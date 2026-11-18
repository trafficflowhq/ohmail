import type { RuleDTO, SyncChange, SyncResponse, TagDTO } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { accounts, accountSettings, approvals, mailboxes, rules, tags, threads } from "@trafficflow/db/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import { requestOrganizerTakeover } from "../src/organize-here.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * NO DOOR WRITES FOR AN ERASED ACCOUNT — the local store's half of the erasure fence.
 *
 * `accounts` survives Art. 17 erasure, so a row keyed to the account alone has no structural
 * refusal for a writer arriving after the sweep. The replay's account-owned arms read the stamp
 * and SKIP; the local consent write takes `fenceErasedAccount` and answers 410. Beside them, the
 * REMOTE half: a hosted `410 account_erased` stops this mirror for good, and a `410 cursor_expired`
 * — the same status, a different answer — still re-bootstraps.
 *
 * Mutations watched red, restored by `cmp`: each fence cut → the row lands again; the code test in
 * `answersAccountErased` cut → a cursor expiry stops the mirror.
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED = [hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")];

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

const iso = (): string => new Date().toISOString();
const change = (type: SyncChange["type"], id: string, seq: number, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq, updatedAt: iso(), entity });
const page = (changes: SyncChange[], cursor: string): SyncResponse => ({
  changes: { creates: changes, updates: [], moves: [], deletes: [] },
  cursor, hasMore: false, serverTime: iso(),
});
const ruleDTO = (id: string): RuleDTO => ({
  id, kind: "sender", match: "stranger@nowhere.test", destination: "ohmail/Screened",
  priority: 0, provenance: "promoted", enabled: true, subjectContains: null, bodyContains: null,
  stats: { hits: 1, lastHitAt: iso(), demotions: 0 }, createdAt: iso(), updatedAt: iso(),
  retro: { requestedAt: null, doneAt: null },
  byOhmail: false,
});
const tagDTO = (id: string): TagDTO =>
  ({ id, name: "Receipts", hue: "moss", createdAt: iso(), updatedAt: iso() }) as TagDTO;

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
/** The hosted API's own refusal envelope, which is what the discriminator reads. */
const gone = (code: string): Response =>
  new Response(JSON.stringify({ error: { code, message: "gone" } }), {
    status: 410, headers: { "content-type": "application/json" },
  });

/** The fake Cloud API. `syncAnswer` lets a case replace what `/sync` says on the Nth ask. */
function fakeAuth(pages: SyncResponse[], syncAnswer?: (n: number) => Response | null): CloudAuth {
  let s = 0;
  let asked = 0;
  const empty = page([], "end");
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED));
      if (path.startsWith("/sync/snapshot")) {
        return json({ changes: [], cursor: "snap", window: null, serverTime: iso() });
      }
      if (path.startsWith("/sync")
        && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json(empty);
      }
      if (path.startsWith("/sync")) {
        const override = syncAnswer?.(asked++);
        if (override) return override;
        return json(pages[s++] ?? empty);
      }
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
  } as unknown as CloudAuth;
}

async function store(label: string): Promise<{ db: OpenLocalDb["db"]; world: Awaited<ReturnType<typeof ensureLocalWorld>>; cursorPath: string }> {
  const dataDir = await freshDataDir(label);
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  return { db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

describe("the replay writes nothing for an account this store records as erased", () => {
  it("skips the settings, thread, tag, rule and approval rows, and the mailbox refresh", async () => {
    const { db, world, cursorPath } = await store("ohmail-mirror-erased-account-");
    // A first pull so the refresh mirrors the hosted mailbox while the account is live.
    await createCloudMirror({ db, world, auth: fakeAuth([page([], "c0")]), cursorPath, now: () => new Date() })
      .pullOnce();
    expect(await db.select().from(mailboxes).where(eq(mailboxes.id, CLOUD_MAILBOX))).toHaveLength(1);
    await db.delete(mailboxes).where(eq(mailboxes.id, CLOUD_MAILBOX));

    // THE ERASURE, written exactly as `deleteAccount` writes it: the stamp first, the row kept.
    await db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, world.accountId));

    const tagId = randomUUID();
    const ruleId = randomUUID();
    const threadId = randomUUID();
    const approvalId = randomUUID();
    const feed = page([
      change("settings", world.accountId, 1, { dormancyDays: 30, updatedAt: iso() }),
      change("thread", threadId, 2, { id: threadId, subject: "Can we talk?", participants: [], updatedAt: iso() }),
      change("tag", tagId, 3, tagDTO(tagId)),
      change("rule", ruleId, 4, ruleDTO(ruleId)),
      change("approval", approvalId, 5, {
        id: approvalId, kind: "rule", messageId: null, routingDecisionId: null,
        proposed: { action: "file", summary: "", payload: null }, confidence: null,
        status: "pending", expiresAt: null, updatedAt: iso(),
      }),
    ], "c1");

    await createCloudMirror({ db, world, auth: fakeAuth([feed]), cursorPath, now: () => new Date() })
      .pullOnce();

    expect(await db.select().from(accountSettings).where(eq(accountSettings.accountId, world.accountId))).toHaveLength(0);
    expect(await db.select().from(threads).where(eq(threads.id, threadId))).toHaveLength(0);
    expect(await db.select().from(tags).where(eq(tags.id, tagId))).toHaveLength(0);
    expect(await db.select().from(rules).where(eq(rules.id, ruleId))).toHaveLength(0);
    expect(await db.select().from(approvals).where(eq(approvals.id, approvalId))).toHaveLength(0);
    // …and the refresh put no mailbox back either.
    expect(
      await db.select().from(mailboxes).where(eq(mailboxes.id, CLOUD_MAILBOX)),
      "the refresh re-created a mailbox for an account that has been deleted",
    ).toHaveLength(0);
  });

  it("…and a live account still takes the whole page — the control", async () => {
    const { db, world, cursorPath } = await store("ohmail-mirror-live-account-");
    const tagId = randomUUID();
    const ruleId = randomUUID();
    const feed = page([
      change("tag", tagId, 1, tagDTO(tagId)),
      change("rule", ruleId, 2, ruleDTO(ruleId)),
    ], "c1");
    await createCloudMirror({ db, world, auth: fakeAuth([feed]), cursorPath, now: () => new Date() })
      .pullOnce();
    expect(await db.select().from(tags).where(eq(tags.id, tagId))).toHaveLength(1);
    expect(await db.select().from(rules).where(eq(rules.id, ruleId))).toHaveLength(1);
    expect(await db.select().from(mailboxes).where(eq(mailboxes.id, CLOUD_MAILBOX))).toHaveLength(1);
  });
});

describe("a hosted 410 that says the account is gone stops this mirror", () => {
  it("latches, writes nothing more, and does not retry", async () => {
    const { db, world, cursorPath } = await store("ohmail-mirror-410-erased-");
    const ruleId = randomUUID();
    const feed = page([change("rule", ruleId, 1, ruleDTO(ruleId))], "c1");
    // The FIRST ask is the refusal; the page behind it would land if anything asked again.
    const mirror = createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([feed], (n) => (n === 0 ? gone("account_erased") : null)),
    });

    await expect(mirror.pullOnce(), "the stop is not an error the poll should back off from")
      .resolves.toBe(0);
    expect(mirror.accountErased()).toBe(true);
    expect(await db.select().from(rules).where(eq(rules.id, ruleId))).toHaveLength(0);
    // A second ask writes nothing either — and never reaches the wire.
    await mirror.pullOnce();
    expect(await db.select().from(rules).where(eq(rules.id, ruleId))).toHaveLength(0);
  });

  it("…and a cursor expiry is the SAME STATUS with a different answer: it re-bootstraps", async () => {
    const { db, world, cursorPath } = await store("ohmail-mirror-410-cursor-");
    const ruleId = randomUUID();
    const feed = page([change("rule", ruleId, 1, ruleDTO(ruleId))], "c1");
    const mirror = createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([feed], (n) => (n === 0 ? gone("cursor_expired") : null)),
    });
    await mirror.pullOnce();
    expect(mirror.accountErased(), "a cursor below the retention horizon is not an ending").toBe(false);
    expect(
      await db.select().from(rules).where(eq(rules.id, ruleId)),
      "the re-bootstrap did not deliver the page behind the expiry",
    ).toHaveLength(1);
  });
});

describe("the local consent write refuses an erased account", () => {
  it("answers the fence's 410 rather than putting the settings row back", async () => {
    const { db, world, cursorPath } = await store("ohmail-consent-erased-");
    await createCloudMirror({ db, world, auth: fakeAuth([page([], "c0")]), cursorPath, now: () => new Date() })
      .pullOnce();
    await db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, world.accountId));

    await expect(requestOrganizerTakeover(db, {
      mailboxId: CLOUD_MAILBOX, now: new Date(), accountId: world.accountId,
      intent: "takeover", screening: { dormancyDays: 30, scope: "window" },
    })).rejects.toMatchObject({ code: "account_erased", httpStatus: 410 });
    expect(await db.select().from(accountSettings).where(eq(accountSettings.accountId, world.accountId)))
      .toHaveLength(0);
  });

  it("…and a live account is taken — the control", async () => {
    const { db, world, cursorPath } = await store("ohmail-consent-live-");
    await createCloudMirror({ db, world, auth: fakeAuth([page([], "c0")]), cursorPath, now: () => new Date() })
      .pullOnce();
    const result = await requestOrganizerTakeover(db, {
      mailboxId: CLOUD_MAILBOX, now: new Date(), accountId: world.accountId,
      intent: "takeover", screening: { dormancyDays: 30, scope: "window" },
    });
    expect(result.outcome).not.toBe("no_such_mailbox");
    expect(await db.select().from(accountSettings).where(eq(accountSettings.accountId, world.accountId)))
      .toHaveLength(1);
  });
});
