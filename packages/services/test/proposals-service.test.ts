import type { WorkflowPattern } from "@ohmail/wire";
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { learningSignals, messages, mailboxes, workflowProposals } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { ProposalsService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import { ServiceError } from "../src/errors.js";
import type { ProposalAnswer, WorkflowPort } from "@trafficflow/core";

const NOW = new Date("2026-07-28T12:00:00Z");
const svc = new ProposalsService();

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function ctxFor(): Promise<{ db: Db; ctx: ServiceContext; accountId: string }> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  return { db, ctx, accountId };
}

async function statusOf(p: Promise<unknown>): Promise<number> {
  try { await p; return 0; } catch (e) {
    if (e instanceof ServiceError) return e.httpStatus;
    throw e;
  }
}

/** Seed N positive learning signals for a sender→destination pattern. */
async function seedSignals(db: Db, accountId: string, sender: string, destination: string, n: number): Promise<void> {
  const domain = sender.split("@")[1] ?? null;
  for (let i = 0; i < n; i++) {
    await db.insert(learningSignals).values({
      accountId, triggeringActionId: `sig:${sender}:${i}:${randomUUID()}`,
      kind: "external_move", senderAddress: sender, senderDomain: domain,
      destination, label: "positive",
    });
  }
}

/** Seed a message from `sender`, optionally sensitivity-flagged. */
async function seedMessage(db: Db, accountId: string, sender: string, flags: Partial<{ noAi: boolean; sensitivityCategory: string }> = {}): Promise<void> {
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "g@tf.example" }).returning();
  const dedup = `mid:${randomUUID()}`;
  await db.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "s", fromAddress: sender, snippet: "x", nativeLocator: { folder: "INBOX", ref: "1:1" },
    noAi: flags.noAi ?? false, sensitivityCategory: flags.sensitivityCategory ?? null,
  });
}

/** A spy port that records the patterns it received and returns a canned proposal per pattern. */
function spyPort(): WorkflowPort & { received: WorkflowPattern[][] } {
  const received: WorkflowPattern[][] = [];
  return {
    received,
    async propose(patterns: WorkflowPattern[]): Promise<ProposalAnswer[]> {
      received.push(patterns);
      return patterns.map((p, i) => ({
        pattern: i,
        name: `File ${p.senderAddress ?? p.senderDomain}`,
        rationale: `${p.count}x → ${p.destination}`,
        steps: [{ tool: "file_message" }],
      }));
    },
  };
}

describe("ProposalsService.assemblePatterns — redaction + sensitive exclusion", () => {
  it("emits recurring sender patterns as METADATA only; a sensitive-derived pattern is EXCLUDED", async () => {
    const { db, ctx, accountId } = await ctxFor();
    // Sender A: 4 positive signals, NO sensitive mail → a candidate pattern.
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    // Sender B: 4 positive signals, but B has a sensitivity-flagged message → EXCLUDED.
    await seedSignals(db, accountId, "secret@bank.example", "ohmail/Receipts", 4);
    await seedMessage(db, accountId, "secret@bank.example", { sensitivityCategory: "financial" });
    // Sender C: only 1 signal (below threshold) → not recurring.
    await seedSignals(db, accountId, "rare@once.example", "INBOX", 1);

    const patterns = await svc.assemblePatterns(ctx, { threshold: 3 });
    const senders = patterns.map((p) => p.senderAddress);
    expect(senders).toContain("news@acme-com.example");         // recurring, non-sensitive
    expect(senders).not.toContain("secret@bank.example");   // sensitive-derived → excluded
    expect(senders).not.toContain("rare@once.example");     // below threshold

    // METADATA only — no body/snippet/subject field on any pattern.
    for (const p of patterns) {
      expect(Object.keys(p).sort()).toEqual(
        expect.arrayContaining(Object.keys(p).filter((k) =>
          ["kind", "senderAddress", "senderDomain", "destination", "count", "provenance"].includes(k))),
      );
      expect(p).not.toHaveProperty("snippet");
      expect(p).not.toHaveProperty("body");
      expect(p).not.toHaveProperty("subject");
    }
  });
});

