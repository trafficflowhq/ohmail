import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";
import { folderState, mailboxes, messages, type Tx } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import {
  makeNodeOneClickPost, makeScreenerService, makeUnsubscribeService, ONE_CLICK_BODY,
  type HostResolver, type OneClickPost, type ServiceContext,
} from "@trafficflow/services";
import { runSyncCycle, type SyncDeps } from "../src/sync.js";
import { ruleRetroPass } from "../src/rule-retro.js";
import { byMessageId, makeHarness, rawClient, DB_URL, ORGANIZER_CONSENT } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE LIVE CELL, on this checkout's own Postgres and GreenMail. A list whose held letter
 * offers one-click, and a person whose held letter offers none, are screened out through
 * `ScreenerService.decide`, the call `POST /screener/:id` makes. The person is asked too, LATER: the
 * past-mail pass moves an older letter of theirs that offers one-click, and a letter arriving after
 * the press offers it — the hourly drain asks for both. That is why the press says the sender-level
 * condition and never nothing. Requests are read on the rig's 127.0.0.1 listener, the production port
 * pinned to loopback, so no outside host is asked; each list is asked once.
 */

/** The sender's host resolves public for the SSRF gate; the rig port then dials loopback only. */
const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
const WINDOW_MS = 60 * 60 * 1000;
/**
 * The mailbox's provider, as a Gmail-held mailbox resolves it (`providerAuthservIds`): every path
 * that reads a verdict here trusts the same position, and each letter carries that provider's
 * confirmation of its sender — the automatic pass asks a list only for a sender it can confirm.
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);

function eml(o: { from: string; subject: string; messageId: string; date?: Date; oneClick?: { list: string; token: string } }): string {
  return [
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, "To: reader@mailbox.rig.test", `Subject: ${o.subject}`,
    "Authentication-Results: mx.google.com; spf=pass; dmarc=pass",
    ...(o.date ? [`Date: ${o.date.toUTCString()}`] : []),
    ...(o.oneClick
      ? [`List-Id: <${o.oneClick.list}>`, `List-Unsubscribe: <https://${o.oneClick.list}/leave?t=${o.oneClick.token}>`,
        "List-Unsubscribe-Post: List-Unsubscribe=One-Click"]
      : []),
    "Content-Type: text/plain", "", "hello",
  ].join("\r\n");
}

describe("a screen-out asks each list once, for the sender's mail now and later (real GreenMail)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("the list is asked at the press; the person's past and later one-click mail by the passes; nobody twice", async () => {
    // THE RIG'S RECEIVING SIDE.
    const received: Array<{ method: string; url: string; body: string }> = [];
    const rig: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
      req.on("end", () => { received.push({ method: req.method ?? "", url: req.url ?? "", body }); res.writeHead(200).end(); });
    });
    await new Promise<void>((r) => rig.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise<void>((r) => rig.close(() => r())));
    const port = (rig.address() as { port: number }).port;
    const real = makeNodeOneClickPost();
    const rigPost: OneClickPost = {
      async post(url, _pin, timeoutMs) {
        const u = new URL(url);
        return real.post(`http://127.0.0.1:${port}${u.pathname}${u.search}`, ["127.0.0.1"], timeoutMs);
      },
    };
    const unsubscribe = makeUnsubscribeService({ post: rigPost, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });
    const screener = makeScreenerService({ unsubscribe });
    const paths = () => received.map((r) => r.url);

    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    await h.db.update(mailboxes).set(ORGANIZER_CONSENT).where(eq(mailboxes.id, h.mailboxId));
    // Mail that arrived before the cutoff keeps its place: the person's older letter stays in the INBOX.
    const deps: SyncDeps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      role: "organizer", trustedAuthservIds: GMAIL, screeningCutoff: new Date(Date.now() - WINDOW_MS) };

    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout(); });
    const old = new Date("2026-01-05T09:00:00Z");
    await c.append("INBOX", eml({ from: "person@plain.rig.test", subject: "Spring", messageId: "plain0@rig", date: old, oneClick: { list: "old.plain.rig.test", token: "old" } }), [], old);
    await c.append("INBOX", eml({ from: "news@list.rig.test", subject: "Weekly", messageId: "list1@rig", oneClick: { list: "list.rig.test", token: "rig-token" } }));
    await c.append("INBOX", eml({ from: "person@plain.rig.test", subject: "Hello", messageId: "plain1@rig" }));
    await runSyncCycle(deps);

    const one = async (mid: string) => (await h.db.select().from(messages).where(byMessageId(h.mailboxId, mid)))[0]!;
    const desired = async (id: string) =>
      (await h.db.select().from(folderState).where(eq(folderState.messageId, id)))[0]?.desiredFolder;
    const [list, plain, plainOld] = [await one("list1@rig"), await one("plain1@rig"), await one("plain0@rig")];
    expect(await desired(list.id), "premise: the list waits in the Screener").toBe("ohmail/Screener");
    expect(await desired(plain.id), "premise: the person waits in the Screener").toBe("ohmail/Screener");
    expect(await desired(plainOld.id), "premise: the person's older letter stayed in the INBOX").toBe("INBOX");

    const ctx: ServiceContext = { db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "cell" };
    const drain = () => unsubscribe.sweepScreenedOut(ctx, { since: new Date(Date.now() - WINDOW_MS), limit: 50 });

    // The list, at the press: exactly the RFC 8058 body, once.
    await screener.decide(ctx, list.id, { decision: "no", dest: "ohmail/Screened", scope: "sender" });
    expect(received).toEqual([{ method: "POST", url: "/leave?t=rig-token", body: ONE_CLICK_BODY }]);

    // The person: their held letter offers none, so the press itself asks nothing…
    await screener.decide(ctx, plain.id, { decision: "no", dest: "ohmail/Screened", scope: "sender" });
    expect(paths()).toEqual(["/leave?t=rig-token"]);
    // …but the past-mail pass moves the older letter, and the drain asks for it.
    await ruleRetroPass(h.db as unknown as Tx, { accountId: h.accountId, trustedAuthservIdsFor: async () => GMAIL }, new Date());
    expect(await desired(plainOld.id), "the past-mail pass moved the older letter").toBe("ohmail/Screened");
    await drain();
    expect(paths()).toEqual(["/leave?t=rig-token", "/leave?t=old"]);

    // A letter arriving after the press offers one-click: the rule files it, and the drain asks again.
    await c.append("INBOX", eml({ from: "person@plain.rig.test", subject: "Later", messageId: "plain2@rig", oneClick: { list: "later.plain.rig.test", token: "later" } }));
    await runSyncCycle(deps);
    expect(await desired((await one("plain2@rig")).id), "the rule filed the later letter").toBe("ohmail/Screened");
    await drain();
    expect(paths()).toEqual(["/leave?t=rig-token", "/leave?t=old", "/leave?t=later"]);
    expect(received.every((r) => r.method === "POST" && r.body === ONE_CLICK_BODY)).toBe(true);

    // And nobody twice: another drain over the same window asks nobody.
    const again = await drain();
    expect(again.posted).toBe(0);
    expect(received).toHaveLength(3);
  }, 90_000);
});
