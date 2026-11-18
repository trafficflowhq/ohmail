import type { MailboxDTO, SyncChange, SyncResponse } from "@ohmail/wire";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
 * A SETTLED MIRROR DOES NOT ASK WHICH MESSAGES HAVE NO BODY.
 *
 * "Which of my messages has no body" is an anti-join over every message the account holds, and the
 * body walk's COMPLETE state ran it on every poll — for ever, on a mirror where the answer had
 * been "none" since the walk finished. It is now latched by the answer itself and unlatched by a
 * pull that applied rows, which is the only way the gap can open.
 *
 * Counted at the seam, not timed: `bodyGapReads()` is the number of times the query ran.
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ opened: OpenLocalDb; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-body-gap-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  return { opened, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

const emptyPage = (): SyncResponse => ({
  changes: { creates: [] as SyncChange[], updates: [], moves: [], deletes: [] },
  cursor: "end", hasMore: false, serverTime: new Date().toISOString(),
});

/** One message, so a pull can APPLY something and open the gap. */
const messagePage = (id: string, seq: number): SyncResponse => ({
  changes: {
    creates: [{
      type: "message", op: "create", id, seq, updatedAt: new Date().toISOString(),
      entity: {
        id, accountId: "acct", mailboxId: CLOUD_MAILBOX, threadId: null, messageIdHeader: null,
        subject: "hello", from: { name: null, address: "someone@elsewhere.test" }, to: [], cc: [],
        date: new Date().toISOString(), folder: "INBOX", snippet: "s", unread: true,
        hasAttachments: false, attachmentCount: 0,
        sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
        triage: null, labels: [], remoteContent: "none", updatedAt: new Date().toISOString(),
      },
    }] as unknown as SyncChange[],
    updates: [], moves: [], deletes: [],
  },
  cursor: `c${seq}`, hasMore: false, serverTime: new Date().toISOString(),
});

/** `pending` is spliced by the TEST, so a page lands on the pull the test chooses and no other. */
function fakeAuth(pending: SyncResponse[] = []): CloudAuth {
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) {
        const rows: MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")];
        return json(mailboxList(rows));
      }
      if (path.startsWith("/sync/snapshot")) {
        return json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
      }
      if (path.startsWith("/sync")
          && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json(emptyPage());
      }
      if (path.startsWith("/sync")) return json(pending.shift() ?? emptyPage());
      // The account owns nothing we ask about — so a body asked for is a body that stays missing.
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

describe("the missing-body question", () => {
  it("is asked once and then not again while nothing arrives", async () => {
    const { opened, world, cursorPath } = await standUp();
    const mirror = createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(), auth: fakeAuth(),
    });
    /* TWO PULLS TO SETTLE, and the second is not bookkeeping: the first leaves the body walk
       WALKING, and a walking mirror is owed the question on every pull — it is the completed walk
       whose answer may be latched. The claim is about the state after that, which is the state a
       mirror spends its life in. */
    await mirror.pullOnce();
    await mirror.pullOnce();
    const asked = mirror.bodyGapReads();
    expect(asked).toBeGreaterThan(0);

    await mirror.pullOnce();
    await mirror.pullOnce();
    await mirror.pullOnce();
    // THE WHOLE CLAIM: three more polls of a mirror with nothing missing, and the anti-join did
    // not run once.
    expect(mirror.bodyGapReads()).toBe(asked);
  });

  it("is asked again the moment a pull applies a row", async () => {
    const { opened, world, cursorPath } = await standUp();
    const pending: SyncResponse[] = [];
    const mirror = createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(), auth: fakeAuth(pending),
    });
    await mirror.pullOnce();
    await mirror.pullOnce();
    await mirror.pullOnce();            // nothing — latched
    const quiet = mirror.bodyGapReads();

    pending.push(messagePage("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 5));
    await mirror.pullOnce();            // a message lands
    expect(mirror.bodyGapReads()).toBeGreaterThan(quiet);
  });
});