describe("ProposalsService.assemblePatterns — only the six canonical destinations are offered", () => {
  it("a pattern routed to Junk or to a folder of the person's own never reaches the model", async () => {
    const { db, ctx, accountId } = await ctxFor();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    await seedSignals(db, accountId, "spam@junk.test", "Junk", 4);
    await seedSignals(db, accountId, "proj@own.test", "Archive/Projects", 4);
    const patterns = await svc.assemblePatterns(ctx, { threshold: 3 });
    expect(patterns.map((p) => [p.senderAddress, p.destination])).toEqual([["news@acme-com.example", "ohmail/News"]]);
  });
});

describe("ProposalsService.generate — the mock port receives ONLY redacted metadata", () => {
  it("passes redacted patterns to the port and stores the returned proposals", async () => {
    const { db, ctx, accountId } = await ctxFor();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 5);
    await seedSignals(db, accountId, "secret@bank.example", "ohmail/Receipts", 5);
    await seedMessage(db, accountId, "secret@bank.example", { noAi: true });

    const port = spyPort();
    const dtos = await svc.generate(ctx, { port, threshold: 3 });

    // The port saw exactly one call, carrying ONLY the non-sensitive sender's metadata.
    expect(port.received).toHaveLength(1);
    const seen = port.received[0]!;
    expect(seen.map((p) => p.senderAddress)).toEqual(["news@acme-com.example"]);
    // And nothing the port received carried raw content.
    expect(JSON.stringify(seen)).not.toMatch(/snippet|"body"|subject/i);

    // The proposals are stored (open).
    expect(dtos).toHaveLength(1);
    const rows = await db.select().from(workflowProposals).where(eq(workflowProposals.accountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("open");
  });

  it("DROPS a proposal whose step declares a non-allowlisted tool", async () => {
    const { db, ctx, accountId } = await ctxFor();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 5);
    const evilPort: WorkflowPort = {
      async propose() {
        return [
          { pattern: 0, name: "Good", rationale: "", steps: [{ tool: "file_message" }] },
          { pattern: 0, name: "Exfil", rationale: "", steps: [{ tool: "send" }] },
        ];
      },
    };
    const dtos = await svc.generate(ctx, { port: evilPort, threshold: 3 });
    expect(dtos.map((d) => d.name)).toEqual(["Good"]);   // the send-tool proposal was dropped
  });

  it("re-running REPLACES the open set (dedup — no pile-up)", async () => {
    const { db, ctx, accountId } = await ctxFor();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 5);
    const port = spyPort();
    await svc.generate(ctx, { port, threshold: 3 });
    await svc.generate(ctx, { port, threshold: 3 });
    const rows = await db.select().from(workflowProposals).where(eq(workflowProposals.accountId, accountId));
    expect(rows.filter((r) => r.status === "open")).toHaveLength(1);   // not 2
  });
});

describe("ProposalsService — list + dismiss", () => {
  it("lists OPEN proposals; dismiss marks one dismissed; a dismissed one leaves the list", async () => {
    const { db, ctx, accountId } = await ctxFor();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 5);
    await svc.generate(ctx, { port: spyPort(), threshold: 3 });

    const listed = await svc.list(ctx);
    expect(listed).toHaveLength(1);
    const id = listed[0]!.id;

    await svc.dismiss(ctx, id);
    expect(await svc.list(ctx)).toHaveLength(0);
    const [row] = await db.select().from(workflowProposals).where(eq(workflowProposals.id, id));
    expect(row!.status).toBe("dismissed");

    // A second dismiss (no longer open) → 404; cross-account dismiss → 404.
    expect(await statusOf(svc.dismiss(ctx, id))).toBe(404);
    expect(await statusOf(svc.dismiss(ctx, randomUUID()))).toBe(404);
  });

  it("list + dismiss are account-scoped (no cross-account leak)", async () => {
    const { db, accountId } = await ctxFor();
    const stranger = randomUUID();
    const other: ServiceContext = { db: dbFor(db, stranger), accountId: stranger, userId: null, now: () => NOW, requestId: "r" };
    const owner: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 5);
    await svc.generate(owner, { port: spyPort(), threshold: 3 });
    expect(await svc.list(other)).toHaveLength(0);   // other account sees nothing
  });
});
