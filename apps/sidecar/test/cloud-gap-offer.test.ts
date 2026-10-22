import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { mailboxes } from "@trafficflow/db";
import type { MailboxDTO, SyncChange, SyncResponse } from "@trafficflow/services/mail";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

/**
 * THE ACCOUNT'S GAP OFFER REACHES A CLOUD-PAIRED WINDOW (the desktop's Cloud door). That
 * door serves `GET /mailboxes` out of the mirror, which holds no gap window, so the count the account
 * held reached no window. The mirror keeps each refresh's answer (`hostedGaps`, rebuilt whole) and the
 * door decorates the list with it; the mirror's own row keeps no window, so a later switch to the
 * standalone door carries none of the account's into this store.
 */

const A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWN = "me@ohmail.test";
type Gap = number | null | "absent" | "junk" | { letters: number; strangers: number };

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);
const sidecars: CloudSidecar[] = [];
const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [sidecars, mirrors], close: opens, remove: dirs }));

const emptyPage = (): SyncResponse => ({
  changes: { creates: [] as SyncChange[], updates: [], moves: [], deletes: [] },
  cursor: "end", hasMore: false, serverTime: new Date().toISOString(),
});
const send = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

/** The hosted mailbox row, carrying the offer as the server would — or not at all, or malformed. */
function box(gap: Gap): MailboxDTO {
  const row = hostedMailbox(A, OWN, { organizerRole: "organizer" });
  if (gap === "absent") return row;
  if (gap !== null && typeof gap === "object") return { ...row, gapLetters: gap.letters, gapStrangers: gap.strangers };
  return { ...row, gapLetters: (gap === "junk" ? "3" : gap) as number | null };
}

/** One hosted answer per path, the mailbox list read from `gap()` at each refresh. */
function answer(path: string, gap: () => Gap): Response {
  if (path.startsWith("/mailboxes")) return send(mailboxList([box(gap())]));
  if (path.startsWith("/sync/snapshot")) return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
  if (path.startsWith("/sync")) return send(emptyPage());
  if (path.startsWith("/messages/bodies")) return send({ items: [], nextCursor: null });
  return new Response("not found", { status: 404 });
}

describe("the mirror keeps the account's gap offer per refresh", () => {
  it("follows the hosted answer, keeps only a count or null, and stores no window of its own", async () => {
    const dataDir = await freshDataDir("ohmail-cloud-gap-");
    dirs.push(dataDir);
    const opened = await openLocalDb(dataDir);
    opens.push(opened);
    const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
    let gap: Gap = 2;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => answer(path, () => gap),
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json"), now: () => new Date(), auth });

    await mirror.pullOnce();
    expect(mirror.hostedGaps().get(A), "the account's count never reached the mirror").toEqual({ letters: 2 });
    const [row] = await opened.db.select({ since: mailboxes.gapSince, letters: mailboxes.gapLetters })
      .from(mailboxes).where(eq(mailboxes.id, A));
    expect(row, "the hosted mailbox was not mirrored").toBeDefined();
    expect(row, "the account's window was copied into this store").toEqual({ since: null, letters: null });

    gap = null;
    await mirror.pullOnce();
    expect(mirror.hostedGaps().get(A), "an answered offer stayed up").toBeNull();
    gap = "absent";
    await mirror.pullOnce();
    expect(mirror.hostedGaps().has(A), "an older server's silence was read as an answer").toBe(false);
    gap = "junk";
    await mirror.pullOnce();
    expect(mirror.hostedGaps().has(A), "a malformed count was kept").toBe(false);
    gap = { letters: 0, strangers: 2 };
    await mirror.pullOnce();
    expect(mirror.hostedGaps().get(A), "a strangers-only offer was dropped").toEqual({ letters: 0, strangers: 2 });
    const [after] = await opened.db.select({ since: mailboxes.gapSince, strangers: mailboxes.gapStrangers })
      .from(mailboxes).where(eq(mailboxes.id, A));
    expect(after, "the account's strangers were copied into this store").toEqual({ since: null, strangers: null });
  });
});

describe("the Cloud door's mailbox list carries it", () => {
  async function door(gap: Gap): Promise<Record<string, unknown>> {
    const dataDir = await freshDataDir("ohmail-cloud-gap-door-");
    dirs.push(dataDir);
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl: "https://cloud.test", address: OWN, tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return answer(`${url.pathname}${url.search}`, () => gap);
      }) as unknown as typeof fetch,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start();
    const res = await sidecar.handle(new Request("http://sidecar/mailboxes", {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    expect(res.status).toBe(200);
    const [row] = (await res.json()).items as Array<Record<string, unknown>>;
    return row!;
  }

  it("the account's count reaches the window", { timeout: 30_000 }, async () => {
    expect((await door(2)).gapLetters, "the offer the account counted reached no Cloud-paired window").toBe(2);
  });

  it("a strangers-only offer arrives with both counts", { timeout: 30_000 }, async () => {
    const row = await door({ letters: 0, strangers: 2 });
    expect({ letters: row.gapLetters, strangers: row.gapStrangers }, "the strangers reached no Cloud-paired window")
      .toEqual({ letters: 0, strangers: 2 });
  });

  it("CONTROL: with nothing from the account the row says what the mirror's own read says", { timeout: 30_000 }, async () => {
    expect((await door("absent")).gapLetters).toBeNull();
  });
});
