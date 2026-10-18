import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { eq } from "drizzle-orm";
import { accounts, listAddresses, messages } from "@trafficflow/db/mail";
import { materializeMessages } from "@trafficflow/services/mail";
import type { MailboxDTO, MessageDTO, SnapshotResponse, SyncChange, SyncResponse } from "@trafficflow/services/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * THE IDENTITY FACT SURVIVES THE CLOUD MIRROR (mail 0148). `MessageDTO.senderCheck`
 * is written into the local row's `sender_check` and `sender_check_brand`, so the Cloud-mode
 * desktop's door re-emits what Cloud computed: the chip, the reader line and the held pictures.
 * Absent on the wire (an older server) is NULL, `null` is `'none'`; both fields are in the
 * conflict set, so a mark Cloud's backfill writes later repaints a message already mirrored.
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWN = "me@ohmail.test";
const HOSTED_MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, OWN)];

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
const MIRROR = fileURLToPath(new URL("../src/cloud-mirror.ts", import.meta.url));
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ db: OpenLocalDb["db"]; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-sender-check-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
  return { db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

const iso = (): string => new Date().toISOString();
const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const EMPTY_SNAPSHOT: SnapshotResponse = { asOfSeq: 99, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } };

function inbound(id: string, from: string, verdict: MessageDTO["authVerdict"] | "absent"): MessageDTO {
  return {
    id, accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: `${id}@sender.test`, subject: "Hello",
    from: { name: null, address: from }, to: [{ name: null, address: OWN }], cc: [],
    arrivedAt: "2026-09-26T08:00:00.000Z", date: "2026-09-26T08:00:00.000Z", folder: "INBOX",
    snippet: "", unread: true, lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-26T08:00:00.000Z",
    ...(verdict === "absent" ? {} : { authVerdict: verdict }),
  };
}

function page(messages: MessageDTO[]): SyncResponse {
  const creates: SyncChange[] = messages.map((m, i) => ({
    type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: iso(), entity: m,
  }));
  return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c1", hasMore: false, serverTime: iso() };
}

/** A Cloud serving each page once, in order, then nothing more. */
function fakeAuth(...pages: SyncResponse[]): CloudAuth {
  let served = 0;
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED_MAILBOXES));
      if (path.startsWith("/sync/snapshot")) return json(EMPTY_SNAPSHOT);
      const none = { creates: [], updates: [], moves: [], deletes: [] };
      // The bootstrap's rules-first pass: this feed carries no rules.
      if (path.startsWith("/sync") && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json({ changes: none, cursor: "0", hasMore: false, serverTime: iso() });
      }
      if (path.startsWith("/sync")) {
        const page = pages[served];
        if (page === undefined) return json({ changes: none, cursor: "end", hasMore: false, serverTime: iso() });
        served += 1;
        return json(page);
      }
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

const PHISH = personalAt("fixture.mila", "gmail.com");
const marked = (id: string, check: MessageDTO["senderCheck"] | "absent"): MessageDTO => ({
  ...inbound(id, PHISH, "absent"),
  from: { name: "PostFinance", address: PHISH },
  subject: "Bitte bestätigen: Reaktivierung Ihrer PostFinance Karte erforderlich",
  ...(check === "absent" ? {} : { senderCheck: check }),
});
const FACT = { reason: "impersonation" as const, brand: "PostFinance", domainShared: true };

