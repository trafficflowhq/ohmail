import { randomUUID } from "node:crypto";
import { format } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { messageBodies, unsubscribeRecords } from "@trafficflow/db";
import { createLogger, type Logger } from "@trafficflow/core/mail";
import {
  makeUnsubscribeService, unsubscribeListKey, ServiceError,
  type HostResolver, type OneClickPost,
} from "../src/index.js";
import { LIST_REFUSED, oneClickSettleOf } from "../src/unsubscribe-service.js";
import { makeCtx, personScreenedOut, seedMessage } from "./helpers.js";

/**
 * THE LIST'S ANSWER DECIDES THE RECORD. Only a 2xx settles as sent. A refusal is
 * stored `refused`/`list_refused`, said by name and never asked again; a failure is stored `failed`,
 * which a person's press may retry and the automatic pass never does. A row written before the rule
 * (`sent` over a 405) is read by the same rule.
 */

const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
/**
 * The position a Gmail-held mailbox trusts (`providerAuthservIds`). The letter carries that
 * provider's confirmation of its sender: the automatic arm asks a list only for a confirmed sender.
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);
const URL_ = "https://list.example/leave?t=abc";
const ONE_CLICK = {
  "list-unsubscribe": [`<${URL_}>`],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
  "list-id": ["<weekly.list.example>"],
  "authentication-results": ["mx.google.com; dmarc=pass"],
};
const FROM = "news@list.example";

function answering(...answers: Array<number | Error>): OneClickPost & { calls: number } {
  const port = {
    calls: 0,
    async post(): Promise<{ status: number }> {
      const a = answers[Math.min(port.calls, answers.length - 1)]!;
      port.calls += 1;
      if (a instanceof Error) throw a;
      return { status: a };
    },
  };
  return port;
}

const svcWith = (post: OneClickPost, log?: Logger) =>
  makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL, ...(log ? { log } : {}) });

/** The hardened logger into a sink, and every console call rendered as the process would print it. */
function heard(): { log: Logger; lines: () => Array<Record<string, unknown>>; printed: () => string } {
  const raw: string[] = [];
  const consoleSays: string[] = [];
  for (const m of ["error", "warn", "log", "info"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleSays.push(format(...a)); });
  }
  return {
    log: createLogger({ service: "unsubscribe", sink: (l) => { raw.push(l); } }),
    lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>),
    printed: () => [...raw, ...consoleSays].join("\n"),
  };
}

type Db = Awaited<ReturnType<typeof makeCtx>>["db"];

async function seedLetter(db: Db, accountId: string, mailboxId: string): Promise<string> {
  const id = await seedMessage(db, accountId, mailboxId, { from: FROM, folder: "ohmail/Screened" });
  await db.insert(messageBodies).values({ messageId: id, text: "", headers: ONE_CLICK });
  return id;
}

async function legacyRecord(db: Db, accountId: string, mailboxId: string, httpStatus: number): Promise<void> {
  await db.insert(unsubscribeRecords).values({
    accountId, mailboxId, listKey: unsubscribeListKey(ONE_CLICK, FROM), state: "sent", httpStatus,
    messageId: await seedLetter(db, accountId, mailboxId),
    createdAt: new Date("2026-07-01T00:00:00Z"), updatedAt: new Date("2026-07-01T00:00:00Z"),
  });
}

const rowsOf = (db: Db, accountId: string) =>
  db.select().from(unsubscribeRecords).where(eq(unsubscribeRecords.accountId, accountId));

afterEach(() => { vi.restoreAllMocks(); });

describe("oneClickSettleOf — done only on a 2xx", () => {
  it.each([
    [200, "sent"], [202, "sent"], [204, "sent"], [299, "sent"],
    [199, "refused"], [301, "refused"], [302, "refused"], [400, "refused"], [404, "refused"], [405, "refused"], [410, "refused"],
    [408, "failed"], [429, "failed"], [500, "failed"], [502, "failed"], [503, "failed"],
  ] as const)("%i settles as %s", (status, settled) => {
    expect(oneClickSettleOf(status)).toBe(settled);
  });
});

