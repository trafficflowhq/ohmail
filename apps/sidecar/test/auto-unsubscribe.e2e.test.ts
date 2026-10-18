import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import { eq, isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { folderState, mailboxes, messageBodies, messages, unsubscribeRecords } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  UNSUBSCRIBE ON THE STANDALONE DOOR — the automatic pass, behind the consent surface
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The automatic arm was withheld here while two things were missing: the shared client's
 * pre-click disclosure was mode-gated off on this door, and the account's off switch had no
 * local route. Both exist now — this door serves `consentRoutes` (the switch reads and writes
 * `block_auto_unsubscribe_at` here), and the disclosure reads that row rather than the build —
 * so the screen-out states the unsubscribe before the press and then makes it, which is the
 * self-host bag's wiring exactly. The landing copy drops its standalone qualifier with it.
 *
 * Five properties, all watched at the network edge:
 *
 *  · a screen-out POSTS once and records it; an admit posts nothing (the reject branch only);
 *  · it posts only for a sender the mailbox's provider confirmed: at an IMAP host whose
 *    `Authentication-Results` nobody is known to sign, it asks nobody, and the person's own press
 *    still posts;
 *  · the account's switch STOPS it — the promise "a switch in Settings turns it off" is a
 *    claim about this door too, and it is made true by a route this door serves;
 *  · a consent-less READER posts nothing: its decision is a request for whoever organizes the
 *    mailbox, and a request carries no courtesy;
 *  · the at-most-once claim per list spans both arms, so the manual verb after an automatic
 *    post answers `already_recorded` rather than asking the list twice.
 *
 * The POST is counted at the port (`SidecarConfig.oneClickPost`, the test seam beside
 * `fetchImpl`), because "how many requests would have left this machine" is the only measure that
 * does not depend on which function the code happened to call. The URL is an IP-literal so the
 * SSRF gate needs no DNS — the gate permits a public literal without resolving (it IS the pin) —
 * which keeps this hermetic in DNS-less sandboxes while still exercising the real gate.
 *
 * Mutations watched red, then restored:
 *  · `unsubscribe` dropped from `makeScreenerService` → the screen-out case reads zero posts and
 *    the landing pin demands the qualifier back;
 *  · `blocked()` made to answer false → the switched-off case posts anyway. The switch has TWO
 *    readers and only this one is on the immediate path: mutating the DRAIN's candidate query
 *    (`block_auto_unsubscribe_at is null`) leaves every case here green, which is what a green
 *    mutation is for — it named the reader this file does not measure.
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

/** A mailbox with nothing in it — the held rows under test are seeded straight into the store. */
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
/* A PUBLIC IP-literal: the SSRF gate permits it without DNS (the literal is its own pin), and no
   socket ever opens — the POST lands in the recorded port below. TEST-NET ranges are refused by
   the gate, deliberately, so this is an address from ordinary public space. */
const ONE_CLICK_URL = "https://11.22.33.44/unsubscribe/token-abc";

/** Every one-click POST the engine would have made. */
function recordingPost(status = 200): { calls: Array<{ url: string; pin: readonly string[] }>; post(url: string, pin: readonly string[]): Promise<{ status: number }> } {
  const calls: Array<{ url: string; pin: readonly string[] }> = [];
  return {
    calls,
    async post(url: string, pin: readonly string[]) {
      calls.push({ url, pin });
      return { status };
    },
  };
}

describe("auto-unsubscribe on the standalone door", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  /**
   * `host` decides whose `Authentication-Results` this install believes (`providerAuthservIds`):
   * Gmail's by default, so the screen-out below meets a sender its provider confirmed; an unmapped
   * host trusts nobody. The adapter is the quiet double above, so no host is ever dialled.
   */
  async function boot(
    post: ReturnType<typeof recordingPost>, consented = true, host = "imap.gmail.com",
  ): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-autounsub-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host, port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "auto-unsubscribe host",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(),
      oneClickPost: post,
      log: () => {},
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    /* THIS INSTALL HAS AGREED — unless the case asks for the pre-consent state. A fresh local row
     * is a READER with no consent, and the columns the real flow writes are both: the consent
     * route stamps consent, the pass that spends it writes the role. Guarded on a NULL stamp so a
     * store with history keeps it. */
    if (consented) {
      await sidecar.db.update(mailboxes)
        .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
        .where(isNull(mailboxes.organizeConsentedAt));
    }
    await sidecar.start();
    return sidecar;
  }

  const auth = (s: Sidecar): Record<string, string> => ({
    authorization: `Bearer ${s.sessionToken}`,
    "content-type": "application/json",
  });

  /** One held first-contact sender whose stored headers advertise RFC 8058 one-click. */
  async function seedHeldOneClick(s: Sidecar, address: string, listId?: string): Promise<string> {
    const dedup = `mid:${address}@unsub.test`;
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      messageIdHeader: dedup,
      bodyHash: `hash-${address}`,
      dedupKey: dedup,
      subject: `weekly letter from ${address}`,
      fromAddress: address,
      snippet: "a short extract of the mail",
      nativeLocator: { folder: "INBOX", ref: `1:${address.length}` },
    }).returning();
    await s.db.insert(messageBodies).values({
      messageId: m!.id,
      text: "the letter",
      // Stored header values are string ARRAYS — the shape `rules.ts#headerValues` reads;
      // a bare string is treated as absent, which `unsubscribeHeaderState` reports `no_header`.
      headers: {
        "list-unsubscribe": [`<${ONE_CLICK_URL}>`],
        "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
        // The mailbox's provider confirming the sender, from the position a Gmail host trusts.
        "authentication-results": ["mx.google.com; spf=pass; dkim=pass header.d=bulk.example; dmarc=pass"],
        ...(listId ? { "list-id": [listId] } : {}),
      },
    });
    await s.db.insert(folderState).values({
      messageId: m!.id,
      observedFolder: "INBOX",
      desiredFolder: SCREENER,
      lastSetBy: "us",
      reconcileStatus: "pending",
    });
    return m!.id;
  }

  it("a screen-out posts the one-click unsubscribe and records it", async () => {
    const post = recordingPost();
    const s = await boot(post);
    const held = await seedHeldOneClick(s, "letters@bulk.example", "Letters <letters.bulk.example>");

    const res = await s.handle(new Request(`http://local/screener/${held}`, {
      method: "POST", headers: auth(s), body: JSON.stringify({ decision: "no" }),
    }));
    expect(res.status, await res.clone().text()).toBe(200);

    // ONE request, to the advertised URL, pinned to the address the gate validated — the same
    // sentence the sheet showed before the press.
    expect(post.calls).toEqual([{ url: ONE_CLICK_URL, pin: ["11.22.33.44"] }]);
    const records = await s.db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.accountId, s.world.accountId));
    expect(records).toHaveLength(1);
    expect(records[0]!.state).toBe("sent");
  }, 60_000);

  it("at a host no provider is known for, a screen-out asks nobody and records nothing; the person's press still posts", async () => {
    const post = recordingPost();
    const s = await boot(post, true, "imap.invalid");
    const held = await seedHeldOneClick(s, "unknown@bulk.example", "Unknown <unknown.bulk.example>");

    const res = await s.handle(new Request(`http://local/screener/${held}`, {
      method: "POST", headers: auth(s), body: JSON.stringify({ decision: "no" }),
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(post.calls, "a request left for a sender nobody confirmed").toEqual([]);
    expect(await s.db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.accountId, s.world.accountId))).toHaveLength(0);

    // The button is a person looking at the letter.
    const pressed = await s.handle(new Request(`http://local/messages/${held}/unsubscribe`, {
      method: "POST", headers: auth(s), body: JSON.stringify({}),
    }));
    expect(pressed.status, await pressed.clone().text()).toBe(200);
    expect(((await pressed.json()) as { posted: boolean }).posted).toBe(true);
    expect(post.calls).toEqual([{ url: ONE_CLICK_URL, pin: ["11.22.33.44"] }]);
  }, 60_000);

  it("the account's switch stops it — the promise the copy makes, on this door", async () => {
    const post = recordingPost();
    const s = await boot(post);
    // The local consent route, which is what makes "a switch in Settings turns it off" true here.
    const off = await s.handle(new Request("http://local/consent/settings", {
      method: "PATCH", headers: auth(s), body: JSON.stringify({ blockAutoUnsubscribe: true }),
    }));
    expect(off.status, await off.clone().text()).toBe(200);

    const held = await seedHeldOneClick(s, "stopped@bulk.example", "Stopped <stopped.bulk.example>");
    const res = await s.handle(new Request(`http://local/screener/${held}`, {
      method: "POST", headers: auth(s), body: JSON.stringify({ decision: "no" }),
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(post.calls, "the switch is off and a request left anyway").toEqual([]);
  }, 60_000);

  it("A CONSENT-LESS READER POSTS NOTHING — its decision is a request, not an act", async () => {
    const post = recordingPost();
    const s = await boot(post, false);
    const held = await seedHeldOneClick(s, "reader@bulk.example", "Reader <reader.bulk.example>");

    const res = await s.handle(new Request(`http://local/screener/${held}`, {
      method: "POST", headers: auth(s), body: JSON.stringify({ decision: "no" }),
    }));
    /* NAMED, so a 500 cannot pass for "the courtesy declined": a pre-consent row has no
       organizer anywhere, so the decision is refused as this install being a reader. */
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "organized_elsewhere" },
    });
    /* Whatever this door answers a reader — the request branch, or a refusal naming no holder —
       nothing may leave the machine on behalf of a mailbox nobody here has been allowed to
       organize. That is the courtesy's own gate, read at the edge rather than from the branch. */
    expect(post.calls).toEqual([]);
    const records = await s.db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.accountId, s.world.accountId));
    expect(records).toHaveLength(0);
  }, 60_000);

  it("an admit sends nothing either", async () => {
    const post = recordingPost();
    const s = await boot(post);
    const held = await seedHeldOneClick(s, "friend@people.example");

    const res = await s.handle(new Request(`http://local/screener/${held}`, {
      method: "POST", headers: auth(s), body: JSON.stringify({ decision: "yes" }),
    }));
    expect(res.status).toBe(200);
    expect(post.calls).toHaveLength(0);
  }, 60_000);

  it("the claim per list spans BOTH arms, so nobody asks a list twice", async () => {
    const post = recordingPost();
    const s = await boot(post);
    const held = await seedHeldOneClick(s, "digest@bulk.example", "Digest <digest.bulk.example>");

    // The automatic arm, on the screen-out: one post, recorded.
    await s.handle(new Request(`http://local/screener/${held}`, {
      method: "POST", headers: auth(s), body: JSON.stringify({ decision: "no" }),
    }));
    expect(post.calls).toEqual([{ url: ONE_CLICK_URL, pin: ["11.22.33.44"] }]);

    // The user then presses unsubscribe on the same message: the claim holds — the honest
    // "already recorded", no second request. Keyed on the List-Id identity, which is what makes
    // the two arms one courtesy rather than two.
    const res = await s.handle(new Request(`http://local/messages/${held}/unsubscribe`, {
      method: "POST", headers: auth(s), body: JSON.stringify({}),
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { posted: boolean; refusal: string | null };
    expect(body.refusal).toBe("already_recorded");
    expect(body.posted).toBe(false);
    expect(post.calls).toHaveLength(1);

    // Another message from the SAME list, screened out: still one request in total.
    const again = await seedHeldOneClick(s, "digest2@bulk.example", "Digest <digest.bulk.example>");
    await s.handle(new Request(`http://local/screener/${again}`, {
      method: "POST", headers: auth(s), body: JSON.stringify({ decision: "no" }),
    }));
    expect(post.calls).toHaveLength(1);
    const records = await s.db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.accountId, s.world.accountId));
    expect(records).toHaveLength(1);
    expect(records[0]!.state).toBe("sent");
  }, 60_000);

  it("a list that REFUSED the screen-out's request is never read back as done", async () => {
    const post = recordingPost(405);
    const s = await boot(post);
    const held = await seedHeldOneClick(s, "refuses@bulk.example", "Refuses <refuses.bulk.example>");

    await s.handle(new Request(`http://local/screener/${held}`, {
      method: "POST", headers: auth(s), body: JSON.stringify({ decision: "no" }),
    }));
    expect(post.calls).toHaveLength(1);
    const [record] = await s.db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.accountId, s.world.accountId));
    expect(record).toMatchObject({ state: "refused", refusal: "list_refused", httpStatus: 405 });

    // The preview's press: the list's own answer, by name, with the letter's link — and the list
    // is not asked a second time.
    const res = await s.handle(new Request(`http://local/messages/${held}/unsubscribe`, {
      method: "POST", headers: auth(s), body: JSON.stringify({}),
    }));
    const body = (await res.json()) as { refusal?: string; error?: { code: string; details?: { siteUrl?: string } } };
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error?.code).toBe("unsubscribe_list_refused");
    expect(body.error?.details?.siteUrl).toBe(ONE_CLICK_URL);
    expect(post.calls).toHaveLength(1);
  }, 60_000);

  it("the manual verb still posts where no screen-out has been made", async () => {
    const post = recordingPost();
    const s = await boot(post);
    const held = await seedHeldOneClick(s, "manual@bulk.example", "Manual <manual.bulk.example>");
    // Out of the Ohbox without the courtesy: the switch is off, so the screen-out posts nothing
    // and the user's own press is the only request.
    await s.handle(new Request("http://local/consent/settings", {
      method: "PATCH", headers: auth(s), body: JSON.stringify({ blockAutoUnsubscribe: true }),
    }));
    await s.handle(new Request(`http://local/screener/${held}`, {
      method: "POST", headers: auth(s), body: JSON.stringify({ decision: "no" }),
    }));
    expect(post.calls).toHaveLength(0);

    const res = await s.handle(new Request(`http://local/messages/${held}/unsubscribe`, {
      method: "POST", headers: auth(s), body: JSON.stringify({}),
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { posted: boolean; refusal: string | null };
    expect(body.posted).toBe(true);
    expect(body.refusal).toBeNull();
    expect(post.calls).toEqual([{ url: ONE_CLICK_URL, pin: ["11.22.33.44"] }]);
  }, 60_000);
});
