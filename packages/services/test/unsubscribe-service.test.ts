import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { accounts, mailboxes, messages, messageBodies } from "@trafficflow/db";
import {
  makeUnsubscribeService, makeNodeOneClickPost, ONE_CLICK_BODY, ServiceError,
  type HostResolver, type OneClickPost, type ServiceContext,
} from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * RFC 8058 ONE-CLICK UNSUBSCRIBE, AT THE SERVICE.
 *
 * **NO REAL SENDER IS EVER CONTACTED BY THIS FILE.** Every test either injects a recording
 * {@link OneClickPost} that opens no socket, or drives the production port against a listener on
 * 127.0.0.1 that this file starts and stops itself. The suite-wide trap in
 * `test/setup/no-external-network.ts` is the second layer, and loopback is the only thing it
 * leaves open.
 *
 * The two owner rules are asserted as "the port was never called", which is a stronger claim
 * than "the return value was null": a parser that leaked a `mailto:` would still be caught here.
 */

/** Records every call and its full argument list; opens nothing. */
function spyPost(status = 200): OneClickPost & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async post(...args: [string, readonly string[], (number | undefined)?]) {
      calls.push(args); return { status };
    },
  };
}

/** A port that must never be reached. Calling it fails the test at the call site. */
const FORBIDDEN_POST: OneClickPost = {
  async post(url: string) {
    throw new Error(`the unsubscribe port was called, and it must not have been: ${url}`);
  },
};

const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
const PROVIDER = new Set(["mx.provider.example"]);
const NOBODY: ReadonlySet<string> = new Set<string>();

const ONE_CLICK_HEADERS = {
  "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
};

type Db = Awaited<ReturnType<typeof makeCtx>>["db"];

async function seedWithHeaders(
  db: Db, accountId: string, mailboxId: string,
  headers: Record<string, string[]>,
  opts: { from?: string; desired?: string } = {},
): Promise<string> {
  const messageId = await seedMessage(db, accountId, mailboxId, {
    from: opts.from ?? "news@sender.example",
    folder: opts.desired ?? "ohmail/Screened",
  });
  await db.insert(messageBodies).values({ messageId, accountId, text: "", headers });
  return messageId;
}

const verdictOf = async (db: Db, messageId: string): Promise<string | null> => {
  const rows = await db.select({ v: messages.authVerdict }).from(messages).where(eq(messages.id, messageId));
  return rows[0]?.v ?? null;
};

let listener: Server | null = null;
afterEach(async () => {
  if (listener) await new Promise<void>((resolve) => listener!.close(() => resolve()));
  listener = null;
});

describe("UnsubscribeService — GUARD 1: a mailto: unsubscribe sends NOTHING", () => {
  it("refuses a mailto:-only sender and never calls the port", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, {
      "list-unsubscribe": ["<mailto:leave@sender.example>"],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    });
    const svc = makeUnsubscribeService({ post: FORBIDDEN_POST, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });

    await expect(svc.unsubscribe(ctx, messageId)).rejects.toMatchObject({
      code: "unsubscribe_mailto_only", httpStatus: 409,
    });
  });

  it("there is no mail port on the service at all — a defeated parser still could not send", () => {
    const svc = makeUnsubscribeService({ post: FORBIDDEN_POST, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(svc) as object),
      ...Object.keys(svc as unknown as Record<string, unknown>),
    ];
    expect(surface.filter((k) => /mail|smtp|send/i.test(k))).toEqual([]);
  });
});

describe("UnsubscribeService — GUARD 2: https without List-Unsubscribe-Post is not auto-actioned", () => {
  it("refuses and never calls the port", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, {
      "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
    });
    const svc = makeUnsubscribeService({ post: FORBIDDEN_POST, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });

    await expect(svc.unsubscribe(ctx, messageId)).rejects.toMatchObject({
      code: "unsubscribe_not_one_click", httpStatus: 409,
    });
  });

  it("refuses a sender that publishes no unsubscribe route at all", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, { subject: ["hi"] });
    const svc = makeUnsubscribeService({ post: FORBIDDEN_POST, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });

    await expect(svc.unsubscribe(ctx, messageId)).rejects.toMatchObject({ code: "unsubscribe_no_header" });
  });
});