describe("a person's press", () => {
  it("a 405 is refused by name with the letter's link, stored with its status, and the list is not asked twice", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seedLetter(db, accountId, mailboxId);
    const post = answering(405);

    const first = await svcWith(post).unsubscribe(ctx, id).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ServiceError);
    expect(first).toMatchObject({
      code: "unsubscribe_list_refused", httpStatus: 409, retryable: false,
      details: { messageId: id, status: 405, siteUrl: URL_ },
    });
    expect(await rowsOf(db, accountId)).toMatchObject([{ state: "refused", refusal: LIST_REFUSED, httpStatus: 405 }]);

    await expect(svcWith(post).unsubscribe(ctx, id)).rejects.toMatchObject({ code: "unsubscribe_list_refused" });
    expect(post.calls).toBe(1);
  });

  it("a transport failure is `list_failed`, retryable, with its cause; the next press asks again and a 2xx settles the SAME row", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seedLetter(db, accountId, mailboxId);
    const cause = new Error("ECONNRESET");
    const post = answering(cause, 200);

    await expect(svcWith(post).unsubscribe(ctx, id)).rejects.toMatchObject({
      code: "unsubscribe_list_failed", retryable: true, details: { status: null }, cause,
    });
    expect(await rowsOf(db, accountId)).toMatchObject([{ state: "failed", httpStatus: null }]);

    expect(await svcWith(post).unsubscribe(ctx, id)).toMatchObject({ posted: true, status: 200, refusal: null });
    expect(post.calls).toBe(2);
    expect(await rowsOf(db, accountId)).toMatchObject([{ state: "sent", httpStatus: 200 }]);
  });

  it("a row settled `sent` over a 405 before the rule is read as the refusal it was", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await legacyRecord(db, accountId, mailboxId, 405);
    const id = await seedLetter(db, accountId, mailboxId);
    const post = answering(200);

    await expect(svcWith(post).unsubscribe(ctx, id)).rejects.toMatchObject({ code: "unsubscribe_list_refused" });
    expect(post.calls).toBe(0);
  });

  it("a row settled `sent` over a 500 before the rule is a failure a person may retry", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await legacyRecord(db, accountId, mailboxId, 500);
    const id = await seedLetter(db, accountId, mailboxId);
    const post = answering(200);

    expect(await svcWith(post).unsubscribe(ctx, id)).toMatchObject({ posted: true, status: 200 });
    expect(post.calls).toBe(1);
    expect(await rowsOf(db, accountId)).toHaveLength(1);
  });

  it("control: a row settled `sent` over a 200 still answers `already_recorded`", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await legacyRecord(db, accountId, mailboxId, 200);
    const id = await seedLetter(db, accountId, mailboxId);
    const post = answering(200);

    expect(await svcWith(post).unsubscribe(ctx, id)).toMatchObject({ posted: false, refusal: "already_recorded" });
    expect(post.calls).toBe(0);
  });

  it("our own gate's refusal is untouched: nothing is sent and it is not read as the list's", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const id = await seedLetter(db, accountId, mailboxId);
    await db.insert(unsubscribeRecords).values({
      accountId, mailboxId, listKey: unsubscribeListKey(ONE_CLICK, FROM), state: "refused", refusal: "ssrf_gate",
      messageId: id,
    });
    const post = answering(200);

    expect(await svcWith(post).unsubscribe(ctx, id)).toMatchObject({ posted: false, refusal: "previous_attempt_unsettled" });
    expect(post.calls).toBe(0);
  });
});

