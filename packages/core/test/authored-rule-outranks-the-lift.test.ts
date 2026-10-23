/**
 * A SENDER THE PERSON FILED BY HAND FILES THERE, SIGN-IN NOTICES AND CODES INCLUDED
 * (RULE-FILED-MESSAGE-SNAPS-BACK-TO-OHBOX). The arrival's sensitivity lift kept a login notice in
 * INBOX over the person's own Receipts rule, while the retro walk filed the same mail by the rule:
 * the next notice landed in the Ohbox the sheet had just said it would leave. An authored rule
 * (manual, migrated, or promoted by the person's own Screener decision) now wins; an inferred one
 * keeps the lift, and a deny still outranks both.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, rules } from "@trafficflow/db";
import { makeDrizzleRepo } from "../src/adapters/drizzle-repo.js";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../src/pipeline.js";
import { classifySensitivity } from "../src/sensitive.js";
import { FakeRepo, FakeAdapter } from "./fakes.js";
import type { Change, PipelineDeps } from "../src/ports.js";

const SENDER = "notice@host.example";

function eml(subject: string, body: string, from = SENDER): Buffer {
  return Buffer.from([
    `Message-ID: <lift-${Math.random()}@host.example>`, `From: ${from}`, "To: me@lichtgrat.example",
    `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body,
  ].join("\r\n"));
}

async function arrive(provenance: string, destination: string, subject: string, body: string, personDecided = false) {
  const d: PipelineDeps & { repo: FakeRepo; adapter: FakeAdapter } = {
    repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "acct-1", mailboxId: "mb-1",
  };
  d.repo.senders.add(SENDER);
  d.repo.rules = [{
    id: "r-person", kind: "sender", match: SENDER, destination,
    effect: destination === "ohmail/Quarantine" || destination === "ohmail/Screened" ? "deny" : "allow",
    priority: 0, provenance: provenance as never, enabled: true, ...(personDecided ? { personDecided: true } : {}),
  }];
  const change: Change = { type: "create", locator: { folder: "INBOX", ref: "1:10" }, raw: eml(subject, body) };
  const plan = await planChange(change, { repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId });
  const res = await commitChange(plan, { storageCap: UNMETERED_STORAGE_CAP, repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId });
  return res.action;
}

const NOTICES = [
  ["a login notice", "Neue Anmeldung bei Ihrem Konto", "Es gab eine neue Anmeldung bei Ihrem Konto von einem neuen Gerät."],
  ["a new-login notice in English", "New login to your account", "We noticed a new login to your account from a new device."],
] as const;

describe("the arrival's sensitivity lift against the person's own rule", () => {
  it("premise: the notices read as sensitive", () => {
    for (const [, subject, body] of NOTICES) {
      const s = classifySensitivity({
        canonical: { messageIdHeader: null, bodyHash: "" }, subject, from: { name: null, address: SENDER },
        to: [], cc: [], date: null, headers: {}, textBody: body, htmlBody: null, hasAttachments: false, attachments: [],
      } as never);
      expect(s.sensitive, subject).toBe(true);
    }
  });

  for (const [name, subject, body] of NOTICES) {
    for (const provenance of ["manual", "migrated"]) {
      it(`${name} under a ${provenance} Receipts rule files to Receipts`, async () => {
        expect(await arrive(provenance, "ohmail/Receipts", subject, body)).toEqual({ type: "move", to: "ohmail/Receipts" });
      });
    }
    for (const provenance of ["promoted", "seeded-from-sent"]) {
      it(`${name} under a ${provenance} Receipts rule stays in the Ohbox`, async () => {
        expect(await arrive(provenance, "ohmail/Receipts", subject, body)).toEqual({ type: "none" });
      });
    }
    it(`${name} under a Receipts rule the person's Screener decision promoted files to Receipts`, async () => {
      expect(await arrive("promoted", "ohmail/Receipts", subject, body, true)).toEqual({ type: "move", to: "ohmail/Receipts" });
    });
  }

  it("the store carries the person's stamp: their decision files the notice, the act's keeps the lift", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "me@lichtgrat.example" }).returning();
    const ACT = "alert@host.example";
    await db.insert(rules).values([
      { accountId, kind: "sender", match: SENDER, destination: "ohmail/Receipts", provenance: "promoted", personDecidedAt: new Date() },
      { accountId, kind: "sender", match: ACT, destination: "ohmail/Receipts", provenance: "promoted" },
    ]);
    const repo = makeDrizzleRepo(db as never);
    const [, subject, body] = NOTICES[1];
    const desired = async (from: string, ref: string) => (await planChange(
      { type: "create", locator: { folder: "INBOX", ref }, raw: eml(subject, body, from) },
      { repo, accountId, mailboxId: mb!.id },
    )).new?.desired;
    expect(await desired(SENDER, "1:11"), "a person's Screener decision").toBe("ohmail/Receipts");
    expect(await desired(ACT, "1:12"), "the act's promotion, unstamped").toBe("INBOX");
  });

  it("a deny still outranks sensitivity: a manual Spam rule quarantines the notice", async () => {
    const [, subject, body] = NOTICES[0];
    expect(await arrive("manual", "ohmail/Quarantine", subject, body)).toEqual({ type: "move", to: "ohmail/Quarantine" });
  });
});