describe("UnsubscribeService — the auth verdict is written, and only a failure blocks", () => {
  it("GUARD 3: a trusted dkim=fail REFUSES, and the verdict is on the row as the reason", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, {
      ...ONE_CLICK_HEADERS,
      "authentication-results": ["mx.provider.example; dkim=fail header.d=sender.example"],
    });
    const svc = makeUnsubscribeService({ post: FORBIDDEN_POST, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => PROVIDER });

    await expect(svc.unsubscribe(ctx, messageId)).rejects.toMatchObject({
      code: "unsubscribe_author_failed_authentication", httpStatus: 409,
    });
    // Persisted BEFORE the refusal was thrown — the evidence outlives the request.
    expect(await verdictOf(db, messageId)).toBe("fail");
  });

  it("GUARD 4: NO Authentication-Results at all still unsubscribes, and records `unavailable`", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, ONE_CLICK_HEADERS);
    const post = spyPost();
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => PROVIDER });

    const out = await svc.unsubscribe(ctx, messageId);
    expect(out).toMatchObject({ posted: true, status: 200, refusal: null, authVerdict: "unavailable" });
    expect(await verdictOf(db, messageId)).toBe("unavailable");
  });

  it("GUARD 5: a SENDER-inserted Authentication-Results is worth nothing in either direction", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, {
      ...ONE_CLICK_HEADERS,
      "authentication-results": ["evil.example; dkim=pass header.d=sender.example; dmarc=pass header.from=sender.example"],
    });
    const post = spyPost();
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => PROVIDER });

    const out = await svc.unsubscribe(ctx, messageId);
    // NOT "pass": the header came from a position we are not entitled to believe.
    expect(out.authVerdict).toBe("unavailable");
    expect(await verdictOf(db, messageId)).toBe("unavailable");
  });

  it("an EMPTY allowlist — the shipped default — believes nobody and blocks nothing", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, {
      ...ONE_CLICK_HEADERS,
      "authentication-results": ["mx.provider.example; dkim=fail header.d=sender.example"],
    });
    const post = spyPost();
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });

    const out = await svc.unsubscribe(ctx, messageId);
    expect(out.authVerdict).toBe("unavailable");
    expect(post.calls).toHaveLength(1);
  });
});