describe("the automatic pass on a person's screen-out", () => {
  it.each([
    [405, { state: "refused", refusal: LIST_REFUSED, httpStatus: 405 }],
    [500, { state: "failed", refusal: null, httpStatus: 500 }],
  ] as const)("a %i is counted failed, never posted, and the pass does not ask again", async (status, row) => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await personScreenedOut(db, accountId, FROM);
    const first = await seedLetter(db, accountId, mailboxId);
    const post = answering(status);
    const h = heard();

    expect(await svcWith(post, h.log).onScreenOut(ctx, [first]))
      .toEqual({ considered: 1, posted: 0, skipped: 0, failed: 1, remaining: 0 });
    expect(await rowsOf(db, accountId)).toMatchObject([row]);
    // The log line names the outcome and never the list's link.
    expect(h.lines().filter((l) => l.event === "unsubscribe_list_failed")).toHaveLength(1);
    expect(h.printed()).not.toContain("list.example");

    const second = await seedLetter(db, accountId, mailboxId);
    expect(await svcWith(post).onScreenOut(ctx, [second]))
      .toEqual({ considered: 1, posted: 0, skipped: 1, failed: 0, remaining: 0 });
    expect(post.calls).toBe(1);
  });

  it("a transport failure is logged by its class and code, never by the cause's text", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await personScreenedOut(db, accountId, FROM);
    const id = await seedLetter(db, accountId, mailboxId);
    const host = `list-${randomUUID().slice(0, 8)}.mail.example`;
    const h = heard();

    const cause = Object.assign(new Error(`connect ECONNRESET ${host}:443`), { code: "ECONNRESET" });
    expect(await svcWith(answering(cause), h.log).onScreenOut(ctx, [id]))
      .toEqual({ considered: 1, posted: 0, skipped: 0, failed: 1, remaining: 0 });
    expect(h.lines().filter((l) => l.event === "unsubscribe_list_failed")
      .map((l) => [l.code, l.errorClass, l.errorCode])).toEqual([["unsubscribe_list_failed", "Error", "ECONNRESET"]]);
    expect.soft(h.printed().includes(host), "the cause's text, which names the list's server, was printed").toBe(false);
  });

  it("any other fault in the pass, and an unreadable account switch, are logged by class and code too", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await personScreenedOut(db, accountId, FROM);
    const id = await seedLetter(db, accountId, mailboxId);
    const host = `mx-${randomUUID().slice(0, 8)}.mail.example`;
    const fault = (): Error => Object.assign(new Error(`read failed against ${host}`), { code: "EFAULT" });
    const h = heard();

    const faulting = makeUnsubscribeService({
      post: answering(204), resolver: PUBLIC_DNS, log: h.log, trustedAuthservIdsFor: async () => { throw fault(); },
    });
    expect(await faulting.onScreenOut(ctx, [id])).toEqual({ considered: 1, posted: 0, skipped: 0, failed: 1, remaining: 0 });
    const noSwitch = { ...ctx, db: new Proxy(db, { get: (t, p, r) => (p === "select" ? () => { throw fault(); } : Reflect.get(t, p, r)) }) };
    expect(await svcWith(answering(204), h.log).onScreenOut(noSwitch, [id])).toMatchObject({ considered: 0, posted: 0 });

    expect(h.lines().filter((l) => l.event === "unsubscribe_sweep_failed" || l.event === "unsubscribe_switch_read_failed")
      .map((l) => [l.event, l.errorClass, l.errorCode]))
      .toEqual([["unsubscribe_sweep_failed", "Error", "EFAULT"], ["unsubscribe_switch_read_failed", "Error", "EFAULT"]]);
    expect.soft(h.printed().includes(host), "an error's text, which names a server, was printed").toBe(false);
  });

  it("control: a 2xx is posted", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await personScreenedOut(db, accountId, FROM);
    const id = await seedLetter(db, accountId, mailboxId);
    expect(await svcWith(answering(204)).onScreenOut(ctx, [id]))
      .toEqual({ considered: 1, posted: 1, skipped: 0, failed: 0, remaining: 0 });
    expect(await rowsOf(db, accountId)).toMatchObject([{ state: "sent", httpStatus: 204 }]);
  });
});