describe("the Cloud mirror and MessageDTO.senderCheck", () => {
  it("the local door re-emits the fact Cloud computed", async () => {
    const { db, world, cursorPath } = await standUp();
    const m = marked(randomUUID(), FACT);
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth(page([m])) }).pullOnce();
    const got = (await materializeMessages(db, world.accountId, [m.id])).get(m.id);
    expect(got?.senderCheck).toEqual(FACT);
  });

  it("who wrote the fact travels with it (mail 0149), and a server older than the field sends none", async () => {
    const { db, world, cursorPath } = await standUp();
    const ingested = marked(randomUUID(), { ...FACT, by: "ingest" });
    const backfilled = marked(randomUUID(), { ...FACT, by: "backfill" });
    const older = marked(randomUUID(), FACT);
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth(page([ingested, backfilled, older])) }).pullOnce();
    const got = await materializeMessages(db, world.accountId, [ingested.id, backfilled.id, older.id]);
    expect(got.get(ingested.id)?.senderCheck).toEqual({ ...FACT, by: "ingest" });
    expect(got.get(backfilled.id)?.senderCheck).toEqual({ ...FACT, by: "backfill" });
    expect(got.get(older.id)?.senderCheck).toEqual(FACT);
  });

  it("an unconfirmed brand sender mirrors as never checked, and the local door says the line off its own verdict", async () => {
    const { db, world, cursorPath } = await standUp();
    const BRAND = "service@paypal.com";
    const unconfirmed: MessageDTO = {
      ...inbound(randomUUID(), BRAND, "unavailable"),
      senderCheck: { reason: "unverified", brand: "PayPal", domainShared: false },
    };
    const confirmed: MessageDTO = { ...inbound(randomUUID(), BRAND, "pass"), senderCheck: null };
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth(page([unconfirmed, confirmed])) }).pullOnce();
    // The mirror stores no fact it did not compute: the line is not a column value.
    const [row] = await db.select({ c: messages.senderCheck, b: messages.senderCheckBrand })
      .from(messages).where(eq(messages.id, unconfirmed.id));
    expect(row).toEqual({ c: null, b: null });
    const got = await materializeMessages(db, world.accountId, [unconfirmed.id, confirmed.id]);
    expect(got.get(unconfirmed.id)?.senderCheck)
      .toEqual({ reason: "unverified", brand: "PayPal", domainShared: false, unchecked: true });
    expect(got.get(confirmed.id)?.senderCheck).toBeNull();
  });

  it("a Cloud that named one office for an umbrella domain is not repeated: the local door names the domain", async () => {
    const { db, world, cursorPath } = await standUp();
    // What a Cloud before this change served for a BAG letter: the first office listed under admin.ch.
    const bag: MessageDTO = {
      ...inbound(randomUUID(), "info@bag.admin.ch", "unavailable"),
      senderCheck: { reason: "unverified", brand: "ESTV", domainShared: false },
    };
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth(page([bag])) }).pullOnce();
    const got = await materializeMessages(db, world.accountId, [bag.id]);
    expect(got.get(bag.id)?.senderCheck)
      .toEqual({ reason: "unverified", brand: "admin.ch", domainShared: false, unchecked: true });
  });

  it("checked-and-clean is null, never-checked is absent", async () => {
    const { db, world, cursorPath } = await standUp();
    const clean = marked(randomUUID(), null);
    const old = marked(randomUUID(), "absent");
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth(page([clean, old])) }).pullOnce();
    const got = await materializeMessages(db, world.accountId, [clean.id, old.id]);
    expect(got.get(clean.id)?.senderCheck).toBeNull();
    expect(got.get(old.id) !== undefined && "senderCheck" in got.get(old.id)!).toBe(false);
  });

  it("a mark Cloud's backfill writes later repaints a message already mirrored: the conflict set carries it", async () => {
    const { db, world, cursorPath } = await standUp();
    const id = randomUUID();
    const before = marked(id, "absent");
    const after: SyncResponse = {
      changes: {
        creates: [], moves: [], deletes: [],
        updates: [{ type: "message", op: "update", id, seq: 9, updatedAt: iso(), entity: marked(id, FACT) }],
      },
      cursor: "c2", hasMore: false, serverTime: iso(),
    };
    const mirror = createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth(page([before]), after) });
    await mirror.pullOnce();
    expect("senderCheck" in (await materializeMessages(db, world.accountId, [id])).get(id)!).toBe(false);
    await mirror.pullOnce();
    expect((await materializeMessages(db, world.accountId, [id])).get(id)?.senderCheck).toEqual(FACT);
  });

  const LISTED = { ...FACT, list: true as const };

  it("a claim from a list address keeps its list sentence on the local door (mail 0150)", async () => {
    const { db, world, cursorPath } = await standUp();
    const m = marked(randomUUID(), LISTED);
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth(page([m])) }).pullOnce();
    expect((await materializeMessages(db, world.accountId, [m.id])).get(m.id)?.senderCheck).toEqual(LISTED);
  });

  it("a list fact Cloud learns after the message was mirrored reaches the local door on the update", async () => {
    const { db, world, cursorPath } = await standUp();
    const id = randomUUID();
    const after: SyncResponse = {
      changes: {
        creates: [], moves: [], deletes: [],
        updates: [{ type: "message", op: "update", id, seq: 9, updatedAt: iso(), entity: marked(id, LISTED) }],
      },
      cursor: "c2", hasMore: false, serverTime: iso(),
    };
    const mirror = createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth(page([marked(id, FACT)]), after) });
    await mirror.pullOnce();
    expect((await materializeMessages(db, world.accountId, [id])).get(id)?.senderCheck).toEqual(FACT);
    await mirror.pullOnce();
    expect((await materializeMessages(db, world.accountId, [id])).get(id)?.senderCheck).toEqual(LISTED);
  });

  it("an erased account's page writes the message and records no list address (the case above is the control)", async () => {
    const { db, world, cursorPath } = await standUp();
    const m = marked(randomUUID(), LISTED);
    // A first pull while the account is live mirrors the hosted mailbox; then the erasure's stamp.
    const mirror = createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth(page([]), page([m])) });
    await mirror.pullOnce();
    await db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, world.accountId));
    await mirror.pullOnce();
    expect(await db.select({ id: messages.id }).from(messages).where(eq(messages.id, m.id)), "the message arm ran")
      .toHaveLength(1);
    expect(await db.select({ a: listAddresses.address }).from(listAddresses)
      .where(eq(listAddresses.accountId, world.accountId))).toEqual([]);
  });

  it("CENSUS: the message upsert's display object, its insert half and its conflict set, names both fields", () => {
    const src = readFileSync(MIRROR, "utf8");
    const arm = src.slice(src.indexOf('case "message": {'), src.indexOf("onConflictDoUpdate({ target: messages.id"));
    const display = arm.slice(arm.indexOf("const display = {"));
    expect(display.length, "the message arm's display object moved").toBeGreaterThan(100);
    for (const field of ["senderCheck:", "senderCheckBrand:", "authVerdict:"]) {
      expect(display, `the display object does not carry ${field}`).toContain(field);
    }
    expect(src).toContain("onConflictDoUpdate({ target: messages.id, set: { ...display, ...rowArrival } })");
  });
});