describe("UnsubscribeService — which messages may be acted on", () => {
  /**
   * SCOPE CORRECTION, 2026-08-04 — this list LOST the News pile and `ohmail/Receipts`, and that
   * is not an assertion weakened to pass: the decision to offer unsubscribe there was WITHDRAWN.
   * The News pile is mail the user chose to keep (unsubscribing inverts that choice); Receipts
   * holds confirmations a sender unsubscribed would stop sending. Both moved to the REFUSES list
   * below, where the suite asserts no request is made for either — the opposite of before.
   * The rule: REJECT destinations only, never KEEP destinations.
   */
  it.each(["ohmail/Screened", "ohmail/Quarantine"])(
    "acts for a message desired into %s", async (desired) => {
      const { db, ctx, accountId, mailboxId } = await makeCtx();
      const messageId = await seedWithHeaders(db, accountId, mailboxId, ONE_CLICK_HEADERS, { desired });
      const post = spyPost();
      const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });

      expect((await svc.unsubscribe(ctx, messageId)).posted).toBe(true);
      expect(post.calls).toHaveLength(1);
    },
  );

  // `ohmail/News` and `ohmail/Receipts` are here BECAUSE of the 2026-08-04 correction, and they
  // are the two rows of this table that matter most: they are the only ones whose expected
  // behaviour reversed, and a regression that re-added them to `ACTIONABLE_FOLDERS` would be
  // invisible without them. `FORBIDDEN_POST` makes the claim "no request was made", not the
  // weaker "the return value was falsy".
  it.each(["ohmail/Screener", "INBOX", "ohmail/News", "ohmail/Receipts"])(
    "REFUSES a message desired into %s", async (desired) => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, ONE_CLICK_HEADERS, { desired });
    const svc = makeUnsubscribeService({ post: FORBIDDEN_POST, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });

    await expect(svc.unsubscribe(ctx, messageId)).rejects.toMatchObject({
      code: "unsubscribe_not_actionable", httpStatus: 409,
    });
    },
  );

  it("another account's message is a 404, not a 403", async () => {
    // BOTH ACCOUNTS IN ONE DATABASE (UD-R4-06). The second account used to get its own harness
    // database, where the id is simply not there — so this case passed with the ownership
    // predicate REMOVED, which is the whole thing it exists to assert. Two accounts in one store
    // is the production shape, and the predicate is now the only reason the answer is not found.
    const a = await makeCtx();
    const other = randomUUID();
    await a.db.insert(accounts).values({ id: other, name: `bc6-${other.slice(0, 8)}` });
    const [otherBox] = await a.db.insert(mailboxes).values({
      accountId: other, provider: "imap", address: `bc6-${other.slice(0, 8)}@example.test`,
    }).returning();
    const b: ServiceContext = { db: a.db, accountId: other, userId: null, now: () => new Date(), requestId: "bc6" };
    const messageId = await seedWithHeaders(a.db, a.accountId, a.mailboxId, ONE_CLICK_HEADERS);
    // The other account has mail of its OWN, so an empty world is not what answers here.
    await seedWithHeaders(a.db, other, otherBox!.id, ONE_CLICK_HEADERS);
    const svc = makeUnsubscribeService({ post: FORBIDDEN_POST, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });

    // AND THE MESSAGE, because two mechanisms answer `not_found` 404 here and only the sentence
    // tells them apart: the ownership predicate on the message read says "message not found", the
    // organizer fence one layer in says "no such mailbox". Measured — with the predicate removed,
    // the fence still answered 404, so a case asserting the code alone measures the PAIR and
    // cannot see the predicate go.
    await expect(svc.unsubscribe(b, messageId)).rejects.toMatchObject({
      code: "not_found", httpStatus: 404, message: "message not found",
    });
  });

  it("a non-uuid id is a 404 and never a 500 from a Postgres cast", async () => {
    const { ctx } = await makeCtx();
    const svc = makeUnsubscribeService({ post: FORBIDDEN_POST, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });
    await expect(svc.unsubscribe(ctx, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("UnsubscribeService — the outbound request", () => {
  it("passes the url and the validated PIN to the port — and nothing else can ride along", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, ONE_CLICK_HEADERS);
    const post = spyPost();
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });

    await svc.unsubscribe(ctx, messageId);
    // The url, the addresses the SSRF gate resolved and cleared, and — on the drain's path only —
    // what is LEFT of its budget. The pin is NOT caller data: it is the gate's own output, and it
    // is what makes the POST connect to a pre-validated address instead of re-resolving the
    // sender's host. The third is a deadline, a number, nothing a sender could read anything from.
    // There is still no headers bag, so no cookie/referer/IP can travel — and the BUTTON supplies
    // no deadline at all, which is the assertion below: a person watching gets the port's own
    // ceiling, not a share of a pass's clock.
    expect(post.calls).toEqual([["https://sender.example/u?t=abc", ["93.184.216.34"], undefined]]);
    expect(post.calls[0]!.length).toBe(3);
    expect(post.calls[0]![2]).toBeUndefined();
  });

  it("the URL comes from the STORED headers — a caller cannot name a host", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, {
      "list-unsubscribe": ["<https://chosen-by-the-sender.example/leave>"],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    });
    const post = spyPost();
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });

    await svc.unsubscribe(ctx, messageId);
    expect(post.calls[0]![0]).toBe("https://chosen-by-the-sender.example/leave");
  });

  it("the SSRF gate runs first: a public NAME that resolves inside is refused, unsent", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, {
      "list-unsubscribe": ["<https://unsubscribe.sender.example/leave>"],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    });
    const metadata: HostResolver = { async resolve() { return ["169.254.169.254"]; } };
    const svc = makeUnsubscribeService({ post: FORBIDDEN_POST, resolver: metadata, trustedAuthservIdsFor: async () => NOBODY });

    await expect(svc.unsubscribe(ctx, messageId)).rejects.toBeInstanceOf(ServiceError);
  });

  it("a sender's non-2xx answer is reported as the list's refusal, not retried and not followed", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedWithHeaders(db, accountId, mailboxId, ONE_CLICK_HEADERS);
    const post = spyPost(410);
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => NOBODY });

    // Not `posted: true` — a 410 is the list's answer and not a completed unsubscribe.
    await expect(svc.unsubscribe(ctx, messageId))
      .rejects.toMatchObject({ code: "unsubscribe_list_refused", details: { status: 410 } });
    expect(post.calls).toHaveLength(1);
  });
});

