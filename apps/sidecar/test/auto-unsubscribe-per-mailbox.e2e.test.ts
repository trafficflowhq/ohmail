import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { folderState, messages, unsubscribeRecords } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * ONE STANDALONE INSTALL, TWO PROVIDERS: whose `Authentication-Results` the unsubscribe believes is
 * the provider of the mailbox that holds the letter, as at ingest — never the first mailbox's. With
 * the first mailbox's, a Gmail-confirmed letter in a second mailbox was refused its automatic
 * unsubscribe and re-marked as not confirmed, and a header a sender wrote in Gmail's name was
 * believed for a mailbox at another provider.
 */

class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
}

const EMPTY_CURSOR = { folders: {} };
/* A public IP literal: the SSRF gate permits it without DNS, and the POST lands in the recording port. */
const ONE_CLICK_URL = "https://11.22.33.44/unsubscribe/token-abc";
const GMAIL_CONFIRMED = "mx.google.com; dkim=pass header.i=@paypal.com; spf=pass smtp.mailfrom=service@paypal.com; dmarc=pass header.from=paypal.com";

function letter(to: string, authResults: string, tag: string): Buffer {
  const date = new Date().toUTCString().replace("GMT", "+0000");
  return Buffer.from([
    `Message-ID: <news-${tag}@paypal.com>`,
    `Authentication-Results: ${authResults}`,
    "From: PayPal <service@paypal.com>",
    `To: ${to}`,
    "Subject: Your PayPal news",
    `Date: ${date}`,
    `List-Unsubscribe: <${ONE_CLICK_URL}>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello",
  ].join("\r\n"), "utf8");
}

/** One mailbox's server: the letters its first sync hands over, and nothing after. */
interface Server { user: string; host: string; meta: MemoryMeta; raws: Buffer[]; handed: boolean }
const server = (user: string, host: string, raws: Buffer[] = []): Server =>
  ({ user, host, meta: new MemoryMeta(), raws, handed: false });

/** Each login reaches its own server double; nothing is dialled. */
function servers(all: Server[]) {
  return (cfg: ImapConfig) => {
    const w = all.find((x) => x.user === cfg.auth.user);
    if (!w) throw new Error(`unknown login ${cfg.auth.user}`);
    return {
      leaseIo: () => w.meta,
      leasePeekIo: () => ({ listClaims: () => w.meta.listClaims() }),
      async connect(): Promise<void> {},
      async close(): Promise<void> {},
      async capabilities(): Promise<ImapCapabilities> {
        return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders(): Promise<void> {},
      async changesSince(): Promise<ChangeBatch> {
        if (w.handed) return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR };
        w.handed = true;
        return {
          creates: w.raws.map((raw, i) => ({
            type: "create" as const, locator: { folder: "INBOX", ref: `1:${i + 1}` } as NativeLocator, raw,
          })) as ChangeBatch["creates"],
          moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR,
        };
      },
      async move(_l: NativeLocator, to: string): Promise<NativeLocator> { return { folder: to, ref: "7:41" } as NativeLocator; },
      async setFlags(): Promise<void> {},
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(): Promise<() => Promise<void>> { return async () => {}; },
      async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this double cannot send"); },
      async messageInSent(): Promise<boolean> { return false; },
      async fetchPart(): Promise<FetchedPart> { throw new Error("this double cannot fetchPart"); },
    } as unknown as MailboxAdapter & { leaseIo(): LeaseIo };
  };
}

function recordingPost() {
  const calls: string[] = [];
  return { calls, async post(url: string) { calls.push(url); return { status: 200 }; } };
}

describe("the standalone door's unsubscribe believes each mailbox's own provider", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(all: Server[], post: ReturnType<typeof recordingPost>, keyRing = true): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-unsub-per-mailbox-");
    const seed = all[0]!;
    const s = await createSidecar({
      dataDir,
      imap: {
        host: seed.host, port: 993, secure: true,
        auth: { user: seed.user, pass: "not-dialled-password-password" },
        smtp: { host: "smtp-a.invalid", port: 587, secure: false },
      },
      address: seed.user,
      machineName: "two providers",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      ...(keyRing ? { keks: { 1: Buffer.alloc(32, 7) } } : {}),
      adapterFactory: servers(all),
      oneClickPost: post,
      log: () => {},
    });
    cleanups.push(async () => { await s.stop().catch(() => undefined); rmSync(dataDir, { recursive: true, force: true }); });
    await s.start();
    return s;
  }
  const call = (s: Sidecar, method: string, path: string, body?: unknown) =>
    s.handle(new Request(`http://local${path}`, {
      method, headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  /** Adds the second mailbox, organizes both, and syncs the second: its letter is ingested at its own host. */
  async function addSecond(s: Sidecar, second: Server): Promise<string> {
    const res = await call(s, "POST", "/local/mailboxes", {
      provider: "imap", address: second.user,
      imap: { host: second.host, port: 993, secure: true, user: second.user, pass: "second-password" },
      smtp: { host: "smtp-b.invalid", port: 587, secure: false },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    for (const m of [s.world.mailboxId, id]) {
      const r = await call(s, "POST", `/local/mailboxes/${m}/organize`, { screening: { dormancyDays: 365 } });
      expect(r.status, await r.clone().text()).toBe(200);
    }
    await s.syncMailbox(id);
    return id;
  }

  /** The PayPal letter in `mailboxId`, held at the gate as a first-contact letter is. */
  async function heldLetter(s: Sidecar, mailboxId: string): Promise<string> {
    const [m] = await s.db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(m?.fromAddress, "the letter was not ingested").toBe("service@paypal.com");
    await s.db.update(folderState).set({ desiredFolder: "ohmail/Screener" }).where(eq(folderState.messageId, m!.id));
    return m!.id;
  }
  const storedVerdict = async (s: Sidecar, id: string) =>
    (await s.db.select({ v: messages.authVerdict }).from(messages).where(eq(messages.id, id)))[0]!.v;
  const senderCheckOf = async (s: Sidecar, id: string): Promise<unknown> => {
    const r = await call(s, "GET", `/messages/${id}`);
    expect(r.status).toBe(200);
    return ((await r.json()) as { senderCheck?: unknown }).senderCheck ?? null;
  };
  const records = (s: Sidecar) => s.db.select().from(unsubscribeRecords)
    .where(eq(unsubscribeRecords.accountId, s.world.accountId));

  it("a Gmail mailbox beside an unmapped first one: its confirmed letter is unsubscribed and stays confirmed", async () => {
    const post = recordingPost();
    const first = server("one@example.test", "mail.infomaniak.com");
    const gmail = server("two@example.test", "imap.gmail.com", [letter("two@example.test", GMAIL_CONFIRMED, "a")]);
    const s = await boot([first, gmail], post);
    const id = await heldLetter(s, await addSecond(s, gmail));
    expect(await storedVerdict(s, id)).toBe("pass");

    const res = await call(s, "POST", `/screener/${id}`, { decision: "no" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(post.calls, "the confirmed letter's unsubscribe was refused").toEqual([ONE_CLICK_URL]);
    expect(await records(s)).toHaveLength(1);
    expect(await storedVerdict(s, id), "the request re-read the letter under the first mailbox's provider").toBe("pass");
    expect(await senderCheckOf(s, id)).toBeNull();
  });

  it("an unmapped mailbox beside a Gmail first one: a header written in Gmail's name is not believed", async () => {
    const post = recordingPost();
    const gmail = server("one@example.test", "imap.gmail.com");
    const other = server("two@example.test", "mail.infomaniak.com", [letter("two@example.test", "mx.google.com; dmarc=pass header.from=paypal.com", "b")]);
    const s = await boot([gmail, other], post);
    const id = await heldLetter(s, await addSecond(s, other));
    expect(await storedVerdict(s, id)).toBe("unavailable");

    // A press while the letter waits is refused, and leaves the provider's word as ingest read it.
    const press = await call(s, "POST", `/messages/${id}/unsubscribe`, {});
    expect(press.status).toBe(409);
    expect(await storedVerdict(s, id)).toBe("unavailable");
    expect(await senderCheckOf(s, id)).toMatchObject({ reason: "unverified", brand: "PayPal" });

    const res = await call(s, "POST", `/screener/${id}`, { decision: "no" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(post.calls, "a request left on a header the sender wrote").toEqual([]);
    expect(await records(s)).toHaveLength(0);
  });

  /* WHAT THE MAILBOX LIST SAYS, from the host each mailbox dials — the one the unsubscribe reads:
     the clients say no request before a screen-out where no mailbox's provider is read. */
  const providerConfirmsOf = async (s: Sidecar): Promise<Record<string, unknown>> => {
    const r = await call(s, "GET", "/mailboxes");
    expect(r.status).toBe(200);
    const items = ((await r.json()) as { items: Array<{ id: string; providerConfirms?: unknown }> }).items;
    return Object.fromEntries(items.map((m) => [m.id, m.providerConfirms]));
  };

  it("each mailbox row says whether its provider's word is read", async () => {
    const s = await boot([server("one@example.test", "mail.infomaniak.com"), server("two@example.test", "imap.gmail.com")], recordingPost());
    const second = await addSecond(s, server("two@example.test", "imap.gmail.com"));
    expect(await providerConfirmsOf(s)).toEqual({ [s.world.mailboxId]: false, [second]: true });
  });

  it("an install with no key ring stores no password, and its first mailbox still says it from the host it dials", async () => {
    for (const [host, confirms] of [["mail.infomaniak.com", false], ["imap.gmail.com", true]] as const) {
      const s = await boot([server("one@example.test", host)], recordingPost(), false);
      expect(await providerConfirmsOf(s), host).toEqual({ [s.world.mailboxId]: confirms });
    }
  });
});