describe("makeNodeOneClickPost — the production port, against a LOCAL listener only", () => {
  /**
   * The one place real bytes go on a socket, and the socket is 127.0.0.1. What is asserted is
   * exactly what RFC 8058 §3.1 specifies and nothing else: a POST, the fixed body, the form
   * content type — and NO cookie, NO referer and no header naming the user.
   */
  it("sends POST `List-Unsubscribe=One-Click` as a form body, with nothing about the user", async () => {
    const seen: { method?: string; body: string; headers: Record<string, string | string[] | undefined> } =
      { body: "", headers: {} };

    listener = createServer((req, res) => {
      seen.method = req.method;
      seen.headers = req.headers;
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
      req.on("end", () => { seen.body = body; res.writeHead(200).end(); });
    });
    await new Promise<void>((resolve) => listener!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = listener.address() as AddressInfo;

    const out = await makeNodeOneClickPost().post(`http://127.0.0.1:${port}/leave?t=abc`, ["127.0.0.1"]);

    expect(out.status).toBe(200);
    expect(seen.method).toBe("POST");
    expect(seen.body).toBe("List-Unsubscribe=One-Click");
    expect(seen.body).toBe(ONE_CLICK_BODY);
    expect(seen.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(seen.headers["cookie"]).toBeUndefined();
    expect(seen.headers["referer"]).toBeUndefined();
    expect(seen.headers["user-agent"]).toBe("ohmail-Unsubscribe/1.0");
  });

  it("does NOT follow a redirect — the gate can only speak about the url it was handed", async () => {
    let hits = 0;
    listener = createServer((req, res) => {
      hits++;
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    });
    await new Promise<void>((resolve) => listener!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = listener.address() as AddressInfo;

    const out = await makeNodeOneClickPost().post(`http://127.0.0.1:${port}/leave`, ["127.0.0.1"]);
    expect(out.status).toBe(302);
    expect(hits).toBe(1);
  });

  /**
   * ── THE DNS-REBIND PIN, ON THE REAL PORT ─────────────────────────────────────────────────
   *
   * The POST connects through the PINNED lookup: it dials a NAME host (`localhost`) but the socket
   * is decided by the pin, not a fresh resolution of the sender's name. The environment-free proof
   * that the pin OVERRIDES the name is the `pinnedLookup` unit describe in `privacy-service.test.ts`
   * (the suite egress trap blocks a non-loopback url host at `http.request` before any lookup, so a
   * rebind cannot be staged end-to-end); this asserts the POST port wires the pin into the request.
   */
  it("dials a NAME host through the pinned lookup and reaches the pinned listener", async () => {
    let hits = 0;
    listener = createServer((_req, res) => { hits++; res.writeHead(200).end(); });
    await new Promise<void>((resolve) => listener!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = listener.address() as AddressInfo;

    const out = await makeNodeOneClickPost().post(`http://localhost:${port}/leave`, ["127.0.0.1"]);
    expect(out.status).toBe(200);
    expect(hits).toBe(1);
  });
});
